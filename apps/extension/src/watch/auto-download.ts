import { Effect, Either } from 'effect';
import type { FailureCode } from '@gramgrab/protocol';
import { browser, type BrowserDownload } from '../lib/browser.ts';
import { normalizeBrowserDownloadFailure, normalizeSourceFailure } from '../errors/normalize.ts';
import { acceptedHistoryEntry } from '../history/receipt.ts';
import { appendHistory, getHistory } from '../history/repository.ts';
import type { MediaItem } from '../instagram/normalize.ts';
import { WatchRequests } from '../instagram/requests.ts';
import type { ChildDownload, Discovery, Watch } from './contracts.ts';
import { historyOrigin, originalFilename, reacquire, type Slot } from './export.ts';
import { fetchViewer } from './identity.ts';
import { mutateStore, readStore } from './store.ts';

const FINAL_CODES: ReadonlySet<FailureCode> = new Set([
  'WATCH_STORY_EXPIRED',
  'WATCH_AVATAR_CHANGED',
  'WATCH_INSTANT_NOT_IN_FEED',
  'WATCH_MEDIA_UNAVAILABLE',
]);

export const retryableDownload = (child: ChildDownload) =>
  child.status === 'failed' && !FINAL_CODES.has(child.code);

async function filenameDigest(filename: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(filename));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

const changeDiscovery = (
  watchId: string,
  viewerId: string,
  entryId: string,
  change: (entry: Discovery) => Discovery | undefined
) =>
  mutateStore(store => {
    const watch = store.watches.find(
      candidate => candidate.id === watchId && candidate.viewerId === viewerId && candidate.enabled
    );
    const entry = watch?.discoveries.find(candidate => candidate.id === entryId);
    if (!watch || !entry) return { store, value: undefined };
    const next = change(entry);
    if (!next) return { store, value: undefined };
    if (next === entry) return { store, value: entry };
    return {
      store: {
        ...store,
        watches: store.watches.map(candidate =>
          candidate.id === watchId
            ? {
                ...watch,
                discoveries: watch.discoveries.map(candidate =>
                  candidate.id === entryId ? next : candidate
                ),
              }
            : candidate
        ),
      },
      value: next,
    };
  });

const changeChild = (
  watch: Watch,
  entry: Discovery,
  index: number,
  child: ChildDownload,
  expected: ChildDownload['status']
) =>
  changeDiscovery(watch.id, watch.viewerId, entry.id, current => {
    if (!current.download || current.download.children[index]?.status !== expected)
      return undefined;
    return {
      ...current,
      download: {
        ...current.download,
        children: current.download.children.map((existing, position) =>
          position === index ? child : existing
        ),
      },
    };
  });

const authorized = Effect.fn(function* (watch: Watch) {
  const viewer = yield* Effect.either(fetchViewer);
  if (Either.isLeft(viewer) || viewer.right.accountId !== watch.viewerId) return false;
  const current = yield* Effect.promise(readStore);
  return (
    current.kind === 'ok' &&
    current.store.watches.some(
      candidate =>
        candidate.id === watch.id && candidate.viewerId === watch.viewerId && candidate.enabled
    )
  );
});

const fileRef = (watch: Watch, entry: Discovery, index: number) => {
  const { ref } = entry;
  if (ref._tag === 'Sidecar') return ref.children[index];
  return ref._tag === 'Avatar'
    ? { mediaId: `profile-avatar:${watch.username}`, mediaType: 'image' as const }
    : ref;
};

async function saveReceipt(
  watch: Watch,
  entry: Discovery,
  index: number,
  filename: string,
  at: number
): Promise<boolean> {
  const ref = fileRef(watch, entry, index);
  if (!ref) return false;
  const id = `watch:${entry.id}:${index}`;
  try {
    const existing = await getHistory();
    if (existing.entries.some(receipt => 'id' in receipt && receipt.id === id)) return true;
    await appendHistory({
      ...acceptedHistoryEntry(
        {
          itemIndex: index,
          mediaId: ref.mediaId,
          mediaType: ref.mediaType,
          filename,
          exportMode: 'direct',
        },
        historyOrigin(watch, entry.ref)
      ),
      id,
      downloadedAt: at,
    });
    return true;
  } catch {
    return false;
  }
}

const basename = (filename: string) => filename.split(/[\\/]/).at(-1) ?? '';

const committedChild = (
  write: Awaited<ReturnType<typeof changeDiscovery>>,
  index: number,
  status: ChildDownload['status']
) => write.kind === 'ok' && write.value?.download?.children[index]?.status === status;

async function matchingDownloads(child: Extract<ChildDownload, { status: 'starting' }>) {
  const extensionId = new URL(browser.runtime.getURL('')).hostname;
  const records = await browser.downloads
    .search({ startedAfter: new Date(child.at - 1).toISOString() })
    .catch(() => []);
  const matches: BrowserDownload[] = [];
  for (const record of records) {
    if (record.byExtensionId !== extensionId || !record.filename) continue;
    if ((await filenameDigest(basename(record.filename))) === child.filenameDigest)
      matches.push(record);
  }
  return matches;
}

