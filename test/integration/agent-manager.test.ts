import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { ActiveAgentVersionResultV1 } from "@famashines/ai-systems-contracts";
import { loadConfig } from "@famashines/ai-systems-kit/config";
import { connectNats, type Nats } from "@famashines/ai-systems-kit/messaging";
import { connectMongo, type Mongo } from "@famashines/ai-systems-kit/mongo";
import { createLogger } from "@famashines/ai-systems-kit/observability";
import {
  createStreams,
  startMongo,
  startNats,
  waitFor,
  type Started,
} from "@famashines/ai-systems-kit/testing";
import { seeds } from "../../src/application/seed.ts";
import { envSchema, start } from "../../src/main.ts";

const agentManagerGrants = [
  "agents.>",
  "dlq.agent-manager.>",
  "$JS.API.INFO",
  "$JS.API.STREAM.INFO.AGENTS",
];

const adminGrants = [
  "$JS.API.>",
  "$JS.ACK.>",
  "orchestration.>",
  "conversation.>",
  "llm.>",
  "budget.>",
  "agents.>",
  "prompts.>",
  "dlq.>",
];

const list = (subjects: string[]): string => subjects.map((s) => `"${s}"`).join(", ");

const natsConfig = `
jetstream { store_dir: /data }
accounts {
  AISYSTEMS {
    jetstream { max_file: 1073741824, max_memory: 0 }
    users = [
      {
        user: ai-systems-admin, password: admin
        permissions {
          publish { allow: [${list(adminGrants)}] }
          subscribe { allow: ["_INBOX_admin.>"] }
        }
      }
      {
        user: ai-systems-agent-manager, password: agent-manager
        permissions {
          publish { allow: [${list(agentManagerGrants)}] }
          subscribe { allow: ["_INBOX_agent-manager.>"] }
        }
      }
    ]
  }
}
`;

const logger = createLogger({ service: "test", release: "test", level: "silent" });
let mongoContainer: Started;
let natsContainer: Started;
let mongo: Mongo;
let admin: Nats;
let manager: JetStreamManager;
let running: Awaited<ReturnType<typeof start>> | undefined;
let base = "";
const issuer = "https://auth.example.test/realms/ai-systems";
let jwks: Server;
let privateKey: CryptoKey;

