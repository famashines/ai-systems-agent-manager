import type {
  ActivateAgentVersionCommandPayloadV1,
  ActiveAgentVersionResultV1,
  Actor,
  CreateAgentCommandPayloadV1,
  PublishAgentVersionCommandPayloadV1,
  SetAgentEnabledCommandPayloadV1,
} from "@famashines/ai-systems-contracts";
import { ConcurrencyError, type EventStore } from "@famashines/ai-systems-kit/event-store";
import { ConflictError } from "@famashines/ai-systems-kit/http";
import type { ClientSession } from "mongodb";
import {
  activeVersion,
  agentStreamId,
  decide,
  evolve,
  initialState,
  type AgentCommand,
  type AgentEvent,
  type AgentState,
} from "../domain/agent.ts";

export interface Names {
  claim(name: string, agentId: string, session: ClientSession): Promise<void>;
  find(name: string): Promise<string | undefined>;
}

export interface Deps {
  store: EventStore;
  names: Names;
  newId: () => string;
}

export interface CommandInput {
  commandId: string;
  actor: Actor;
  expectedVersion?: number;
}

export interface Answer {
  agentId: string;
  version: number;
  agentVersion?: number;
}

export class AgentNameTakenError extends ConflictError {
  constructor() {
    super("An agent with this name exists");
  }
}

const isAgentEvent = <E extends { type: string }>(
  event: E,
): event is Extract<E, { type: AgentEvent["type"] }> => event.type.startsWith("agents.");

async function load(store: EventStore, agentId: string) {
  const events = await store.readStream(agentStreamId(agentId));
  const state = events.filter(isAgentEvent).reduce<AgentState>(evolve, initialState);
  return { state, version: events.length };
}

async function handle(
  { store }: Deps,
  agentId: string,
  input: CommandInput,
  command: AgentCommand,
  also?: (session: ClientSession) => Promise<void>,
): Promise<{ answer: Answer; replayed: boolean }> {
  const { state, version } = await load(store, agentId);
  if (input.expectedVersion !== undefined && input.expectedVersion !== version) {
    const result = await store.append<Answer | undefined>({
      streamId: agentStreamId(agentId),
      expectedVersion: -1,
      events: [],
      command: { commandId: input.commandId, answer: undefined },
    });
    if (!result.replayed || result.answer === undefined) throw new ConcurrencyError();
    return { answer: result.answer, replayed: true };
  }
  const events = decide(state, command);
  const published = events.find((event) => event.type === "agents.AgentVersionPublished");
  const answer: Answer = {
    agentId,
    version: version + events.length,
    ...(published ? { agentVersion: published.payload.version } : {}),
  };
  const result = await store.append({
    streamId: agentStreamId(agentId),
    expectedVersion: version,
    events: events.map((event) => ({
      ...event,
      correlationId: input.commandId,
      causationId: input.commandId,
      actor: input.actor,
    })),
    command: { commandId: input.commandId, answer },
    ...(also ? { also } : {}),
  });
  return { answer: result.answer ?? answer, replayed: result.replayed };
}

export type Input<P> = CommandInput & { payload: P };

export function createAgent(deps: Deps, input: Input<CreateAgentCommandPayloadV1>) {
  const agentId = deps.newId();
  const { name } = input.payload;
  return handle(deps, agentId, input, { type: "CreateAgent", agentId, name }, (session) =>
    deps.names.claim(name, agentId, session),
  );
}

export const publishAgentVersion = (
  deps: Deps,
  input: Input<PublishAgentVersionCommandPayloadV1>,
) => handle(deps, input.payload.agentId, input, { type: "PublishAgentVersion", ...input.payload });

export const activateAgentVersion = (
  deps: Deps,
  input: Input<ActivateAgentVersionCommandPayloadV1>,
) => handle(deps, input.payload.agentId, input, { type: "ActivateAgentVersion", ...input.payload });

export const setAgentEnabled = (deps: Deps, input: Input<SetAgentEnabledCommandPayloadV1>) =>
  handle(deps, input.payload.agentId, input, { type: "SetAgentEnabled", ...input.payload });

export async function findActiveVersionById(
  { store }: Deps,
  agentId: string,
): Promise<ActiveAgentVersionResultV1 | undefined> {
  return activeVersion((await load(store, agentId)).state);
}

export async function findActiveVersion(
  deps: Deps,
  name: string,
): Promise<ActiveAgentVersionResultV1 | undefined> {
  const agentId = await deps.names.find(name);
  return agentId === undefined ? undefined : findActiveVersionById(deps, agentId);
}
