import {
  ActivateAgentVersionCommandPayloadV1,
  ActiveAgentVersionResultV1,
  Actor,
  AgentName,
  AgentRef,
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
  findActiveVersionById,
  publishAgentVersion,
  setAgentEnabled,
  type Answer,
  type Deps,
  type Input,
} from "../application/agents.ts";

const command = (type: string, payload: z.ZodType) =>
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

export function routes({ verify, ...deps }: HttpDeps): Route[] {
  const owner = bearerHook(verify);
  const commandRoute = <P>(
    name: string,
    schema: z.ZodType,
    run: (deps: Deps, input: Input<P>) => Promise<{ answer: Answer; replayed: boolean }>,
    createdStatus: number,
  ): Route => ({
    method: "POST",
    path: `/internal/commands/${name}`,
    handler: guard(async (request: Request) => {
      await owner(request);
      const body = (await validate(request, { body: schema })).body as CommandEnvelopeV1<P>;
      const { commandId, actor, expectedVersion } = body;
      if (actor.id !== subjectOf(request).sub) {
        throw new ForbiddenError("The actor is not the subject of the token");
      }
      const { answer, replayed } = await run(deps, {
        commandId,
        actor,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
        payload: body.payload,
      });
      return { status: replayed ? 200 : createdStatus, body: answer };
    }),
  });

  const activeVersionRoute = <S extends z.ZodType>(
    path: string,
    params: S,
    find: (params: z.output<S>) => Promise<ActiveAgentVersionResultV1 | undefined>,
  ): Route => ({
    method: "GET",
    path,
    handler: guard(async (request) => {
      const result = await find((await validate(request, { params })).params);
      if (!result) throw new NotFoundError("The agent has no active version");
      return { body: result };
    }),
  });

  return [
    commandRoute(
      "create-agent",
      command("agents.CreateAgent", CreateAgentCommandPayloadV1).extend({
        expectedVersion: z.literal(0).exactOptional(),
      }),
      createAgent,
      201,
    ),
    commandRoute(
      "publish-agent-version",
      command("agents.PublishAgentVersion", PublishAgentVersionCommandPayloadV1),
      publishAgentVersion,
      201,
    ),
    commandRoute(
      "activate-agent-version",
      command("agents.ActivateAgentVersion", ActivateAgentVersionCommandPayloadV1),
      activateAgentVersion,
      200,
    ),
    commandRoute(
      "set-agent-enabled",
      command("agents.SetAgentEnabled", SetAgentEnabledCommandPayloadV1),
      setAgentEnabled,
      200,
    ),
    activeVersionRoute(
      "/internal/agents/by-name/:name/active-version",
      z.object({ name: AgentName }),
      ({ name }) => findActiveVersion(deps, name),
    ),
    activeVersionRoute(
      "/internal/agents/:agentId/active-version",
      z.object({ agentId: AgentRef.shape.agentId }),
      ({ agentId }) => findActiveVersionById(deps, agentId),
    ),
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
