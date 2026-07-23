import { Effect } from 'effect';
import { VideoFrameExtractionFailed } from './errors.ts';

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

export const captureFrameFromVideoEffect = (
  video: HTMLVideoElement,
  timestampSeconds: number
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

    const targetTime = Math.max(0, Math.min(Math.ceil(video.duration) - 1, timestampSeconds));
    if (Math.abs(video.currentTime - targetTime) > 0.01) {
      video.currentTime = targetTime;
      yield* waitForEvent(video, 'seeked');
    }

    if (!video.videoWidth || !video.videoHeight) {
      return yield* Effect.fail(new VideoFrameExtractionFailed({ reason: 'no-frame' }));
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return yield* Effect.fail(new VideoFrameExtractionFailed({ reason: 'no-canvas' }));
    }

    ctx.drawImage(video, 0, 0);
    const blob = yield* Effect.async<Blob | null, never>(resume => {
      canvas.toBlob(b => resume(Effect.succeed(b)), 'image/jpeg', 0.95);
    });

    if (!blob) {
      return yield* Effect.fail(new VideoFrameExtractionFailed({ reason: 'no-blob' }));
    }

    return blob;
  });
