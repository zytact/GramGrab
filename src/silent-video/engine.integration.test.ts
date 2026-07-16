import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { StreamTargetChunk } from 'mediabunny';
import { operationIdFrom, requestIdFrom } from '../download/contracts.ts';
import { inspectSilentVideo, processSilentVideo } from './engine.ts';

type StoredPart = string | StreamTargetChunk;

class MemoryWritable extends WritableStream<StoredPart> {
  constructor(
    private readonly name: string,
    private readonly files: Map<string, Uint8Array<ArrayBuffer>>
  ) {
    super({ write: chunk => MemoryWritable.store(files, name, chunk) });
  }

  write(chunk: StoredPart): Promise<void> {
    MemoryWritable.store(this.files, this.name, chunk);
    return Promise.resolve();
  }

  override close(): Promise<void> {
    return Promise.resolve();
  }

  private static store(
    files: Map<string, Uint8Array<ArrayBuffer>>,
    name: string,
    chunk: StoredPart
  ): void {
    if (typeof chunk !== 'string') {
      const current = files.get(name) ?? new Uint8Array();
      const next = new Uint8Array(Math.max(current.byteLength, chunk.position + chunk.data.length));
      next.set(current);
      next.set(chunk.data, chunk.position);
      files.set(name, next);
      return;
    }
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array();
    files.set(name, bytes);
  }
}

class MemoryFileHandle {
  constructor(
    readonly name: string,
    private readonly files: Map<string, Uint8Array<ArrayBuffer>>
  ) {}

  getFile(): Promise<File> {
    const bytes = this.files.get(this.name) ?? new Uint8Array();
    return Promise.resolve(new File([bytes.buffer], this.name));
  }

  createWritable(): Promise<MemoryWritable> {
    return Promise.resolve(new MemoryWritable(this.name, this.files));
  }
}

class MemoryDirectory {
  readonly files = new Map<string, Uint8Array<ArrayBuffer>>();

  getDirectoryHandle(): Promise<MemoryDirectory> {
    return Promise.resolve(this);
  }

  getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryFileHandle> {
    if (!this.files.has(name) && !options?.create)
      return Promise.reject(new DOMException('Missing file', 'NotFoundError'));
    if (!this.files.has(name)) this.files.set(name, new Uint8Array());
    return Promise.resolve(new MemoryFileHandle(name, this.files));
  }

  removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name))
      return Promise.reject(new DOMException('Missing file', 'NotFoundError'));
    return Promise.resolve();
  }
}

describe('silent video media processing', () => {
  let directory: MemoryDirectory;

  beforeEach(() => {
    directory = new MemoryDirectory();
    vi.stubGlobal('navigator', {
      storage: { getDirectory: () => Promise.resolve(directory) },
    });
  });

  it('packet-copies an audiovisual MP4 into a playable video-only MP4', async () => {
    const requestId = requestIdFrom('00000000-0000-4000-8000-000000000001');
    const operationId = operationIdFrom('10000000-0000-4000-8000-000000000001');
    const fixturePath = resolve('src/silent-video/__fixtures__/synthetic-av.mp4');
    directory.files.set(`${operationId}.source`, Uint8Array.from(await readFile(fixturePath)));

    const result = await processSilentVideo(operationId, requestId, false, () => {});

    expect(result.alreadySilent).toBe(false);
    expect(result.opfsName).toBe(`${operationId}.mp4`);
    const outputBytes = directory.files.get(`${operationId}.mp4`) ?? new Uint8Array();
    const output = new File([outputBytes.buffer], `${operationId}.mp4`);
    const preflight = await inspectSilentVideo(operationId, requestId, output);
    expect(preflight.videoCodec).toBe('avc');
    expect(preflight.audioTrackCount).toBe(0);
    expect(preflight.width).toBe(16);
    expect(preflight.height).toBe(16);
  });
});
