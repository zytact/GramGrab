import { Context, Data, Effect, Layer, Schema } from 'effect';
import type { InstagramLogin } from '@gramgrab/protocol';
import {
  AnswerUntrusted,
  GraphQLRequestFailed,
  NetworkError,
  RateLimited,
} from '../effect/errors.ts';
import { browser } from '../lib/browser.ts';
import { linkedRoute, readLinkedLogin } from './linked-login.ts';
import {
  HOUR_MS,
  LEDGER_KEYS,
  LedgerState,
  RequestPause,
  decodeLedger,
  watchHold,
  type LedgerView,
} from './request-state.ts';

/** Fails a refused response: a 429 as a rate limit, any other error status as a failed request. */
export const requireOk = (response: Response) =>
  Effect.gen(function* () {
    if (response.status === 429) return yield* Effect.fail(new RateLimited({ status: 429 }));
    if (!response.ok)
      return yield* Effect.fail(new GraphQLRequestFailed({ status: response.status }));
  });

/** The JSON body of a successful response. A body that is not JSON is one bad answer. */
export const readJson = (response: Response) =>
  Effect.gen(function* () {
    yield* requireOk(response);
    return yield* Effect.tryPromise({
      try: (): Promise<unknown> => response.json(),
      catch: cause =>
        cause instanceof SyntaxError
          ? new AnswerUntrusted({ reason: 'not-json' })
          : new NetworkError({ cause }),
    });
  });

/** What a caller says about an Instagram request. The service picks credentials for the login. */
export interface InstagramRequestInit {
  readonly method?: 'GET' | 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: URLSearchParams;
  /** Sends the login's `csrftoken` back as `X-CSRFToken`. */
  readonly csrf?: boolean;
}

/**
 * Every Instagram API attempt goes through `InstagramRequests`, so the person's own work and Watch
 * work of one login share its ledger of real attempts, and every request carries that login's
 * session. CDN media and Avatar image fetches do not use it.
 */
export class InstagramRequests extends Context.Tag('InstagramRequests')<
  InstagramRequests,
  {
    readonly login: InstagramLogin;
    readonly fetch: (
      url: string,
      init?: InstagramRequestInit
    ) => Effect.Effect<Response, NetworkError | WatchRequestDeferred>;
  }
>() {}

type RequestsService = Context.Tag.Service<typeof InstagramRequests>;

/** A Watch attempt that may not start before `until`. Person-initiated work never sees it. */
export class WatchRequestDeferred extends Data.TaggedError('WatchRequestDeferred')<{
  until: number;
}> {}

const WATCH_SPACING_MS = 20_000;
const WATCH_SPACING_JITTER_MS = 5_000;
const PAUSE_BASE_MS = 30 * 60_000;
const PAUSE_CEILING_MS = 6 * HOUR_MS;
/** A Watch attempt waits in the worker up to this long; a longer wait is handed back as deferred. */
const IN_WORKER_WAIT_MS = 25_000;
const BUSY_POLL_MS = 1_000;

type RequestOrigin = { readonly kind: 'person' } | { readonly kind: 'watch' };

type WatchAdmission =
  | { readonly _tag: 'admit'; readonly probe: boolean }
  | { readonly _tag: 'wait'; readonly until: number };

/**
 * One login's Instagram request ledger: its rolling cap, spacing, and 429 pause, so a 429 on one
 * login never holds the other back. Only a Watch request's 429 starts the pause: person-initiated
 * work can hit an endpoint that answers 429 on its own.
 */
class RequestLedger {
  private attempts: readonly number[] = [];
  private nextWatchAt = 0;
  private currentPause: RequestPause | undefined;
  private loaded: Promise<void> | undefined;
  private writing: Promise<void> = Promise.resolve();
  private personInFlight = 0;
  private watchInFlight = false;
  private watchReserved = false;

  constructor(private readonly key: string) {}

  ready(): Promise<void> {
    this.loaded ??= browser.storage
      .get(this.key)
      .then(stored => {
        const decoded = decodeLedger(stored[this.key]);
        if (!decoded) return;
        this.attempts = decoded.attempts;
        this.nextWatchAt = decoded.nextWatchAt;
        this.currentPause = decoded.pause;
      })
      .catch(() => undefined);
    return this.loaded;
  }

  /** When a 429 pause still holding Watch work ends, or undefined once it has run out. */
  pausedUntil(now: number): number | undefined {
    return watchHold(this.view, now)?.pausedUntil;
  }

  get personBusy(): boolean {
    return this.personInFlight > 0;
  }

  /** Attempts started within the rolling hour ending at `now`. */
  recentAttempts(now: number): number {
    return this.attempts.filter(at => at > now - HOUR_MS).length;
  }

  get view(): LedgerView {
    return {
      attempts: this.attempts,
      nextWatchAt: this.nextWatchAt,
      ...(this.currentPause ? { pause: this.currentPause } : {}),
    };
  }

  /** When the next Watch attempt could start, ignoring work currently in flight. */
  nextWatchAllowedAt(now: number): number {
    return watchHold(this.view, now)?.until ?? now;
  }

  admitWatch(now: number): WatchAdmission {
    if (this.personInFlight > 0 || this.watchInFlight || this.watchReserved)
      return { _tag: 'wait', until: now + BUSY_POLL_MS };
    const hold = watchHold(this.view, now);
    return hold
      ? { _tag: 'wait', until: hold.until }
      : { _tag: 'admit', probe: this.currentPause !== undefined };
  }

  begin(origin: RequestOrigin, now: number): void {
    if (origin.kind === 'person') this.personInFlight++;
    else this.watchInFlight = true;
    this.attempts = [...this.attempts.filter(at => at > now - HOUR_MS), now];
    this.persist();
  }

