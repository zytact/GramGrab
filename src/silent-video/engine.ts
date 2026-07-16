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
  UrlSource,
} from 'mediabunny';
import type { RequestId } from '../download/contracts.ts';
import { SilentPreflight } from './contracts.ts';
import { createOutput, readOutput, removeOutput } from './opfs.ts';

const mp4 = new Mp4OutputFormat({ fastStart: 'reserve' });

function inputFromUrl(url: string) {
  return new Input({ formats: ALL_FORMATS, source: new UrlSource(url) });
}

export async function inspectSilentVideo(
  requestId: RequestId,
  url: string
): Promise<SilentPreflight> {
  const input = inputFromUrl(url);
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new Error('The source contains no video track.');
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
  requestId: RequestId,
  url: string,
  transcode: boolean,
  onProgress: (progress: number) => void
): Promise<{ alreadySilent: boolean; opfsName?: string }> {
  const preflight = await inspectSilentVideo(requestId, url);
  if (preflight.audioTrackCount === 0) return { alreadySilent: true };
  if (!preflight.copyCompatible && !transcode) throw new Error('Re-encoding was not approved.');
  const owned = await createOutput(requestId);
  try {
    if (transcode) await transcodeVideo(url, owned.writable, onProgress);
    else await copyVideo(url, owned.writable, preflight.durationSeconds, onProgress);
    await validateOutput(owned.name);
    return { alreadySilent: false, opfsName: owned.name };
  } catch (error) {
    await removeOutput(owned.name);
    throw error;
  }
}

async function copyVideo(
  url: string,
  writable: WritableStream,
  duration: number,
  onProgress: (progress: number) => void
) {
  const input = inputFromUrl(url);
  try {
    const track = await input.getPrimaryVideoTrack();
    const codec = await track?.getCodec();
    if (!track || !codec) throw new Error('The source video track cannot be copied.');
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
  url: string,
  writable: WritableStream,
  onProgress: (progress: number) => void
) {
  if (!(await canEncodeVideo('avc')))
    throw new Error('This browser cannot encode high-quality H.264 video.');
  const input = inputFromUrl(url);
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('The source contains no video track.');
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
    if (!conversion.isValid) throw new Error('The source cannot be converted to H.264 MP4.');
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
      throw new Error('The generated file has no video track.');
    if ((await input.getAudioTracks()).length !== 0)
      throw new Error('The generated file still contains audio.');
  } finally {
    input.dispose();
  }
}
