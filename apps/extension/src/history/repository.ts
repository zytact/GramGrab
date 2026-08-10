import { browser } from '../lib/browser.ts';
import {
  DOWNLOAD_HISTORY_KEY,
  DOWNLOAD_HISTORY_LIMIT,
  DOWNLOAD_HISTORY_VERSION,
  isWhatsAppHistoryReceipt,
  type DownloadHistoryEntry,
  type DownloadHistoryStoreV4,
  type HistoryEntry,
  type LegacyDownloadHistoryEntry,
  type HistoryReadResult,
  type WhatsAppHistoryReceipt,
} from './contracts.ts';
import { historySource } from './source.ts';

let mutationQueue: Promise<void> = Promise.resolve();

const validKinds = new Set(['post', 'reel', 'story', 'highlight', 'profile']);
const validTypes = new Set(['image', 'video']);

function validInstagramEntry(value: unknown): value is DownloadHistoryEntry {
  const item = value as Partial<DownloadHistoryEntry> | null;
  return Boolean(item && hasValidIdentity(item) && hasValidMedia(item) && hasValidOutcome(item));
}

function validHistoryEntry(value: unknown): value is HistoryEntry {
  return isWhatsAppHistoryReceipt(value) || validInstagramEntry(value);
}

function hasValidIdentity(item: Partial<DownloadHistoryEntry>): boolean {
  if (typeof item.id !== 'string' || !item.origin) return false;
  if (item.origin.kind === 'instants') return true;
  const source = historySource(item.origin.sourceUrl);
  return source?.url === item.origin.sourceUrl && source?.kind === item.origin.sourceKind;
}

// fallow-ignore-next-line complexity
function hasValidMedia(item: Partial<DownloadHistoryEntry>): boolean {
  return Boolean(
    (item.origin?.kind === 'instants' || validKinds.has(item.origin?.sourceKind ?? '')) &&
    Number.isSafeInteger(item.itemIndex) &&
    item.itemIndex! >= 0 &&
    (item.mediaId === undefined || typeof item.mediaId === 'string') &&
    validTypes.has(item.mediaType ?? '') &&
    typeof item.filenameHint === 'string' &&
    (item.exportMode === undefined ||
      item.exportMode === 'direct' ||
      item.exportMode === 'frame' ||
      item.exportMode === 'silent') &&
    (item.frameTimestampSeconds === undefined ||
      (Number.isSafeInteger(item.frameTimestampSeconds) && item.frameTimestampSeconds >= 0)) &&
    (item.exportMode !== 'frame' || item.frameTimestampSeconds !== undefined)
  );
}

function hasValidOutcome(item: Partial<DownloadHistoryEntry>): boolean {
  return Number.isFinite(item.downloadedAt) && item.outcome === 'accepted';
}

function decode(value: unknown): HistoryReadResult {
  if (value === undefined) return { kind: 'ok', entries: [], repaired: false };
  const store = value as
    | (Omit<Partial<DownloadHistoryStoreV4>, 'version'> & { version?: number })
    | null;
  if (!store || typeof store.version !== 'number' || !Array.isArray(store.entries))
    return { kind: 'ok', entries: [], repaired: true };
  if (store.version !== 1 && store.version !== 2 && store.version !== 3 && store.version !== 4)
    return { kind: 'unknown-version', entries: [] };
  const entries = store.entries.flatMap(entry => {
    if (store.version === DOWNLOAD_HISTORY_VERSION) return validHistoryEntry(entry) ? [entry] : [];
    if (store.version === 3) return validInstagramEntry(entry) ? [entry] : [];
    const legacy = entry as unknown as Partial<LegacyDownloadHistoryEntry>;
    if (typeof legacy.sourceUrl !== 'string' || !legacy.sourceKind) return [];
    const migrated = {
      ...legacy,
      origin: {
        kind: 'source' as const,
        sourceUrl: legacy.sourceUrl,
        sourceKind: legacy.sourceKind,
      },
    };
    delete (migrated as { sourceUrl?: string }).sourceUrl;
    delete (migrated as { sourceKind?: string }).sourceKind;
    return validInstagramEntry(migrated) ? [migrated] : [];
  });
  return {
    kind: 'ok',
    entries,
    repaired: store.version !== DOWNLOAD_HISTORY_VERSION || entries.length !== store.entries.length,
  };
}

async function read(): Promise<HistoryReadResult> {
  return decode((await browser.storage.get(DOWNLOAD_HISTORY_KEY))[DOWNLOAD_HISTORY_KEY]);
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export async function getHistory(): Promise<HistoryReadResult> {
  return read();
}

function append(entry: HistoryEntry): Promise<HistoryEntry[]> {
  return enqueue(async () => {
    const current = await read();
    if (current.kind === 'unknown-version')
      throw new Error('Download history uses a newer version.');
    const entries = [...current.entries, entry].slice(-DOWNLOAD_HISTORY_LIMIT);
    await browser.storage.set({
      [DOWNLOAD_HISTORY_KEY]: { version: DOWNLOAD_HISTORY_VERSION, entries },
    });
    return entries;
  });
}

export function appendHistory(entry: DownloadHistoryEntry): Promise<HistoryEntry[]> {
  return append(entry);
}

export function appendWhatsAppHistoryReceipt(
  receipt: WhatsAppHistoryReceipt
): Promise<HistoryEntry[]> {
  return append(receipt);
}

export function removeHistory(id: string): Promise<HistoryEntry[]> {
  return enqueue(async () => {
    const current = await read();
    if (current.kind === 'unknown-version')
      throw new Error('Download history uses a newer version.');
    const entries = current.entries.filter(entry => !('id' in entry && entry.id === id));
    await browser.storage.set({
      [DOWNLOAD_HISTORY_KEY]: { version: DOWNLOAD_HISTORY_VERSION, entries },
    });
    return entries;
  });
}

export function removeWhatsAppHistoryReceipt(
  receipt: WhatsAppHistoryReceipt
): Promise<HistoryEntry[]> {
  return enqueue(async () => {
    const current = await read();
    if (current.kind === 'unknown-version')
      throw new Error('Download history uses a newer version.');
    const index = current.entries.findIndex(
      entry =>
        isWhatsAppHistoryReceipt(entry) &&
        entry.source === receipt.source &&
        entry.mediaKind === receipt.mediaKind &&
        entry.timestamp === receipt.timestamp &&
        entry.savedFilename === receipt.savedFilename &&
        entry.outcome === receipt.outcome
    );
    const entries =
      index === -1
        ? current.entries
        : [...current.entries.slice(0, index), ...current.entries.slice(index + 1)];
    await browser.storage.set({
      [DOWNLOAD_HISTORY_KEY]: { version: DOWNLOAD_HISTORY_VERSION, entries },
    });
    return entries;
  });
}

export function clearHistory(): Promise<void> {
  return enqueue(async () => {
    const current = await read();
    if (current.kind === 'unknown-version')
      throw new Error('Download history uses a newer version.');
    await browser.storage.set({
      [DOWNLOAD_HISTORY_KEY]: { version: DOWNLOAD_HISTORY_VERSION, entries: [] },
    });
  });
}
