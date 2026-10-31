import {
  ActivateAgentVersionCommandPayloadV1,
  Actor,
  AgentName,
  CommandEnvelopeV1,
  CreateAgentCommandPayloadV1,
  PublishAgentVersionCommandPayloadV1,
  SetAgentEnabledCommandPayloadV1,
} from "@famashines/ai-systems-contracts";
import { bearerHook, subjectOf, type JwtVerifier } from "@famashines/ai-systems-kit/auth";
import {
  ForbiddenError,
  NotFoundError,
  UnavailableError,
  validate,
  type Handler,
  type Request,
  type Route,
} from "@famashines/ai-systems-kit/http";
import { isInfrastructure } from "@famashines/ai-systems-kit/messaging";
import { z } from "zod";
import {
  activateAgentVersion,
  createAgent,
  findActiveVersion,
  publishAgentVersion,
  setAgentEnabled,
  type Answer,
  type Deps,
  type Input,
} from "../application/agents.ts";

const command = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  CommandEnvelopeV1(payload).extend({
    type: z.literal(type),
    actor: Actor.extend({ kind: z.literal("owner") }),
  });

const count = (fallback: string, schema: z.ZodInt) =>
  z.string().regex(/^\d+$/).default(fallback).transform(Number).pipe(schema);

const EventsQuery = z.object({
  afterPosition: count("0", z.int().min(0)),
  limit: count("100", z.int().min(1).max(1000)),
});

export function toHttpError(error: unknown): unknown {
  if (isInfrastructure(error)) return new UnavailableError("The database is not available");
  return error;
}

const guard =
  (handler: Handler): Handler =>
  async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      throw toHttpError(error);
    }
  };

export interface HttpDeps extends Deps {
  verify: JwtVerifier;
}

export function routes(deps: HttpDeps): Route[] {
  const owner = bearerHook(deps.verify);

  const commandRoute = <P extends z.ZodType>(
    name: string,
    type: string,
    payload: P,
    run: (deps: Deps, input: Input<z.output<P>>) => Promise<{ answer: Answer; replayed: boolean }>,
    createdStatus: number,
  ): Route => ({
    method: "POST",
    path: `/internal/commands/${name}`,
    handler: guard(async (request: Request) => {
      await owner(request);
      const body = (await validate(request, { body: command(type, payload) }))
        .body as CommandEnvelopeV1<z.output<P>>;
      if (body.actor.id !== subjectOf(request).sub) {
        throw new ForbiddenError("The actor is not the owner of the token");
      }
      const { commandId, actor, expectedVersion } = body;
      const { answer, replayed } = await run(deps, {
        commandId,
        actor,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
        payload: body.payload,
      });
      return { status: replayed ? 200 : createdStatus, body: answer };
    }),
  });

  return [
    commandRoute(
      "create-agent",
      "agents.CreateAgent",
      CreateAgentCommandPayloadV1,
      createAgent,
      201,
    ),
    commandRoute(
      "publish-agent-version",
      "agents.PublishAgentVersion",
      PublishAgentVersionCommandPayloadV1,
      publishAgentVersion,
      201,
    ),
    commandRoute(
      "activate-agent-version",
      "agents.ActivateAgentVersion",
      ActivateAgentVersionCommandPayloadV1,
      activateAgentVersion,
      200,
    ),
    commandRoute(
      "set-agent-enabled",
      "agents.SetAgentEnabled",
      SetAgentEnabledCommandPayloadV1,
      setAgentEnabled,
      200,
    ),
    {
      method: "GET",
      path: "/internal/agents/by-name/:name/active-version",
      handler: guard(async (request) => {
        const { params } = await validate(request, { params: z.object({ name: AgentName }) });
        const result = await findActiveVersion(deps, params.name);
        if (!result) throw new NotFoundError("The agent has no active version");
        return { body: result };
      }),
    },
    {
      method: "GET",
      path: "/internal/events",
      handler: guard(async (request) => {
        const { query } = await validate(request, { query: EventsQuery });
        return { body: { events: await deps.store.readAll(query) } };
      }),
    },
  ];
}
