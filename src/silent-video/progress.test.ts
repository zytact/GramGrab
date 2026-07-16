import { describe, expect, it } from 'vite-plus/test';
import { requestIdFrom } from '../download/contracts.ts';
import type { AttemptEntry, AttemptOperation, AttemptOutcome } from '../download/attempt.ts';
import { silentProgressMessage } from './progress.ts';

const operation = (index: number): AttemptOperation => ({
  requestId: requestIdFrom(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`),
  itemIndex: index,
  displayIndex: index,
  url: `https://example.com/${index}.mp4`,
  filename: `${index}.mp4`,
  mediaType: 'video',
  mode: 'silent',
});

const entry = (index: number, outcome: AttemptOutcome): AttemptEntry => ({
  operation: operation(index),
  outcome,
});

describe('silent video progress message', () => {
  it.each([
    ['queued', 0, 'Waiting to inspect video…'],
    ['inspecting', 0.25, 'Inspecting video… 25%'],
    ['processing', 0.5, 'Removing audio… 50%'],
    ['validating', 0.75, 'Validating silent video… 75%'],
    ['downloading', 1, 'Download started'],
  ])('describes %s progress truthfully', (phase, progress, expected) => {
    expect(silentProgressMessage([entry(1, { status: 'pending', phase, progress })])).toBe(
      expected
    );
  });

  it('selects active work instead of a completed earlier item', () => {
    expect(
      silentProgressMessage([
        entry(1, { status: 'accepted' }),
        entry(2, { status: 'pending', phase: 'processing', progress: 0.4 }),
      ])
    ).toBe('Removing audio… 40%');
  });

  it('prefers processing work over lower-priority queued work', () => {
    expect(
      silentProgressMessage([
        entry(1, { status: 'pending', phase: 'queued', progress: 0 }),
        entry(2, { status: 'pending', phase: 'processing', progress: 0.6 }),
      ])
    ).toBe('Removing audio… 60%');
  });
});
