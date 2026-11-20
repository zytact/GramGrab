import { readFile } from 'node:fs/promises';
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import { Schema } from 'effect';
import { describe, expect, it, vi } from 'vite-plus/test';
import { AttemptOperationSchema } from '../download/attempt.ts';
import { resetBrowserMocks } from '../test/setup.ts';
import { WhatsAppCaptureDescriptor } from './contracts.ts';
import { makeWhatsAppCaptureSnapshot } from './snapshot.ts';
import { exportWhatsAppEdited } from './export.ts';

describe('WhatsApp silent export through the shared engine', () => {
  it('keeps the video track, turns it, and removes the audio track', async () => {
    resetBrowserMocks();
    const bytes = await readFile(
      new URL('../silent-video/__fixtures__/synthetic-av.mp4', import.meta.url)
    );
    const descriptor = Schema.decodeUnknownSync(WhatsAppCaptureDescriptor)({
      captureId: '123e4567-e89b-42d3-a456-426614174000',
      kind: 'video',
      mimeType: 'video/mp4',
      byteLength: bytes.byteLength,
      width: 64,
      height: 64,
      durationMs: 1_000,
      capturedAt: 1,
    });
    const snapshot = makeWhatsAppCaptureSnapshot(descriptor, [new Uint8Array(bytes)]);
    let output: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
      output = blob as Blob;
      return 'blob:silent-output';
    });

    const result = await exportWhatsAppEdited(
      {
        descriptor,
        snapshot,
        filename: 'whatsapp-visible-status.mp4',
        download: async () => ({ downloadId: 1, filename: 'unused' }),
        release: () => snapshot.release(),
      },
      Schema.decodeUnknownSync(AttemptOperationSchema)({
        operationId: '00000000-0000-4000-8000-000000000001',
        requestId: '00000000-0000-4000-8000-000000000002',
        itemIndex: 0,
        url: 'blob:captured-status',
        originalUrl: 'blob:captured-status',
        originalFilename: 'whatsapp-visible-status.mp4',
        filename: 'whatsapp-visible-status-muted.mp4',
        mediaType: 'video',
        mode: 'silent',
        displayIndex: 0,
        rotation: 90,
      })
    );

    expect(result.status).toBe('started');
    if (!output) throw new Error('Expected a silent output.');
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(output) });
    try {
      expect(await (await input.getPrimaryVideoTrack())?.getRotation()).toBe(90);
      expect(await input.getAudioTracks()).toHaveLength(0);
    } finally {
      input.dispose();
    }
  });
});
