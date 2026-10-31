import type {
  ActivateAgentVersionCommandPayloadV1,
  ActiveAgentVersionResultV1,
  AgentVersionPublishedEventPayloadV1,
  CreateAgentCommandPayloadV1,
  PublishAgentVersionCommandPayloadV1,
  RegisteredEvent,
  SetAgentEnabledCommandPayloadV1,
} from "@famashines/ai-systems-contracts";
import { ConflictError, NotFoundError } from "@famashines/ai-systems-kit/http";

export type AgentCommand =
  | ({ type: "CreateAgent"; agentId: string } & CreateAgentCommandPayloadV1)
  | ({ type: "PublishAgentVersion" } & PublishAgentVersionCommandPayloadV1)
  | ({ type: "ActivateAgentVersion" } & ActivateAgentVersionCommandPayloadV1)
  | ({ type: "SetAgentEnabled" } & SetAgentEnabledCommandPayloadV1);

type Slim<E> = E extends { type: infer T; schemaVersion: infer V; payload: infer P }
  ? { type: T; schemaVersion: V; payload: P }
  : never;

export type AgentEvent = Slim<Extract<RegisteredEvent, { type: `agents.${string}` }>>;

export type AgentState =
  | { status: "new" }
  | {
      status: "created";
      agentId: string;
      name: string;
      enabled: boolean;
      versions: AgentVersionPublishedEventPayloadV1[];
      active?: number;
    };

export class AgentExistsError extends ConflictError {
  constructor() {
    super("The agent exists");
  }
}

export class AgentNotFoundError extends NotFoundError {
  constructor() {
    super("The agent does not exist");
  }
}

export class VersionNotFoundError extends NotFoundError {
  constructor() {
    super("The agent version does not exist");
  }
}

export class NoActiveVersionError extends ConflictError {
  constructor() {
    super("The agent has no active version");
  }
}

export const initialState: AgentState = { status: "new" };

export const agentStreamId = (agentId: string): string => `agent-${agentId}`;

export function decide(state: AgentState, command: AgentCommand): AgentEvent[] {
  if (command.type === "CreateAgent") {
    if (state.status !== "new") throw new AgentExistsError();
    const { agentId, name } = command;
    return [{ type: "agents.AgentCreated", schemaVersion: 1, payload: { agentId, name } }];
  }
  if (state.status === "new") throw new AgentNotFoundError();
  const { agentId } = state;
  switch (command.type) {
    case "PublishAgentVersion": {
      const { prompt, models, limits } = command;
      const version = state.versions.length + 1;
      return [
        {
          type: "agents.AgentVersionPublished",
          schemaVersion: 1,
          payload: { agentId, prompt, models, limits, version },
        },
      ];
    }
    case "ActivateAgentVersion": {
      const { version } = command;
      if (version > state.versions.length) throw new VersionNotFoundError();
      if (version === state.active) return [];
      return [
        { type: "agents.AgentVersionActivated", schemaVersion: 1, payload: { agentId, version } },
      ];
    }
    case "SetAgentEnabled": {
      if (command.enabled === state.enabled) return [];
      if (command.enabled && state.active === undefined) throw new NoActiveVersionError();
      return [
        command.enabled
          ? { type: "agents.AgentEnabled", schemaVersion: 1, payload: { agentId } }
          : { type: "agents.AgentDisabled", schemaVersion: 1, payload: { agentId } },
      ];
    }
  }
}

const created = (state: AgentState) => {
  if (state.status === "new") throw new Error("The agent stream has no AgentCreated event");
  return state;
};

export function evolve(state: AgentState, event: AgentEvent): AgentState {
  switch (event.type) {
    case "agents.AgentCreated":
      return { status: "created", ...event.payload, enabled: false, versions: [] };
    case "agents.AgentVersionPublished": {
      const agent = created(state);
      return { ...agent, versions: [...agent.versions, event.payload] };
    }
    case "agents.AgentVersionActivated":
      return { ...created(state), active: event.payload.version };
    case "agents.AgentEnabled":
      return { ...created(state), enabled: true };
    case "agents.AgentDisabled":
      return { ...created(state), enabled: false };
  }
}

export function activeVersion(state: AgentState): ActiveAgentVersionResultV1 | undefined {
  if (state.status === "new" || state.active === undefined) return undefined;
  const version = state.versions[state.active - 1];
  return version && { ...version, name: state.name, enabled: state.enabled };
}
