# Changelog

## Unreleased

- `/internal/commands/*` needs an owner bearer token (M2-17, ADR 0028).
  A path-scoped `kit/auth` hook checks the role `owner`, the issuer, the
  audience and `exp`: no token or a bad token gives 401, no `owner` role
  gives 403. The `actor.id` of the command must be the `sub` of the token,
  else 403. The active version read, the replay API, `/health`, `/ready`
  and `/metrics` need no token.
- New env: `OIDC_ISSUER`, `OIDC_JWKS_URL`, `OIDC_AUDIENCE` (the same as
  budget).

## 0.1.0

- Agent aggregate on the stream `agent-<agentId>`: `CreateAgent`,
  `PublishAgentVersion`, `ActivateAgentVersion`, `SetAgentEnabled` give the
  `agents.*` events of contracts v0.3.0 (schema version 1). A rollback is an
  activation of an older version.
- Owner commands on `POST /internal/commands/<name>`: only an `owner`
  actor (api-gateway checks the token), command idempotency by
  `commandId`.
- `GET /internal/agents/by-name/:name/active-version`: the
  `ActiveAgentVersionResultV1` for orchestration.
- `GET /internal/events`: the replay API in position order.
- Unique agent names in the collection `agent_names`, written in the
  transaction of `AgentCreated`.
- Seeds at start: the agents `orchestrator` and `writer`, version 1,
  active and enabled, with fixed ids and a task allowance of 0.05 USD.
  A seed that a conflict skips gives a warn log.
- A wrong `expectedVersion` gives the first answer for a known
  `commandId`, else 409 with no write. The decision always uses the
  version that the service read.
- Outbox relay to the stream `AGENTS`, `/health`, `/ready`, `/metrics`.
- Container image and release workflow as in orchestration.