  reserveWatch(): () => void {
    this.watchReserved = true;
    return () => {
      this.watchReserved = false;
    };
  }

  end(origin: RequestOrigin, now: number, status: number | 'failed', probe = false): void {
    if (origin.kind === 'person') this.personInFlight = Math.max(0, this.personInFlight - 1);
    else this.watchInFlight = false;
    this.nextWatchAt = now + WATCH_SPACING_MS + Math.round(Math.random() * WATCH_SPACING_JITTER_MS);
    if (status === 429 && origin.kind === 'watch') {
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
      .then(() => browser.storage.set({ [this.key]: snapshot }))
      .catch(() => undefined);
  }
}

const ledgers: Record<InstagramLogin, RequestLedger> = {
  main: new RequestLedger(LEDGER_KEYS.main),
  linked: new RequestLedger(LEDGER_KEYS.linked),
};

export const ledgerOf = (login: InstagramLogin): RequestLedger => ledgers[login];

const sleep = (ms: number) =>
  Effect.promise(() => new Promise<void>(resolve => setTimeout(resolve, Math.max(0, ms))));

/** The main login sends the browser's own cookies and reads its token from them. */
const mainRoute = async (url: string) => ({
  url,
  credentials: 'include' as const,
  csrfToken: () =>
    browser.cookies
      .get({ url: 'https://www.instagram.com/', name: 'csrftoken' })
      .then(cookie => cookie?.value),
});

const ROUTES = { main: mainRoute, linked: linkedRoute } satisfies Record<
  InstagramLogin,
  (url: string) => Promise<unknown>
>;

/** The browser request for `login`, with that login's session and, if asked, its token. */
async function prepare(login: InstagramLogin, url: string, init: InstagramRequestInit) {
  const route = await ROUTES[login](url);
  const csrfToken = init.csrf ? await route.csrfToken() : undefined;
  const request: RequestInit = {
    method: init.method ?? 'GET',
    credentials: route.credentials,
    headers: { ...init.headers, ...(csrfToken ? { 'X-CSRFToken': csrfToken } : {}) },
    body: init.body,
  };
  return { url: route.url, request };
}

const attempt = (
  login: InstagramLogin,
  url: string,
  init: InstagramRequestInit,
  origin: RequestOrigin,
  probe: boolean
) =>
  Effect.tryPromise({
    try: async () => {
      const prepared = await prepare(login, url, init);
      return fetch(prepared.url, prepared.request);
    },
    catch: cause => new NetworkError({ cause }),
  }).pipe(
    Effect.tap(response =>
      Effect.sync(() => ledgerOf(login).end(origin, Date.now(), response.status, probe))
    ),
    Effect.tapError(() =>
      Effect.sync(() => ledgerOf(login).end(origin, Date.now(), 'failed', probe))
    )
  );

const personFetch =
  (login: InstagramLogin): RequestsService['fetch'] =>
  (url, init = {}) =>
    Effect.gen(function* () {
      const ledger = ledgerOf(login);
      yield* Effect.promise(() => ledger.ready());
      ledger.begin({ kind: 'person' }, Date.now());
      return yield* attempt(login, url, init, { kind: 'person' }, false);
    });

export const withWatchAdmission = <A, E, R>(
  login: InstagramLogin,
  use: (requests: RequestsService) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function* () {
    const ledger = ledgerOf(login);
    yield* Effect.promise(() => ledger.ready());
    for (;;) {
      const now = Date.now();
      const admission = ledger.admitWatch(now);
      if (admission._tag === 'admit') {
        return yield* Effect.acquireUseRelease(
          Effect.sync(() => ledger.reserveWatch()),
          () =>
            use({
              login,
              fetch: (url, init = {}) =>
                Effect.gen(function* () {
                  const now = Date.now();
                  const until = Math.max(
                    ledger.nextWatchAllowedAt(now),
                    now + (ledger.personBusy ? BUSY_POLL_MS : 0)
                  );
                  if (until > now) return yield* Effect.fail(new WatchRequestDeferred({ until }));
                  ledger.begin({ kind: 'watch' }, now);
                  return yield* attempt(login, url, init, { kind: 'watch' }, admission.probe);
                }),
            }),
          release => Effect.sync(release)
        );
      }
      if (admission.until - now > IN_WORKER_WAIT_MS)
        return yield* Effect.fail(new WatchRequestDeferred({ until: admission.until }));
      yield* sleep(admission.until - now);
    }
  });

/** Requests the person asked for in the moment, as `login`: counted, never held back. */
export const PersonRequests = (login: InstagramLogin = 'main') =>
  Layer.succeed(InstagramRequests, { login, fetch: personFetch(login) });

/**
 * Unattended Watch requests as `login`: one at a time, spaced, capped, and stopped by their own
 * 429 pause.
 */
export const WatchRequests = (login: InstagramLogin) =>
  Layer.succeed(InstagramRequests, {
    login,
    fetch: (url, init) => withWatchAdmission(login, requests => requests.fetch(url, init)),
  });

/** The login a Watch of `viewerId` runs as: the linked login when it is that account. */
export const loginOf = async (viewerId: string): Promise<InstagramLogin> =>
  (await readLinkedLogin())?.accountId === viewerId ? 'linked' : 'main';

/** Unattended requests as the login that owns Watches of `viewerId`. */
export const OwnerRequests = (viewerId: string) =>
  Layer.unwrapEffect(Effect.promise(() => loginOf(viewerId)).pipe(Effect.map(WatchRequests)));
