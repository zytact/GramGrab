import { Either, Schema } from 'effect';
import { browser } from '../lib/browser.ts';
import { STORE_BUDGET_BYTES, STORE_KEY, STORE_VERSION, WatchStore } from './contracts.ts';

export type StoreFailureCode =
  | 'WATCH_STORE_CAPACITY_EXCEEDED'
  | 'WATCH_STORE_FAILED'
  | 'WATCH_STORE_VERSION_UNSUPPORTED'
  | 'WATCH_STORE_UNREADABLE';

export type StoreRead =
  | { readonly kind: 'ok'; readonly store: WatchStore; readonly bytes: number }
  | { readonly kind: 'failed'; readonly code: StoreFailureCode };

export type StoreWrite<T> =
  | { readonly kind: 'ok'; readonly value: T; readonly store: WatchStore }
  | { readonly kind: 'failed'; readonly code: StoreFailureCode };

/** A mutation returns the next store, or the same store object to skip the write. */
export type StoreChange<T> = (store: WatchStore) => {
  readonly store: WatchStore;
  readonly value: T;
};

const HEALTH_KEY = 'watch-store-health';
const strict = { onExcessProperty: 'error' } as const;
const decodeStore = Schema.decodeUnknownEither(WatchStore, strict);
const encodeStore = Schema.encodeSync(WatchStore);
const emptyStore: WatchStore = { version: STORE_VERSION, watches: [] };

const storeBytes = (store: WatchStore): number =>
  new TextEncoder().encode(JSON.stringify(encodeStore(store))).length;

function decode(value: unknown): StoreRead {
  if (value === undefined) return { kind: 'ok', store: emptyStore, bytes: storeBytes(emptyStore) };
  const decoded = decodeStore(value);
  if (Either.isRight(decoded))
    return { kind: 'ok', store: decoded.right, bytes: storeBytes(decoded.right) };
  const version =
    typeof value === 'object' && value !== null && 'version' in value ? value.version : undefined;
  // A store this build cannot read is kept exactly as it is: it is never read as empty or reset.
  return typeof version === 'number' && version > STORE_VERSION
    ? { kind: 'failed', code: 'WATCH_STORE_VERSION_UNSUPPORTED' }
    : { kind: 'failed', code: 'WATCH_STORE_UNREADABLE' };
}

export async function readStore(): Promise<StoreRead> {
  try {
    return decode((await browser.storage.get(STORE_KEY))[STORE_KEY]);
  } catch {
    return { kind: 'failed', code: 'WATCH_STORE_FAILED' };
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** Applies `change` to the latest store, one mutation at a time, within the byte budget. */
export function mutateStore<T>(change: StoreChange<T>): Promise<StoreWrite<T>> {
  const run = async (): Promise<StoreWrite<T>> => {
    const current = await readStore();
    if (current.kind === 'failed') return current;
    const next = change(current.store);
    if (next.store === current.store) return { kind: 'ok', value: next.value, store: next.store };
    const encoded = encodeStore(next.store);
    if (new TextEncoder().encode(JSON.stringify(encoded)).length > STORE_BUDGET_BYTES)
      return recordFailure('WATCH_STORE_CAPACITY_EXCEEDED');
    try {
      await browser.storage.set({ [STORE_KEY]: encoded });
    } catch {
      return recordFailure('WATCH_STORE_FAILED');
    }
    await clearFailure();
    return { kind: 'ok', value: next.value, store: next.store };
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

const StoreHealth = Schema.Struct({
  code: Schema.Literal('WATCH_STORE_CAPACITY_EXCEEDED', 'WATCH_STORE_FAILED'),
  at: Schema.Number,
});
export type StoreHealth = Schema.Schema.Type<typeof StoreHealth>;

async function recordFailure(
  code: 'WATCH_STORE_CAPACITY_EXCEEDED' | 'WATCH_STORE_FAILED'
): Promise<StoreWrite<never>> {
  await browser.sessionStorage
    .set({ [HEALTH_KEY]: { code, at: Date.now() } })
    .catch(() => undefined);
  return { kind: 'failed', code };
}

async function clearFailure(): Promise<void> {
  await browser.sessionStorage.remove(HEALTH_KEY).catch(() => undefined);
}

/** The last write the store refused, until a later write succeeds. */
export async function storeHealth(): Promise<StoreHealth | undefined> {
  const stored = await browser.sessionStorage
    .get(HEALTH_KEY)
    .catch((): Record<string, unknown> => ({}));
  const decoded = Schema.decodeUnknownOption(StoreHealth)(stored[HEALTH_KEY]);
  return decoded._tag === 'Some' ? decoded.value : undefined;
}
