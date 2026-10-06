import { Context, Data, Effect, Layer, Schema } from 'effect';
import { NetworkError } from '../effect/errors.ts';
import { browser } from '../lib/browser.ts';

/**
 * Every Instagram API attempt goes through `InstagramRequests`, so the person's own work and Watch
 * work share one ledger of real attempts. CDN media and Avatar icon fetches do not use it.
 */
export class InstagramRequests extends Context.Tag('InstagramRequests')<
  InstagramRequests,
  {
    readonly fetch: (
      url: string,
      init?: RequestInit
    ) => Effect.Effect<Response, NetworkError | WatchRequestDeferred>;
  }
>() {}

/** A Watch attempt that may not start before `until`. Person-initiated work never sees it. */
export class WatchRequestDeferred extends Data.TaggedError('WatchRequestDeferred')<{
  until: number;
}> {}

const HOUR_MS = 60 * 60_000;
const HOURLY_REQUEST_CAP = 60;
const WATCH_SPACING_MS = 20_000;
const WATCH_SPACING_JITTER_MS = 5_000;
const PAUSE_BASE_MS = 30 * 60_000;
const PAUSE_CEILING_MS = 6 * HOUR_MS;
/** A Watch attempt waits in the worker up to this long; a longer wait is handed back as deferred. */
const IN_WORKER_WAIT_MS = 25_000;
const BUSY_POLL_MS = 1_000;

const LEDGER_KEY = 'instagram-requests';

class RequestPause extends Schema.Class<RequestPause>('RequestPause')({
  until: Schema.Number,
  level: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
}) {}

class LedgerState extends Schema.Class<LedgerState>('LedgerState')({
  version: Schema.Literal(1),
  /** Start times of attempts in the last hour, oldest first. */
  attempts: Schema.Array(Schema.Number),
  /** The earliest time the next Watch attempt may start, set when any attempt ends. */
  nextWatchAt: Schema.Number,
  pause: Schema.optional(RequestPause),
}) {}

type RequestOrigin = { readonly kind: 'person' } | { readonly kind: 'watch' };

type WatchAdmission =
  | { readonly _tag: 'admit'; readonly probe: boolean }
  | {
      readonly _tag: 'wait';
      readonly until: number;
      readonly reason: 'person' | 'watch' | 'spacing' | 'capacity' | 'paused';
    };

/**
 * The browser's Instagram request ledger. One session signs in at a time, so the rolling cap,
 * spacing, and 429 pause belong to whichever login is signed in.
 */
class RequestLedger {
  private attempts: readonly number[] = [];
  private nextWatchAt = 0;
  private currentPause: RequestPause | undefined;
  private loaded: Promise<void> | undefined;
  private writing: Promise<void> = Promise.resolve();
  private personInFlight = 0;
  private watchInFlight = false;

  ready(): Promise<void> {
    this.loaded ??= browser.storage
      .get(LEDGER_KEY)
      .then(stored => {
        const decoded = Schema.decodeUnknownOption(LedgerState)(stored[LEDGER_KEY]);
        if (decoded._tag === 'None') return;
        this.attempts = decoded.value.attempts;
        this.nextWatchAt = decoded.value.nextWatchAt;
        this.currentPause = decoded.value.pause;
      })
      .catch(() => undefined);
    return this.loaded;
  }

  get pause(): RequestPause | undefined {
    return this.currentPause;
  }

  get personBusy(): boolean {
    return this.personInFlight > 0;
  }

  /** Attempts started within the rolling hour ending at `now`. */
  recentAttempts(now: number): number {
    return this.attempts.filter(at => at > now - HOUR_MS).length;
  }

  /** When the next Watch attempt could start, ignoring work currently in flight. */
  nextWatchAllowedAt(now: number): number {
    const recent = this.attempts.filter(at => at > now - HOUR_MS);
    const capacityAt =
      recent.length >= HOURLY_REQUEST_CAP
        ? recent[recent.length - HOURLY_REQUEST_CAP]! + HOUR_MS
        : now;
    return Math.max(now, this.nextWatchAt, capacityAt, this.currentPause?.until ?? now);
  }

