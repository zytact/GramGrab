import { Schema } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { AttemptOperationSchema } from '../download/attempt.ts';
import { browser } from '../lib/browser.ts';
import { getDownloadCalls, resetBrowserMocks } from '../test/setup.ts';
import { executeRotatedExport } from './executor.ts';
import { rotateImage } from './media.ts';

vi.mock('./media.ts', () => ({ rotateImage: vi.fn(), rotateVideo: vi.fn() }));

const operation = {
  ...Schema.decodeUnknownSync(AttemptOperationSchema)({
    operationId: '00000000-0000-4000-8000-000000000001',
    requestId: '00000000-0000-4000-8000-000000000002',
    itemIndex: 0,
    url: 'https://cdn.instagram.com/photo.jpg',
    filename: 'post_1.jpg',
    originalUrl: 'https://cdn.instagram.com/photo.jpg',
    originalFilename: 'post_1.jpg',
    mediaType: 'image',
    mode: 'direct',
    displayIndex: 0,
  }),
  rotation: 90 as const,
};

const respond = (status: number) =>
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status < 400,
      status,
      statusText: '',
      blob: () => Promise.resolve(new Blob(['photo'])),
    })
  );

describe('executeRotatedExport', () => {
  beforeEach(() => {
    resetBrowserMocks();
    respond(200);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:rotated');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.mocked(rotateImage).mockResolvedValue(new Blob(['rotated']));
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({});
  });

  it('downloads the rotated file and records its rotation in history', async () => {
    const result = await executeRotatedExport(
      operation,
      'https://www.instagram.com/p/abc/',
      'source'
    );

    expect(result.status).toBe('started');
    expect(rotateImage).toHaveBeenCalledWith(expect.any(Blob), 90);
    expect(getDownloadCalls()).toEqual([
      { url: 'blob:rotated', filename: 'post_1.jpg', saveAs: false },
    ]);
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'RECORD_DIRECT_EXPORT',
        item: expect.objectContaining({ rotation: 90 }),
      })
    );
  });

  it('classifies an expired media URL without downloading', async () => {
    respond(403);

    const result = await executeRotatedExport(
      operation,
      'https://www.instagram.com/p/abc/',
      'source'
    );

    expect(result).toMatchObject({ status: 'failed', failure: { code: 'MEDIA_URL_EXPIRED' } });
    expect(getDownloadCalls()).toEqual([]);
  });

  it('offers the original when the media cannot be rotated', async () => {
    vi.mocked(rotateImage).mockRejectedValue(new Error('decode failed'));

    const result = await executeRotatedExport(
      operation,
      'https://www.instagram.com/p/abc/',
      'source'
    );

    expect(result).toMatchObject({
      status: 'failed',
      failure: { code: 'ROTATION_FAILED', phase: 'rotation' },
    });
    expect(getDownloadCalls()).toEqual([]);
    expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
  });
});
