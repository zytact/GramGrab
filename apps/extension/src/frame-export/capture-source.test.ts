import { Either } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { canvasToJpeg, drawModified } from '../rotation/media.ts';
import { captureFrameFromSource } from './capture-source.ts';

const media = vi.hoisted(() => ({
  track: undefined as
    | {
        computeDuration: () => Promise<number>;
        getFirstTimestamp: () => Promise<number>;
      }
    | undefined,
  getCanvas: vi.fn<(timestamp: number) => Promise<{ canvas: object } | null>>(),
  dispose: vi.fn(),
}));

vi.mock('mediabunny', () => ({
  ALL_FORMATS: [],
  BlobSource: class {},
  Input: class {
    getPrimaryVideoTrack = () => Promise.resolve(media.track);
    dispose = media.dispose;
  },
  CanvasSink: class {
    getCanvas = media.getCanvas;
  },
}));

vi.mock('../rotation/media.ts', () => ({ drawModified: vi.fn(), canvasToJpeg: vi.fn() }));

const frame = { width: 640, height: 360 };
const canvas = {};
const jpeg = new Blob(['jpeg'], { type: 'image/jpeg' });

function videoTrack(duration: number, firstTimestamp = 0) {
  media.track = {
    computeDuration: () => Promise.resolve(duration),
    getFirstTimestamp: () => Promise.resolve(firstTimestamp),
  };
}

const capture = (timestampSeconds: number) =>
  captureFrameFromSource(new Blob(['video']), timestampSeconds, { rotation: 90 });

async function failureReason(timestampSeconds = 3) {
  const result = await capture(timestampSeconds);
  return Either.isLeft(result) ? result.left.reason : undefined;
}

describe('captureFrameFromSource', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    videoTrack(10);
    media.getCanvas.mockResolvedValue({ canvas: frame });
    vi.mocked(drawModified).mockReturnValue(canvas as HTMLCanvasElement);
    vi.mocked(canvasToJpeg).mockResolvedValue(jpeg);
  });

  afterEach(() => vi.useRealTimers());

  it('encodes the decoded frame with its modifiers and frees the input', async () => {
    expect(await capture(4.5)).toEqual(Either.right(jpeg));
    expect(media.getCanvas).toHaveBeenCalledWith(4.5);
    expect(drawModified).toHaveBeenCalledWith(frame, 640, 360, { rotation: 90 });
    expect(media.dispose).toHaveBeenCalledOnce();
  });

  it('clamps the timestamp to the last whole second and the first frame', async () => {
    await capture(30);
    videoTrack(10, 0.5);
    await capture(0);

    expect(media.getCanvas.mock.calls).toEqual([[9], [0.5]]);
  });

  it('names why a frame could not be produced', async () => {
    media.track = undefined;
    expect(await failureReason()).toBe('no-frame');

    videoTrack(0);
    expect(await failureReason()).toBe('no-duration');

    videoTrack(10);
    media.getCanvas.mockRejectedValueOnce(new Error('unsupported codec'));
    expect(await failureReason()).toBe('no-frame');

    vi.mocked(drawModified).mockReturnValueOnce(undefined);
    expect(await failureReason()).toBe('no-canvas');

    vi.mocked(canvasToJpeg).mockResolvedValueOnce(null);
    expect(await failureReason()).toBe('no-blob');
    expect(media.dispose).toHaveBeenCalledTimes(5);
  });

  it('times out a decode that never finishes and still frees the input', async () => {
    vi.useFakeTimers();
    media.getCanvas.mockReturnValue(new Promise(() => {}));

    const result = failureReason();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(await result).toBe('timeout');
    expect(media.dispose).toHaveBeenCalledOnce();
  });
});
