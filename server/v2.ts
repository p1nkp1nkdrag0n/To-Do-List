import { createServer, type Server } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseConfig, type AppConfig } from "./config/env.js";
import { openV2Database, type V2Database } from "./db/database.js";
import { migrateV2Database } from "./db/migrations.js";
import { createV2App } from "./http/app.js";
import { defaultV2Logger } from "./http/dependencies.js";
import type { V2Logger } from "./http/errors.js";
import {
  ATTEMPT_HOUSEKEEPING_INTERVAL_MS,
  type IntervalScheduler,
  purgeStaleAttempts,
  systemIntervalScheduler,
} from "./modules/attempt-housekeeping.js";

export interface V2ServerHandle {
  server: Server;
  database: V2Database;
  url: string;
  close: () => Promise<void>;
}

export interface V2ServerOptions {
  clock?: () => Date;
  intervalScheduler?: IntervalScheduler;
  attemptHousekeepingIntervalMs?: number;
  logger?: V2Logger;
}

export async function startV2Server(
  config: AppConfig = parseConfig(),
  options: V2ServerOptions = {},
): Promise<V2ServerHandle> {
  const clock = options.clock ?? (() => new Date());
  const logger = options.logger ?? defaultV2Logger;
  const database = openV2Database(config.dbPath);
  try {
    migrateV2Database(database);
    purgeStaleAttempts(database, clock());
  } catch (error) {
    database.close();
    throw error;
  }

  const server = createServer(
    createV2App({
      database,
      sessionSecret: config.sessionSecret,
      cookieSecure: config.cookieSecure,
      bootstrapCode: config.bootstrapCode,
      trustProxyHops: config.trustProxyHops,
      clock,
      logger,
    }),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(config.port, config.host, () => {
        server.off("error", onError);
        resolve();
      });
    });
  } catch (error) {
    database.close();
    throw error;
  }

  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
    throw new Error("The v2 server did not expose a TCP address.");
  }

  const intervalScheduler =
    options.intervalScheduler ?? systemIntervalScheduler;
  const housekeeping = intervalScheduler.schedule(
    () => {
      try {
        purgeStaleAttempts(database, clock());
      } catch (error) {
        logger.error(error, {
          method: "INTERNAL",
          path: "attempt_housekeeping",
        });
      }
    },
    options.attemptHousekeepingIntervalMs ??
      ATTEMPT_HOUSEKEEPING_INTERVAL_MS,
  );

  let closingPromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closingPromise !== undefined) {
      return closingPromise;
    }
    closingPromise = (async () => {
      try {
        housekeeping.cancel();
        await new Promise<void>((resolve, reject) => {
          server.close((error) =>
            error === undefined ? resolve() : reject(error),
          );
        });
      } finally {
        database.close();
      }
    })();
    return closingPromise;
  };

  return {
    server,
    database,
    url: `http://${config.host}:${address.port}`,
    close,
  };
}

const entrypointUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;

if (entrypointUrl === import.meta.url) {
  void startV2Server()
    .then((handle) => {
      console.log(`v2 API listening at ${handle.url}`);
      const shutdown = (): void => {
        void handle.close().then(() => process.exit(0));
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
