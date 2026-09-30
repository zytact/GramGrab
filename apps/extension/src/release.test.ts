import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vite-plus/test';
import {
  CHROMIUM_EXTENSION_ID,
  chromiumUpdateManifest,
  firefoxUpdateManifest,
} from '../scripts/release.mjs';

describe('release update manifests', () => {
  it('points Chromium at the versioned CRX for the pinned extension ID', () => {
    const xml = chromiumUpdateManifest('1.2.3');

    expect(xml).toContain(`appid='${CHROMIUM_EXTENSION_ID}'`);
    expect(xml).toContain(
      "codebase='https://github.com/zytact/GramGrab/releases/download/v1.2.3/gramgrab.crx' version='1.2.3'"
    );
  });

  it('points Firefox at the versioned XPI and pins its hash', () => {
    const xpi = new TextEncoder().encode('signed xpi');

    expect(JSON.parse(firefoxUpdateManifest('1.2.3', xpi))).toEqual({
      addons: {
        'gramgrab@zytact': {
          updates: [
            {
              version: '1.2.3',
              update_link:
                'https://github.com/zytact/GramGrab/releases/download/v1.2.3/gramgrab.xpi',
              update_hash: `sha256:${createHash('sha256').update(xpi).digest('hex')}`,
            },
          ],
        },
      },
    });
  });
});

describe('native host registration', () => {
  it('allows the pinned Chromium extension ID', async () => {
    const manifest = JSON.parse(
      await readFile('apps/native-host/manifests/chromium.json', 'utf8')
    ) as { allowed_origins: string[] };

    expect(manifest.allowed_origins).toEqual([`chrome-extension://${CHROMIUM_EXTENSION_ID}/`]);
  });
});
