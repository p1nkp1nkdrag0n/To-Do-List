import fs from "node:fs";
import path from "node:path";
import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementResultingChanges,
  type StatementSync,
} from "node:sqlite";
import { types as utilTypes } from "node:util";

export type SqlParameters =
  | readonly SQLInputValue[]
  | Record<string, SQLInputValue>;

export interface DatabaseOptions {
  busyTimeoutMs?: number;
}

function validateBusyTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("busyTimeoutMs must be a non-negative integer.");
  }
  return value;
}

function runStatement(
  statement: StatementSync,
  parameters: SqlParameters,
): StatementResultingChanges {
  return Array.isArray(parameters)
    ? statement.run(...parameters)
    : statement.run(parameters as Record<string, SQLInputValue>);
}

function getStatement(
  statement: StatementSync,
  parameters: SqlParameters,
): Record<string, SQLOutputValue> | undefined {
  return Array.isArray(parameters)
    ? statement.get(...parameters)
    : statement.get(parameters as Record<string, SQLInputValue>);
}

function allStatement(
  statement: StatementSync,
  parameters: SqlParameters,
): Record<string, SQLOutputValue>[] {
  return Array.isArray(parameters)
    ? statement.all(...parameters)
    : statement.all(parameters as Record<string, SQLInputValue>);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

const synchronousTransactionError =
  "Transaction callbacks must be synchronous and must not return Promise-like values.";

type SynchronousResultConstraint<Result> = [Result] extends [never]
  ? unknown
  : Result extends PromiseLike<unknown>
    ? never
    : unknown;

export class V2Database {
  readonly #database: DatabaseSync;
  #closed = false;
  #transactionActive = false;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  prepare(sql: string): StatementSync {
    return this.#database.prepare(sql);
  }

  exec(sql: string): void {
    this.#database.exec(sql);
  }

  run(
    sql: string,
    parameters: SqlParameters = [],
  ): StatementResultingChanges {
    return runStatement(this.prepare(sql), parameters);
  }

  get<Row extends Record<string, unknown>>(
    sql: string,
    parameters: SqlParameters = [],
  ): Row | undefined {
    return getStatement(this.prepare(sql), parameters) as Row | undefined;
  }

  all<Row extends Record<string, unknown>>(
    sql: string,
    parameters: SqlParameters = [],
  ): Row[] {
    return allStatement(this.prepare(sql), parameters) as Row[];
  }

  transaction<Result>(
    operation: (() => Result) & SynchronousResultConstraint<Result>,
  ): Result;
  transaction<Result>(operation: () => Result): Result {
    if (utilTypes.isAsyncFunction(operation)) {
      throw new TypeError(synchronousTransactionError);
    }
    if (this.#transactionActive) {
      throw new Error("Nested transactions are not supported.");
    }

    this.#database.exec("BEGIN IMMEDIATE");
    this.#transactionActive = true;
    try {
      const result = operation();
      if (isPromiseLike(result)) {
        throw new TypeError(synchronousTransactionError);
      }
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    } finally {
      this.#transactionActive = false;
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#database.close();
    this.#closed = true;
  }
}

export function openV2Database(
  databasePath: string,
  options: DatabaseOptions = {},
): V2Database {
  const busyTimeoutMs = validateBusyTimeout(options.busyTimeoutMs ?? 5_000);
  const isMemoryDatabase = databasePath === ":memory:";
  const resolvedPath = isMemoryDatabase
    ? databasePath
    : path.resolve(databasePath);

  if (!isMemoryDatabase) {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  }

  const nativeDatabase = new DatabaseSync(resolvedPath);
  const database = new V2Database(nativeDatabase);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    if (!isMemoryDatabase) {
      database.exec("PRAGMA journal_mode = WAL");
    }
    return database;
  } catch (error) {
    try {
      database.close();
    } catch {
      // Preserve the initialization error if cleanup also fails.
    }
    throw error;
  }
}
