import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { OperationFailure } from '../errors/contracts.ts';
import { cleanFailedOutput } from './engine.ts';
import { cacheInput, createOutput, sweepOutputs } from './opfs.ts';

class MemoryWritable extends WritableStream<BlobPart> {
  constructor(
    private readonly name: string,
    private readonly files: Map<string, BlobPart[]>
  ) {
    super({
      write: chunk => {
        const existing = files.get(name) ?? [];
        files.set(name, [...existing, chunk]);
      },
    });
  }

  write(chunk: BlobPart): Promise<void> {
    this.files.set(this.name, [chunk]);
    return Promise.resolve();
  }

  override close(): Promise<void> {
    return Promise.resolve();
  }
}

class MemoryFileHandle {
  constructor(
    readonly name: string,
    private readonly files: Map<string, BlobPart[]>
  ) {}

  getFile(): Promise<File> {
    return Promise.resolve(new File(this.files.get(this.name) ?? [], this.name));
  }

  createWritable(): Promise<MemoryWritable> {
    return Promise.resolve(new MemoryWritable(this.name, this.files));
  }
}

class LockingDirectory {
  readonly files = new Map<string, BlobPart[]>();
  readonly locked = new Set<string>();

  getDirectoryHandle(): Promise<LockingDirectory> {
    return Promise.resolve(this);
  }

  getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryFileHandle> {
    if (!this.files.has(name) && !options?.create)
      return Promise.reject(new DOMException('Missing file', 'NotFoundError'));
    if (!this.files.has(name)) this.files.set(name, []);
    return Promise.resolve(new MemoryFileHandle(name, this.files));
  }

  removeEntry(name: string): Promise<void> {
    if (this.locked.has(name))
      return Promise.reject(new DOMException('File is locked', 'NoModificationAllowedError'));
    if (!this.files.delete(name))
      return Promise.reject(new DOMException('Missing file', 'NotFoundError'));
    return Promise.resolve();
  }

  async *entries(): AsyncIterableIterator<[string, MemoryFileHandle]> {
    for (const name of this.files.keys()) yield [name, new MemoryFileHandle(name, this.files)];
  }
}

describe('silent video OPFS cleanup', () => {
  let directory: LockingDirectory;

  beforeEach(() => {
    directory = new LockingDirectory();
    vi.stubGlobal('navigator', {
      storage: { getDirectory: () => Promise.resolve(directory) },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves a stream failure while retaining a locked artifact ledger for a later sweep', async () => {
    const requestId = '00000000-0000-4000-8000-000000000001';
    const streamError = new Error('The source stream ended unexpectedly.');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.error(streamError);
      },
    });
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(body, { headers: { 'Content-Length': '6' } }))
    );
    directory.locked.add(`${requestId}.source`);

    await expect(
      cacheInput(requestId, 'https://example.com/video.mp4', () => {})
    ).rejects.toMatchObject({ code: 'SILENT_STORAGE_WRITE_FAILED' });
    expect(directory.files.has(`${requestId}.source`)).toBe(true);
    expect(directory.files.has(`${requestId}.json`)).toBe(true);

    directory.locked.clear();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    await expect(sweepOutputs()).resolves.toBeUndefined();
    expect(directory.files.has(`${requestId}.source`)).toBe(false);
    expect(directory.files.has(`${requestId}.json`)).toBe(false);
  });

  it('removes a failed generated output while retaining cached input for re-encoding', async () => {
    const operationId = '10000000-0000-4000-8000-000000000001';
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(new Uint8Array([1, 2, 3]))));
    await cacheInput(operationId, 'https://example.com/video.mp4', () => {});
    const output = await createOutput(operationId);
    await output.writable.close();
    expect(directory.files.has(`${operationId}.mp4`)).toBe(true);

    await cleanFailedOutput(
      output.name,
      OperationFailure.make({
        code: 'SILENT_COPY_FAILED',
        phase: 'silent-copy',
        scope: 'item',
      })
    );

    expect(directory.files.has(`${operationId}.source`)).toBe(true);
    expect(directory.files.has(`${operationId}.json`)).toBe(true);
    expect(directory.files.has(`${operationId}.mp4`)).toBe(false);
  });
});
