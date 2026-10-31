import { randomUUID } from "node:crypto";
import { createJwtVerifier } from "@famashines/ai-systems-kit/auth";
import { commonEnv, loadConfig } from "@famashines/ai-systems-kit/config";
import { createEventStore, eventStoreMigration } from "@famashines/ai-systems-kit/event-store";
import { createService } from "@famashines/ai-systems-kit/http";
import { connectNats, startRelay } from "@famashines/ai-systems-kit/messaging";
import { connectMongo, runMigrations } from "@famashines/ai-systems-kit/mongo";
import { createLogger, startTelemetry } from "@famashines/ai-systems-kit/observability";
import { z } from "zod";
import { routes } from "./adapters/http.ts";
import { mongoNames } from "./adapters/names.ts";
import { seed } from "./application/seed.ts";

export const service = "agent-manager";

const httpUrl = z.url({ protocol: /^https?$/ });

export const envSchema = commonEnv.omit({ SERVICE_NAME: true }).extend({
  MONGODB_URI: z.string().min(1),
  MONGODB_DATABASE: z.string().min(1).default("agent_manager"),
  NATS_SERVERS: z
    .string()
    .min(1)
    .transform((value) =>
      value
        .split(",")
        .map((server) => server.trim())
        .filter((server) => server !== ""),
    )
    .pipe(z.array(z.string()).min(1)),
  NATS_USER: z.string().min(1),
  NATS_PASSWORD: z.string().min(1),
  OIDC_ISSUER: httpUrl.default("https://auth.famashines.com/realms/ai-systems"),
  OIDC_JWKS_URL: httpUrl.optional(),
  OIDC_AUDIENCE: z.string().min(1).default("ai-systems-app"),
  REQUIRED_ROLE: z.string().min(1).default("owner"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.url().optional(),
});

export type Config = z.output<typeof envSchema>;

export async function start(config: Readonly<Config>, options: { drainDelayMs?: number } = {}) {
  const release = config.RELEASE;
  const telemetry = startTelemetry({ serviceName: service, release });
  const logger = createLogger({ service, release, level: config.LOG_LEVEL });
  logger.info("connecting to MongoDB");
  const mongo = await connectMongo({
    url: config.MONGODB_URI,
    database: config.MONGODB_DATABASE,
    clientOptions: { serverSelectionTimeoutMS: 5000 },
  });
  const migrations = [eventStoreMigration];
  await runMigrations(mongo.db, migrations);
  const deps = {
    store: createEventStore(mongo.db),
    names: mongoNames(mongo.db),
    newId: randomUUID,
  };
  const added = await seed(deps);
  if (added.length > 0) logger.info({ agents: added }, "seed agents added");
  logger.info("connecting to NATS");
  const nats = await connectNats({
    servers: config.NATS_SERVERS,
    user: config.NATS_USER,
    pass: config.NATS_PASSWORD,
    service,
    logger,
  });
  const relay = startRelay({ store: deps.store, nats, streams: ["AGENTS"] });
  const verify = createJwtVerifier({
    issuer: config.OIDC_ISSUER,
    audience: config.OIDC_AUDIENCE,
    requiredRole: config.REQUIRED_ROLE,
    ...(config.OIDC_JWKS_URL === undefined ? {} : { jwksUrl: config.OIDC_JWKS_URL }),
    logger,
  });
  const app = createService({
    logger,
    routes: routes({ ...deps, verify }),
    readiness: {
      mongo: mongo.ready,
      migrations: async () =>
        (await mongo.db
          .collection<{ _id: string }>("migrations")
          .countDocuments({ _id: { $in: migrations.map((migration) => migration.name) } })) ===
        migrations.length,
    },
    metrics: telemetry.metricsHandler,
    closeHooks: [telemetry.shutdown, mongo.close, nats.close, relay.close],
    ...options,
  });
  const address = await app.listen(config.PORT);
  logger.info({ port: address.port }, "agent-manager started");
  return { app, address };
}

if (import.meta.main) {
  const exitEarly = (): never => process.exit(143);
  process.once("SIGTERM", exitEarly);
  process.once("SIGINT", exitEarly);
  const { app } = await start(loadConfig(envSchema));
  process.off("SIGTERM", exitEarly);
  process.off("SIGINT", exitEarly);
  app.handleSignals();
}
