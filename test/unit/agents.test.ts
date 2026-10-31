import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { EventStore } from "@famashines/ai-systems-kit/event-store";
import { ConflictError } from "@famashines/ai-systems-kit/http";
import { createMemoryEventStore, fakeIds } from "@famashines/ai-systems-kit/testing";
import {
  activateAgentVersion,
  createAgent,
  publishAgentVersion,
  setAgentEnabled,
  type Deps,
  type Names,
} from "../../src/application/agents.ts";

const actor = { kind: "owner", id: "owner-1" } as const;
const prompt = { promptId: "00000000-0000-4000-8000-0000000000b1", version: 1 };
const limits = { maxCalls: 5, maxTokens: 1000, maxCostMicroUsd: 5000 };
const commandIds = fakeIds(7);
const names: Names = { claim: () => Promise.resolve(), find: () => Promise.resolve(undefined) };

let store: EventStore;
let deps: Deps;
let agentId: string;

beforeEach(async () => {
  store = createMemoryEventStore({ newId: fakeIds(5) });
  deps = { store, names, newId: fakeIds(6) };
  ({ agentId } = (
    await createAgent(deps, { commandId: commandIds(), actor, payload: { name: "writer" } })
  ).answer);
});

const input = <P>(payload: P, expectedVersion?: number) => ({
  commandId: commandIds(),
  actor,
  ...(expectedVersion === undefined ? {} : { expectedVersion }),
  payload,
});

const publish = (model: string, expectedVersion?: number) =>
  input({ agentId, prompt, models: [model], limits }, expectedVersion);

const racing = (concurrent: () => Promise<unknown>): Deps => {
  let done = false;
  return {
    ...deps,
    store: {
      ...store,
      readStream: async (streamId, options) => {
        const events = await store.readStream(streamId, options);
        if (!done) {
          done = true;
          await concurrent();
        }
        return events;
      },
    },
  };
};

const types = async () => (await store.readStream(`agent-${agentId}`)).map((event) => event.type);

test("a future expectedVersion during a concurrent publish gives 409 and no event", async () => {
  await publishAgentVersion(deps, publish("a/one"));
  const during = racing(() => publishAgentVersion(deps, publish("a/two")));
  await assert.rejects(publishAgentVersion(during, publish("a/three", 3)), ConflictError);
  const versions = (await store.readStream(`agent-${agentId}`))
    .filter((event) => event.type === "agents.AgentVersionPublished")
    .map((event) => (event.payload as { version: number }).version);
  assert.deepEqual(versions, [1, 2]);
});

test("a future expectedVersion during a concurrent activation gives 409 and no event", async () => {
  await publishAgentVersion(deps, publish("a/one"));
  await publishAgentVersion(deps, publish("a/two"));
  await activateAgentVersion(deps, input({ agentId, version: 1 }));
  const during = racing(() => activateAgentVersion(deps, input({ agentId, version: 2 })));
  await assert.rejects(
    activateAgentVersion(during, input({ agentId, version: 1 }, 5)),
    ConflictError,
  );
  assert.equal((await types()).length, 5);
});

test("a future expectedVersion during a concurrent enable gives 409 and no event", async () => {
  await publishAgentVersion(deps, publish("a/one"));
  await activateAgentVersion(deps, input({ agentId, version: 1 }));
  const during = racing(() => setAgentEnabled(deps, input({ agentId, enabled: true })));
  await assert.rejects(
    setAgentEnabled(during, input({ agentId, enabled: true }, 4)),
    ConflictError,
  );
  assert.deepEqual(
    (await types()).filter((type) => type === "agents.AgentEnabled"),
    ["agents.AgentEnabled"],
  );
});

test("a retry with an old expectedVersion gives the first answer again", async () => {
  const command = publish("a/one", 1);
  const first = await publishAgentVersion(deps, command);
  await publishAgentVersion(deps, publish("a/two"));
  const again = await publishAgentVersion(deps, command);
  assert.equal(first.replayed, false);
  assert.equal(again.replayed, true);
  assert.deepEqual(again.answer, first.answer);
  assert.equal((await types()).length, 3);
});

test("a wrong expectedVersion with a new commandId gives 409 and no event", async () => {
  await assert.rejects(publishAgentVersion(deps, publish("a/one", 7)), ConflictError);
  assert.deepEqual(await types(), ["agents.AgentCreated"]);
});
