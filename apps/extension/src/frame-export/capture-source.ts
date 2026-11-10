import { Effect, Either } from 'effect';
import type { Input } from 'mediabunny';
import { VideoFrameExtractionFailed } from '../effect/errors.ts';
import { canvasToJpeg, drawModified, type Modifiers } from '../rotation/media.ts';

const DECODE_TIMEOUT = '15 seconds';

const failure = (reason: VideoFrameExtractionFailed['reason']) =>
  new VideoFrameExtractionFailed({ reason });

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: () => failure('no-frame') });

const decodeFrame = (input: Input, timestampSeconds: number) =>
  Effect.gen(function* () {
    const track = yield* attempt(() => input.getPrimaryVideoTrack());
    if (!track) return yield* failure('no-frame');
    const duration = yield* attempt(() => track.computeDuration());
    if (!Number.isFinite(duration) || duration <= 0) return yield* failure('no-duration');
    const firstTimestamp = yield* attempt(() => track.getFirstTimestamp());
    const at = Math.max(firstTimestamp, Math.min(Math.ceil(duration) - 1, timestampSeconds));
    const frame = yield* attempt(async () => {
      const { CanvasSink } = await import('../video/mediabunny.ts');
      return new CanvasSink(track).getCanvas(at);
    });
    return frame?.canvas ?? (yield* failure('no-frame'));
  });

/**
 * Decodes the frame shown at `timestampSeconds` with WebCodecs and encodes it as a JPEG with
 * `modifiers` applied. No media element is involved, so it works in a hidden or minimized page.
 */
export const captureFrameFromSource = (
  source: Blob,
  timestampSeconds: number,
  modifiers: Modifiers = {}
): Promise<Either.Either<Blob, VideoFrameExtractionFailed>> =>
  Effect.acquireUseRelease(
    attempt(async () => {
      const { openVideoInput } = await import('../video/mediabunny.ts');
      return openVideoInput(source);
    }),
    input =>
      Effect.gen(function* () {
        const frame = yield* decodeFrame(input, timestampSeconds).pipe(
          Effect.timeoutFail({ duration: DECODE_TIMEOUT, onTimeout: () => failure('timeout') })
        );
        const canvas = drawModified(frame, frame.width, frame.height, modifiers);
        if (!canvas) return yield* failure('no-canvas');
        const jpeg = yield* Effect.promise(() => canvasToJpeg(canvas));
        return jpeg ?? (yield* failure('no-blob'));
      }),
    input => Effect.sync(() => input.dispose())
  ).pipe(Effect.either, Effect.runPromise);
