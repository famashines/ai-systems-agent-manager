import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createService } from "@famashines/ai-systems-kit/http";
import { createLogger } from "@famashines/ai-systems-kit/observability";
import { createMemoryEventStore, fakeClock, fakeIds } from "@famashines/ai-systems-kit/testing";
import { routes } from "../../src/adapters/http.ts";
import { AgentNameTakenError, type Names } from "../../src/application/agents.ts";
import { seed, seeds } from "../../src/application/seed.ts";

const clock = fakeClock();
const store = createMemoryEventStore({ now: clock.now, newId: fakeIds(1) });
const taken = new Map<string, string>();
const names: Names = {
  claim: (name, agentId) => {
    if (taken.has(name)) return Promise.reject(new AgentNameTakenError());
    taken.set(name, agentId);
    return Promise.resolve();
  },
  find: (name) => Promise.resolve(taken.get(name)),
};
const deps = { store, names, newId: fakeIds(2) };
const quiet = { warn: () => undefined };
const app = createService({
  logger: createLogger({ service: "agent-manager", release: "test", level: "silent" }),
  routes: routes(deps),
  drainDelayMs: 0,
});
let base: string;

before(async () => {
  await seed(deps, quiet);
  const { port } = await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${String(port)}`;
});

after(async () => {
  await app.close();
});

const commandIds = fakeIds(3);
const owner = { kind: "owner", id: "owner-1" } as const;
const prompt = { promptId: "cc74090a-534e-4072-8bfd-e6c5b9f22f41", version: 1 };
const limits = { maxCalls: 5, maxTokens: 1000, maxCostMicroUsd: 5000 };

const send = (name: string, body: unknown) =>
  fetch(`${base}/internal/commands/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const envelope = (type: string, payload: unknown, overrides: Record<string, unknown> = {}) => ({
  commandId: commandIds(),
  type: `agents.${type}`,
  actor: owner,
  payload,
  ...overrides,
});

const create = async (name: string) => {
  const response = await send("create-agent", envelope("CreateAgent", { name }));
  assert.equal(response.status, 201);
  return (await response.json()) as { agentId: string; version: number };
};

const publish = async (agentId: string, model: string) => {
  const response = await send(
    "publish-agent-version",
    envelope("PublishAgentVersion", { agentId, prompt, models: [model], limits }),
  );
  assert.equal(response.status, 201);
  return (await response.json()) as { agentId: string; version: number; agentVersion: number };
};

const active = (name: string) => fetch(`${base}/internal/agents/by-name/${name}/active-version`);

test("the seeds give an enabled orchestrator and writer with version 1", async () => {
  for (const item of seeds) {
    const response = await active(item.name);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      agentId: item.agentId,
      prompt: item.prompt,
      models: item.models,
      limits: item.limits,
      version: 1,
      name: item.name,
      enabled: true,
    });
  }
});

test("the seed a second time adds no event", async () => {
  const count = (await store.readAll({ limit: 1000 })).length;
  assert.deepEqual(await seed(deps, quiet), []);
  assert.equal((await store.readAll({ limit: 1000 })).length, count);
});

test("an agent goes from create to publish, activate, enable and a rollback", async () => {
  const { agentId, version } = await create("researcher");
  assert.equal(version, 1);
  assert.equal((await active("researcher")).status, 404);
  const first = await publish(agentId, "openai/gpt-4.1-nano");
  assert.deepEqual(first, { agentId, version: 2, agentVersion: 1 });
  const second = await publish(agentId, "google/gemini-2.5-flash-lite");
  assert.equal(second.agentVersion, 2);
  for (const version of [2, 1]) {
    const response = await send(
      "activate-agent-version",
      envelope("ActivateAgentVersion", { agentId, version }),
    );
    assert.equal(response.status, 200);
    const read = (await (await active("researcher")).json()) as Record<string, unknown>;
    assert.equal(read.version, version);
    assert.equal(read.enabled, false);
  }
  const on = await send(
    "set-agent-enabled",
    envelope("SetAgentEnabled", { agentId, enabled: true }),
  );
  assert.equal(on.status, 200);
  const read = (await (await active("researcher")).json()) as Record<string, unknown>;
  assert.deepEqual(read.models, ["openai/gpt-4.1-nano"]);
  assert.equal(read.enabled, true);
  const types = (await store.readStream(`agent-${agentId}`)).map((event) => event.type);
  assert.deepEqual(types, [
    "agents.AgentCreated",
    "agents.AgentVersionPublished",
    "agents.AgentVersionPublished",
    "agents.AgentVersionActivated",
    "agents.AgentVersionActivated",
    "agents.AgentEnabled",
  ]);
});

