# ai-systems-agent-manager

The Agent Definition service of ai-systems. It keeps each agent as an
event-sourced stream `agent-<agentId>` in MongoDB: the agent, its immutable
versions (a prompt version, a model chain, limits), the active version, and
on or off. The `events` collection is the outbox: a relay publishes each
event to the NATS JetStream stream `AGENTS`. The service is internal: it
has no Ingress.

```
api-gateway --POST /internal/commands/<name> (owner actor)--> agent-manager
                                                                | one transaction
                                                                v
                                     MongoDB agent_manager: events, commands, agent_names
                                                                | outbox relay, Nats-Msg-Id = eventId
                                                                v
                                     NATS stream AGENTS (agents.>)
orchestration --GET /internal/agents/by-name/:name/active-version--> agent-manager
projections   --GET /internal/events--> agent-manager (rebuild only)
```

Architecture and reasons: `ai-systems-docs` (`ARCHITECTURE.md` 3 to 7,
ADR 0006, 0007, 0021, 0023). Schemas: `@famashines/ai-systems-contracts`
v0.3.0 (`src/agents.ts`).

## Rules

| Command                | Event                                           | Rule                                                                                                                 |
| ---------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `CreateAgent`          | `agents.AgentCreated`                           | The service makes the agent id (UUID v4). The name is unique. A new agent is off and has no active version.          |
| `PublishAgentVersion`  | `agents.AgentVersionPublished`                  | The version is the last version plus 1, from 1. A version never changes. Publish does not activate.                  |
| `ActivateAgentVersion` | `agents.AgentVersionActivated`                  | New runs use this version. A rollback is an activation of an older version. The active version again gives no event. |
| `SetAgentEnabled`      | `agents.AgentEnabled` or `agents.AgentDisabled` | On needs an active version. The value that the agent has already gives no event.                                     |

- `prompt` (`promptId`, `version`) is not checked against prompt-studio.
  The domain has no I/O, and agent-manager has no network path to
  prompt-studio. Orchestration reads the prompt version when it runs the
  agent.
- `models` is the default model first, then the fallback chain (1 to 5,
  each model once). ai-proxy uses it in this order.
- projections builds the agent list from the same events with the same
  rules: `enabled` is `false` after `AgentCreated`.

## Seeds

At each start, after the migrations and before the server listens, the
service adds the seed agents that are not there. A seed is one append with
`expectedVersion: 0` of four events: `AgentCreated`,
`AgentVersionPublished` (version 1), `AgentVersionActivated` (1) and
`AgentEnabled`. The actor is `{ kind: "system", id: "agent-manager" }`.
The service checks the stream first, so it does not use the `commands`
TTL. Two pods that start at the same time: one append wins, the other gets
a conflict, skips the seed and writes a warn log with the agent name. A
seed never changes an agent that exists.
To change a seed agent, publish and activate a new version.

The ids are fixed, UUID v4 in form, and the same in prompt-studio:

| Agent          | `agentId`                              | Prompt `promptId` (version 1)          |
| -------------- | -------------------------------------- | -------------------------------------- |
| `orchestrator` | `00000000-0000-4000-8000-00000000a001` | `a0d53ff1-1eda-4636-bb2f-880df141bcb9` |
| `writer`       | `00000000-0000-4000-8000-00000000a002` | `cc74090a-534e-4072-8bfd-e6c5b9f22f41` |

Both seeds have the same model chain and limits:

| Field    | Value                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------- |
| `models` | `google/gemini-2.5-flash-lite`, `openai/gpt-4.1-nano`, `mistralai/mistral-small-3.2-24b-instruct` |
| `limits` | `maxCalls` 10, `maxTokens` 4096, `maxCostMicroUsd` 50000 (0.05 USD for each task)                 |

`maxCostMicroUsd` is the allowance of the agent for one task, not a limit
for each call (ADR 0027). Orchestration (task M2-06) sends the rest of the
allowance as `CallRequested.maxCostMicroUsd`. 50000 micro-USD is about 12
calls at the worst case of 0.004 USD each, so `maxCalls` 10 stops a task
first.

## API

| Method | Path                                            | Auth                 | Does                                                    |
| ------ | ----------------------------------------------- | -------------------- | ------------------------------------------------------- |
| POST   | `/internal/commands/create-agent`               | owner token          | `CreateAgent`                                           |
| POST   | `/internal/commands/publish-agent-version`      | owner token          | `PublishAgentVersion`                                   |
| POST   | `/internal/commands/activate-agent-version`     | owner token          | `ActivateAgentVersion`                                  |
| POST   | `/internal/commands/set-agent-enabled`          | owner token          | `SetAgentEnabled`                                       |
| GET    | `/internal/agents/by-name/:name/active-version` | none (NetworkPolicy) | `ActiveAgentVersionResultV1` for a name                 |
| GET    | `/internal/events?afterPosition=<n>&limit=<m>`  | none (NetworkPolicy) | Replay API: all events in position order                |
| GET    | `/health`, `/ready`, `/metrics`                 | none                 | Liveness, readiness (`mongo`, `migrations`), Prometheus |

