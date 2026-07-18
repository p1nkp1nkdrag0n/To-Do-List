import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseConfig, type AppConfig } from "./config/env.js";
import { openV2Database, type V2Database } from "./db/database.js";
import { migrateV2Database } from "./db/migrations.js";
import { createV2App } from "./http/app.js";
import { defaultV2Logger, resolveDependencies } from "./http/dependencies.js";
import type { V2Logger } from "./http/errors.js";
import {
  ATTEMPT_HOUSEKEEPING_INTERVAL_MS,
  type IntervalScheduler,
  purgeStaleAttempts,
  systemIntervalScheduler,
} from "./modules/attempt-housekeeping.js";
import { BlobStore } from "./modules/resources/blob-store.js";
import { purgeExpiredTrash } from "./modules/trash-housekeeping.js";
import { recoverInterruptedRestore } from "./modules/backups/restore-service.js";
import {
  acquireDeploymentLock,
  type DeploymentLockRelease,
} from "./modules/deployment-lock.js";
import { CollaborationHub } from "./realtime/collaboration-hub.js";

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
  realtimeLockTtlMs?: number;
  realtimeSweepIntervalMs?: number;
  realtimePreviewThrottleMs?: number;
  staticPath?: string | null;
}

export async function startV2Server(
  config: AppConfig = parseConfig(),
  options: V2ServerOptions = {},
): Promise<V2ServerHandle> {
  const clock = options.clock ?? (() => new Date());
  const logger = options.logger ?? defaultV2Logger;
  let releaseDeploymentLock: DeploymentLockRelease | undefined;
  let database: V2Database | undefined;
  const blobStore = new BlobStore({
    rootPath: config.uploadPath,
    maxUploadBytes: config.maxUploadBytes,
  });
  try {
    releaseDeploymentLock = await acquireDeploymentLock(config.dbPath);
    await recoverInterruptedRestore({
      databasePath: config.dbPath,
      uploadPath: config.uploadPath,
    });
    database = openV2Database(config.dbPath);
    migrateV2Database(database);
    purgeStaleAttempts(database, clock());
    await blobStore.initialize();
    blobStore.assertSufficientSpace();
    await purgeExpiredTrash({
      database,
      blobStore,
      clock,
      idGenerator: randomUUID,
    });
  } catch (error) {
    database?.close();
    await releaseDeploymentLock?.();
    throw error;
  }
  if (database === undefined || releaseDeploymentLock === undefined) {
    throw new Error("The v2 deployment did not finish initialization.");
  }

  const closeDatabaseAndRelease = async (): Promise<void> => {
    try {
      database.close();
    } finally {
      await releaseDeploymentLock();
    }
  };

  const appDependencies = resolveDependencies({
    database,
    sessionSecret: config.sessionSecret,
    cookieSecure: config.cookieSecure,
    bootstrapCode: config.bootstrapCode,
    uploadPath: config.uploadPath,
    maxUploadBytes: config.maxUploadBytes,
    blobStore,
    trustProxyHops: config.trustProxyHops,
    clock,
    logger,
  });
  let collaborationHub: CollaborationHub | undefined;
  const staticPath = options.staticPath === null
    ? undefined
    : options.staticPath
      ?? (config.environment === "production" ? path.resolve(process.cwd(), "dist") : undefined);
  const server = createServer(
    createV2App(
      {
        ...appDependencies,
        publishEntityInvalidation: (projectId, entityType, entityId) =>
          collaborationHub?.publishEntityInvalidation(projectId, entityType, entityId),
      },
      { staticPath },
    ),
  );
  collaborationHub = new CollaborationHub(server, appDependencies, {
    lockTtlMs: options.realtimeLockTtlMs,
    sweepIntervalMs: options.realtimeSweepIntervalMs,
    previewThrottleMs: options.realtimePreviewThrottleMs,
  });
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
    await collaborationHub.close();
    await closeDatabaseAndRelease();
    throw error;
  }

  const address = server.address();
  if (address === null || typeof address === "string") {
    await collaborationHub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDatabaseAndRelease();
    throw new Error("The v2 server did not expose a TCP address.");
  }

  const intervalScheduler =
    options.intervalScheduler ?? systemIntervalScheduler;
  let trashHousekeepingPromise: Promise<void> | undefined;
  const runTrashHousekeeping = (): void => {
    if (trashHousekeepingPromise !== undefined) return;
    trashHousekeepingPromise = purgeExpiredTrash({
      database,
      blobStore,
      clock,
      idGenerator: randomUUID,
    })
      .then(() => undefined)
      .catch((error: unknown) => {
        logger.error(error, {
          method: "INTERNAL",
          path: "trash_housekeeping",
        });
      })
      .finally(() => {
        trashHousekeepingPromise = undefined;
      });
  };
  const housekeeping = intervalScheduler.schedule(
    () => {
      try {
        purgeStaleAttempts(database, clock());
        runTrashHousekeeping();
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
        try {
          await collaborationHub.close();
          await new Promise<void>((resolve, reject) => {
            server.close((error) =>
              error === undefined ? resolve() : reject(error),
            );
          });
        } finally {
          await trashHousekeepingPromise;
        }
      } finally {
        await closeDatabaseAndRelease();
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
