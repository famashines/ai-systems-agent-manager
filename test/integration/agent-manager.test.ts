import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
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

const startService = async (): Promise<void> => {
  const config = loadConfig(envSchema, {
    MONGODB_URI: mongoContainer.url,
    NATS_SERVERS: natsContainer.url,
    NATS_USER: "ai-systems-agent-manager",
    NATS_PASSWORD: "agent-manager",
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
  await Promise.all([mongoContainer.stop(), natsContainer.stop()]);
});

const send = (name: string, type: string, payload: unknown, kind = "owner") =>
  fetch(`${base}/internal/commands/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
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
