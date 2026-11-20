import { Either, Schema } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { AttemptOperationSchema, type AttemptOperation } from '../download/attempt.ts';
import { getDownloadCalls, getMockBrowser, resetBrowserMocks } from '../test/setup.ts';
import { captureFrameFromSource } from '../frame-export/capture-source.ts';
import { modifyImage } from '../rotation/media.ts';
import { inspectSilentVideo, writeProcessedVideo } from '../silent-video/engine.ts';
import { normalizeWhatsAppSilentFailure } from '../errors/normalize.ts';
import { WhatsAppCaptureDescriptor } from './contracts.ts';
import { makeWhatsAppCaptureSnapshot } from './snapshot.ts';
import { exportWhatsAppEdited } from './export.ts';

vi.mock('../frame-export/capture-source.ts', () => ({ captureFrameFromSource: vi.fn() }));
vi.mock('../rotation/media.ts', () => ({ modifyImage: vi.fn(), rotateVideo: vi.fn() }));
vi.mock('../silent-video/engine.ts', () => ({
  inspectSilentVideo: vi.fn(),
  writeProcessedVideo: vi.fn(),
  validateProcessedVideo: vi.fn(),
}));

const crop = { x: 0.1, y: 0.2, width: 0.5, height: 0.6 };

const baseOperation = {
  operationId: '00000000-0000-4000-8000-000000000001',
  requestId: '00000000-0000-4000-8000-000000000002',
  itemIndex: 0,
  url: 'blob:captured-status',
  originalUrl: 'blob:captured-status',
  originalFilename: 'whatsapp-visible-status.mp4',
  filename: 'whatsapp-visible-status.mp4',
  mediaType: 'video',
  mode: 'direct',
  displayIndex: 0,
};

const operationWith = (fields: Record<string, unknown>): AttemptOperation =>
  Schema.decodeUnknownSync(AttemptOperationSchema)({ ...baseOperation, ...fields });

const descriptorOf = (kind: 'photo' | 'video') =>
  Schema.decodeUnknownSync(WhatsAppCaptureDescriptor)({
    captureId: '123e4567-e89b-42d3-a456-426614174000',
    kind,
    mimeType: kind === 'photo' ? 'image/jpeg' : 'video/mp4',
    byteLength: 3,
    width: 640,
    height: 480,
    ...(kind === 'video' ? { durationMs: 1_000 } : {}),
    capturedAt: 1,
  });

function handleOf(kind: 'photo' | 'video') {
  const descriptor = descriptorOf(kind);
  const snapshot = makeWhatsAppCaptureSnapshot(descriptor, [new Uint8Array([1, 2, 3])]);
  return {
    captured: snapshot.blob,
    handle: {
      descriptor,
      snapshot,
      filename: 'whatsapp-visible-status',
      download: async () => ({ downloadId: 1, filename: 'unused' }),
      release: vi.fn(() => snapshot.release()),
    },
  };
}

let createdBlobs: Blob[];
let revokeObjectUrl: ReturnType<typeof vi.fn<(url: string) => void>>;

describe('exportWhatsAppEdited', () => {
  beforeEach(() => {
    resetBrowserMocks();
    createdBlobs = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
      createdBlobs.push(blob as Blob);
      return 'blob:edited-output';
    });
    revokeObjectUrl = vi.fn<(url: string) => void>();
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeObjectUrl);
    vi.mocked(inspectSilentVideo).mockResolvedValue({
      copyCompatible: true,
      durationSeconds: 1,
    } as never);
    vi.mocked(writeProcessedVideo).mockImplementation(async (_file, target) => {
      Object.assign(target, { buffer: new ArrayBuffer(4) });
    });
  });

  it('downloads a photo turned and cropped from the captured bytes', async () => {
    const { captured, handle } = handleOf('photo');
    const edited = new Blob(['edited'], { type: 'image/jpeg' });
    vi.mocked(modifyImage).mockResolvedValueOnce(edited);
    const operation = operationWith({
      mediaType: 'image',
      filename: 'whatsapp-visible-status.jpg',
      rotation: 90,
      crop,
    });

    const result = await exportWhatsAppEdited(handle, operation);

    expect(result.status).toBe('started');
    expect(modifyImage).toHaveBeenCalledWith(captured, operation);
    expect(createdBlobs).toEqual([edited]);
    expect(getDownloadCalls()).toEqual([
      { url: 'blob:edited-output', filename: 'whatsapp-visible-status.jpg', saveAs: false },
    ]);
    expect(handle.release).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).not.toHaveBeenCalled();
    const onChanged = getMockBrowser().downloads.onChanged.addListener.mock.calls[0]?.[0];
    onChanged?.({ id: 1, state: { current: 'complete' } });
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:edited-output');
    expect(getMockBrowser().runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'RECORD_WHATSAPP_HISTORY',
        receipt: expect.objectContaining({ mediaKind: 'photo' }),
      })
    );
  });

  it.each([
    ['direct', true],
    ['silent', false],
  ] as const)('re-encodes a %s video crop, keeping audio: %s', async (mode, keepAudio) => {
    const { captured, handle } = handleOf('video');

    const result = await exportWhatsAppEdited(handle, operationWith({ mode, rotation: 90, crop }));

    expect(result.status).toBe('started');
    expect(writeProcessedVideo).toHaveBeenCalledWith(
      captured,
      expect.anything(),
      1,
      true,
      { keepAudio, rotation: 90, crop },
      expect.any(Function)
    );
    expect(createdBlobs[0]?.size).toBe(4);
  });

  it('turns and crops the exported frame', async () => {
    const { captured, handle } = handleOf('video');
    vi.mocked(captureFrameFromSource).mockResolvedValueOnce(Either.right(new Blob(['frame'])));
    const operation = operationWith({
      mode: 'frame',
      frameTimestampSeconds: 1,
      filename: 'whatsapp-visible-status_frame_00m01s.jpg',
      rotation: 270,
      crop,
    });

    await exportWhatsAppEdited(handle, operation);

    expect(captureFrameFromSource).toHaveBeenCalledWith(captured, 1, operation);
    expect(getMockBrowser().runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ receipt: expect.objectContaining({ mediaKind: 'photo' }) })
    );
  });

  it('reports a failed crop as a structural WhatsApp failure and releases the capture', async () => {
    const { handle } = handleOf('photo');
    vi.mocked(modifyImage).mockRejectedValueOnce(new Error('canvas https://example.com/x.jpg'));

    const result = await exportWhatsAppEdited(handle, operationWith({ mediaType: 'image', crop }));

    expect(result).toMatchObject({
      status: 'failed',
      failure: { platform: 'whatsapp', code: 'CROP_FAILED', phase: 'crop' },
    });
    expect(JSON.stringify(result)).not.toContain('example.com');
    expect(getDownloadCalls()).toHaveLength(0);
    expect(handle.release).toHaveBeenCalledOnce();
  });

  it('keeps a typed silent processing failure on the WhatsApp branch', async () => {
    const { handle } = handleOf('video');
    vi.mocked(writeProcessedVideo).mockRejectedValueOnce(
      normalizeWhatsAppSilentFailure('SILENT_SOURCE_CONVERSION_UNSUPPORTED', 'silent-reencode')
    );

    const result = await exportWhatsAppEdited(handle, operationWith({ mode: 'silent' }));

    expect(result).toMatchObject({
      status: 'failed',
      failure: { platform: 'whatsapp', code: 'SILENT_SOURCE_CONVERSION_UNSUPPORTED' },
    });
  });
});
