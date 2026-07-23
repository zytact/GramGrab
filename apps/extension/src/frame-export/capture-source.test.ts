import { Either } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { VideoFrameExtractionFailed } from '../effect/errors.ts';
import { captureFrameFromSource } from './capture-source.ts';

describe('captureFrameFromSource', () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  });

  it('recreates the video and retries one metadata timeout', async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce(Either.left(new VideoFrameExtractionFailed({ reason: 'timeout' })))
      .mockResolvedValueOnce(Either.right(new Blob(['frame'])));

    const result = await captureFrameFromSource('blob:video', 0, capture);

    expect(Either.isRight(result)).toBe(true);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls[0]?.[0]).not.toBe(capture.mock.calls[1]?.[0]);
    expect(document.querySelectorAll('video')).toHaveLength(0);
  });

  it('does not retry a non-timeout frame failure', async () => {
    const capture = vi
      .fn()
      .mockResolvedValue(Either.left(new VideoFrameExtractionFailed({ reason: 'no-frame' })));

    await captureFrameFromSource('blob:video', 0, capture);

    expect(capture).toHaveBeenCalledTimes(1);
  });
});
