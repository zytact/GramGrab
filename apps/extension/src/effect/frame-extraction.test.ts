import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { VideoFrameExtractionFailed } from './errors.ts';
import { captureFrameFromVideoEffect } from './frame-extraction.ts';

function makeVideo(overrides: Partial<HTMLVideoElement> = {}): HTMLVideoElement {
  const listeners: Record<string, EventListenerOrEventListenerObject[]> = {};
  const video = {
    readyState: 4,
    duration: 10,
    videoWidth: 640,
    videoHeight: 480,
    currentTime: 0,
    addEventListener(name: string, handler: EventListenerOrEventListenerObject) {
      (listeners[name] ??= []).push(handler);
    },
    removeEventListener(name: string, handler: EventListenerOrEventListenerObject) {
      listeners[name] = (listeners[name] ?? []).filter(h => h !== handler);
    },
    _listeners: listeners,
    ...overrides,
  } as unknown as HTMLVideoElement & { _listeners: typeof listeners };
  return video;
}

function fireEvent(
  video: HTMLVideoElement & { _listeners?: Record<string, EventListenerOrEventListenerObject[]> },
  name: string
) {
  const handlers = video._listeners?.[name] ?? [];
  handlers.forEach(h => {
    if (typeof h === 'function') h(new Event(name));
    else h.handleEvent(new Event(name));
  });
}

function makeCanvas() {
  const ctx = { drawImage: vi.fn() };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn().mockReturnValue(ctx),
    toBlob: vi.fn().mockImplementation((cb: (b: Blob | null) => void) => {
      cb(new Blob(['img'], { type: 'image/jpeg' }));
    }),
  };
  return canvas;
}

describe('captureFrameFromVideoEffect', () => {
  let originalCreateElement: typeof document.createElement;
  let currentCanvas: ReturnType<typeof makeCanvas>;

  beforeEach(() => {
    originalCreateElement = document.createElement.bind(document);
    currentCanvas = makeCanvas();
    document.createElement = (tag: string) => {
      if (tag === 'canvas') return currentCanvas as unknown as HTMLCanvasElement;
      return originalCreateElement(tag);
    };
  });

  afterEach(() => {
    document.createElement = originalCreateElement;
    vi.useRealTimers();
  });

  it('captures a frame from a ready video', async () => {
    const video = makeVideo({ readyState: 4, duration: 10 }) as HTMLVideoElement & {
      _listeners: Record<string, EventListenerOrEventListenerObject[]>;
    };

    const resultPromise = Effect.runPromise(
      captureFrameFromVideoEffect(video, 3).pipe(Effect.either)
    );

    // seeked event fires after currentTime is set
    await Promise.resolve();
    fireEvent(video, 'seeked');

    const result = await resultPromise;
    expect(result._tag).toBe('Right');
    expect(video.currentTime).toBe(3);
    if (result._tag === 'Right') {
      expect(result.right).toBeInstanceOf(Blob);
    }
  });

  it('waits for loadedmetadata when readyState < 1', async () => {
    const video = makeVideo({ readyState: 0, duration: 10 }) as HTMLVideoElement & {
      _listeners: Record<string, EventListenerOrEventListenerObject[]>;
    };

    const resultPromise = Effect.runPromise(
      captureFrameFromVideoEffect(video, 3).pipe(Effect.either)
    );

    for (let i = 0; i < 5; i++) await Promise.resolve();
    fireEvent(video, 'loadedmetadata');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    fireEvent(video, 'loadeddata');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    fireEvent(video, 'seeked');

    const result = await resultPromise;
    expect(result._tag).toBe('Right');
  });

  it('waits for the first decoded frame at timestamp zero', async () => {
    const video = makeVideo({ readyState: 1, duration: 10, currentTime: 0 }) as HTMLVideoElement & {
      _listeners: Record<string, EventListenerOrEventListenerObject[]>;
    };

    const resultPromise = Effect.runPromise(
      captureFrameFromVideoEffect(video, 0).pipe(Effect.either)
    );
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(currentCanvas.getContext).not.toHaveBeenCalled();

    fireEvent(video, 'loadeddata');

    const result = await resultPromise;
    expect(result._tag).toBe('Right');
    expect(currentCanvas.getContext).toHaveBeenCalled();
  });

  it('fails with timeout when loadedmetadata never fires', async () => {
    vi.useFakeTimers();
    const video = makeVideo({ readyState: 0, duration: 10 }) as HTMLVideoElement & {
      _listeners: Record<string, EventListenerOrEventListenerObject[]>;
    };

    const resultPromise = Effect.runPromise(
      captureFrameFromVideoEffect(video, 3).pipe(Effect.either)
    );

    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect(result.left).toBeInstanceOf(VideoFrameExtractionFailed);
      expect((result.left as VideoFrameExtractionFailed).reason).toBe('timeout');
    }
  });

  it('removes the event listener when loadedmetadata times out', async () => {
    vi.useFakeTimers();
    const video = makeVideo({ readyState: 0 }) as HTMLVideoElement & {
      _listeners: Record<string, EventListenerOrEventListenerObject[]>;
    };
    const removeSpy = vi.spyOn(video, 'removeEventListener');

    const resultPromise = Effect.runPromise(
      captureFrameFromVideoEffect(video, 3).pipe(Effect.either)
    );
    await vi.runAllTimersAsync();
    await resultPromise;

    expect(removeSpy).toHaveBeenCalledWith('loadedmetadata', expect.any(Function));
  });

  it('fails with no-duration when duration is 0', async () => {
    const video = makeVideo({ readyState: 4, duration: 0 }) as HTMLVideoElement & {
      _listeners: Record<string, EventListenerOrEventListenerObject[]>;
    };

    const result = await Effect.runPromise(
      captureFrameFromVideoEffect(video, 3).pipe(Effect.either)
    );
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect((result.left as VideoFrameExtractionFailed).reason).toBe('no-duration');
    }
  });

  it('fails with no-frame when videoWidth is 0 after seek', async () => {
    const video = makeVideo({
      readyState: 4,
      duration: 10,
      videoWidth: 0,
      videoHeight: 0,
    }) as HTMLVideoElement & { _listeners: Record<string, EventListenerOrEventListenerObject[]> };

    const resultPromise = Effect.runPromise(
      captureFrameFromVideoEffect(video, 3).pipe(Effect.either)
    );
    await Promise.resolve();
    fireEvent(video, 'seeked');
    const result = await resultPromise;
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect((result.left as VideoFrameExtractionFailed).reason).toBe('no-frame');
    }
  });

  it('fails with no-blob when toBlob yields null', async () => {
    (currentCanvas.toBlob as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: (b: Blob | null) => void) => cb(null)
    );

    const video = makeVideo({ readyState: 4, duration: 10 }) as HTMLVideoElement & {
      _listeners: Record<string, EventListenerOrEventListenerObject[]>;
    };

    const resultPromise = Effect.runPromise(
      captureFrameFromVideoEffect(video, 3).pipe(Effect.either)
    );
    await Promise.resolve();
    fireEvent(video, 'seeked');
    const result = await resultPromise;
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect((result.left as VideoFrameExtractionFailed).reason).toBe('no-blob');
    }
  });
});
