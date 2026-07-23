import { describe, expect, it } from 'vite-plus/test';
import {
  clampFrameSecond,
  defaultFrameSecond,
  formatFrameTimestamp,
  frameFilename,
  frameTimestampAriaValue,
  maximumFrameSecond,
} from './timestamp.ts';

describe('frame timestamp policy', () => {
  it.each([
    [0.4, 0],
    [1, 0],
    [1.1, 1],
    [5, 4],
    [5.1, 5],
    [Number.POSITIVE_INFINITY, undefined],
    [Number.NaN, undefined],
  ])('selects the last whole second before %s', (duration, expected) => {
    expect(maximumFrameSecond(duration)).toBe(expected);
  });

  it('defaults to five seconds when safe and clamps all values', () => {
    expect(defaultFrameSecond(12)).toBe(5);
    expect(defaultFrameSecond(2.1)).toBe(2);
    expect(clampFrameSecond(99, 5)).toBe(4);
    expect(clampFrameSecond(-1, 5)).toBe(0);
  });

  it('formats display, accessible values, and filenames consistently', () => {
    expect(formatFrameTimestamp(65)).toBe('01:05');
    expect(frameTimestampAriaValue(1)).toBe('1 second');
    expect(frameTimestampAriaValue(65)).toBe('65 seconds');
    expect(frameFilename('clip', 65)).toBe('clip_frame_01-05.jpg');
  });
});
