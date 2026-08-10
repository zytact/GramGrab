const permissionDocumentation = [
  { permission: 'downloads', reason: 'Save media files and debug exports to disk' },
  { permission: 'storage', reason: 'Persist download history and workspace handoff state' },
  { permission: 'cookies', reason: 'Read the current Instagram CSRF token for Instants requests' },
  {
    permission: 'activeTab',
    reason: 'Temporarily access the current tab when GramGrab is invoked',
  },
  {
    permission: 'scripting',
    reason: 'Inject the one-shot isolated WhatsApp capture controller',
  },
  {
    permission: 'tabs',
    reason: 'Read and manage tabs for URL detection and the GramGrab workspace',
  },
  { permission: 'contextMenus', reason: 'Add GramGrab actions to page and link context menus' },
  { permission: 'nativeMessaging', reason: 'Expose GramGrab operations to the local CLI bridge' },
];

const hostPermissionDocumentation = [
  { permission: 'https://*.instagram.com/*', reason: 'Fetch media metadata from Instagram' },
  {
    permission: 'https://*.fbcdn.net/*',
    reason: 'Load media previews and videos from Instagram’s CDN',
  },
];

export const manifestPermissionDocumentation = [
  ...permissionDocumentation,
  ...hostPermissionDocumentation,
];

/**
 * @param {string} value
 * @returns {'chromium' | 'firefox'}
 */
export function parseBrowserTarget(value) {
  if (value === 'chromium' || value === 'firefox') return value;
  throw new Error(`Unsupported browser target: ${value}`);
}

/**
 * Build the MV3 manifest for a supported browser target.
 *
 * @param {'chromium' | 'firefox'} browser
 */
export function createManifest(browser) {
  const background =
    browser === 'chromium'
      ? { service_worker: 'js/background.js', type: 'module' }
      : { scripts: ['js/background.js'], type: 'module' };

  const browserSettings =
    browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: { id: 'gramgrab@zytact', strict_min_version: '109.0' },
          },
        }
      : {};

  return {
    manifest_version: 3,
    name: 'GramGrab',
    version: '1.0.0',
    description:
      'Download Instagram posts, reels, stories, and highlights directly from your browser session.',
    icons: {
      16: 'icons/icon-16.png',
      48: 'icons/icon-48.png',
      96: 'icons/icon-96.png',
    },
    action: {
      default_popup: 'popup.html',
      default_icon: {
        16: 'icons/icon-16.png',
        48: 'icons/icon-48.png',
      },
      default_title: 'GramGrab',
    },
    permissions: permissionDocumentation.map(({ permission }) => permission),
    host_permissions: hostPermissionDocumentation.map(({ permission }) => permission),
    background,
    ...browserSettings,
  };
}
