const HEADER_BYTES = 4;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class FrameDecoder {
  private buffer = new Uint8Array();

  push(chunk: Uint8Array): Uint8Array[] {
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer);
    joined.set(chunk, this.buffer.length);
    this.buffer = joined;

    const frames: Uint8Array[] = [];
    while (this.buffer.length >= HEADER_BYTES) {
      const length = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset,
        HEADER_BYTES
      ).getUint32(0, true);
      if (length > MAX_FRAME_BYTES) throw new Error(`Frame exceeds ${MAX_FRAME_BYTES} bytes.`);
      if (this.buffer.length < HEADER_BYTES + length) break;
      frames.push(this.buffer.slice(HEADER_BYTES, HEADER_BYTES + length));
      this.buffer = this.buffer.slice(HEADER_BYTES + length);
    }
    return frames;
  }

  finish(): void {
    if (this.buffer.length !== 0) throw new Error('Stream ended with an incomplete frame.');
  }
}

export function encodeFrame(payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_FRAME_BYTES) throw new Error(`Frame exceeds ${MAX_FRAME_BYTES} bytes.`);
  const framed = new Uint8Array(HEADER_BYTES + payload.length);
  new DataView(framed.buffer).setUint32(0, payload.length, true);
  framed.set(payload, HEADER_BYTES);
  return framed;
}

export const encodeJsonFrame = (value: unknown): Uint8Array =>
  encodeFrame(new TextEncoder().encode(JSON.stringify(value)));

export const decodeJsonFrame = (payload: Uint8Array): unknown =>
  JSON.parse(new TextDecoder().decode(payload));
