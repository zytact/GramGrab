import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const RELEASE_REPOSITORY = 'zytact/GramGrab';
export const FIREFOX_EXTENSION_ID = 'gramgrab@zytact';

/** Public half of the key that signs release CRXs. It pins the Chromium extension ID. */
export const CHROMIUM_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwZ0U9mOcob11P6YWBFnAaQBl2DHNFBakMPuVwuLxTbflqokayx74wM3jH3GBaTUxYWLdesIobiny1MBQJ++9rLofy0TSD3PMpyaDpzbYONdRIDMZayfzK7rqOVXhsm/nsQ/x0g+jue5tcEedSPngHjC9G76dI2pf996SgvopPUbfPwjwpISp+dRKsKr1TKafOjrraRI5r8nNhurO+3qgaq9/uhyx0AUAgbbQ5RmC6+4DlKfn5diG+zi5RHi4WqESNmIOHUFZ96EejzHvoXT9+DdqFChe0ZrIMMWk4Nfpbj7wv+VUX0uKQYIsY9XN6lf1zfXhf0ErlItshsclHBYuGQIDAQAB';

export const CHROMIUM_EXTENSION_ID = createHash('sha256')
  .update(Buffer.from(CHROMIUM_PUBLIC_KEY, 'base64'))
  .digest('hex')
  .slice(0, 32)
  .replace(/[0-9a-f]/gu, digit => String.fromCharCode(97 + Number.parseInt(digit, 16)));

/** The private CRX signing key. CI points `CHROMIUM_CRX_KEY_FILE` at a secret. */
export const chromiumKeyFile =
  process.env.CHROMIUM_CRX_KEY_FILE ?? join(homedir(), '.config/gramgrab-release/chromium.pem');

/** @param {string} name */
export const latestReleaseAssetUrl = name =>
  `https://github.com/${RELEASE_REPOSITORY}/releases/latest/download/${name}`;

/**
 * @param {string} version
 * @param {string} name
 */
const releaseAssetUrl = (version, name) =>
  `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}/${name}`;

/** @param {string} version */
export function chromiumUpdateManifest(version) {
  return `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${CHROMIUM_EXTENSION_ID}'>
    <updatecheck codebase='${releaseAssetUrl(version, 'gramgrab.crx')}' version='${version}' />
  </app>
</gupdate>
`;
}

/**
 * @param {string} version
 * @param {Uint8Array} xpi
 */
export function firefoxUpdateManifest(version, xpi) {
  const hash = createHash('sha256').update(xpi).digest('hex');
  const update = {
    version,
    update_link: releaseAssetUrl(version, 'gramgrab.xpi'),
    update_hash: `sha256:${hash}`,
  };
  return `${JSON.stringify({ addons: { [FIREFOX_EXTENSION_ID]: { updates: [update] } } }, undefined, 2)}\n`;
}
