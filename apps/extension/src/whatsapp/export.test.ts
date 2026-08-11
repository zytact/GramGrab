import { Either, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { AttemptOperationSchema } from '../download/attempt.ts';
import { getDownloadCalls, getMockBrowser, resetBrowserMocks } from '../test/setup.ts';
import { captureFrameFromSource } from '../frame-export/capture-source.ts';
import { WhatsAppCaptureDescriptor } from './contracts.ts';
import { normalizeWhatsAppSilentFailure } from '../errors/normalize.ts';
import { makeWhatsAppCaptureSnapshot } from './snapshot.ts';
import { exportWhatsAppFrame, exportWhatsAppSilent } from './export.ts';
import { createWhatsAppSilentVideo } from './mute.ts';

vi.mock('../frame-export/capture-source.ts', () => ({ captureFrameFromSource: vi.fn() }));
vi.mock('./mute.ts', () => ({ createWhatsAppSilentVideo: vi.fn() }));

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
    vi.mocked(createWhatsAppSilentVideo).mockResolvedValue(
      new Blob(['silent'], { type: 'video/mp4' })
    );
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

  it('cancels an active frame download and releases its URL at the retention ceiling', async () => {
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
    expect(getMockBrowser().downloads.cancel).toHaveBeenCalledWith(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:exported-frame');
  });

  it('mutes from the capture blob and uses a name-free muted filename', async () => {
    const snapshot = makeWhatsAppCaptureSnapshot(descriptor, [new Uint8Array([1, 2, 3])]);
    const inputBlob = snapshot.blob;
    const release = vi.fn(() => snapshot.release());
    const mutedOperation = {
      ...operation,
      mode: 'silent' as const,
      filename: 'whatsapp-visible-status-20260811T000000Z-muted.mp4',
    };

    const result = await exportWhatsAppSilent(
      {
        descriptor,
        snapshot,
        filename: 'whatsapp-visible-status-20260811T000000Z.mp4',
        download: async () => ({ downloadId: 1, filename: 'unused.mp4' }),
        release,
      },
      mutedOperation
    );

    expect(result.status).toBe('started');
    expect(createWhatsAppSilentVideo).toHaveBeenCalledWith(inputBlob, undefined);
    expect(getDownloadCalls()).toEqual([
      {
        url: 'blob:captured-status',
        filename: mutedOperation.filename,
        saveAs: false,
      },
    ]);
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:captured-status');
    expect(release).toHaveBeenCalledOnce();
  });

  it('reports peak-memory refusal with the silent memory failure code', async () => {
    const oversizedDescriptor = Schema.decodeUnknownSync(WhatsAppCaptureDescriptor)({
      captureId: '123e4567-e89b-42d3-a456-426614174000',
      kind: 'video',
      mimeType: 'video/mp4',
      byteLength: 33 * 1024 * 1024,
      width: 640,
      height: 480,
      durationMs: 1_000,
      capturedAt: 1,
      retentionDeadline: 1_787_000_000_000,
    });
    const snapshot = makeWhatsAppCaptureSnapshot(descriptor, [new Uint8Array([1, 2, 3])]);
    const release = vi.fn(() => snapshot.release());

    const result = await exportWhatsAppSilent(
      {
        descriptor: oversizedDescriptor,
        snapshot,
        filename: 'whatsapp-visible-status.mp4',
        download: async () => ({ downloadId: 1, filename: 'unused.mp4' }),
        release,
      },
      { ...operation, mode: 'silent', filename: 'whatsapp-visible-status-muted.mp4' }
    );

    expect(result).toMatchObject({
      status: 'failed',
      failure: { platform: 'whatsapp', code: 'SILENT_MEMORY_CAPACITY_EXCEEDED' },
    });
    expect(createWhatsAppSilentVideo).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('preserves typed silent processing failures instead of normalizing them as downloads', async () => {
    const snapshot = makeWhatsAppCaptureSnapshot(descriptor, [new Uint8Array([1, 2, 3])]);
    vi.mocked(createWhatsAppSilentVideo).mockRejectedValueOnce(
      normalizeWhatsAppSilentFailure('SILENT_REENCODE_FAILED', 'silent-reencode')
    );

    const result = await exportWhatsAppSilent(
      {
        descriptor,
        snapshot,
        filename: 'whatsapp-visible-status.mp4',
        download: async () => ({ downloadId: 1, filename: 'unused.mp4' }),
        release: () => snapshot.release(),
      },
      { ...operation, mode: 'silent', filename: 'whatsapp-visible-status-muted.mp4' }
    );

    expect(result).toMatchObject({
      status: 'failed',
      failure: { platform: 'whatsapp', code: 'SILENT_REENCODE_FAILED' },
    });
  });
});
