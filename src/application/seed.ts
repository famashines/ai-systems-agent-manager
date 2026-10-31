import type { AgentLimits, PromptRef } from "@famashines/ai-systems-contracts";
import { ConflictError } from "@famashines/ai-systems-kit/http";
import {
  agentStreamId,
  decide,
  evolve,
  initialState,
  type AgentCommand,
  type AgentEvent,
} from "../domain/agent.ts";
import type { Deps } from "./agents.ts";

export interface Seed {
  agentId: string;
  name: string;
  prompt: PromptRef;
  models: string[];
  limits: AgentLimits;
}

const models = [
  "google/gemini-2.5-flash-lite",
  "openai/gpt-4.1-nano",
  "mistralai/mistral-small-3.2-24b-instruct",
];

const limits: AgentLimits = { maxCalls: 10, maxTokens: 4096, maxCostMicroUsd: 50_000 };

export const seeds: readonly Seed[] = [
  {
    agentId: "00000000-0000-4000-8000-00000000a001",
    name: "orchestrator",
    prompt: { promptId: "a0d53ff1-1eda-4636-bb2f-880df141bcb9", version: 1 },
    models,
    limits,
  },
  {
    agentId: "00000000-0000-4000-8000-00000000a002",
    name: "writer",
    prompt: { promptId: "cc74090a-534e-4072-8bfd-e6c5b9f22f41", version: 1 },
    models,
    limits,
  },
];

export function seedEvents({ agentId, name, prompt, models, limits }: Seed): AgentEvent[] {
  const commands: AgentCommand[] = [
    { type: "CreateAgent", agentId, name },
    { type: "PublishAgentVersion", agentId, prompt, models, limits },
    { type: "ActivateAgentVersion", agentId, version: 1 },
    { type: "SetAgentEnabled", agentId, enabled: true },
  ];
  let state = initialState;
  return commands.flatMap((command) => {
    const events = decide(state, command);
    state = events.reduce(evolve, state);
    return events;
  });
}

export interface SeedLogger {
  warn(details: object, message: string): void;
}

export async function seed(
  deps: Deps,
  logger: SeedLogger,
  list: readonly Seed[] = seeds,
): Promise<string[]> {
  const added: string[] = [];
  for (const item of list) {
    const streamId = agentStreamId(item.agentId);
    if ((await deps.store.readStream(streamId)).length > 0) continue;
    const commandId = deps.newId();
    try {
      await deps.store.append({
        streamId,
        expectedVersion: 0,
        events: seedEvents(item).map((event) => ({
          ...event,
          correlationId: commandId,
          causationId: commandId,
          actor: { kind: "system", id: "agent-manager" },
        })),
        also: (session) => deps.names.claim(item.name, item.agentId, session),
      });
      added.push(item.name);
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      logger.warn({ agent: item.name, err: error }, "seed skipped because of a conflict");
    }
  }
  return added;
}
