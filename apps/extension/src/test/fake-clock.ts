import { vi } from 'vite-plus/test';

export async function settled<T>(promise: Promise<T>): Promise<T> {
  let answer: { value: T } | undefined;
  void promise.then(value => {
    answer = { value };
  });
  while (!answer) await vi.advanceTimersByTimeAsync(1_000);
  return answer.value;
}
