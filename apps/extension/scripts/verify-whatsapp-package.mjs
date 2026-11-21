import { readFile } from 'node:fs/promises';
import { parse } from 'acorn';

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

function containsDynamicImport(node) {
  if (node === null || typeof node !== 'object') return false;
  if (node.type === 'ImportExpression') return true;
  return Object.values(node).some(child =>
    Array.isArray(child) ? child.some(containsDynamicImport) : containsDynamicImport(child)
  );
}

function assertClassicScript(target, source) {
  let program;
  try {
    program = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  } catch (error) {
    throw new Error(`${target}: WhatsApp controller must parse as a classic script`, {
      cause: error,
    });
  }
  if (containsDynamicImport(program)) {
    throw new Error(`${target}: WhatsApp controller must not import modules`);
  }
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
  assertClassicScript(target, await readFile(`${root}/js/whatsapp-controller.js`, 'utf8'));
}

console.log('WhatsApp package policy: Chromium and Firefox structural checks passed.');
