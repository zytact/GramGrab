import { Effect } from 'effect';
import { VideoFrameExtractionFailed } from './errors.ts';
import type { Rotation } from '../rotation/contracts.ts';
import { canvasToJpeg, drawRotated } from '../rotation/media.ts';

const EVENT_TIMEOUT = '5 seconds';

const waitForEvent = (
  target: HTMLVideoElement,
  eventName: string
): Effect.Effect<void, VideoFrameExtractionFailed> =>
  Effect.async<void, VideoFrameExtractionFailed>((resume, signal) => {
    const cleanup = () => target.removeEventListener(eventName, handler);
    const handler = () => {
      cleanup();
      resume(Effect.void);
    };
    target.addEventListener(eventName, handler, { once: true });
    signal.addEventListener('abort', () => {
      cleanup();
    });
  }).pipe(
    Effect.timeoutFail({
      duration: EVENT_TIMEOUT,
      onTimeout: () => new VideoFrameExtractionFailed({ reason: 'timeout' }),
    })
  );

const seekToTimestamp = (
  video: HTMLVideoElement,
  timestampSeconds: number
): Effect.Effect<void, VideoFrameExtractionFailed> => {
  const targetTime = Math.max(0, Math.min(Math.ceil(video.duration) - 1, timestampSeconds));
  if (Math.abs(video.currentTime - targetTime) <= 0.01) return Effect.void;

  video.currentTime = targetTime;
  return waitForEvent(video, 'seeked');
};

const captureCanvasFrame = (
  video: HTMLVideoElement,
  rotation: Rotation | undefined
): Effect.Effect<Blob, VideoFrameExtractionFailed> =>
  Effect.gen(function* () {
    if (!video.videoWidth || !video.videoHeight) {
      return yield* Effect.fail(new VideoFrameExtractionFailed({ reason: 'no-frame' }));
    }

    const canvas = drawRotated(video, video.videoWidth, video.videoHeight, rotation);
    if (!canvas) {
      return yield* Effect.fail(new VideoFrameExtractionFailed({ reason: 'no-canvas' }));
    }

    const blob = yield* Effect.promise(() => canvasToJpeg(canvas));

    return yield* blob
      ? Effect.succeed(blob)
      : Effect.fail(new VideoFrameExtractionFailed({ reason: 'no-blob' }));
  });

export const captureFrameFromVideoEffect = (
  video: HTMLVideoElement,
  timestampSeconds: number,
  rotation?: Rotation
): Effect.Effect<Blob, VideoFrameExtractionFailed> =>
  Effect.gen(function* () {
    if (video.readyState < 1) {
      yield* waitForEvent(video, 'loadedmetadata');
    }

    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      return yield* Effect.fail(new VideoFrameExtractionFailed({ reason: 'no-duration' }));
    }

    if (video.readyState < 2) {
      yield* waitForEvent(video, 'loadeddata');
    }

    yield* seekToTimestamp(video, timestampSeconds);
    return yield* captureCanvasFrame(video, rotation);
  });
