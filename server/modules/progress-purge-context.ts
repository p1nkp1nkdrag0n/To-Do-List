import type { V2Database } from "../db/database.js";

export function withProgressPurgeContext<Result>(
  database: V2Database,
  participantIds: readonly string[],
  operation: () => Result,
): Result {
  const uniqueIds = [...new Set(participantIds)];
  for (const participantId of uniqueIds) {
    database.run(
      "INSERT INTO progress_purge_context (participant_id) VALUES (?)",
      [participantId],
    );
  }
  try {
    return operation();
  } finally {
    for (const participantId of uniqueIds) {
      database.run(
        "DELETE FROM progress_purge_context WHERE participant_id=?",
        [participantId],
      );
    }
  }
}
