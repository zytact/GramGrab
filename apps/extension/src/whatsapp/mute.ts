import type {
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  VideoCodec,
} from 'mediabunny';
import { isOperationFailure } from '../errors/contracts.ts';
import {
  normalizeWhatsAppCaptureFailure,
  normalizeWhatsAppSilentFailure,
} from '../errors/normalize.ts';
import { fitsWithinWhatsAppPeakMemory } from './lease.ts';
import { WHATSAPP_MAX_MEDIA_BYTES } from './limits.ts';

export type WhatsAppSilentProgress = (phase: string, progress: number) => void;

export interface WhatsAppSilentVideoOptions {
  readonly retentionDeadline: number;
  readonly onProgress?: WhatsAppSilentProgress;
}

export function makeOutputMemoryGuard(maximumBytes: number, onExceeded: () => void) {
  let exceeded = false;
  return {
    onWrite({ end }: { readonly end: number }): void {
      if (end <= maximumBytes || exceeded) return;
      exceeded = true;
      onExceeded();
    },
    hasExceeded: (): boolean => exceeded,
  };
}

async function supportedVideoCodec(input: Input, mp4: Mp4OutputFormat): Promise<VideoCodec> {
  const video = await input.getPrimaryVideoTrack();
  if (!video) throw normalizeWhatsAppSilentFailure('SILENT_SOURCE_NO_VIDEO', 'silent-inspection');
  const codec = await video.getCodec();
  if (!codec || !mp4.getSupportedVideoCodecs().includes(codec))
    throw normalizeWhatsAppSilentFailure('SILENT_SOURCE_CONVERSION_UNSUPPORTED', 'silent-reencode');
  return codec;
}

async function executeWithinLease(
  conversion: Conversion,
  retentionDeadline: number,
  outputMemory: ReturnType<typeof makeOutputMemoryGuard>
): Promise<void> {
  let leaseExpired = Date.now() >= retentionDeadline;
  if (leaseExpired) throw normalizeWhatsAppCaptureFailure('retention-expired');
  const leaseTimer = globalThis.setTimeout(
    () => {
      leaseExpired = true;
      void conversion.cancel().catch(() => undefined);
    },
    Math.max(0, retentionDeadline - Date.now())
  );
  try {
    await conversion.execute();
  } catch (cause) {
    if (leaseExpired) throw normalizeWhatsAppCaptureFailure('retention-expired');
    if (outputMemory.hasExceeded())
      throw normalizeWhatsAppSilentFailure('SILENT_MEMORY_CAPACITY_EXCEEDED', 'silent-reencode');
    if (isOperationFailure(cause)) throw cause;
    throw normalizeWhatsAppSilentFailure('SILENT_REENCODE_FAILED', 'silent-reencode');
  } finally {
    globalThis.clearTimeout(leaseTimer);
  }
  if (Date.now() >= retentionDeadline) throw normalizeWhatsAppCaptureFailure('retention-expired');
}

function takeSilentBlob(target: BufferTarget, inputBytes: number): Blob {
  const buffer = target.buffer;
  if (!buffer) throw normalizeWhatsAppSilentFailure('SILENT_REENCODE_FAILED', 'silent-reencode');
  if (!fitsWithinWhatsAppPeakMemory({ inputBytes, outputBytes: buffer.byteLength }))
    throw normalizeWhatsAppSilentFailure('SILENT_MEMORY_CAPACITY_EXCEEDED', 'silent-reencode');
  const silent = new Blob([buffer], { type: 'video/mp4' });
  target.buffer = null;
  return silent;
}

export async function createWhatsAppSilentVideo(
  blob: Blob,
  { retentionDeadline, onProgress = () => {} }: WhatsAppSilentVideoOptions
): Promise<Blob> {
  const maximumOutputBytes = WHATSAPP_MAX_MEDIA_BYTES - blob.size;
  if (maximumOutputBytes < 0)
    throw normalizeWhatsAppSilentFailure('SILENT_MEMORY_CAPACITY_EXCEEDED', 'silent-reencode');
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
    const outputMemory = makeOutputMemoryGuard(maximumOutputBytes, () => {
      void conversion.cancel().catch(() => undefined);
    });
    target.on('write', event => outputMemory.onWrite(event));
    conversion.onProgress = progress => onProgress('processing', progress);
    await executeWithinLease(conversion, retentionDeadline, outputMemory);
    const silent = takeSilentBlob(target, blob.size);
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
