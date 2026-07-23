import { describe, expect, it } from 'vite-plus/test';
import { decodeJsonFrame, encodeJsonFrame, FrameDecoder } from '../src/index.ts';

describe('length-prefixed framing', () => {
  it('decodes fragmented and adjacent frames', () => {
    const first = encodeJsonFrame({ value: 1 });
    const second = encodeJsonFrame({ value: 2 });
    const combined = new Uint8Array(first.length + second.length);
    combined.set(first);
    combined.set(second, first.length);
    const decoder = new FrameDecoder();

    expect(decoder.push(combined.slice(0, 3))).toEqual([]);
    const frames = decoder.push(combined.slice(3));
    expect(frames.map(decodeJsonFrame)).toEqual([{ value: 1 }, { value: 2 }]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it('rejects malformed lengths and incomplete frames', () => {
    const oversized = new Uint8Array([1, 0, 0, 1]);
    expect(() => new FrameDecoder().push(oversized)).toThrow(/exceeds/);
    const decoder = new FrameDecoder();
    decoder.push(encodeJsonFrame({ ok: true }).slice(0, 5));
    expect(() => decoder.finish()).toThrow(/incomplete/);
  });
});
