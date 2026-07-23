import { describe, expect, it } from 'vite-plus/test';
import { DEFAULT_MEDIA_RATIO, resolveMediaRatio } from './media-ratio';

describe('resolveMediaRatio', () => {
  it('prefers valid metadata over intrinsic dimensions', () => {
    expect(resolveMediaRatio(1080, 1920, 1600, 900)).toBe(1080 / 1920);
  });

  it('uses valid intrinsic dimensions when metadata is unusable', () => {
    expect(resolveMediaRatio(0, 1920, 1600, 900)).toBe(16 / 9);
  });

  it('uses the stable default for absent, one-sided, and non-finite dimensions', () => {
    expect(resolveMediaRatio(undefined, undefined)).toBe(DEFAULT_MEDIA_RATIO);
    expect(resolveMediaRatio(1080, undefined)).toBe(DEFAULT_MEDIA_RATIO);
    expect(resolveMediaRatio(Infinity, 10)).toBe(DEFAULT_MEDIA_RATIO);
  });
});
