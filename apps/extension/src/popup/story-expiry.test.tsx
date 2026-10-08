import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { StoryExpiry } from './story-expiry';

const now = Date.parse('2026-10-08T00:00:00.000Z');

describe('Story expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    [3 * 60 * 60_000 + 59 * 60_000, 'Expires in 3h'],
    [60 * 60_000, 'Expires in 1h'],
    [59 * 60_000, 'Expires in 59m'],
    [60_000, 'Expires in 1m'],
    [59_000, 'Expires in <1m'],
    [0, 'Expired'],
    [-60_000, 'Expired'],
  ])('formats %i ms remaining as %s', (remaining, label) => {
    const expiresAt = new Date(now + remaining).toISOString();
    render(<StoryExpiry expiresAt={expiresAt} />);
    expect(screen.getByText(label).getAttribute('datetime')).toBe(expiresAt);
  });

  it.each([undefined, 'invalid'])('omits an unknown expiry: %s', expiresAt => {
    const { container } = render(<StoryExpiry expiresAt={expiresAt} />);
    expect(container.textContent).toBe('');
  });

  it('refreshes the remaining time and marks a Story expired while it stays open', async () => {
    render(<StoryExpiry expiresAt={new Date(now + 2 * 60_000).toISOString()} />);
    expect(screen.getByText('Expires in 2m')).toBeDefined();
    await act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText('Expires in 1m')).toBeDefined();
    await act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText('Expired')).toBeDefined();
  });
});