async function recordAcceptance(
  watch: Watch,
  entry: Discovery,
  index: number,
  file: { downloadId: number; filename: string; at: number; expected: 'starting' | 'accepted' }
) {
  const { downloadId, filename, at, expected } = file;
  const accepted: ChildDownload = { status: 'accepted', at, downloadId, historySaved: false };
  const write = await changeChild(watch, entry, index, accepted, expected);
  const historySaved = await saveReceipt(watch, entry, index, filename, at);
  if (committedChild(write, index, 'accepted'))
    await changeChild(watch, entry, index, { ...accepted, historySaved }, 'accepted');
}

async function reconcile(
  watch: Watch,
  entry: Discovery,
  index: number,
  child: Extract<ChildDownload, { status: 'starting' }>
) {
  const history = await getHistory().catch(() => undefined);
  const receipt = history?.entries.find(
    receipt => 'id' in receipt && receipt.id === `watch:${entry.id}:${index}`
  );
  if (receipt && 'id' in receipt) {
    await changeChild(
      watch,
      entry,
      index,
      { status: 'accepted', at: receipt.downloadedAt, historySaved: true },
      'starting'
    );
    return;
  }
  const matches = await matchingDownloads(child);
  const [match] = matches;
  if (matches.length !== 1 || !match?.filename) {
    await changeChild(watch, entry, index, { status: 'uncertain', at: child.at }, 'starting');
    return;
  }
  await recordAcceptance(watch, entry, index, {
    downloadId: match.id,
    filename: basename(match.filename),
    at: child.at,
    expected: 'starting',
  });
}

const inFlight = new Set<string>();
const childKey = (entryId: string, index: number) => `${entryId}:${index}`;

async function downloadAvailable() {
  const active = await browser.downloads.search({ state: 'in_progress' }).catch(() => undefined);
  return active !== undefined && active.length < 3;
}

const beginDelivery = Effect.fn(function* (
  watch: Watch,
  entry: Discovery,
  item: MediaItem,
  index: number
) {
  if (!(yield* authorized(watch)) || !(yield* Effect.promise(downloadAvailable))) return undefined;
  const filename = originalFilename(item, index);
  const at = Date.now();
  const starting: ChildDownload = {
    status: 'starting',
    at,
    filenameDigest: yield* Effect.promise(() => filenameDigest(filename)),
  };
  const write = yield* Effect.promise(() => changeChild(watch, entry, index, starting, 'pending'));
  return committedChild(write, index, 'starting') ? { filename, at, index } : undefined;
});

const deliverStarted = Effect.fn(function* (
  watch: Watch,
  entry: Discovery,
  item: MediaItem,
  attempt: { filename: string; at: number; index: number }
) {
  const { index } = attempt;
  const result = yield* Effect.tryPromise({
    try: () =>
      browser.downloads.download({ url: item.url, filename: attempt.filename, saveAs: false }),
    catch: normalizeBrowserDownloadFailure,
  }).pipe(Effect.either);
  if (Either.isLeft(result)) {
    yield* Effect.promise(() =>
      changeChild(
        watch,
        entry,
        index,
        { status: 'failed', at: Date.now(), code: result.left.code },
        'starting'
      )
    );
    return;
  }
  yield* Effect.promise(() =>
    recordAcceptance(watch, entry, index, {
      downloadId: result.right,
      filename: attempt.filename,
      at: attempt.at,
      expected: 'starting',
    })
  );
});

const deliver = Effect.fn(function* (
  watch: Watch,
  entry: Discovery,
  item: MediaItem,
  index: number
) {
  const attempt = yield* beginDelivery(watch, entry, item, index);
  if (!attempt) return;
  const key = childKey(entry.id, index);
  inFlight.add(key);
  yield* deliverStarted(watch, entry, item, attempt).pipe(
    Effect.ensuring(Effect.sync(() => inFlight.delete(key)))
  );
});

const failPending = (watch: Watch, entry: Discovery, code: FailureCode) =>
  changeDiscovery(watch.id, watch.viewerId, entry.id, current =>
    current.download
      ? {
          ...current,
          download: {
            ...current.download,
            children: current.download.children.map(child =>
              child.status === 'pending' ? { status: 'failed', at: Date.now(), code } : child
            ),
          },
        }
      : current
  );

async function collect(watch: Watch, entry: Discovery): Promise<void> {
  if (!entry.collect || !('status' in entry.collect) || entry.collect.status !== 'pending') return;
  const write = await changeDiscovery(watch.id, watch.viewerId, entry.id, current =>
    current.collect && 'status' in current.collect && current.collect.status === 'pending'
      ? { ...current, collect: { at: Date.now() } }
      : current
  );
  if (
    write.kind === 'failed' &&
    (write.code === 'WATCH_STORE_FAILED' || write.code === 'WATCH_STORE_CAPACITY_EXCEEDED')
  ) {
    const code = write.code;
    await changeDiscovery(watch.id, watch.viewerId, entry.id, current => ({
      ...current,
      collect: { status: 'failed', at: Date.now(), code, dismissed: false },
    }));
  }
}

