// @vitest-environment node

import { readFile } from 'node:fs/promises';
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import { describe, expect, it } from 'vite-plus/test';
import { createWhatsAppSilentVideo } from './mute.ts';

describe('WhatsApp in-memory silent-video encoding', () => {
  it('keeps the video track and removes the audio track', async () => {
    const fixturePath = new URL('../silent-video/__fixtures__/synthetic-av.mp4', import.meta.url);
    const inputBytes = await readFile(fixturePath);
    const silent = await createWhatsAppSilentVideo(new Blob([inputBytes], { type: 'video/mp4' }));
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(silent) });
    try {
      expect(await input.getPrimaryVideoTrack()).toBeDefined();
      expect(await input.getAudioTracks()).toHaveLength(0);
    } finally {
      input.dispose();
    }
  });
});