  admitWatch(now: number): WatchAdmission {
    if (this.personInFlight > 0)
      return { _tag: 'wait', until: now + BUSY_POLL_MS, reason: 'person' };
    if (this.watchInFlight) return { _tag: 'wait', until: now + BUSY_POLL_MS, reason: 'watch' };
    const until = this.nextWatchAllowedAt(now);
    if (until <= now) return { _tag: 'admit', probe: this.currentPause !== undefined };
    const reason =
      until === this.currentPause?.until
        ? 'paused'
        : until === this.nextWatchAt
          ? 'spacing'
          : 'capacity';
    return { _tag: 'wait', until, reason };
  }

  begin(origin: RequestOrigin, now: number): void {
    if (origin.kind === 'person') this.personInFlight++;
    else this.watchInFlight = true;
    this.attempts = [...this.attempts.filter(at => at > now - HOUR_MS), now];
    this.persist();
  }

  end(origin: RequestOrigin, now: number, status: number | 'failed', probe = false): void {
    if (origin.kind === 'person') this.personInFlight = Math.max(0, this.personInFlight - 1);
    else this.watchInFlight = false;
    this.nextWatchAt = now + WATCH_SPACING_MS + Math.random() * WATCH_SPACING_JITTER_MS;
    if (status === 429) {
      const level = this.currentPause ? this.currentPause.level + 1 : 0;
      this.currentPause = RequestPause.make({
        until: now + Math.min(PAUSE_BASE_MS * 2 ** level, PAUSE_CEILING_MS),
        level,
      });
    } else if (probe && typeof status === 'number' && status >= 200 && status < 300) {
      this.currentPause = undefined;
    }
    this.persist();
  }

  private persist(): void {
    const snapshot = Schema.encodeSync(LedgerState)(
      LedgerState.make({
        version: 1,
        attempts: this.attempts,
        nextWatchAt: this.nextWatchAt,
        ...(this.currentPause ? { pause: this.currentPause } : {}),
      })
    );
    this.writing = this.writing
      .then(() => browser.storage.set({ [LEDGER_KEY]: snapshot }))
      .catch(() => undefined);
  }
}

export const requestLedger = new RequestLedger();

const sleep = (ms: number) =>
  Effect.promise(() => new Promise<void>(resolve => setTimeout(resolve, Math.max(0, ms))));

const attempt = (
  url: string,
  init: RequestInit | undefined,
  origin: RequestOrigin,
  probe: boolean
) =>
  Effect.tryPromise({
    try: () => fetch(url, init),
    catch: cause => new NetworkError({ cause }),
  }).pipe(
    Effect.tap(response =>
      Effect.sync(() => requestLedger.end(origin, Date.now(), response.status, probe))
    ),
    Effect.tapError(() => Effect.sync(() => requestLedger.end(origin, Date.now(), 'failed', probe)))
  );

const personFetch = (url: string, init?: RequestInit) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => requestLedger.ready());
    requestLedger.begin({ kind: 'person' }, Date.now());
    return yield* attempt(url, init, { kind: 'person' }, false);
  });

const watchFetch = (url: string, init?: RequestInit) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => requestLedger.ready());
    for (;;) {
      const now = Date.now();
      const admission = requestLedger.admitWatch(now);
      if (admission._tag === 'admit') {
        requestLedger.begin({ kind: 'watch' }, now);
        return yield* attempt(url, init, { kind: 'watch' }, admission.probe);
      }
      if (admission.until - now > IN_WORKER_WAIT_MS)
        return yield* Effect.fail(new WatchRequestDeferred({ until: admission.until }));
      yield* sleep(admission.until - now);
    }
  });

/** Requests the person asked for in the moment: counted, never held back. */
export const PersonRequests = Layer.succeed(InstagramRequests, { fetch: personFetch });

/** Unattended Watch requests: one at a time, spaced, capped, and stopped by a shared pause. */
export const WatchRequests = Layer.succeed(InstagramRequests, { fetch: watchFetch });
