import { Schema } from 'effect';

/** The request ledger's persisted state. The options page reads it too, to follow the 429 pause. */
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

/** When the 429 pause in a stored ledger ends, or undefined when it holds none. */
export function storedPauseUntil(stored: unknown): number | undefined {
  const decoded = Schema.decodeUnknownOption(LedgerState)(stored);
  return decoded._tag === 'Some' ? decoded.value.pause?.until : undefined;
}
