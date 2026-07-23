import { Either, Schema } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { AttemptOperationSchema } from '../download/attempt.ts';
import { browser } from '../lib/browser.ts';
import { captureFrameFromSource } from './capture-source.ts';
import { executeFrameExport } from './executor.ts';

vi.mock('./capture-source.ts', () => ({ captureFrameFromSource: vi.fn() }));

const operation = Schema.decodeUnknownSync(AttemptOperationSchema)({
  operationId: '00000000-0000-4000-8000-000000000001',
  requestId: '00000000-0000-4000-8000-000000000002',
  itemIndex: 4,
  mediaId: 'media-5',
  url: 'https://cdn.instagram.com/video.mp4',
  filename: 'story_5_frame.jpg',
  originalUrl: 'https://cdn.instagram.com/video.mp4',
  originalFilename: 'story_5.mp4',
  mediaType: 'video',
  mode: 'frame',
  displayIndex: 4,
  frameTimestampSeconds: 7.5,
});

describe('executeFrameExport', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        blob: () => Promise.resolve(new Blob(['video'])),
      })
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:media');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.mocked(captureFrameFromSource).mockResolvedValue(Either.right(new Blob(['frame'])));
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({ error: undefined });
  });

  it('preserves a non-zero timestamp through capture, download, and history', async () => {
    const phases: string[] = [];
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL');

    const result = await executeFrameExport(
      operation,
      'https://www.instagram.com/stories/example/',
      { onPhase: phase => phases.push(phase) }
    );

    expect(result.status).toBe('started');
    expect(captureFrameFromSource).toHaveBeenCalledWith('blob:media', 7.5);
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'DOWNLOAD_FRAME_EXPORT',
        item: expect.objectContaining({ itemIndex: 4, frameTimestampSeconds: 7.5 }),
      })
    );
    expect(phases).toEqual(['frame-metadata', 'frame-export']);
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:media');
  });

  it('defaults an omitted operation timestamp to zero', async () => {
    const withoutTimestamp = Schema.decodeUnknownSync(AttemptOperationSchema)({
      ...operation,
      frameTimestampSeconds: undefined,
    });

    await executeFrameExport(withoutTimestamp, 'https://www.instagram.com/p/example/');

    expect(captureFrameFromSource).toHaveBeenCalledWith('blob:media', 0);
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ item: expect.objectContaining({ frameTimestampSeconds: 0 }) })
    );
  });
});