Errors are RFC 9457 problem JSON with a `code` (`@famashines/ai-systems-kit/http`).

### Callers and trust

A NetworkPolicy is L4: it limits pod and port, not the caller. So the
service does not trust `actor.kind` `owner` in the body (ADR 0028,
M2-17). A hook of `kit/auth` checks each request on
`/internal/commands/*`: `Authorization: Bearer <access token>` with the
role `owner`, issuer `OIDC_ISSUER`, audience `OIDC_AUDIENCE` and `exp`.
The `actor.id` of the command must be the `sub` of the token. The hook
is only on `/internal/commands/*`. The read and replay routes stay open
to the callers that the network lets in.

| Caller        | Paths                                               | Token                    |
| ------------- | --------------------------------------------------- | ------------------------ |
| api-gateway   | `POST /internal/commands/*`                         | Forwards the owner token |
| orchestration | `GET /internal/agents/by-name/:name/active-version` | None                     |
| projections   | `GET /internal/events`                              | None                     |
| Prometheus    | `GET /metrics`                                      | None                     |

api-gateway has no agent command routes yet, so no caller sends commands
today. Its routes must forward the `Authorization` header of the owner.

### Commands

The request needs an owner bearer token (see "Callers and trust"). The
body is a `CommandEnvelopeV1` with the payload schema of contracts:

```json
{
  "commandId": "6f1c2b9e-1d1a-4c55-9b0e-3a7f0d5e8c21",
  "type": "agents.PublishAgentVersion",
  "actor": { "kind": "owner", "id": "<sub of the token>" },
  "expectedVersion": 3,
  "payload": {
    "agentId": "00000000-0000-4000-8000-00000000a002",
    "prompt": { "promptId": "cc74090a-534e-4072-8bfd-e6c5b9f22f41", "version": 2 },
    "models": ["google/gemini-2.5-flash-lite", "openai/gpt-4.1-nano"],
    "limits": { "maxCalls": 10, "maxTokens": 4096, "maxCostMicroUsd": 20000 }
  }
}
```

| Path                     | `type`                        | Payload                                |
| ------------------------ | ----------------------------- | -------------------------------------- |
| `create-agent`           | `agents.CreateAgent`          | `CreateAgentCommandPayloadV1`          |
| `publish-agent-version`  | `agents.PublishAgentVersion`  | `PublishAgentVersionCommandPayloadV1`  |
| `activate-agent-version` | `agents.ActivateAgentVersion` | `ActivateAgentVersionCommandPayloadV1` |
| `set-agent-enabled`      | `agents.SetAgentEnabled`      | `SetAgentEnabledCommandPayloadV1`      |

- `commandId` is the idempotency key (api-gateway takes it from the
  `Idempotency-Key` header). The same `commandId` again gives the first
  answer with 200 and writes nothing.
- `actor.kind` must be `owner`. `actor.id` must be the `sub` of the
  token (api-gateway sets it so).
- `expectedVersion` is optional. For `create-agent` it can only be `0`
  (else 400). The service always decides on the stream that it read and
  appends with that version, so a change between the read and the append
  gives 409. If `expectedVersion` is not the version that it read, the
  service first looks up the `commandId`: a known `commandId` gives the
  first answer with 200 (a retry with an old `expectedVersion`), else the
  answer is 409 and the service writes nothing.
- Events have `correlationId` and `causationId` = the `commandId`, and the
  `actor` of the command.

The answer is `{ agentId, version }`, where `version` is the version of
the stream (for the next `expectedVersion`). Publish also gives
`agentVersion`, the new agent version number.

| Status | When                                                                    |
| ------ | ----------------------------------------------------------------------- |
| 201    | Create or publish: a new agent or version                               |
| 200    | Activate or enable; or the same `commandId` came before                 |
| 400    | The body is not valid (problem JSON with `errors`: paths, never values) |
| 401    | No token, or a token that is not valid                                  |
| 403    | No `owner` role, or `actor.id` is not the `sub` of the token            |
| 404    | The agent or the agent version does not exist                           |
| 409    | The name exists, the stream changed, or on with no active version       |
| 503    | MongoDB does not answer, or Keycloak cannot be read                     |

### `GET /internal/agents/by-name/:name/active-version`

The read of orchestration (contracts README, Reads). `name` is an
`AgentName`. The answer is `ActiveAgentVersionResultV1`: the payload of the
active `AgentVersionPublished`, with `name` and `enabled`. A disabled agent
gives 200 with `enabled: false`; the caller decides. An unknown name, or an
agent with no active version, gives 404. The read uses the event stream,
so it is strongly consistent with the commands.

The read and the replay API have no token check. The NetworkPolicy of
the service lets only orchestration and projections call them.

## Data

| Collection               | Content                                                                |
| ------------------------ | ---------------------------------------------------------------------- |
| `events`                 | the kit event store and outbox, streams `agent-<agentId>`              |
| `commands`               | command ids and answers, TTL 45 days (kit)                             |
| `agent_names`            | `{ _id: name, agentId }`, written in the transaction of `AgentCreated` |
| `counters`, `migrations` | kit                                                                    |

