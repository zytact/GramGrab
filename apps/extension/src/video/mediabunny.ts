// Callers load this module with `import()`, so pages that never touch a video skip mediabunny,
// and its chunk keeps only the names below.
import { BlobSource, Input, MP4, QTFF, type BlobSourceOptions } from 'mediabunny';

export {
  BufferTarget,
  CanvasSink,
  Conversion,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from 'mediabunny';

/** Opens an MP4 or QuickTime video, the only containers Instagram and WhatsApp serve. */
export const openVideoInput = (video: Blob, options?: BlobSourceOptions): Input =>
  new Input({ formats: [MP4, QTFF], source: new BlobSource(video, options) });
