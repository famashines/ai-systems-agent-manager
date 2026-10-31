import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ConfigError, loadConfig } from "@famashines/ai-systems-kit/config";
import { ConcurrencyError } from "@famashines/ai-systems-kit/event-store";
import { createService, UnavailableError } from "@famashines/ai-systems-kit/http";
import { createLogger } from "@famashines/ai-systems-kit/observability";
import { MongoNetworkError, MongoServerSelectionError } from "mongodb";
import { routes, toHttpError } from "../../src/adapters/http.ts";
import { seed } from "../../src/application/seed.ts";
import { envSchema } from "../../src/main.ts";

const down = (): Promise<never> =>
  Promise.reject(new MongoServerSelectionError("no primary at mongo-0:27017", {} as never));

const store = { append: down, readStream: down, readAll: down };
const names = { claim: down, find: down };
const newId = () => "00000000-0000-4000-8000-000000000001";
const app = createService({
  logger: createLogger({ service: "agent-manager", release: "test", level: "silent" }),
  routes: routes({ store, names, newId }),
  drainDelayMs: 0,
});
let base: string;

before(async () => {
  const { port } = await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${String(port)}`;
});

after(async () => {
  await app.close();
});

test("the reads give 503 with no detail when MongoDB is down", async () => {
  for (const path of ["/internal/events", "/internal/agents/by-name/writer/active-version"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.equal((JSON.parse(text) as { code: string }).code, "unavailable");
    assert.ok(!text.includes("mongo-0"));
  }
});

test("toHttpError maps the database errors and keeps the others", () => {
  assert.ok(toHttpError(new MongoNetworkError("connection closed")) instanceof UnavailableError);
  const other = new Error("bug");
  assert.equal(toHttpError(other), other);
});

test("the seed skips a seed that another pod wrote at the same time", async () => {
  const racing = {
    store: {
      append: () => Promise.reject(new ConcurrencyError()),
      readStream: () => Promise.resolve([]),
      readAll: down,
    },
    names,
    newId,
  };
  const warned: unknown[] = [];
  const logger = { warn: (details: object) => warned.push(details) };
  assert.deepEqual(await seed(racing, logger), []);
  assert.deepEqual(
    warned.map((details) => (details as { agent: string }).agent),
    ["orchestrator", "writer"],
  );
});

test("the seed stops on a database error", async () => {
  await assert.rejects(
    seed({ store, names, newId }, { warn: () => undefined }),
    MongoServerSelectionError,
  );
});

const env = {
  MONGODB_URI: "mongodb://mongo:27017/?replicaSet=rs0",
  NATS_USER: "ai-systems-agent-manager",
  NATS_PASSWORD: "secret",
};

test("the config has the defaults and trims NATS_SERVERS", () => {
  const config = loadConfig(envSchema, {
    ...env,
    NATS_SERVERS: " nats://a:4222 ,, nats://b:4222,",
  });
  assert.deepEqual(config.NATS_SERVERS, ["nats://a:4222", "nats://b:4222"]);
  assert.equal(config.MONGODB_DATABASE, "agent_manager");
});

for (const [name, value] of [
  ["NATS_SERVERS", " , ,"],
  ["MONGODB_URI", ""],
] as const) {
  test(`${name} "${value}" is refused`, () => {
    assert.throws(
      () => loadConfig(envSchema, { NATS_SERVERS: "nats://a:4222", ...env, [name]: value }),
      ConfigError,
    );
  });
}
