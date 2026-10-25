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
import { cropPixels, type Crop } from '../crop/contracts.ts';
import { combineRotations, swapsAxes, type Rotation } from './contracts.ts';

/** The Export modifiers a document applies to an output: a clockwise turn, then a crop. */
export interface Modifiers {
  readonly rotation?: Rotation;
  readonly crop?: Crop;
}

/** Draws `source` turned clockwise, then cropped, onto a canvas sized for the result. */
export function drawModified(
  source: CanvasImageSource,
  width: number,
  height: number,
  { rotation, crop }: Modifiers
): HTMLCanvasElement | undefined {
  const turned = document.createElement('canvas');
  turned.width = swapsAxes(rotation) ? height : width;
  turned.height = swapsAxes(rotation) ? width : height;
  const context = turned.getContext('2d');
  if (!context) return undefined;
  context.translate(turned.width / 2, turned.height / 2);
  context.rotate(((rotation ?? 0) * Math.PI) / 180);
  context.drawImage(source, -width / 2, -height / 2, width, height);
  if (!crop) return turned;

  const area = cropPixels(crop, turned.width, turned.height);
  const cropped = document.createElement('canvas');
  cropped.width = area.width;
  cropped.height = area.height;
  const croppedContext = cropped.getContext('2d');
  if (!croppedContext) return undefined;
  croppedContext.drawImage(
    turned,
    area.x,
    area.y,
    area.width,
    area.height,
    0,
    0,
    area.width,
    area.height
  );
  return cropped;
}

export function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95));
}

/** Re-encodes an image as a JPEG with its modifiers applied to its displayed orientation. */
export async function modifyImage(image: Blob, modifiers: Modifiers): Promise<Blob> {
  const bitmap = await createImageBitmap(image);
  try {
    const canvas = drawModified(bitmap, bitmap.width, bitmap.height, modifiers);
    const jpeg = canvas && (await canvasToJpeg(canvas));
    if (!jpeg) throw new Error('The modified image could not be encoded.');
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
