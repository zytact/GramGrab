import type { StreamTargetChunk } from 'mediabunny';

const DIRECTORY = 'gramgrab-silent-v1';
const WORKER_STALE_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_STALE_MS = 7 * WORKER_STALE_MS;

interface OwnershipLedger {
  requestId: string;
  inputName?: string;
  outputName?: string;
  owner: 'worker' | 'download';
  updatedAt: number;
  downloadId?: number;
}

async function directory(): Promise<FileSystemDirectoryHandle> {
  if (!navigator.storage?.getDirectory) throw new Error('Private browser storage is unavailable.');
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIRECTORY, { create: true });
}

export function outputName(requestId: string): string {
  return `${requestId}.mp4`;
}

function inputName(requestId: string): string {
  return `${requestId}.source`;
}

function ledgerName(requestId: string): string {
  return `${requestId}.json`;
}

async function writeLedger(ledger: OwnershipLedger): Promise<void> {
  const handle = await (
    await directory()
  ).getFileHandle(ledgerName(ledger.requestId), {
    create: true,
  });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(ledger));
  await writable.close();
}

async function readLedger(requestId: string): Promise<OwnershipLedger | undefined> {
  try {
    const file = await (await directory()).getFileHandle(ledgerName(requestId));
    return JSON.parse(await (await file.getFile()).text()) as OwnershipLedger;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return undefined;
    throw error;
  }
}

export async function cacheInput(
  requestId: string,
  url: string,
  onProgress: (progress: number) => void
): Promise<File> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Network request failed with status ${response.status}.`);
  if (!response.body) throw new Error('The network response did not contain video data.');

  const parent = await directory();
  const name = inputName(requestId);
  const handle = await parent.getFileHandle(name, { create: true });
  await writeLedger({ requestId, inputName: name, owner: 'worker', updatedAt: Date.now() });
  const writable = await handle.createWritable();
  const contentLength = Number(response.headers.get('Content-Length')) || 0;
  let received = 0;
  const progress = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      onProgress(contentLength > 0 ? Math.min(0.99, received / contentLength) : 0);
      controller.enqueue(chunk);
    },
  });
  try {
    await response.body.pipeThrough(progress).pipeTo(writable);
    onProgress(1);
    return handle.getFile();
  } catch (error) {
    await removeOutput(outputName(requestId)).catch(() => undefined);
    throw error;
  }
}

export async function readInput(requestId: string): Promise<File> {
  return (await (await directory()).getFileHandle(inputName(requestId))).getFile();
}

export async function createOutput(requestId: string) {
  const parent = await directory();
  const name = outputName(requestId);
  const existing = await readLedger(requestId);
  await writeLedger({
    requestId,
    ...(existing?.inputName ? { inputName: existing.inputName } : {}),
    outputName: name,
    owner: 'worker',
    updatedAt: Date.now(),
  });
  const handle = await parent.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  return { name, handle, writable: writable as WritableStream<StreamTargetChunk> };
}

export async function transferOutputToDownload(
  requestId: string,
  downloadId: number
): Promise<void> {
  const existing = await readLedger(requestId);
  await writeLedger({
    requestId,
    ...(existing?.inputName ? { inputName: existing.inputName } : {}),
    outputName: outputName(requestId),
    owner: 'download',
    downloadId,
    updatedAt: Date.now(),
  });
}

export async function readOutput(name: string): Promise<File> {
  return (await (await directory()).getFileHandle(name)).getFile();
}

async function removeEntry(parent: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await parent.removeEntry(name);
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return true;
    if (error instanceof DOMException && error.name === 'NoModificationAllowedError') return false;
    throw error;
  }
}

export async function removeOutput(name: string): Promise<void> {
  const requestId = name.replace(/\.mp4$/, '');
  const ledger = await readLedger(requestId);
  const artifacts = [ledger?.inputName, ledger?.outputName, name].filter(
    (artifact, index, all): artifact is string =>
      Boolean(artifact) && all.indexOf(artifact) === index
  );
  const parent = await directory();
  let locked = false;
  for (const artifact of artifacts) {
    if (!(await removeEntry(parent, artifact))) locked = true;
  }
  if (locked) return;
  await removeEntry(parent, ledgerName(requestId));
}

export async function sweepOutputs(): Promise<void> {
  const parent = await directory();
  const ledgers: string[] = [];
  const entries = (
    parent as unknown as { entries: () => AsyncIterableIterator<[string, FileSystemHandle]> }
  ).entries();
  for await (const [name] of entries) {
    if (name.endsWith('.json')) ledgers.push(name);
  }
  await Promise.all(
    ledgers.map(async name => {
      try {
        const file = await (await parent.getFileHandle(name)).getFile();
        const ledger = JSON.parse(await file.text()) as OwnershipLedger;
        const staleAfter = ledger.owner === 'worker' ? WORKER_STALE_MS : DOWNLOAD_STALE_MS;
        if (Date.now() - ledger.updatedAt <= staleAfter) return;
        await removeOutput(ledger.outputName ?? outputName(ledger.requestId));
      } catch {
        await parent.removeEntry(name);
      }
    })
  );
}