const collectNeedsWork = (entry: Discovery) =>
  entry.collect !== undefined && 'status' in entry.collect && entry.collect.status === 'pending';

const downloadNeedsWork = (entry: Discovery) =>
  entry.download !== undefined &&
  !entry.download.dismissed &&
  entry.download.children.some(
    child =>
      child.status === 'pending' ||
      child.status === 'starting' ||
      (child.status === 'accepted' && child.historySaved === false)
  );

export const actionsNeedWork = (watch: Watch) =>
  watch.enabled &&
  watch.discoveries.some(entry => collectNeedsWork(entry) || downloadNeedsWork(entry));

async function resumeChild(watch: Watch, entry: Discovery, index: number, child: ChildDownload) {
  if (inFlight.has(childKey(entry.id, index))) return;
  if (child.status === 'starting') return reconcile(watch, entry, index, child);
  if (child.status !== 'accepted' || child.downloadId === undefined || child.historySaved !== false)
    return;
  const [record] = await browser.downloads.search({ id: child.downloadId }).catch(() => []);
  if (!record?.filename) return;
  await recordAcceptance(watch, entry, index, {
    downloadId: child.downloadId,
    filename: basename(record.filename),
    at: child.at,
    expected: 'accepted',
  });
}

async function recordMissing(
  watch: Watch,
  entry: Discovery,
  index: number,
  code: NonNullable<Discovery['unavailable']>
) {
  await changeChild(watch, entry, index, { status: 'failed', at: Date.now(), code }, 'pending');
  await changeDiscovery(watch.id, watch.viewerId, entry.id, current => {
    if (entry.ref._tag !== 'Sidecar') return { ...current, unavailable: code };
    const missingChildren = [
      ...new Set([...(current.missingChildren ?? []), entry.ref.children[index]!.mediaId]),
    ];
    return {
      ...current,
      missingChildren,
      ...(missingChildren.length === entry.ref.children.length
        ? { unavailable: 'WATCH_MEDIA_UNAVAILABLE' as const }
        : {}),
    };
  });
}

const settleSlot = Effect.fn(function* (watch: Watch, entry: Discovery, index: number, slot: Slot) {
  if (entry.download?.children[index]?.status !== 'pending') return;
  if (
    entry.ref._tag === 'Sidecar' &&
    entry.missingChildren?.includes(entry.ref.children[index]!.mediaId)
  ) {
    yield* Effect.promise(() => recordMissing(watch, entry, index, 'WATCH_MEDIA_UNAVAILABLE'));
    return;
  }
  if (slot._tag === 'gone')
    yield* Effect.promise(() => recordMissing(watch, entry, index, slot.code));
  else yield* deliver(watch, entry, slot.item, index);
});

const exportPending = Effect.fn(function* (watch: Watch, entry: Discovery) {
  if (!entry.download?.children.some(child => child.status === 'pending')) return true;
  if (!(yield* Effect.promise(downloadAvailable))) return false;
  const unavailable = entry.unavailable;
  if (unavailable) {
    yield* Effect.promise(() => failPending(watch, entry, unavailable));
    return true;
  }
  const result = yield* Effect.either(reacquire(watch, entry.ref, Math.floor(Date.now() / 1000)));
  if (Either.isLeft(result)) {
    if (result.left._tag === 'WatchRequestDeferred' || result.left._tag === 'RateLimited')
      return false;
    yield* Effect.promise(() =>
      failPending(watch, entry, normalizeSourceFailure(result.left).code)
    );
    return true;
  }
  for (const [index, slot] of result.right.entries()) yield* settleSlot(watch, entry, index, slot);
  return true;
});

export const finishActions = Effect.fn(function* (watch: Watch) {
  for (const entry of watch.discoveries) {
    if (!collectNeedsWork(entry) && !downloadNeedsWork(entry)) continue;
    if (!(yield* authorized(watch))) return;
    yield* Effect.promise(() => collect(watch, entry));
    const download = entry.download;
    if (!download || !downloadNeedsWork(entry)) continue;
    for (const [index, child] of download.children.entries())
      yield* Effect.promise(() => resumeChild(watch, entry, index, child));
    if (!(yield* exportPending(watch, entry))) return;
  }
});

let running: Promise<void> = Promise.resolve();
export function runActions(watchId: string, viewerId: string): Promise<void> {
  const run = async () => {
    const read = await readStore();
    const watch =
      read.kind === 'ok'
        ? read.store.watches.find(
            candidate =>
              candidate.id === watchId && candidate.viewerId === viewerId && candidate.enabled
          )
        : undefined;
    if (!watch) return;
    await Effect.runPromise(finishActions(watch).pipe(Effect.provide(WatchRequests)));
  };
  const result = running.then(run, run);
  running = result.catch(() => undefined);
  return result;
}
