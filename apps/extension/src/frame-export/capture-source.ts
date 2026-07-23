import { Effect, Either } from 'effect';
import { captureFrameFromVideoEffect } from '../effect/frame-extraction.ts';
import type { VideoFrameExtractionFailed } from '../effect/errors.ts';

type Capture = (
  video: HTMLVideoElement,
  timestampSeconds: number
) => Promise<Either.Either<Blob, VideoFrameExtractionFailed>>;

const captureFrame: Capture = (video, timestampSeconds) =>
  Effect.runPromise(captureFrameFromVideoEffect(video, timestampSeconds).pipe(Effect.either));

export async function captureFrameFromSource(
  sourceUrl: string,
  timestampSeconds: number,
  capture: Capture = captureFrame
): Promise<Either.Either<Blob, VideoFrameExtractionFailed>> {
  const attempt = async () => {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.src = sourceUrl;
    document.body.append(video);
    try {
      const pending = capture(video, timestampSeconds);
      video.load();
      return await pending;
    } finally {
      video.removeAttribute('src');
      video.load();
      video.remove();
    }
  };
  const first = await attempt();
  return Either.isLeft(first) && first.left.reason === 'timeout' ? attempt() : first;
}
