import { Option, Schema } from 'effect';

export const HOUR_MS = 60 * 60_000;
export const HOURLY_REQUEST_CAP = 60;

export const LEDGER_KEY = 'instagram-requests';

export class RequestPause extends Schema.Class<RequestPause>('RequestPause')({
  until: Schema.Number,
  level: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
}) {}

export class LedgerState extends Schema.Class<LedgerState>('LedgerState')({
  version: Schema.Literal(1),
  /** Start times of attempts in the last hour, oldest first. */
  attempts: Schema.Array(Schema.Number),
  /** The earliest time the next Watch attempt may start, set when any attempt ends. */
  nextWatchAt: Schema.Number,
  pause: Schema.optional(RequestPause),
}) {}

export type LedgerView = Pick<LedgerState, 'attempts' | 'nextWatchAt' | 'pause'>;

/** The stored ledger, or undefined when it is missing or unreadable. */
export const decodeLedger = (stored: unknown): LedgerView | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(LedgerState)(stored));

/**
 * What holds the next Watch attempt back, ignoring work in flight. `until` is a floor, since later
 * requests can push it back. `pausedUntil` is set while a 429 pause runs, and `capped` while the
 * rolling hour holds the cap's worth of attempts.
 */
type WatchHold = {
  readonly until: number;
  readonly pausedUntil?: number;
  readonly capped: boolean;
};

/** What holds Watch work back under `ledger` at `now`, or undefined when nothing does. */
export function watchHold(ledger: LedgerView, now: number): WatchHold | undefined {
  const recent = ledger.attempts.filter(at => at > now - HOUR_MS);
  const capacityAt =
    recent.length >= HOURLY_REQUEST_CAP
      ? recent[recent.length - HOURLY_REQUEST_CAP]! + HOUR_MS
      : now;
  const pausedUntil = ledger.pause && ledger.pause.until > now ? ledger.pause.until : undefined;
  const until = Math.max(now, ledger.nextWatchAt, capacityAt, pausedUntil ?? now);
  if (until <= now) return undefined;
  return { until, ...(pausedUntil ? { pausedUntil } : {}), capped: capacityAt > now };
}