`agent_names` makes the name unique (a duplicate `_id` gives 409) and maps
a name to its agent. It is not a projection: it changes only with
`AgentCreated`, and there is no rename.

## Known limits

- The same `commandId` with another body, or on another command route,
  gives the first answer. The kit stores the answer of a command but no
  hash of its body. A later kit version can store a hash and give 409.
- The JWKS comes over plain HTTP inside the cluster (ARCHITECTURE 11.1,
  accepted).
- The `commandId` lookup for a wrong `expectedVersion` is an append with
  `expectedVersion: -1` and no events. The kit checks the `commandId`
  before the version, so a known `commandId` gives its answer, and every
  other case fails the version check and writes nothing.

## Configuration

Environment variables (`.env.example` has all of them):

| Variable                                                            | Default                                         | Content                                   |
| ------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------- |
| `MONGODB_URI`                                                       | required                                        | MongoDB connection string (replica set)   |
| `MONGODB_DATABASE`                                                  | `agent_manager`                                 | Database name                             |
| `NATS_SERVERS`                                                      | required                                        | NATS URLs, comma-separated; at least one  |
| `NATS_USER`                                                         | required                                        | `ai-systems-agent-manager` on the cluster |
| `NATS_PASSWORD`                                                     | required                                        | From the SealedSecret                     |
| `OIDC_ISSUER`                                                       | `https://auth.famashines.com/realms/ai-systems` | Keycloak realm                            |
| `OIDC_JWKS_URL`                                                     | `<issuer>/protocol/openid-connect/certs`        | JWKS inside the cluster                   |
| `OIDC_AUDIENCE`                                                     | `ai-systems-app`                                | Audience and `azp` of the token           |
| `PORT`                                                              | `8080`                                          | HTTP port                                 |
| `LOG_LEVEL`                                                         | `info`                                          | pino level                                |
| `RELEASE`                                                           | `local`                                         | Release id in logs and metrics            |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | not set                                         | Traces go over OTLP only when one is set  |

A bad value stops the process at start with the variable name. An empty
value is a value: delete the line to get the default. The kit service name
is fixed to `agent-manager`, so the NATS inbox prefix is
`_INBOX_agent-manager` and the grants of ADR 0023 apply: publish
`agents.>`, `dlq.agent-manager.>`, `$JS.API.INFO`,
`$JS.API.STREAM.INFO.AGENTS`; subscribe `_INBOX_agent-manager.>`.

Deploy: set `OIDC_JWKS_URL` to the Keycloak service inside the cluster,
and add a NetworkPolicy egress from agent-manager to Keycloak on port
8080 for the JWKS, as for budget. Keycloak is not a readiness check:
when the JWKS cannot be read, a command gets 503.

At start the service connects to MongoDB, runs the migration
`000-event-store`, adds the seeds, connects to NATS, starts the relay, and
listens. A SIGTERM or SIGINT before the server listens stops the process at
once with exit code 143. After that, the graceful shutdown of `kit/http`
applies.

NATS and the relay are not readiness checks (ARCHITECTURE 14). When NATS
is down or the stream `AGENTS` does not exist, the service still takes
commands, and the events wait in the outbox. The service does not make
streams: the gitops stream Job makes `AGENTS`. A stuck relay shows in the
metrics `outbox_oldest_pending_seconds` and `outbox_publish_failures_total`.
NATS must be available at start, because the kit waits for the first NATS
connection.

## Run locally

Node 26 (`nvm use`), a MongoDB replica set, NATS with JetStream and the
stream `AGENTS`. The `compose.yaml` in `ai-systems-kit`
starts them.

```sh
npm ci
cp .env.example .env
node --env-file=.env src/main.ts
```

In `.env`, fill in the required values and delete the lines that you do
not set.

## Container image

```sh
docker build --build-arg RELEASE=$(git rev-parse HEAD) -t ai-systems-agent-manager .
```

Node 26 slim, pinned by digest, with no npm, no npx and no test packages.
The entrypoint is `node src/main.ts` as uid 1000. It writes nothing to
disk, so a read-only root file system works.

Release: when `ci` passes on a push to `main`, `.github/workflows/release.yml`
builds the image, makes a CycloneDX SBOM, scans the image with grype,
pushes `ghcr.io/famashines/ai-systems-agent-manager:sha-<commit>`, and
opens or updates the pull request from the branch
`release/ai-systems-agent-manager-prod` in `famashines/gitops`. The owner
merges it. The job needs the org secret `GITOPS_TOKEN` with access to this
repo, and the gitops app `kubernetes/ai-systems/ai-systems-agent-manager/prod`
(task M2-09).

## Test

| Command                    | Does                                                 |
| -------------------------- | ---------------------------------------------------- |
| `npm run verify`           | type check, lint, unit tests with the coverage gates |
| `npm run test:integration` | MongoDB and NATS in Testcontainers (needs Docker)    |

The integration test uses the NATS grants of the user
`ai-systems-agent-manager` from gitops, an admin user that makes the
stream. Commands for agents:
`CLAUDE.md`.
