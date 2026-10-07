import { Schema } from 'effect';
import {
  AccountId,
  DeferredReason,
  KindCheckOutcome,
  ManualCheckFinished,
  ManualCheckPending,
  WatchKind,
  WatchSchedule,
  type ManualCheck,
} from '@gramgrab/protocol';
import { watchHold, type LedgerView } from '../instagram/request-state.ts';

/** The scheduler's persisted state. The options page reloads when it changes, to follow checks. */
export const SCHEDULER_KEY = 'watch-scheduler';

const EarlyRetry = Schema.Struct({ watchId: Schema.UUID, kind: WatchKind, at: Schema.Number });

const LoginSchedule = Schema.Struct({
  nextRoundAt: Schema.Number.pipe(Schema.int()),
  /** Watches of the current round still waiting for their turn, in order. */
  remaining: Schema.Array(Schema.UUID),
  /** The current round, whose Watches share one Instants feed. */
  roundId: Schema.optional(Schema.UUID),
  /** Watches whose Posts traversal continues this round once the remaining Watches had a turn. */
  catchUp: Schema.optional(Schema.Array(Schema.UUID)),
  earlyRetries: Schema.Array(EarlyRetry),
  manual: Schema.optional(
    Schema.Array(
      Schema.Struct({
        watchId: Schema.UUID,
        checkId: Schema.UUID,
        remainingKinds: Schema.Array(WatchKind),
        outcomes: Schema.optional(Schema.Array(KindCheckOutcome)),
        deferredUntil: Schema.optional(Schema.Number),
        deferredReason: Schema.optional(DeferredReason),
      })
    )
  ),
  /** Each Watch's last finished manual check, kept so the person can read its outcome later. */
  lastManual: Schema.optional(
    Schema.Array(
      Schema.Struct({
        watchId: Schema.UUID,
        finishedAt: Schema.Number,
        outcomes: Schema.Array(KindCheckOutcome),
      })
    )
  ),
});
export type LoginSchedule = Schema.Schema.Type<typeof LoginSchedule>;

export const SchedulerState = Schema.Struct({
  version: Schema.Literal(1),
  logins: Schema.Record({ key: AccountId, value: LoginSchedule }),
  startupHoldUntil: Schema.optional(Schema.Number),
  /** Set when the session was rejected; cleared when the person next verifies their login. */
  suspended: Schema.optional(Schema.Boolean),
});
export type SchedulerState = Schema.Schema.Type<typeof SchedulerState>;

const EMPTY: SchedulerState = { version: 1, logins: {} };

/** The stored scheduler state, or an empty one when it is missing or unreadable. */
export function decodeSchedulerState(stored: unknown): SchedulerState {
  const decoded = Schema.decodeUnknownOption(SchedulerState)(stored);
  return decoded._tag === 'Some' ? decoded.value : EMPTY;
}

/**
 * When the login's next round starts, how much of this round is left, and what holds Watch
 * requests back at `now`. The options page derives it from storage too, so it stays current
 * without asking Instagram.
 */
export function watchSchedule(
  state: SchedulerState,
  ledger: LedgerView | undefined,
  viewerId: string,
  now: number
): WatchSchedule {
  const login = state.logins[viewerId];
  const hold = ledger && watchHold(ledger, now);
  return WatchSchedule.make({
    ...(login ? { nextRoundAt: login.nextRoundAt } : {}),
    roundRemaining: login?.remaining.length ?? 0,
    ...(hold?.pausedUntil ? { pausedUntil: hold.pausedUntil } : {}),
    ...(hold?.capped ? { cappedUntil: hold.until } : {}),
    suspended: state.suspended ?? false,
  });
}

/** Each Watch's queued or running manual check, or else its last finished one. */
export function manualChecks(
  schedule: LoginSchedule | undefined
): ReadonlyMap<string, ManualCheck> {
  const checks = new Map<string, ManualCheck>();
  for (const last of schedule?.lastManual ?? [])
    checks.set(
      last.watchId,
      ManualCheckFinished.make({ finishedAt: last.finishedAt, outcomes: last.outcomes })
    );
  for (const job of schedule?.manual ?? [])
    checks.set(
      job.watchId,
      ManualCheckPending.make({
        remainingKinds: job.remainingKinds,
        outcomes: job.outcomes ?? [],
        ...(job.deferredUntil === undefined || job.deferredReason === undefined
          ? {}
          : { deferredUntil: job.deferredUntil, deferredReason: job.deferredReason }),
      })
    );
  return checks;
}
