import { createHash } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  BlobStore,
  BlobTooLargeError,
  InsufficientStorageError,
  InvalidStorageKeyError,
} from "../../../server/modules/resources/blob-store.js";

const temporaryRoots: string[] = [];

async function createStore(
  maxUploadBytes = 1_024,
  options: ConstructorParameters<typeof BlobStore>[0] extends infer T
    ? Partial<Omit<T, "rootPath" | "maxUploadBytes">>
    : never = {},
): Promise<{ rootPath: string; store: BlobStore }> {
  const parent = await mkdtemp(path.join(tmpdir(), "blob-store-test-"));
  temporaryRoots.push(parent);
  const rootPath = path.join(parent, "nested", "uploads");
  const store = new BlobStore({ rootPath, maxUploadBytes, ...options });
  return { rootPath, store };
}

async function streamText(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("BlobStore", () => {
  it("initializes writable root and temporary directories", async () => {
    const { rootPath, store } = await createStore();

    await store.initialize();

    expect(await readdir(rootPath)).toEqual([".tmp"]);
    expect(await readdir(path.join(rootPath, ".tmp"))).toEqual([]);
  });

  it("streams a blob to a random key while counting bytes and hashing", async () => {
    const { rootPath, store } = await createStore();
    const content = Buffer.from("research payload", "utf8");

    const result = await store.write(Readable.from([content.subarray(0, 4), content.subarray(4)]));

    expect(result.storageKey).toMatch(/^[0-9a-f]{64}$/);
    expect(result.byteSize).toBe(content.byteLength);
    expect(result.sha256).toBe(createHash("sha256").update(content).digest("hex"));
    expect(await readFile(store.readPath(result.storageKey))).toEqual(content);
    expect(path.dirname(store.readPath(result.storageKey))).toBe(path.resolve(rootPath));
    expect(await readdir(path.join(rootPath, ".tmp"))).toEqual([]);
  });

  it("generates a fresh random storage key for identical content", async () => {
    const { store } = await createStore();

    const first = await store.write(Readable.from("same"));
    const second = await store.write(Readable.from("same"));

    expect(first.storageKey).not.toBe(second.storageKey);
    expect(first.sha256).toBe(second.sha256);
  });

  it("allows the exact byte limit and rejects one byte over it", async () => {
    const { rootPath, store } = await createStore(4);

    const accepted = await store.write(Readable.from(Buffer.from("1234")));
    await expect(
      store.write(Readable.from(Buffer.from("12345"))),
    ).rejects.toBeInstanceOf(BlobTooLargeError);

    expect(await readFile(store.readPath(accepted.storageKey), "utf8")).toBe(
      "1234",
    );
    expect(await readdir(path.join(rootPath, ".tmp"))).toEqual([]);
    expect((await readdir(rootPath)).filter((name) => name !== ".tmp")).toEqual([
      accepted.storageKey,
    ]);
  });

  it("cleans temporary files when the source stream is interrupted", async () => {
    const { rootPath, store } = await createStore();
    const interrupted = new Readable({
      read() {
        this.push("partial");
        this.destroy(new Error("source interrupted"));
      },
    });

    await expect(store.write(interrupted)).rejects.toThrow(
      "source interrupted",
    );
    expect(await readdir(path.join(rootPath, ".tmp"))).toEqual([]);
    expect((await readdir(rootPath)).filter((name) => name !== ".tmp")).toEqual(
      [],
    );
  });

  it("checks free space before consuming the upload stream", async () => {
    let streamRead = false;
    const { store } = await createStore(8, {
      statfs: () => ({ bavail: 1n, bsize: 4n }),
    });
    const source = new Readable({
      read() {
        streamRead = true;
        this.push("payload");
        this.push(null);
      },
    });

    await expect(store.write(source)).rejects.toBeInstanceOf(
      InsufficientStorageError,
    );
    expect(streamRead).toBe(false);
  });

  it("reports available space and permits an exact preflight boundary", async () => {
    const { store } = await createStore(8, {
      statfs: () => ({ bavail: 2n, bsize: 4n }),
    });

    await store.initialize();

    expect(store.availableBytes()).toBe(8n);
    expect(() => store.assertSufficientSpace()).not.toThrow();
    await expect(store.write(Readable.from("12345678"))).resolves.toMatchObject({
      byteSize: 8,
    });
  });

  it.each([
    "../outside",
    "..\\outside",
    ".tmp/file",
    "A".repeat(64),
    "a".repeat(63),
    `${"a".repeat(64)}.part`,
  ])("rejects invalid storage key %s", async (storageKey) => {
    const { store } = await createStore();
    await store.initialize();

    expect(() => store.readPath(storageKey)).toThrow(InvalidStorageKeyError);
    expect(() => store.open(storageKey)).toThrow(InvalidStorageKeyError);
    await expect(store.delete(storageKey)).rejects.toBeInstanceOf(
      InvalidStorageKeyError,
    );
  });

  it("opens stored content and deletes it idempotently", async () => {
    const { store } = await createStore();
    const written = await store.write(Readable.from("download me"));

    await expect(streamText(store.open(written.storageKey))).resolves.toBe(
      "download me",
    );
    await expect(store.delete(written.storageKey)).resolves.toBe(true);
    await expect(store.delete(written.storageKey)).resolves.toBe(false);
    await expect(
      readFile(store.readPath(written.storageKey)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
