import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vite-plus/test';
import packageJson from '../../../package.json';
import {
  createManifest,
  manifestPermissionDocumentation,
  parseBrowserTarget,
} from '../scripts/manifest.mjs';
import { CHROMIUM_EXTENSION_ID, CHROMIUM_PUBLIC_KEY } from '../scripts/release.mjs';

const expectedPermissions = [
  'downloads',
  'storage',
  'cookies',
  'activeTab',
  'scripting',
  'tabs',
  'contextMenus',
  'nativeMessaging',
  'alarms',
];
const expectedHostPermissions = ['https://*.instagram.com/*', 'https://*.fbcdn.net/*'];

function readPermissionRows(readme: string) {
  const section = readme.match(/## Permissions\s+([\s\S]*?)\n\n---/u)?.[1];
  if (!section) throw new Error('README permissions section was not found.');

  return section
    .split('\n')
    .slice(2)
    .filter(line => line.startsWith('|'))
    .map(line => {
      const cells = line
        .split('|')
        .slice(1, -1)
        .map(cell => cell.trim());
      const permission = cells[0]?.match(/^`(.+)`$/u)?.[1];
      const reason = cells[1];
      if (!permission || !reason) throw new Error(`Invalid README permission row: ${line}`);
      return { permission, reason };
    });
}

describe('manifest generation', () => {
  it('keeps shared identity, action, icons, and permissions consistent', () => {
    for (const browser of ['chromium', 'firefox'] as const) {
      expect(createManifest(browser)).toMatchObject({
        manifest_version: 3,
        name: 'GramGrab',
        version: packageJson.version,
        action: {
          default_popup: 'popup.html',
          default_title: 'GramGrab',
          default_icon: {
            16: 'icons/icon-16.png',
            48: 'icons/icon-48.png',
          },
        },
        icons: {
          16: 'icons/icon-16.png',
          48: 'icons/icon-48.png',
          96: 'icons/icon-96.png',
        },
        permissions: expectedPermissions,
        host_permissions: expectedHostPermissions,
        options_ui: { page: 'options.html', open_in_tab: true },
      });
      expect(createManifest(browser)).not.toHaveProperty('content_scripts');
      expect(createManifest(browser)).not.toHaveProperty('optional_host_permissions');
      expect(createManifest(browser).host_permissions).not.toContain('https://web.whatsapp.com/*');
      expect(createManifest(browser).permissions).toEqual(
        expect.arrayContaining(['activeTab', 'scripting'])
      );
    }
  });

  it('generates the Chromium service worker declaration', () => {
    const manifest = createManifest('chromium');
    expect(manifest.background).toEqual({
      service_worker: 'js/background.js',
      type: 'module',
    });
    expect(manifest).not.toHaveProperty('browser_specific_settings');
  });

  it('updates Chromium installs from the latest GitHub release', () => {
    expect(createManifest('chromium').update_url).toBe(
      'https://github.com/zytact/GramGrab/releases/latest/download/updates.xml'
    );
  });

  it('pins the Chromium extension ID that installed releases update under', () => {
    expect(createManifest('chromium').key).toBe(CHROMIUM_PUBLIC_KEY);
    expect(CHROMIUM_EXTENSION_ID).toBe('jimjajkoinlnejbiekiaifojpnonfnff');
    expect(createManifest('firefox')).not.toHaveProperty('key');
  });

  it('generates the Firefox background and Gecko declarations', () => {
    expect(createManifest('firefox')).toMatchObject({
      background: { scripts: ['js/background.js'], type: 'module' },
      browser_specific_settings: {
        gecko: {
          id: 'gramgrab@zytact',
          strict_min_version: '109.0',
          data_collection_permissions: { required: ['none'] },
          update_url: 'https://github.com/zytact/GramGrab/releases/latest/download/updates.json',
        },
      },
    });
  });

  it('rejects unsupported browser targets', () => {
    expect(() => parseBrowserTarget('safari')).toThrow('Unsupported browser target: safari');
  });

  it('keeps README permission documentation synchronized', async () => {
    const readme = await readFile('README.md', 'utf8');
    expect(readPermissionRows(readme)).toEqual(manifestPermissionDocumentation);
  });
});
