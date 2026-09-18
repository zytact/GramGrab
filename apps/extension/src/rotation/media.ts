import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  type EncodedPacket,
  type InputTrack,
} from 'mediabunny';
import { combineRotations, swapsAxes, type Rotation } from './contracts.ts';

/** Draws `source` turned clockwise onto a canvas sized for the turned result. */
export function drawRotated(
  source: CanvasImageSource,
  width: number,
  height: number,
  rotation: Rotation | undefined
): HTMLCanvasElement | undefined {
  const canvas = document.createElement('canvas');
  canvas.width = swapsAxes(rotation) ? height : width;
  canvas.height = swapsAxes(rotation) ? width : height;
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(((rotation ?? 0) * Math.PI) / 180);
  context.drawImage(source, -width / 2, -height / 2, width, height);
  return canvas;
}

export function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95));
}

/** Re-encodes an image as a JPEG turned clockwise, relative to its displayed orientation. */
export async function rotateImage(image: Blob, rotation: Rotation): Promise<Blob> {
  const bitmap = await createImageBitmap(image);
  try {
    const canvas = drawRotated(bitmap, bitmap.width, bitmap.height, rotation);
    const jpeg = canvas && (await canvasToJpeg(canvas));
    if (!jpeg) throw new Error('The rotated image could not be encoded.');
    return jpeg;
  } finally {
    bitmap.close();
  }
}

/** Copies one track's encoded packets unchanged apart from a timestamp shift. */
async function copyPackets(
  track: InputTrack,
  shift: number,
  add: (packet: EncodedPacket) => Promise<void>
): Promise<void> {
  for await (const packet of new EncodedPacketSink(track).packets())
    await add(packet.clone({ timestamp: packet.timestamp - shift }));
}

/**
 * Turns a video clockwise by rewriting its MP4 rotation metadata. Video and audio packets are
 * copied through, so nothing is decoded or re-encoded.
 */
export async function rotateVideo(video: Blob, rotation: Rotation): Promise<Blob> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(video) });
  try {
    const format = new Mp4OutputFormat();
    const target = new BufferTarget();
    const output = new Output({ format, target });
    const videoTrack = await input.getPrimaryVideoTrack();
    const audioTrack = await input.getPrimaryAudioTrack();
    const videoCodec = await videoTrack?.getCodec();
    const audioCodec = await audioTrack?.getCodec();
    if (!videoTrack || !videoCodec || !format.getSupportedVideoCodecs().includes(videoCodec))
      throw new Error(`The ${videoCodec ?? 'unknown'} video codec cannot be copied into an MP4.`);
    if (audioTrack && (!audioCodec || !format.getSupportedAudioCodecs().includes(audioCodec)))
      throw new Error(`The ${audioCodec ?? 'unknown'} audio codec cannot be copied into an MP4.`);

    const videoSource = new EncodedVideoPacketSource(videoCodec);
    output.addVideoTrack(videoSource, {
      rotation: combineRotations(await videoTrack.getRotation(), rotation),
    });
    const audioSource = audioCodec ? new EncodedAudioPacketSource(audioCodec) : undefined;
    if (audioSource) output.addAudioTrack(audioSource);
    // AAC priming can start audio before zero, which an MP4 cannot store, so all tracks shift
    // together and stay in sync.
    const shift = Math.min(
      0,
      await videoTrack.getFirstTimestamp(),
      (await audioTrack?.getFirstTimestamp()) ?? 0
    );
    const videoMeta = { decoderConfig: (await videoTrack.getDecoderConfig()) ?? undefined };
    const audioMeta = { decoderConfig: (await audioTrack?.getDecoderConfig()) ?? undefined };

    await output.start();
    await Promise.all([
      copyPackets(videoTrack, shift, packet => videoSource.add(packet, videoMeta)).then(() =>
        videoSource.close()
      ),
      audioTrack &&
        audioSource &&
        copyPackets(audioTrack, shift, packet => audioSource.add(packet, audioMeta)).then(() =>
          audioSource.close()
        ),
    ]);
    await output.finalize();
    if (!target.buffer) throw new Error('The rotated video was not written.');
    return new Blob([target.buffer], { type: 'video/mp4' });
  } finally {
    input.dispose();
  }
}
