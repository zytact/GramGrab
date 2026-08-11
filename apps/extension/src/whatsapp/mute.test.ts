import { describe, expect, it, vi } from 'vite-plus/test';
import { makeOutputMemoryGuard } from './mute.ts';

describe('WhatsApp silent output memory guard', () => {
  it('cancels once when output crosses the remaining memory budget', () => {
    const cancel = vi.fn();
    const guard = makeOutputMemoryGuard(10, cancel);

    guard.onWrite({ end: 10 });
    expect(guard.hasExceeded()).toBe(false);
    expect(cancel).not.toHaveBeenCalled();

    guard.onWrite({ end: 11 });
    guard.onWrite({ end: 12 });
    expect(guard.hasExceeded()).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
