import { vi } from 'vite-plus/test';

export async function settled<T>(promise: Promise<T>): Promise<T> {
  let outcome: PromiseSettledResult<T> | undefined;
  void Promise.allSettled([promise]).then(([result]) => {
    outcome = result;
  });
  while (!outcome) await vi.advanceTimersByTimeAsync(1_000);
  if (outcome.status === 'rejected') throw outcome.reason;
  return outcome.value;
}
