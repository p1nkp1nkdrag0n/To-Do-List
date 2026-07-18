import { randomBytes, createHash } from "node:crypto";
import {
  constants,
  createReadStream,
  createWriteStream,
  statfsSync,
  type ReadStream,
} from "node:fs";
import {
  access,
  mkdir,
  open as openFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const STORAGE_KEY_PATTERN = /^[0-9a-f]{64}$/;

export interface BlobStoreFilesystemStats {
  bavail: number | bigint;
  bsize: number | bigint;
}

export interface BlobStoreOptions {
  rootPath: string;
  maxUploadBytes: number;
  statfs?: (rootPath: string) => BlobStoreFilesystemStats;
}

export interface StoredBlob {
  storageKey: string;
  byteSize: number;
  sha256: string;
}

export class InvalidStorageKeyError extends Error {
  readonly code = "INVALID_STORAGE_KEY";

  constructor() {
    super("Storage key must be exactly 64 lowercase hexadecimal characters.");
    this.name = "InvalidStorageKeyError";
  }
}

export class BlobTooLargeError extends Error {
  readonly code = "BLOB_TOO_LARGE";

  constructor(
    readonly maxUploadBytes: number,
    readonly observedBytes: number,
  ) {
    super(`Blob exceeds the ${maxUploadBytes}-byte upload limit.`);
    this.name = "BlobTooLargeError";
  }
}

export class InsufficientStorageError extends Error {
  readonly code = "INSUFFICIENT_STORAGE";

  constructor(
    readonly requiredBytes: bigint,
    readonly availableBytes: bigint,
  ) {
    super(
      `Insufficient storage space: ${requiredBytes} bytes required, ${availableBytes} available.`,
    );
    this.name = "InsufficientStorageError";
  }
}

export class BlobStore {
  readonly rootPath: string;
  readonly maxUploadBytes: number;

  private readonly temporaryPath: string;
  private readonly statfs: (rootPath: string) => BlobStoreFilesystemStats;

  constructor(options: BlobStoreOptions) {
    if (
      !Number.isSafeInteger(options.maxUploadBytes) ||
      options.maxUploadBytes <= 0
    ) {
      throw new RangeError("maxUploadBytes must be a positive safe integer.");
    }

    this.rootPath = path.resolve(options.rootPath);
    this.maxUploadBytes = options.maxUploadBytes;
    this.temporaryPath = path.join(this.rootPath, ".tmp");
    this.statfs =
      options.statfs ??
      ((rootPath) => statfsSync(rootPath, { bigint: true }));
  }

  async initialize(): Promise<void> {
    await mkdir(this.rootPath, { recursive: true });
    await mkdir(this.temporaryPath, { recursive: true });
    await access(this.rootPath, constants.W_OK);
    await access(this.temporaryPath, constants.W_OK);

    const probePath = path.join(
      this.temporaryPath,
      `.writable-${randomBytes(16).toString("hex")}`,
    );
    let probe: Awaited<ReturnType<typeof openFile>> | undefined;
    try {
      probe = await openFile(probePath, "wx");
      await probe.close();
      probe = undefined;
    } finally {
      if (probe !== undefined) {
        await probe.close().catch(() => undefined);
      }
      await unlink(probePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  availableBytes(): bigint {
    const stats = this.statfs(this.rootPath);
    const availableBlocks = BigInt(stats.bavail);
    const blockSize = BigInt(stats.bsize);
    if (availableBlocks <= 0n || blockSize <= 0n) return 0n;
    return availableBlocks * blockSize;
  }

  assertSufficientSpace(requiredBytes = this.maxUploadBytes): void {
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) {
      throw new RangeError("requiredBytes must be a non-negative safe integer.");
    }

    const required = BigInt(requiredBytes);
    const available = this.availableBytes();
    if (available < required) {
      throw new InsufficientStorageError(required, available);
    }
  }

  async write(source: Readable): Promise<StoredBlob> {
    await this.initialize();
    this.assertSufficientSpace();

    const storageKey = randomBytes(32).toString("hex");
    const temporaryFilePath = path.join(
      this.temporaryPath,
      `${storageKey}-${randomBytes(8).toString("hex")}.part`,
    );
    const destinationPath = this.readPath(storageKey);
    const hash = createHash("sha256");
    let byteSize = 0;

    const meter = new Transform({
      transform: (chunk: Buffer | string, encoding, callback) => {
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk, encoding);
        const nextByteSize = byteSize + buffer.byteLength;
        if (nextByteSize > this.maxUploadBytes) {
          callback(new BlobTooLargeError(this.maxUploadBytes, nextByteSize));
          return;
        }

        byteSize = nextByteSize;
        hash.update(buffer);
        callback(null, buffer);
      },
    });

    try {
      await pipeline(
        source,
        meter,
        createWriteStream(temporaryFilePath, { flags: "wx" }),
      );
      await rename(temporaryFilePath, destinationPath);
    } catch (error) {
      await unlink(temporaryFilePath).catch(
        (cleanupError: NodeJS.ErrnoException) => {
          if (cleanupError.code !== "ENOENT") throw cleanupError;
        },
      );
      throw error;
    }

    return {
      storageKey,
      byteSize,
      sha256: hash.digest("hex"),
    };
  }

  open(storageKey: string): ReadStream {
    return createReadStream(this.readPath(storageKey), { flags: "r" });
  }

  readPath(storageKey: string): string {
    if (!STORAGE_KEY_PATTERN.test(storageKey)) {
      throw new InvalidStorageKeyError();
    }

    const candidate = path.resolve(this.rootPath, storageKey);
    const relative = path.relative(this.rootPath, candidate);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new InvalidStorageKeyError();
    }
    return candidate;
  }

  async delete(storageKey: string): Promise<boolean> {
    const blobPath = this.readPath(storageKey);
    try {
      await unlink(blobPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}
