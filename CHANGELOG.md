# Changelog

## 0.1.0

- Agent aggregate on the stream `agent-<agentId>`: `CreateAgent`,
  `PublishAgentVersion`, `ActivateAgentVersion`, `SetAgentEnabled` give the
  `agents.*` events of contracts v0.3.0 (schema version 1). A rollback is an
  activation of an older version.
- Owner commands on `POST /internal/commands/<name>`: a bearer token with
  the realm role `owner` (kit/auth), the actor id must be the token
  subject, command idempotency by `commandId`.
- `GET /internal/agents/by-name/:name/active-version`: the
  `ActiveAgentVersionResultV1` for orchestration.
- `GET /internal/events`: the replay API in position order.
- Unique agent names in the collection `agent_names`, written in the
  transaction of `AgentCreated`.
- Seeds at start: the agents `orchestrator` and `writer`, version 1,
  active and enabled, with fixed ids.
- Outbox relay to the stream `AGENTS`, `/health`, `/ready`, `/metrics`.
- Container image and release workflow as in orchestration.
