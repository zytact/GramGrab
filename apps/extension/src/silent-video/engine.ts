import {
  ALL_FORMATS,
  BlobSource,
  canEncodeVideo,
  Conversion,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_VERY_HIGH,
  StreamTarget,
} from 'mediabunny';
import type { OperationId, RequestId } from '../download/contracts.ts';
import {
  isOperationFailure,
  OperationFailure,
  diagnosticCause,
  type InstagramFailureCode,
} from '../errors/contracts.ts';
import { SilentPreflight } from './contracts.ts';
import {
  createOutput,
  readInput,
  readOutput,
  removeGeneratedOutput,
  removeOutput,
} from './opfs.ts';
import { FAILURE_PRESENTATION } from '../errors/presentation.ts';

const mp4 = new Mp4OutputFormat({ fastStart: false });

const silentFailure = (
  code: InstagramFailureCode,
  phase: OperationFailure['phase'],
  cause?: unknown
) =>
  OperationFailure.make({
    code,
    phase,
    scope: 'item',
    ...(cause === undefined ? {} : { cause: diagnosticCause(cause) }),
  });

function inputFromFile(file: File) {
  return new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file, { maxCacheSize: 2 ** 21 }),
  });
}

export async function inspectSilentVideo(
  operationId: OperationId,
  requestId: RequestId,
  file: File
): Promise<SilentPreflight> {
  const input = inputFromFile(file);
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw silentFailure('SILENT_SOURCE_NO_VIDEO', 'silent-inspection');
    const [audio, codec, duration, sourceBitrate, width, height] = await Promise.all([
      input.getAudioTracks(),
      video.getCodec(),
      video.getDurationFromMetadata(),
      video.getBitrate(),
      video.getDisplayWidth(),
      video.getDisplayHeight(),
    ]);
    const copyCompatible = codec !== null && mp4.getSupportedVideoCodecs().includes(codec);
    return SilentPreflight.make({
      requestId,
      operationId,
      audioTrackCount: audio.length,
      videoCodec: codec ?? 'unknown',
      durationSeconds: duration ?? 0,
      ...(sourceBitrate ? { sourceBitrate } : {}),
      width,
      height,
      copyCompatible,
      ...(!copyCompatible
        ? { reason: `The ${codec ?? 'unknown'} video codec requires H.264 re-encoding.` }
        : {}),
    });
  } finally {
    input.dispose();
  }
}

export async function processSilentVideo(
  operationId: OperationId,
  requestId: RequestId,
  transcode: boolean,
  onProgress: (progress: number) => void
): Promise<{ alreadySilent: boolean; opfsName?: string }> {
  const file = await readInput(operationId);
  const preflight = await inspectSilentVideo(operationId, requestId, file);
  if (preflight.audioTrackCount === 0) return { alreadySilent: true };
  if (!preflight.copyCompatible && !transcode)
    throw silentFailure('SILENT_COPY_FAILED', 'silent-copy');
  const owned = await createOutput(operationId);
  try {
    await processOutput(file, owned.writable, preflight.durationSeconds, transcode, onProgress);
    await validateOutput(owned.name);
    return { alreadySilent: false, opfsName: owned.name };
  } catch (error) {
    const failure = normalizeProcessingFailure(error, transcode);
    await cleanFailedOutput(owned.name, failure);
    throw failure;
  }
}

async function processOutput(
  file: File,
  writable: WritableStream,
  duration: number,
  transcode: boolean,
  onProgress: (progress: number) => void
): Promise<void> {
  if (transcode) return transcodeVideo(file, writable, onProgress);
  return copyVideo(file, writable, duration, onProgress);
}

function normalizeProcessingFailure(error: unknown, transcode: boolean): OperationFailure {
  if (isOperationFailure(error)) return error;
  return silentFailure(
    transcode ? 'SILENT_REENCODE_FAILED' : 'SILENT_COPY_FAILED',
    transcode ? 'silent-reencode' : 'silent-copy',
    error
  );
}

export async function cleanFailedOutput(name: string, failure: OperationFailure): Promise<void> {
  if (FAILURE_PRESENTATION[failure.code].retainSilentInput) return removeGeneratedOutput(name);
  return removeOutput(name);
}

async function copyVideo(
  file: File,
  writable: WritableStream,
  duration: number,
  onProgress: (progress: number) => void
) {
  const input = inputFromFile(file);
  try {
    const track = await input.getPrimaryVideoTrack();
    const codec = await track?.getCodec();
    if (!track || !codec) throw silentFailure('SILENT_SOURCE_NO_VIDEO', 'silent-copy');
    const source = new EncodedVideoPacketSource(codec);
    const output = new Output({ format: mp4, target: new StreamTarget(writable) });
    output.addVideoTrack(source, { rotation: await track.getRotation() });
    await output.start();
    const meta = { decoderConfig: (await track.getDecoderConfig()) ?? undefined };
    for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, {
      verifyKeyPackets: true,
    })) {
      await source.add(packet, meta);
      onProgress(duration > 0 ? Math.min(1, (packet.timestamp + packet.duration) / duration) : 0);
    }
    source.close();
    await output.finalize();
  } finally {
    input.dispose();
  }
}

async function transcodeVideo(
  file: File,
  writable: WritableStream,
  onProgress: (progress: number) => void
) {
  if (!(await canEncodeVideo('avc')))
    throw silentFailure('SILENT_H264_ENCODER_UNAVAILABLE', 'silent-reencode');
  const input = inputFromFile(file);
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw silentFailure('SILENT_SOURCE_NO_VIDEO', 'silent-reencode');
    const sourceBitrate = await track.getBitrate();
    const output = new Output({ format: mp4, target: new StreamTarget(writable) });
    const conversion = await Conversion.init({
      input,
      output,
      video: {
        codec: 'avc',
        bitrate: sourceBitrate ? Math.ceil(sourceBitrate * 1.2) : QUALITY_VERY_HIGH,
      },
      audio: { discard: true },
      showWarnings: false,
    });
    if (!conversion.isValid)
      throw silentFailure('SILENT_SOURCE_CONVERSION_UNSUPPORTED', 'silent-reencode');
    conversion.onProgress = onProgress;
    await conversion.execute();
  } finally {
    input.dispose();
  }
}

async function validateOutput(name: string): Promise<void> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(await readOutput(name)) });
  try {
    if (!(await input.getPrimaryVideoTrack()))
      throw silentFailure('SILENT_OUTPUT_NO_VIDEO', 'silent-validation');
    if ((await input.getAudioTracks()).length !== 0)
      throw silentFailure('SILENT_OUTPUT_HAS_AUDIO', 'silent-validation');
  } finally {
    input.dispose();
  }
}
