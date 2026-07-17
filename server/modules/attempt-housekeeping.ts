import type { V2Database } from "../db/database.js";

export const ATTEMPT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const REGISTRATION_HASH_RESERVATION_TIMEOUT_MS = 5 * 60 * 1000;
export const ATTEMPT_HOUSEKEEPING_INTERVAL_MS = 60 * 60 * 1000;

export interface IntervalSubscription {
  cancel(): void;
}

export interface IntervalScheduler {
  schedule(operation: () => void, intervalMs: number): IntervalSubscription;
}

export const systemIntervalScheduler: IntervalScheduler = {
  schedule(operation, intervalMs) {
    const timer = setInterval(operation, intervalMs);
    timer.unref();
    return { cancel: () => clearInterval(timer) };
  },
};

export function purgeStaleAttempts(database: V2Database, now: Date): void {
  const cutoff = new Date(now.getTime() - ATTEMPT_RETENTION_MS).toISOString();
  const registrationCutoff = new Date(
    now.getTime() - REGISTRATION_HASH_RESERVATION_TIMEOUT_MS,
  ).toISOString();
  database.transaction(() => {
    database.run("DELETE FROM auth_attempts WHERE attempted_at < ?", [cutoff]);
    database.run(
      "DELETE FROM project_invite_attempts WHERE attempted_at < ?",
      [cutoff],
    );
    database.run(
      "DELETE FROM registration_hash_reservations WHERE reserved_at < ?",
      [registrationCutoff],
    );
  });
}
