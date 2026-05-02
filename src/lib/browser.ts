/**
 * Minimal browser API shim for Chrome/Firefox compatibility.
 *
 * - Firefox (and any env with a native `browser` global): used as-is.
 * - Chromium: wraps callback-based `chrome.*` APIs into Promises.
 * - Test / SSR: falls back to a no-op stub so imports never throw.
 *
 * Only the APIs actually used by this extension are exposed here.
 */

/**
 * Callback signature for runtime.onMessage listeners.
 *
 * Returning `true` tells the browser that the response will be sent
 * asynchronously via `sendResponse`. This is the cross-browser-safe contract:
 * Firefox supports both promise-returning and sendResponse styles; Chrome docs
 * still recommend `sendResponse + return true` for reliable async responses.
 */
export type OnMessageCallback = (
  msg: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void
) => boolean | void;

export interface BrowserShim {
  runtime: {
    sendMessage: (msg: unknown) => Promise<unknown>;
    onMessage: {
      addListener: (callback: OnMessageCallback) => void;
    };
  };
  tabs: {
    query: (queryInfo: {
      active?: boolean;
      currentWindow?: boolean;
    }) => Promise<{ id?: number; url?: string }[]>;
  };
  downloads: {
    download: (options: { url: string; filename?: string; saveAs?: boolean }) => Promise<number>;
  };
  storage: {
    get: (keys?: unknown) => Promise<Record<string, unknown>>;
    set: (items: Record<string, unknown>) => Promise<void>;
  };
}

// ---------------------------------------------------------------------------
// Internal Chrome type (narrow — only what we need)
// ---------------------------------------------------------------------------

interface ChromeRuntime {
  lastError?: { message?: string };
  sendMessage: (msg: unknown, callback: (response: unknown) => void) => void;
  onMessage: { addListener: (callback: OnMessageCallback) => void };
}

interface ChromeGlobal {
  runtime: ChromeRuntime;
  tabs: { query: (q: unknown, cb: (tabs: unknown[]) => void) => void };
  downloads: {
    download: (
      opts: { url: string; filename?: string; saveAs?: boolean },
      cb?: (id: number) => void
    ) => void;
  };
  storage: {
    local: {
      get: (keys: unknown, cb: (result: Record<string, unknown>) => void) => void;
      set: (items: Record<string, unknown>, cb?: () => void) => void;
    };
  };
}

// ---------------------------------------------------------------------------
// Chrome shim builder
// ---------------------------------------------------------------------------

function lastError(cr: ChromeRuntime): Error | undefined {
  return cr.lastError ? new Error(cr.lastError.message ?? 'chrome lastError') : undefined;
}

function buildChromeShim(chrome: ChromeGlobal): BrowserShim {
  return {
    runtime: {
      sendMessage: msg =>
        new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(msg, response => {
            const err = lastError(chrome.runtime);
            if (err) reject(err);
            else resolve(response);
          });
        }),
      onMessage: {
        addListener: callback => chrome.runtime.onMessage.addListener(callback),
      },
    },
    tabs: {
      query: queryInfo =>
        new Promise((resolve, reject) => {
          chrome.tabs.query(queryInfo, tabs => {
            const err = lastError(chrome.runtime);
            if (err) reject(err);
            else resolve(tabs as { id?: number; url?: string }[]);
          });
        }),
    },
    downloads: {
      download: options =>
        new Promise((resolve, reject) => {
          chrome.downloads.download(options, id => {
            const err = lastError(chrome.runtime);
            if (err) reject(err);
            else resolve(id);
          });
        }),
    },
    storage: {
      get: keys =>
        new Promise((resolve, reject) => {
          chrome.storage.local.get(keys, result => {
            const err = lastError(chrome.runtime);
            if (err) reject(err);
            else resolve(result);
          });
        }),
      set: items =>
        new Promise((resolve, reject) => {
          chrome.storage.local.set(items, () => {
            const err = lastError(chrome.runtime);
            if (err) reject(err);
            else resolve();
          });
        }),
    },
  };
}

// ---------------------------------------------------------------------------
// Fallback stub (tests / environments without either global)
// ---------------------------------------------------------------------------

const noopShim: BrowserShim = {
  runtime: {
    sendMessage: () => Promise.resolve(undefined),
    onMessage: { addListener: () => {} },
  },
  tabs: { query: () => Promise.resolve([]) },
  downloads: { download: () => Promise.resolve(0) },
  storage: {
    get: () => Promise.resolve({}),
    set: () => Promise.resolve(),
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Resolve the active browser implementation on every property access.
 * Using a Proxy here means callers always see the current globalThis.browser /
 * globalThis.chrome, which lets tests reassign global.browser without
 * needing to reload the module.
 */
function getActiveBrowser(): BrowserShim {
  const g = globalThis as Record<string, unknown>;
  const nativeBrowser = g['browser'] as BrowserShim | undefined;
  const chrome = g['chrome'] as ChromeGlobal | undefined;
  return nativeBrowser ?? (chrome ? buildChromeShim(chrome) : noopShim);
}

export const browser: BrowserShim = new Proxy({} as BrowserShim, {
  get(_target, prop: string) {
    return (getActiveBrowser() as unknown as Record<string, unknown>)[prop];
  },
});