const token = (roles = ["owner"]) =>
  new SignJWT({ typ: "Bearer", azp: "ai-systems-app", realm_access: { roles } })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(issuer)
    .setAudience("ai-systems-app")
    .setSubject("owner-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

const startService = async (): Promise<void> => {
  const config = loadConfig(envSchema, {
    MONGODB_URI: mongoContainer.url,
    NATS_SERVERS: natsContainer.url,
    NATS_USER: "ai-systems-agent-manager",
    NATS_PASSWORD: "agent-manager",
    OIDC_ISSUER: issuer,
    OIDC_JWKS_URL: `http://127.0.0.1:${String((jwks.address() as AddressInfo).port)}/certs`,
    LOG_LEVEL: "silent",
  });
  running = await start({ ...config, PORT: 0 }, { drainDelayMs: 0 });
  base = `http://127.0.0.1:${String(running.address.port)}`;
  await waitFor(async () => (await fetch(`${base}/ready`)).ok);
};

const stopService = async (): Promise<void> => {
  const stopping = running;
  running = undefined;
  if (stopping) assert.equal(await stopping.app.close(), true);
};

before(async () => {
  [mongoContainer, natsContainer] = await Promise.all([
    startMongo(),
    startNats({ config: natsConfig }),
  ]);
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  jwks = createServer((_request, response) => {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwks.listen(0, "127.0.0.1", resolve));
  mongo = await connectMongo({ url: mongoContainer.url, database: "agent_manager" });
  admin = await connectNats({
    servers: natsContainer.url,
    user: "ai-systems-admin",
    pass: "admin",
    service: "admin",
    logger,
  });
  manager = await jetstreamManager(admin.connection);
  await createStreams(admin.connection, [{ name: "AGENTS", subjects: ["agents.>"] }]);
  await startService();
});

after(async () => {
  await stopService();
  await admin.close();
  await mongo.close();
  await new Promise((resolve) => jwks.close(resolve));
  await Promise.all([mongoContainer.stop(), natsContainer.stop()]);
});

const send = async (
  name: string,
  type: string,
  payload: unknown,
  kind = "owner",
  authorization?: string,
) =>
  fetch(`${base}/internal/commands/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: authorization ?? `Bearer ${await token()}`,
    },
    body: JSON.stringify({
      commandId: randomUUID(),
      type: `agents.${type}`,
      actor: { kind, id: "owner-1" },
      payload,
    }),
  });

const events = () =>
  mongo.db.collection<{ _id: string; streamId: string; publishedAt: Date | null }>("events");

const subjects = async (): Promise<Map<string, string>> => {
  const { state } = await manager.streams.info("AGENTS");
  const found = new Map<string, string>();
  for (let seq = state.first_seq; seq <= state.last_seq && state.messages > 0; seq += 1) {
    const message = await manager.streams.getMessage("AGENTS", { seq });
    if (message) found.set(message.header.get("Nats-Msg-Id"), message.subject);
  }
  return found;
};

const allPublished = async (): Promise<void> => {
  await waitFor(async () => (await events().countDocuments({ publishedAt: null })) === 0);
};

const active = async (name: string) => {
  const response = await fetch(`${base}/internal/agents/by-name/${name}/active-version`);
  return { status: response.status, body: (await response.json()) as unknown };
};

test("a command needs an owner token signed by the JWKS key; the reads need none", async () => {
  const agentId = seeds[1]?.agentId ?? "";
  const payload = { agentId, enabled: false };
  const count = await events().countDocuments();
  for (const [authorization, status] of [
    ["", 401],
    ["Bearer abc.def.ghi", 401],
    [`Bearer ${await token([])}`, 403],
  ] as const) {
    const response = await send(
      "set-agent-enabled",
      "SetAgentEnabled",
      payload,
      "owner",
      authorization,
    );
    assert.equal(response.status, status, authorization);
  }
  for (const path of [
    "//internal/commands/set-agent-enabled",
    "/internal//commands/set-agent-enabled",
  ]) {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 401, path);
  }
  assert.equal(await events().countDocuments(), count);
  const read = await fetch(`${base}/internal/agents/by-name/writer/active-version`);
  assert.equal(read.status, 200);
  const byId = await fetch(`${base}/internal/agents/${agentId}/active-version`);
  assert.equal(byId.status, 200);
  assert.equal((await fetch(`${base}/internal/events`)).status, 200);
});

test("the seeds are in MongoDB once and in AGENTS once, after a restart too", async () => {
  await stopService();
  await startService();
  for (const item of seeds) {
    const stored = await events()
      .find({ streamId: `agent-${item.agentId}` })
      .toArray();
    assert.equal(stored.length, 4);
  }
  await allPublished();
  const published = await subjects();
  const stored = await events().find().toArray();
  assert.equal(published.size, stored.length);
  for (const event of stored) assert.ok(published.get(event._id)?.startsWith("agents."));
});

test("the active version of a seed is the contracts result", async () => {
  const read = await active("orchestrator");
  assert.equal(read.status, 200);
  const result = ActiveAgentVersionResultV1.parse(read.body);
  assert.deepEqual(result, { ...seeds[0], version: 1, enabled: true });
});

test("a new agent, two versions and a rollback", async () => {
  const created = await send("create-agent", "CreateAgent", { name: "researcher" });
  assert.equal(created.status, 201);
  const { agentId } = (await created.json()) as { agentId: string };
  const prompt = { promptId: randomUUID(), version: 1 };
  const limits = { maxCalls: 5, maxTokens: 1000, maxCostMicroUsd: 5000 };
  for (const model of ["openai/gpt-4.1-nano", "google/gemini-2.5-flash-lite"]) {
    const response = await send("publish-agent-version", "PublishAgentVersion", {
      agentId,
      prompt,
      models: [model],
      limits,
    });
    assert.equal(response.status, 201);
  }
  for (const version of [2, 1]) {
    const response = await send("activate-agent-version", "ActivateAgentVersion", {
      agentId,
      version,
    });
    assert.equal(response.status, 200);
  }
  const read = await active("researcher");
  assert.equal(read.status, 200);
  const result = ActiveAgentVersionResultV1.parse(read.body);
  assert.equal(result.version, 1);
  assert.deepEqual(result.models, ["openai/gpt-4.1-nano"]);
  await allPublished();
  const types = [...(await subjects()).values()].filter((subject) => subject.startsWith("agents."));
  assert.equal(types.filter((type) => type === "agents.AgentVersionActivated").length, 4);
});

test("a name that exists gives 409 and writes no event", async () => {
  const count = await events().countDocuments();
  const response = await send("create-agent", "CreateAgent", { name: "writer" });
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { code: string }).code, "conflict");
  assert.equal(await events().countDocuments(), count);
});

test("a command from an actor that is not the owner gives 400", async () => {
  const response = await send("create-agent", "CreateAgent", { name: "guest" }, "agent");
  assert.equal(response.status, 400);
});

test("a wrong expectedVersion gives 409 with no event, and a retry replays the first answer", async () => {
  const agentId = seeds[1]?.agentId ?? "";
  const body = (commandId: string, expectedVersion: number) =>
    JSON.stringify({
      commandId,
      type: "agents.SetAgentEnabled",
      actor: { kind: "owner", id: "owner-1" },
      expectedVersion,
      payload: { agentId, enabled: false },
    });
  const post = async (text: string) =>
    fetch(`${base}/internal/commands/set-agent-enabled`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await token()}` },
      body: text,
    });
  const count = await events().countDocuments();
  const wrong = await post(body(randomUUID(), 9));
  assert.equal(wrong.status, 409);
  assert.equal(await events().countDocuments(), count);
  const commandId = randomUUID();
  const first = await post(body(commandId, 4));
  assert.equal(first.status, 200);
  const retry = await post(body(commandId, 4));
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), await first.json());
  assert.equal(await events().countDocuments(), count + 1);
  assert.equal(
    await mongo.db.collection("commands").countDocuments({ _id: commandId as never }),
    1,
  );
});
