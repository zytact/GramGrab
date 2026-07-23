import { Effect, Layer } from 'effect';
import { describe, expect, it, vi } from 'vite-plus/test';
import { DownloadMediaResponse } from './contracts.ts';
import {
  executeExportPlan,
  ExportCandidate,
  ExportEvents,
  ExportExecution,
  ExportPlan,
  planExportOperations,
} from './coordinator.ts';

const candidate = (overrides: Partial<ExportCandidate> = {}) =>
  ExportCandidate.make({
    index: 0,
    type: 'video',
    url: 'https://cdn.example/video.mp4',
    filenameHint: 'post',
    selected: true,
    frameEnabled: false,
    frameTimestampSeconds: 0,
    removeAudio: false,
    ...overrides,
  });

describe('export coordinator planning', () => {
  it('plans only selected items with stable display and media identity', () => {
    const operations = planExportOperations([
      candidate({ itemIndex: 4, mediaId: 'media-1' }),
      candidate({ index: 1, selected: false }),
    ]);

    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      itemIndex: 4,
      mediaId: 'media-1',
      displayIndex: 0,
      mode: 'direct',
      filename: 'post_1.mp4',
    });
  });

  it('gives silent export precedence over frame export', () => {
    const [operation] = planExportOperations([
      candidate({
        frameEnabled: true,
        frameTimestampSeconds: 7,
        frameDurationSeconds: 10,
        removeAudio: true,
      }),
    ]);

    expect(operation).toMatchObject({ mode: 'silent', filename: 'post_1_silent.mp4' });
    expect(operation).not.toHaveProperty('frameTimestampSeconds');
  });

  it('clamps frame timestamps and creates the frame filename', () => {
    const [operation] = planExportOperations([
      candidate({ frameEnabled: true, frameTimestampSeconds: 12, frameDurationSeconds: 8 }),
    ]);

    expect(operation?.mode).toBe('frame');
    expect(operation?.frameTimestampSeconds).toBeLessThan(8);
    expect(operation?.filename).toMatch(/^post_frame_/u);
  });

  it('continues a mixed plan when silent preflight rejects', async () => {
    const operations = planExportOperations([
      candidate({ removeAudio: true }),
      candidate({ index: 1, type: 'image' }),
    ]);
    const direct = vi.fn(async () => DownloadMediaResponse.make({ results: [] }));
    const settle = vi.fn();
    const execution = Layer.succeed(ExportExecution, {
      frame: vi.fn(),
      direct,
      silent: vi.fn(async () => {
        throw new Error('preflight failed');
      }),
    });
    const events = Layer.succeed(ExportEvents, { progress: vi.fn(), settle });

    await Effect.runPromise(
      executeExportPlan(ExportPlan.make({ operations }), new Set()).pipe(
        Effect.provide(Layer.merge(execution, events))
      )
    );

    expect(direct).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledTimes(2);
  });
});
