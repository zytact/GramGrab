import { Either, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { AttemptOperationSchema } from '../download/attempt.ts';
import { getDownloadCalls, getMockBrowser, resetBrowserMocks } from '../test/setup.ts';
import { captureFrameFromSource } from '../frame-export/capture-source.ts';
import { WhatsAppCaptureDescriptor } from './contracts.ts';
import { makeWhatsAppCaptureSnapshot } from './snapshot.ts';
import { exportWhatsAppFrame } from './export.ts';

vi.mock('../frame-export/capture-source.ts', () => ({ captureFrameFromSource: vi.fn() }));

let revokeObjectUrl: ReturnType<typeof vi.fn<(url: string) => void>>;

const operation = Schema.decodeUnknownSync(AttemptOperationSchema)({
  operationId: '00000000-0000-4000-8000-000000000001',
  requestId: '00000000-0000-4000-8000-000000000002',
  itemIndex: 0,
  url: 'blob:captured-status',
  originalUrl: 'blob:captured-status',
  originalFilename: 'whatsapp-visible-status.mp4',
  filename: 'whatsapp-visible-status_frame_00m01s.jpg',
  mediaType: 'video',
  mode: 'frame',
  displayIndex: 0,
  frameTimestampSeconds: 1,
});

const descriptor = Schema.decodeUnknownSync(WhatsAppCaptureDescriptor)({
  captureId: '123e4567-e89b-42d3-a456-426614174000',
  kind: 'video',
  mimeType: 'video/mp4',
  byteLength: 3,
  width: 640,
  height: 480,
  durationMs: 1_000,
  capturedAt: 1,
  retentionDeadline: 1_787_000_000_000,
});

describe('exportWhatsAppFrame', () => {
  beforeEach(() => {
    resetBrowserMocks();
    vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:captured-status')
      .mockReturnValueOnce('blob:exported-frame');
    revokeObjectUrl = vi.fn<(url: string) => void>();
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeObjectUrl);
    vi.mocked(captureFrameFromSource).mockResolvedValue(Either.right(new Blob(['frame'])));
  });

  afterEach(() => vi.useRealTimers());

  it('releases the capture immediately and the frame URL when the download terminates', async () => {
    const snapshot = makeWhatsAppCaptureSnapshot(descriptor, [new Uint8Array([1, 2, 3])]);
    const release = vi.fn(() => snapshot.release());
    let resolveHistory: ((response: { saved: false }) => void) | undefined;
    getMockBrowser().runtime.sendMessage.mockReturnValueOnce(
      new Promise(resolve => {
        resolveHistory = resolve;
      })
    );

    const exported = exportWhatsAppFrame(
      {
        descriptor,
        snapshot,
        filename: 'whatsapp-visible-status.mp4',
        download: async () => ({ downloadId: 1, filename: 'whatsapp-visible-status.mp4' }),
        release,
      },
      operation
    );

    await vi.waitFor(() => expect(getDownloadCalls()).toHaveLength(1));
    expect(release).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:captured-status');
    expect(revokeObjectUrl).not.toHaveBeenCalledWith('blob:exported-frame');

    const onChanged = getMockBrowser().downloads.onChanged.addListener.mock.calls[0]?.[0];
    if (!onChanged) throw new Error('Expected a download listener.');
    onChanged({ id: 1, state: { current: 'complete' } });
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:exported-frame');

    if (!resolveHistory) throw new Error('Expected History persistence to be pending.');
    resolveHistory({ saved: false });

    await expect(exported).resolves.toMatchObject({
      status: 'started',
      warning: { code: 'HISTORY_SAVE_FAILED' },
    });
  });

  it('cancels a frame download that is still active at the retention ceiling', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_786_999_940_000);
    const snapshot = makeWhatsAppCaptureSnapshot(descriptor, [new Uint8Array([1, 2, 3])]);

    await exportWhatsAppFrame(
      {
        descriptor,
        snapshot,
        filename: 'whatsapp-visible-status.mp4',
        download: async () => ({ downloadId: 1, filename: 'whatsapp-visible-status.mp4' }),
        release: () => snapshot.release(),
      },
      operation
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(getMockBrowser().downloads.cancel).toHaveBeenCalledExactlyOnceWith(1);
  });
});
