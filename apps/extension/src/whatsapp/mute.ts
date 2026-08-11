import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
} from 'mediabunny';
import { isOperationFailure } from '../errors/contracts.ts';
import { normalizeWhatsAppSilentFailure } from '../errors/normalize.ts';
import { fitsWithinWhatsAppPeakMemory } from './lease.ts';

const mp4 = new Mp4OutputFormat({ fastStart: false });

export type WhatsAppSilentProgress = (phase: string, progress: number) => void;

export async function createWhatsAppSilentVideo(
  blob: Blob,
  onProgress: WhatsAppSilentProgress = () => {}
): Promise<Blob> {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(blob, { maxCacheSize: 2 ** 21 }),
  });
  const target = new BufferTarget();
  const output = new Output({ format: mp4, target });
  try {
    onProgress('inspecting', 0);
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw normalizeWhatsAppSilentFailure('SILENT_SOURCE_NO_VIDEO', 'silent-inspection');
    const codec = await video.getCodec();
    if (!codec || !mp4.getSupportedVideoCodecs().includes(codec))
      throw normalizeWhatsAppSilentFailure(
        'SILENT_SOURCE_CONVERSION_UNSUPPORTED',
        'silent-reencode'
      );

    const conversion = await Conversion.init({
      input,
      output,
      video: { codec },
      audio: { discard: true },
      showWarnings: false,
    });
    if (!conversion.isValid)
      throw normalizeWhatsAppSilentFailure(
        'SILENT_SOURCE_CONVERSION_UNSUPPORTED',
        'silent-reencode'
      );
    conversion.onProgress = progress => onProgress('processing', progress);
    try {
      await conversion.execute();
    } catch (cause) {
      if (isOperationFailure(cause)) throw cause;
      throw normalizeWhatsAppSilentFailure('SILENT_REENCODE_FAILED', 'silent-reencode');
    }

    const buffer = target.buffer;
    if (!buffer) throw normalizeWhatsAppSilentFailure('SILENT_REENCODE_FAILED', 'silent-reencode');
    if (!fitsWithinWhatsAppPeakMemory({ inputBytes: blob.size, outputBytes: buffer.byteLength }))
      throw normalizeWhatsAppSilentFailure('SILENT_MEMORY_CAPACITY_EXCEEDED', 'silent-reencode');
    const silent = new Blob([buffer], { type: 'video/mp4' });
    target.buffer = null;
    onProgress('validating', 1);
    return silent;
  } catch (cause) {
    if (isOperationFailure(cause)) throw cause;
    throw normalizeWhatsAppSilentFailure('SILENT_REENCODE_FAILED', 'silent-reencode');
  } finally {
    target.buffer = null;
    if (output.state !== 'finalized') await output.cancel().catch(() => undefined);
    input.dispose();
  }
}
