import { access, readFile } from 'node:fs/promises';

const targets = ['chromium', 'firefox'];
const whatsAppMatchingHosts = new Set([
  '<all_urls>',
  '*',
  '*.com',
  '*.whatsapp.com',
  '*.web.whatsapp.com',
  'web.whatsapp.com',
]);

function matchesWhatsAppHost(permission) {
  const host = /^[^:]+:\/\/([^/]+)\//u.exec(permission)?.[1] ?? permission;
  return whatsAppMatchingHosts.has(host);
}

for (const target of targets) {
  const root = `extension/${target}`;
  const manifest = JSON.parse(await readFile(`${root}/manifest.json`, 'utf8'));
  const hosts = [
    ...(manifest.host_permissions ?? []),
    ...(manifest.optional_host_permissions ?? []),
  ];

  if (
    !manifest.permissions?.includes('activeTab') ||
    !manifest.permissions?.includes('scripting')
  ) {
    throw new Error(`${target}: activeTab and scripting are both required`);
  }
  if (hosts.some(matchesWhatsAppHost)) {
    throw new Error(`${target}: WhatsApp host permissions are forbidden`);
  }
  if ('content_scripts' in manifest) {
    throw new Error(`${target}: permanent content scripts are forbidden`);
  }
  await access(`${root}/js/whatsapp-controller.js`);
}

console.log('WhatsApp package policy: Chromium and Firefox structural checks passed.');
