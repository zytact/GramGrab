import type { OperationId, RequestId } from '../download/contracts.ts';
type WorkerRequest = {
  readonly _tag?: string;
  readonly requestId?: RequestId;
  readonly operationId?: OperationId;
  readonly useCachedInput?: boolean;
  readonly transcode?: boolean;
  readonly rotation?: 90 | 180 | 270;
};

class MemoryFileHandle {
  constructor(
    readonly name: string,
    private readonly files: Map<string, BlobPart[]>
  ) {}

  getFile(): Promise<File> {
    return Promise.resolve(new File(this.files.get(this.name) ?? [], this.name));
  }

  createWritable() {
    return Promise.resolve({
      write: (chunk: BlobPart) => {
        this.files.set(this.name, [chunk]);
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    });
  }
}

export function createMemoryDirectory() {
  const files = new Map<string, BlobPart[]>();
  const directory = {
    files,
    getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name) && !options?.create)
        return Promise.reject(new DOMException('Missing file', 'NotFoundError'));
      if (!files.has(name)) files.set(name, []);
      return Promise.resolve(new MemoryFileHandle(name, files));
    },
    removeEntry(name: string) {
      if (!files.delete(name))
        return Promise.reject(new DOMException('Missing file', 'NotFoundError'));
      return Promise.resolve();
    },
    async *entries(): AsyncIterableIterator<[string, MemoryFileHandle]> {
      for (const name of files.keys()) yield [name, new MemoryFileHandle(name, files)];
    },
  };
  return { ...directory, getDirectoryHandle: () => Promise.resolve(directory) };
}

function createWorker() {
  const messageListeners: ((event: MessageEvent) => void)[] = [];
  const requests: WorkerRequest[] = [];
  const worker = {
    requests,
    terminated: false,
    onRequest: (_request: WorkerRequest) => {},
    addEventListener(type: string, listener: EventListener) {
      if (type === 'message') messageListeners.push(listener);
    },
    postMessage(request: WorkerRequest) {
      worker.requests.push(request);
      worker.onRequest(request);
    },
    terminate() {
      worker.terminated = true;
    },
    respond(response: unknown) {
      queueMicrotask(() => {
        const event = new MessageEvent('message', { data: response });
        for (const listener of messageListeners) listener(event);
      });
    },
  };
  return worker;
}

const WorkerAdapter = class {
  constructor() {
    const worker = createWorker();
    workerAdapter.instance = worker;
    workerAdapter.onCreate(worker);
    return worker;
  }
};
export const workerAdapter: {
  instance: ReturnType<typeof createWorker> | undefined;
  onCreate: (worker: ReturnType<typeof createWorker>) => void;
  Worker: typeof WorkerAdapter;
} = {
  instance: undefined,
  onCreate: () => {},
  Worker: WorkerAdapter,
};