test("the same commandId gives 200 with the first answer and no second event", async () => {
  const { agentId } = await create("coder");
  const command = envelope("PublishAgentVersion", {
    agentId,
    prompt,
    models: ["openai/gpt-4.1-nano"],
    limits,
  });
  const first = await send("publish-agent-version", command);
  const second = await send("publish-agent-version", command);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), await first.json());
  assert.equal((await store.readStream(`agent-${agentId}`)).length, 2);
});

test("an event has the command id as correlation and causation, and the owner actor", async () => {
  const command = envelope("CreateAgent", { name: "reviewer" });
  const { agentId } = (await (await send("create-agent", command)).json()) as { agentId: string };
  const [event] = await store.readStream(`agent-${agentId}`);
  assert.ok(event);
  assert.equal(event.correlationId, command.commandId);
  assert.equal(event.causationId, command.commandId);
  assert.deepEqual(event.actor, owner);
});

const problem = async (response: Response, status: number, code: string) => {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("content-type"), "application/problem+json");
  assert.equal(((await response.json()) as { code: string }).code, code);
};

test("a name that exists gives 409", async () => {
  await problem(
    await send("create-agent", envelope("CreateAgent", { name: "writer" })),
    409,
    "conflict",
  );
});

test("a command for an agent that does not exist gives 404", async () => {
  const agentId = "00000000-0000-4000-8000-0000000000ff";
  await problem(
    await send("activate-agent-version", envelope("ActivateAgentVersion", { agentId, version: 1 })),
    404,
    "not_found",
  );
});

test("an activation of a version that does not exist gives 404", async () => {
  const { agentId } = await create("planner");
  await problem(
    await send("activate-agent-version", envelope("ActivateAgentVersion", { agentId, version: 1 })),
    404,
    "not_found",
  );
});

test("enable with no active version gives 409", async () => {
  const { agentId } = await create("tester");
  await problem(
    await send("set-agent-enabled", envelope("SetAgentEnabled", { agentId, enabled: true })),
    409,
    "conflict",
  );
});

test("a stale expectedVersion gives 409", async () => {
  const agentId = seeds[0]?.agentId;
  await problem(
    await send(
      "set-agent-enabled",
      envelope("SetAgentEnabled", { agentId, enabled: false }, { expectedVersion: 1 }),
    ),
    409,
    "conflict",
  );
});

for (const [name, route, body, path] of [
  ["a bad name", "create-agent", envelope("CreateAgent", { name: "Writer" }), "body.payload.name"],
  ["a bad type", "create-agent", envelope("CreateTask", { name: "a" }), "body.type"],
  [
    "a create expectedVersion that is not 0",
    "create-agent",
    envelope("CreateAgent", { name: "a" }, { expectedVersion: 3 }),
    "body.expectedVersion",
  ],
  [
    "an agent actor",
    "create-agent",
    envelope("CreateAgent", { name: "a" }, { actor: { kind: "agent", id: "owner-1" } }),
    "body.actor.kind",
  ],
  [
    "no models",
    "publish-agent-version",
    envelope("PublishAgentVersion", {
      agentId: seeds[0]?.agentId,
      prompt,
      models: [],
      limits,
    }),
    "body.payload.models",
  ],
  [
    "version 0",
    "activate-agent-version",
    envelope("ActivateAgentVersion", { agentId: seeds[0]?.agentId, version: 0 }),
    "body.payload.version",
  ],
  [
    "no enabled value",
    "set-agent-enabled",
    envelope("SetAgentEnabled", { agentId: seeds[0]?.agentId }),
    "body.payload.enabled",
  ],
] as const) {
  test(`a command with ${name} gives 400 problem JSON`, async () => {
    const response = await send(route, body);
    assert.equal(response.status, 400);
    const result = (await response.json()) as { code: string; errors: { path: string }[] };
    assert.equal(result.code, "validation_failed");
    assert.ok(result.errors.some((issue) => issue.path === path));
  });
}

test("the active version read refuses a bad name and an unknown name", async () => {
  assert.equal((await active("orchestrator")).status, 200);
  await problem(await active("Bad_Name"), 400, "validation_failed");
  await problem(await active("unknown"), 404, "not_found");
});

test("the replay API gives events in position order, in pages", async () => {
  const all = (await (await fetch(`${base}/internal/events?limit=1000`)).json()) as {
    events: { position: number }[];
  };
  assert.deepEqual(
    all.events.map((event) => event.position),
    all.events.map((_, index) => index + 1),
  );
  const page = (await (await fetch(`${base}/internal/events?afterPosition=1&limit=2`)).json()) as {
    events: unknown[];
  };
  assert.deepEqual(page.events, all.events.slice(1, 3));
  assert.equal((await fetch(`${base}/internal/events?limit=1001`)).status, 400);
});
