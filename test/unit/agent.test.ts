import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeVersion,
  AgentExistsError,
  AgentNotFoundError,
  agentStreamId,
  decide,
  evolve,
  initialState,
  NoActiveVersionError,
  VersionNotFoundError,
  type AgentCommand,
  type AgentEvent,
} from "../../src/domain/agent.ts";

const agentId = "00000000-0000-4000-8000-000000000001";
const prompt = { promptId: "00000000-0000-4000-8000-000000000002", version: 1 };
const limits = { maxCalls: 10, maxTokens: 4096, maxCostMicroUsd: 20_000 };
const models = ["google/gemini-2.5-flash-lite"];

const created: AgentEvent = {
  type: "agents.AgentCreated",
  schemaVersion: 1,
  payload: { agentId, name: "writer" },
};
const published = (version: number, model = models[0] ?? ""): AgentEvent => ({
  type: "agents.AgentVersionPublished",
  schemaVersion: 1,
  payload: { agentId, prompt, models: [model], limits, version },
});
const activated = (version: number): AgentEvent => ({
  type: "agents.AgentVersionActivated",
  schemaVersion: 1,
  payload: { agentId, version },
});
const enabled: AgentEvent = { type: "agents.AgentEnabled", schemaVersion: 1, payload: { agentId } };
const disabled: AgentEvent = {
  type: "agents.AgentDisabled",
  schemaVersion: 1,
  payload: { agentId },
};

const create: AgentCommand = { type: "CreateAgent", agentId, name: "writer" };
const publish = (model = models[0] ?? ""): AgentCommand => ({
  type: "PublishAgentVersion",
  agentId,
  prompt,
  models: [model],
  limits,
});
const activate = (version: number): AgentCommand => ({
  type: "ActivateAgentVersion",
  agentId,
  version,
});
const setEnabled = (value: boolean): AgentCommand => ({
  type: "SetAgentEnabled",
  agentId,
  enabled: value,
});

const given = (events: AgentEvent[]) => ({
  when: (command: AgentCommand) => () => decide(events.reduce(evolve, initialState), command),
});

test("given no events, when CreateAgent, then AgentCreated", () => {
  assert.deepEqual(given([]).when(create)(), [created]);
});

test("given AgentCreated, when CreateAgent, then AgentExistsError", () => {
  assert.throws(given([created]).when(create), AgentExistsError);
});

for (const command of [publish(), activate(1), setEnabled(true)]) {
  test(`given no events, when ${command.type}, then AgentNotFoundError`, () => {
    assert.throws(given([]).when(command), AgentNotFoundError);
  });
}

test("given AgentCreated, when PublishAgentVersion, then version 1", () => {
  assert.deepEqual(given([created]).when(publish())(), [published(1)]);
});

test("given two versions, when PublishAgentVersion, then version 3", () => {
  assert.deepEqual(given([created, published(1), published(2)]).when(publish())(), [published(3)]);
});

test("given version 1, when ActivateAgentVersion 1, then AgentVersionActivated", () => {
  assert.deepEqual(given([created, published(1)]).when(activate(1))(), [activated(1)]);
});

test("given version 2 is active, when ActivateAgentVersion 1, then a rollback to 1", () => {
  const history = [created, published(1), activated(1), published(2), activated(2)];
  assert.deepEqual(given(history).when(activate(1))(), [activated(1)]);
  const state = [...history, activated(1)].reduce(evolve, initialState);
  assert.equal(activeVersion(state)?.version, 1);
});

test("given version 1 is active, when ActivateAgentVersion 1, then no event", () => {
  assert.deepEqual(given([created, published(1), activated(1)]).when(activate(1))(), []);
});

test("given one version, when ActivateAgentVersion 2, then VersionNotFoundError", () => {
  assert.throws(given([created, published(1)]).when(activate(2)), VersionNotFoundError);
});

test("given no active version, when SetAgentEnabled true, then NoActiveVersionError", () => {
  assert.throws(given([created, published(1)]).when(setEnabled(true)), NoActiveVersionError);
});

test("given an active version, when SetAgentEnabled true, then AgentEnabled", () => {
  assert.deepEqual(given([created, published(1), activated(1)]).when(setEnabled(true))(), [
    enabled,
  ]);
});

test("given an enabled agent, when SetAgentEnabled false, then AgentDisabled", () => {
  const history = [created, published(1), activated(1), enabled];
  assert.deepEqual(given(history).when(setEnabled(false))(), [disabled]);
});

test("given the same enabled value, when SetAgentEnabled, then no event", () => {
  assert.deepEqual(given([created]).when(setEnabled(false))(), []);
  assert.deepEqual(
    given([created, published(1), activated(1), enabled]).when(setEnabled(true))(),
    [],
  );
});

test("a new agent is disabled and has no active version", () => {
  const state = evolve(initialState, created);
  assert.deepEqual(state, {
    status: "created",
    agentId,
    name: "writer",
    enabled: false,
    versions: [],
  });
  assert.equal(activeVersion(state), undefined);
  assert.equal(activeVersion(initialState), undefined);
});

test("the active version gives the version, its name and enabled", () => {
  const state = [
    created,
    published(1),
    published(2, "openai/gpt-4.1-nano"),
    activated(2),
    enabled,
  ].reduce(evolve, initialState);
  assert.deepEqual(activeVersion(state), {
    agentId,
    prompt,
    models: ["openai/gpt-4.1-nano"],
    limits,
    version: 2,
    name: "writer",
    enabled: true,
  });
  assert.equal(
    activeVersion(
      [...[created, published(1), activated(1), enabled], disabled].reduce(evolve, initialState),
    )?.enabled,
    false,
  );
});

test("an event before AgentCreated is refused", () => {
  for (const event of [published(1), activated(1), enabled, disabled]) {
    assert.throws(() => evolve(initialState, event), /no AgentCreated event/);
  }
});

test("the stream id is agent-<agentId>", () => {
  assert.equal(agentStreamId(agentId), `agent-${agentId}`);
});
