import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ConcurrencyError, type EventStore } from "@famashines/ai-systems-kit/event-store";
import { createMemoryEventStore } from "@famashines/ai-systems-kit/testing";
import {
  activateAgentVersion,
  findActiveVersionById,
  publishAgentVersion,
  setAgentEnabled,
  type Names,
} from "../../src/application/agents.ts";
import {
  orchestratorPromptV2,
  seed,
  seedActor,
  seeds,
  upgradeOrchestrator,
} from "../../src/application/seed.ts";
import { agentStreamId } from "../../src/domain/agent.ts";

const [orchestrator] = seeds;
assert.ok(orchestrator);
const { agentId } = orchestrator;
const owner = { kind: "owner", id: "owner-1" } as const;
const quiet = { warn: () => undefined };

const seeded = async (store: EventStore = createMemoryEventStore()) => {
  const taken = new Map<string, string>();
  const names: Names = {
    claim: (name, id) => Promise.resolve(void taken.set(name, id)),
    find: (name) => Promise.resolve(taken.get(name)),
  };
  const deps = { store, names, newId: randomUUID };
  await seed(deps, quiet);
  return deps;
};

const stream = (store: EventStore) => store.readStream(agentStreamId(agentId));
const by = (commandId = randomUUID()) => ({ commandId, actor: owner });

test("upgradeOrchestrator publishes and activates version 2 with prompt version 2", async () => {
  const deps = await seeded();
  assert.equal(await upgradeOrchestrator(deps), true);
  assert.deepEqual(await findActiveVersionById(deps, agentId), {
    agentId,
    prompt: orchestratorPromptV2.prompt,
    models: orchestrator.models,
    limits: orchestrator.limits,
    version: 2,
    name: "orchestrator",
    enabled: true,
  });
  const events = await stream(deps.store);
  assert.deepEqual(
    events.slice(4).map((event) => [event.type, event.actor, event.causationId]),
    [
      ["agents.AgentVersionPublished", seedActor, orchestratorPromptV2.commandId],
      ["agents.AgentVersionActivated", seedActor, orchestratorPromptV2.commandId],
    ],
  );
});

test("upgradeOrchestrator two times, or from two pods at once, writes version 2 once", async () => {
  const deps = await seeded();
  const runs = await Promise.all([upgradeOrchestrator(deps), upgradeOrchestrator(deps)]);
  assert.deepEqual(runs.toSorted(), [false, true]);
  assert.equal(await upgradeOrchestrator(deps), false);
  assert.equal((await stream(deps.store)).length, 6);
});

test("upgradeOrchestrator does nothing when version 2 exists and the command ids are gone", async () => {
  const first = await seeded();
  await upgradeOrchestrator(first);
  const store = createMemoryEventStore();
  for (const event of await first.store.readAll({ limit: 1000 })) {
    await store.append({ streamId: event.streamId, events: [event] });
  }
  assert.equal(await upgradeOrchestrator({ store }), false);
  assert.equal((await stream(store)).length, 6);
});

test("upgradeOrchestrator never changes an agent that the owner changed", async () => {
  const payload = { agentId, prompt: orchestrator.prompt, limits: orchestrator.limits };
  const changes = [
    async (deps: Awaited<ReturnType<typeof seeded>>) => {
      await publishAgentVersion(deps, { ...by(), payload: { ...payload, models: ["a/b"] } });
      await activateAgentVersion(deps, { ...by(), payload: { agentId, version: 2 } });
    },
    async (deps: Awaited<ReturnType<typeof seeded>>) => {
      await publishAgentVersion(deps, { ...by(), payload: { ...payload, models: ["a/b"] } });
    },
  ];
  for (const change of changes) {
    const deps = await seeded();
    await change(deps);
    const before = await stream(deps.store);
    assert.equal(await upgradeOrchestrator(deps), false);
    assert.deepEqual(await stream(deps.store), before);
  }
});

test("upgradeOrchestrator keeps an agent that the owner turned off turned off", async () => {
  const deps = await seeded();
  await setAgentEnabled(deps, { ...by(), payload: { agentId, enabled: false } });
  assert.equal(await upgradeOrchestrator(deps), true);
  const active = await findActiveVersionById(deps, agentId);
  assert.deepEqual([active?.version, active?.enabled], [2, false]);
});

test("upgradeOrchestrator does nothing without the seed agent", async () => {
  const store = createMemoryEventStore();
  assert.equal(await upgradeOrchestrator({ store }), false);
  assert.equal((await store.readAll({ limit: 1000 })).length, 0);
});

test("upgradeOrchestrator skips a version conflict and passes on other errors", async () => {
  const { store } = await seeded();
  const conflict = { ...store, append: () => Promise.reject(new ConcurrencyError()) };
  assert.equal(await upgradeOrchestrator({ store: conflict }), false);
  const failing = { ...store, append: () => Promise.reject(new Error("disk full")) };
  await assert.rejects(upgradeOrchestrator({ store: failing }), /disk full/);
});
