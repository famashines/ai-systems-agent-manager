# Changelog

## Unreleased

- `GET /internal/agents/:agentId/active-version`: the same
  `ActiveAgentVersionResultV1` as the read by name, for an agent id. No
  token (the same as the read by name). A bad id gives 400. An unknown
  agent or an agent with no active version gives 404.
- `/internal/commands/*` needs an owner bearer token (M2-17, ADR 0028).
  The command route factory checks the token with `bearerHook` of
  `kit/auth` before it reads the body, as budget does: role `owner`,
  issuer, audience and `exp`. No token or a bad token gives 401, no
  `owner` role gives 403. A path with empty segments
  (`//internal/commands/...`) gets the same check. The `actor.id` of the command must be the `sub` of the token,
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
