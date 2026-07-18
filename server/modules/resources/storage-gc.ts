import type { V2RuntimeDependencies } from "../../http/dependencies.js";

type StorageGcDependencies = Pick<
  V2RuntimeDependencies,
  "database" | "blobStore" | "clock"
>;

export async function drainStorageGarbageQueue(
  dependencies: StorageGcDependencies,
): Promise<{ deleted: number; failed: number }> {
  const queued = dependencies.database.all<{ storage_key: string }>(
    "SELECT storage_key FROM storage_gc_queue ORDER BY enqueued_at",
  );
  let deleted = 0;
  let failed = 0;
  for (const { storage_key: storageKey } of queued) {
    try {
      await dependencies.blobStore.delete(storageKey);
      dependencies.database.run("DELETE FROM storage_gc_queue WHERE storage_key=?", [storageKey]);
      deleted += 1;
    } catch (error) {
      failed += 1;
      dependencies.database.run(
        `UPDATE storage_gc_queue SET attempts=attempts+1, last_attempt_at=?, last_error=?
          WHERE storage_key=?`,
        [
          dependencies.clock().toISOString(),
          error instanceof Error ? error.message.slice(0, 2_000) : "Unknown storage cleanup error",
          storageKey,
        ],
      );
    }
  }
  return { deleted, failed };
}
