import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import { describe, expect, it } from 'vite-plus/test';
import { rotateVideo } from './media.ts';

async function describeVideo(video: Blob) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(video) });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    const audioTrack = await input.getPrimaryAudioTrack();
    return {
      rotation: await videoTrack?.getRotation(),
      audioCodec: await audioTrack?.getCodec(),
      audioLead:
        ((await audioTrack?.getFirstTimestamp()) ?? 0) -
        ((await videoTrack?.getFirstTimestamp()) ?? 0),
    };
  } finally {
    input.dispose();
  }
}

describe('rotateVideo', () => {
  it('turns a video through its metadata and keeps its audio in sync', async () => {
    const fixture = new Blob([
      await readFile(resolve('apps/extension/src/silent-video/__fixtures__/synthetic-av.mp4')),
    ]);
    const before = await describeVideo(fixture);

    const after = await describeVideo(await rotateVideo(fixture, 90));

    expect(after.rotation).toBe(90);
    expect(after.audioCodec).toBe(before.audioCodec);
    expect(after.audioLead).toBeCloseTo(before.audioLead, 3);
  });
});
