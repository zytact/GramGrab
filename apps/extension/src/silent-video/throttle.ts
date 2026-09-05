/**
 * Silent-video progress ticks come from every encoded packet and every network chunk, and each one
 * crosses the worker boundary, gets decoded, and updates React state. Intermediate ticks are rate
 * limited to this interval.
 */
const PROGRESS_INTERVAL_MS = 150;

export interface ProgressTick<Phase extends string> {
  readonly phase: Phase;
  readonly progress: number;
}

/**
 * Wraps a progress sink so intermediate ticks are emitted at most once per interval. A phase change
 * and the first tick that completes a phase always go out, so the receiver still sees the shape of
 * the work even when the source emits thousands of times.
 */
export function throttleProgress<Phase extends string>(
  emit: (tick: ProgressTick<Phase>) => void,
  now: () => number = Date.now,
  intervalMs: number = PROGRESS_INTERVAL_MS
): (tick: ProgressTick<Phase>) => void {
  let lastPhase: Phase | undefined;
  let lastEmittedAt = Number.NEGATIVE_INFINITY;
  let phaseCompleted = false;
  return tick => {
    const phaseChanged = tick.phase !== lastPhase;
    const completesPhase = tick.progress >= 1 && (phaseChanged || !phaseCompleted);
    const at = now();
    if (!phaseChanged && !completesPhase && at - lastEmittedAt < intervalMs) return;
    lastPhase = tick.phase;
    lastEmittedAt = at;
    phaseCompleted = tick.progress >= 1;
    emit(tick);
  };
}
