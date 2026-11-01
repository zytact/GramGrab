import type { FailureCode } from '@gramgrab/protocol';
import type { MessageResponse } from '../messaging/contracts.ts';

export type Preview = MessageResponse<'WATCH_INBOX_PREVIEW'>;

/** Failures after which further preview requests would only add Instagram traffic. */
const HALTING = new Set<FailureCode>(['IG_RATE_LIMITED', 'IG_NOT_AUTHENTICATED']);

export const halts = ({ failure }: Preview) =>
  failure?._tag === 'CommandFailure' && HALTING.has(failure.failure.code);

/** Runs at most `max` tasks at once, starting queued ones in order. */
export function concurrencyLimit(max: number) {
  let running = 0;
  const queue: (() => void)[] = [];
  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const start = () => {
        running++;
        task()
          .then(resolve, reject)
          .finally(() => {
            running--;
            queue.shift()?.();
          });
      };
      if (running < max) start();
      else queue.push(start);
    });
}
