import type { BufferTarget, Input, Mp4OutputFormat, Output, VideoCodec } from 'mediabunny';
import { isOperationFailure } from '../errors/contracts.ts';
import { normalizeWhatsAppSilentFailure } from '../errors/normalize.ts';

export type WhatsAppSilentProgress = (phase: string, progress: number) => void;

async function supportedVideoCodec(input: Input, mp4: Mp4OutputFormat): Promise<VideoCodec> {
  const video = await input.getPrimaryVideoTrack();
  if (!video) throw normalizeWhatsAppSilentFailure('SILENT_SOURCE_NO_VIDEO', 'silent-inspection');
  const codec = await video.getCodec();
  if (!codec || !mp4.getSupportedVideoCodecs().includes(codec))
    throw normalizeWhatsAppSilentFailure('SILENT_SOURCE_CONVERSION_UNSUPPORTED', 'silent-reencode');
  return codec;
}

function takeSilentBlob(target: BufferTarget): Blob {
  const buffer = target.buffer;
  if (!buffer) throw normalizeWhatsAppSilentFailure('SILENT_REENCODE_FAILED', 'silent-reencode');
  target.buffer = null;
  return new Blob([buffer], { type: 'video/mp4' });
}

export async function createWhatsAppSilentVideo(
  blob: Blob,
  onProgress: WhatsAppSilentProgress = () => {}
): Promise<Blob> {
  onProgress('inspecting', 0);
  let input: Input | undefined;
  let target: BufferTarget | undefined;
  let output: Output | undefined;
  try {
    const { BufferTarget, Conversion, Mp4OutputFormat, Output, openVideoInput } =
      await import('../video/mediabunny.ts');
    const mp4 = new Mp4OutputFormat({ fastStart: false });
    input = openVideoInput(blob, { maxCacheSize: 2 ** 21 });
    target = new BufferTarget();
    output = new Output({ format: mp4, target });
    const codec = await supportedVideoCodec(input, mp4);
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
    await conversion.execute();
    const silent = takeSilentBlob(target);
    onProgress('validating', 1);
    return silent;
  } catch (cause) {
    if (isOperationFailure(cause)) throw cause;
    throw normalizeWhatsAppSilentFailure('SILENT_REENCODE_FAILED', 'silent-reencode');
  } finally {
    if (target) target.buffer = null;
    if (output && output.state !== 'finalized') await output.cancel().catch(() => undefined);
    input?.dispose();
  }
}
