import type { StreamTargetChunk } from 'mediabunny';

const DIRECTORY = 'gramgrab-silent-v1';
const WORKER_STALE_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_STALE_MS = 7 * WORKER_STALE_MS;

interface OwnershipLedger {
  requestId: string;
  outputName: string;
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

export async function createOutput(requestId: string) {
  const parent = await directory();
  const name = outputName(requestId);
  await writeLedger({ requestId, outputName: name, owner: 'worker', updatedAt: Date.now() });
  const handle = await parent.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  return { name, handle, writable: writable as WritableStream<StreamTargetChunk> };
}

export async function transferOutputToDownload(
  requestId: string,
  downloadId: number
): Promise<void> {
  await writeLedger({
    requestId,
    outputName: outputName(requestId),
    owner: 'download',
    downloadId,
    updatedAt: Date.now(),
  });
}

export async function readOutput(name: string): Promise<File> {
  return (await (await directory()).getFileHandle(name)).getFile();
}

export async function removeOutput(name: string): Promise<void> {
  const requestId = name.replace(/\.mp4$/, '');
  try {
    await (await directory()).removeEntry(name);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
  }
  try {
    await (await directory()).removeEntry(ledgerName(requestId));
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
  }
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
        await removeOutput(ledger.outputName);
      } catch {
        await parent.removeEntry(name);
      }
    })
  );
}
