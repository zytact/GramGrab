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
  sender: { tab?: { id?: number } },
  sendResponse: (response: unknown) => void
) => boolean | void;

export interface NativePort {
  postMessage: (message: unknown) => void;
  disconnect: () => void;
  onMessage: { addListener: (callback: (message: unknown) => void) => void };
  onDisconnect: { addListener: (callback: () => void) => void };
}

export interface BrowserShim {
  runtime: {
    getURL: (path: string) => string;
    getManifest: () => { version?: string };
    sendMessage: (msg: unknown) => Promise<unknown>;
    connectNative: (application: string) => NativePort;
    onMessage: {
      addListener: (callback: OnMessageCallback) => void;
    };
    onStartup: {
      addListener: (callback: () => void) => void;
    };
  };
  tabs: {
    query: (queryInfo: {
      active?: boolean;
      currentWindow?: boolean;
      url?: string;
    }) => Promise<{ id?: number; url?: string; windowId?: number }[]>;
    create: (createProperties: { url: string; active?: boolean }) => Promise<{ id?: number }>;
    update: (tabId: number, updateProperties: { active?: boolean; url?: string }) => Promise<void>;
    sendMessage: (tabId: number, message: unknown) => Promise<unknown>;
    remove: (tabId: number) => Promise<void>;
  };
  downloads: {
    download: (options: { url: string; filename?: string; saveAs?: boolean }) => Promise<number>;
    search: (query: {
      id?: number;
    }) => Promise<{ id: number; state?: string; fileSize?: number }[]>;
    onChanged: {
      addListener: (callback: (delta: DownloadDelta) => void) => void;
      removeListener: (callback: (delta: DownloadDelta) => void) => void;
    };
  };
  storage: {
    get: (keys?: unknown) => Promise<Record<string, unknown>>;
    set: (items: Record<string, unknown>) => Promise<void>;
    remove: (keys: string | string[]) => Promise<void>;
  };
  windows: {
    create: (createData: {
      url: string;
      focused?: boolean;
      state?: 'minimized' | 'normal';
      type?: 'popup';
    }) => Promise<{ id?: number; tabs?: { id?: number }[] }>;
    update: (windowId: number, updateInfo: { focused: boolean }) => Promise<void>;
    remove: (windowId: number) => Promise<void>;
  };
  contextMenus: {
    create: (properties: ContextMenuCreateProperties) => void;
    removeAll: () => Promise<void>;
    update: (id: string, properties: { visible: boolean }) => Promise<void>;
    refresh: () => Promise<void>;
    onClicked: { addListener: (callback: ContextMenuClickedCallback) => void };
    onShown: { addListener: (callback: ContextMenuShownCallback) => void };
  };
}

export interface DownloadDelta {
  id: number;
  state?: { current?: string };
}

export interface ContextMenuCreateProperties {
  id: string;
  title: string;
  contexts?: ('page' | 'link')[];
  parentId?: string;
  visible?: boolean;
}
export type ContextMenuClickedCallback = (info: {
  menuItemId: string;
  pageUrl?: string;
  linkUrl?: string;
}) => void;
export type ContextMenuShownCallback = (info: { pageUrl?: string; linkUrl?: string }) => void;

// ---------------------------------------------------------------------------
// Internal Chrome type (narrow — only what we need)
// ---------------------------------------------------------------------------

interface ChromeRuntime {
  getURL: (path: string) => string;
  getManifest?: () => { version?: string };
  lastError?: { message?: string };
  sendMessage: (msg: unknown, callback: (response: unknown) => void) => void;
  connectNative?: (application: string) => NativePort;
  onMessage: { addListener: (callback: OnMessageCallback) => void };
  onStartup?: { addListener: (callback: () => void) => void };
}

interface ChromeGlobal {
  runtime: ChromeRuntime;
  tabs: {
    query: (q: unknown, cb: (tabs: unknown[]) => void) => void;
    create: (q: unknown, cb: (tab: unknown) => void) => void;
    update: (id: number, q: unknown, cb: () => void) => void;
    sendMessage: (id: number, message: unknown, cb: (response: unknown) => void) => void;
    remove: (id: number, cb: () => void) => void;
  };
  windows: {
    create: (q: unknown, cb: (window: unknown) => void) => void;
    update: (id: number, q: unknown, cb: () => void) => void;
    remove: (id: number, cb: () => void) => void;
  };
  downloads: {
    download: (
      opts: { url: string; filename?: string; saveAs?: boolean },
      cb?: (id: number) => void
    ) => void;
    search: (
      query: { id?: number },
      callback: (items: { id: number; state?: string }[]) => void
    ) => void;
    onChanged: {
      addListener: (callback: (delta: DownloadDelta) => void) => void;
      removeListener: (callback: (delta: DownloadDelta) => void) => void;
    };
  };
  storage: {
    local: {
      get: (keys: unknown, cb: (result: Record<string, unknown>) => void) => void;
      set: (items: Record<string, unknown>, cb?: () => void) => void;
      remove: (keys: string | string[], cb?: () => void) => void;
    };
  };
  contextMenus: {
    create: (properties: ContextMenuCreateProperties) => void;
    removeAll: (callback?: () => void) => void;
    update: (id: string, properties: { visible: boolean }, callback?: () => void) => void;
    refresh: (callback?: () => void) => void;
    onClicked: { addListener: (callback: ContextMenuClickedCallback) => void };
    onShown: { addListener: (callback: ContextMenuShownCallback) => void };
  };
}

interface NativeBrowserGlobal {
  runtime: {
    getURL: (path: string) => string;
    getManifest: () => { version?: string };
    sendMessage: (msg: unknown) => Promise<unknown>;
    connectNative?: (application: string) => NativePort;
    onMessage: { addListener: (callback: OnMessageCallback) => void };
    onStartup?: { addListener: (callback: () => void) => void };
  };
  tabs: {
    query: (queryInfo: unknown) => Promise<{ id?: number; url?: string; windowId?: number }[]>;
    create: (createProperties: { url: string; active?: boolean }) => Promise<{ id?: number }>;
    update: (
      tabId: number,
      updateProperties: { active?: boolean; url?: string }
    ) => Promise<unknown>;
    sendMessage: (tabId: number, message: unknown) => Promise<unknown>;
    remove: (tabId: number) => Promise<void>;
  };
  downloads: {
    download: (options: { url: string; filename?: string; saveAs?: boolean }) => Promise<number>;
    search: (query: { id?: number }) => Promise<{ id: number; state?: string }[]>;
    onChanged: {
      addListener: (callback: (delta: DownloadDelta) => void) => void;
      removeListener: (callback: (delta: DownloadDelta) => void) => void;
    };
  };
  storage: {
    local: {
      get: (keys?: unknown) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
      remove: (keys: string | string[]) => Promise<void>;
    };
  };
  windows: {
    create: (createData: unknown) => Promise<{ id?: number; tabs?: { id?: number }[] }>;
    update: (windowId: number, updateInfo: { focused: boolean }) => Promise<unknown>;
    remove: (windowId: number) => Promise<void>;
  };
  contextMenus: {
    create: (properties: ContextMenuCreateProperties) => void;
    removeAll: () => Promise<void>;
    update: (id: string, properties: { visible: boolean }) => Promise<void>;
    refresh: () => Promise<void>;
    onClicked: { addListener: (callback: ContextMenuClickedCallback) => void };
    onShown: { addListener: (callback: ContextMenuShownCallback) => void };
  };
}

// ---------------------------------------------------------------------------
// Chrome shim builder
// ---------------------------------------------------------------------------

function lastError(cr: ChromeRuntime): Error | undefined {
  return cr.lastError ? new Error(cr.lastError.message ?? 'chrome lastError') : undefined;
}

function buildChromeShim(chrome: ChromeGlobal): BrowserShim {
  const contextMenus = chrome.contextMenus ?? noopContextMenus;
  return {
    runtime: {
      getURL: path => chrome.runtime.getURL(path),
      getManifest: () => chrome.runtime.getManifest?.() ?? {},
      sendMessage: msg =>
        new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(msg, response => {
            const err = lastError(chrome.runtime);
            if (err) reject(err);
            else resolve(response);
          });
        }),
      connectNative: application => chrome.runtime.connectNative?.(application) ?? noopNativePort,
      onMessage: {
        addListener: callback => chrome.runtime.onMessage.addListener(callback),
      },
      onStartup: {
        addListener: callback => chrome.runtime.onStartup?.addListener(callback),
      },
    },
    tabs: {
      query: queryInfo =>
        new Promise((resolve, reject) => {
          chrome.tabs.query(queryInfo, tabs => {
            const err = lastError(chrome.runtime);
            if (err) reject(err);
            else resolve(tabs as { id?: number; url?: string; windowId?: number }[]);
          });
        }),
      create: createProperties =>
        new Promise((resolve, reject) => {
          chrome.tabs.create(createProperties, tab => {
            const err = lastError(chrome.runtime);
            if (err) reject(err);
            else resolve(tab as { id?: number });
          });
        }),
      update: (tabId, updateProperties) =>
        new Promise((resolve, reject) => {
          chrome.tabs.update(tabId, updateProperties, () => {
            const err = lastError(chrome.runtime);
            if (err) reject(err);
            else resolve();
          });
        }),
      sendMessage: (tabId, message) =>
        new Promise((resolve, reject) => {
          chrome.tabs.sendMessage(tabId, message, response => {
            const err = lastError(chrome.runtime);
            if (err) reject(err);
            else resolve(response);
          });
        }),
      remove: tabId =>
        new Promise((resolve, reject) => {
          chrome.tabs.remove(tabId, () => {
            const err = lastError(chrome.runtime);
            if (err) reject(err);
            else resolve();
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
      onChanged: chrome.downloads.onChanged,
      search: query =>
        new Promise((resolve, reject) => {
          chrome.downloads.search(query, items => {
            const err = lastError(chrome.runtime);
            if (err) reject(err);
            else resolve(items);
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
      remove: keys =>
        new Promise((resolve, reject) => {
          chrome.storage.local.remove(keys, () => {
            const err = lastError(chrome.runtime);
            if (err) reject(err);
            else resolve();
          });
        }),
    },
    windows: {
      create: createData =>
        new Promise((resolve, reject) => {
          chrome.windows.create(createData, window => {
            const err = lastError(chrome.runtime);
            if (err) reject(err);
            else resolve(window as { id?: number; tabs?: { id?: number }[] });
          });
        }),
      update: (windowId, updateInfo) =>
        new Promise((resolve, reject) => {
          chrome.windows.update(windowId, updateInfo, () => {
            const err = lastError(chrome.runtime);
            if (err) reject(err);
            else resolve();
          });
        }),
      remove: windowId =>
        new Promise((resolve, reject) => {
          chrome.windows.remove(windowId, () => {
            const err = lastError(chrome.runtime);
            if (err) reject(err);
            else resolve();
          });
        }),
    },
    contextMenus: {
      create: properties => contextMenus.create(properties),
      removeAll: () => callbackPromise(chrome, callback => contextMenus.removeAll(callback)),
      update: (id, properties) =>
        callbackPromise(chrome, callback => contextMenus.update(id, properties, callback)),
      refresh: () => callbackPromise(chrome, callback => contextMenus.refresh(callback)),
      onClicked: contextMenus.onClicked ?? noopContextMenus.onClicked,
      onShown: contextMenus.onShown ?? noopContextMenus.onShown,
    },
  };
}

function callbackPromise(
  chrome: ChromeGlobal,
  invoke: (callback: () => void) => void
): Promise<void> {
  return new Promise((resolve, reject) =>
    invoke(() => {
      const err = lastError(chrome.runtime);
      if (err) reject(err);
      else resolve();
    })
  );
}

function hasNativeStorageLocal(value: unknown): value is NativeBrowserGlobal {
  const storage = (value as { storage?: { local?: unknown } } | undefined)?.storage;
  return typeof storage?.local === 'object' && storage.local !== null;
}

function buildNativeShim(native: NativeBrowserGlobal): BrowserShim {
  return {
    runtime: {
      ...native.runtime,
      connectNative: application => native.runtime.connectNative?.(application) ?? noopNativePort,
      onStartup: native.runtime.onStartup ?? noopRuntimeStartup,
    },
    tabs: {
      query: queryInfo => native.tabs.query(queryInfo),
      create: createProperties => native.tabs.create(createProperties),
      update: async (tabId, updateProperties) => {
        await native.tabs.update(tabId, updateProperties);
      },
      sendMessage: (tabId, message) => native.tabs.sendMessage(tabId, message),
      remove: tabId => native.tabs.remove(tabId),
    },
    downloads: native.downloads,
    storage: native.storage.local,
    windows: {
      create: createData => native.windows.create(createData),
      update: async (windowId, updateInfo) => {
        await native.windows.update(windowId, updateInfo);
      },
      remove: windowId => native.windows.remove(windowId),
    },
    contextMenus: {
      ...noopContextMenus,
      ...native.contextMenus,
      onClicked: native.contextMenus?.onClicked ?? noopContextMenus.onClicked,
      onShown: native.contextMenus?.onShown ?? noopContextMenus.onShown,
    },
  };
}

// ---------------------------------------------------------------------------
// Fallback stub (tests / environments without either global)
// ---------------------------------------------------------------------------

const noopContextMenus: BrowserShim['contextMenus'] = {
  create: () => {},
  removeAll: () => Promise.resolve(),
  update: () => Promise.resolve(),
  refresh: () => Promise.resolve(),
  onClicked: { addListener: () => {} },
  onShown: { addListener: () => {} },
};

const noopNativePort: NativePort = {
  postMessage: () => {},
  disconnect: () => {},
  onMessage: { addListener: () => {} },
  onDisconnect: { addListener: () => {} },
};

const noopRuntimeStartup: BrowserShim['runtime']['onStartup'] = {
  addListener: () => {},
};

const noopShim: BrowserShim = {
  runtime: {
    getURL: path => path,
    getManifest: () => ({}),
    sendMessage: () => Promise.resolve(undefined),
    connectNative: () => noopNativePort,
    onMessage: { addListener: () => {} },
    onStartup: noopRuntimeStartup,
  },
  tabs: {
    query: () => Promise.resolve([]),
    create: () => Promise.resolve({}),
    update: () => Promise.resolve(),
    sendMessage: () => Promise.resolve(undefined),
    remove: () => Promise.resolve(),
  },
  downloads: {
    download: () => Promise.resolve(0),
    search: () => Promise.resolve([]),
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
  storage: {
    get: () => Promise.resolve({}),
    set: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  },
  windows: {
    create: () => Promise.resolve({}),
    update: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  },
  contextMenus: noopContextMenus,
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
  const nativeBrowser = g['browser'];
  const chrome = g['chrome'] as ChromeGlobal | undefined;
  if (hasNativeStorageLocal(nativeBrowser)) return buildNativeShim(nativeBrowser);
  if (nativeBrowser) {
    const partialBrowser = nativeBrowser as Partial<BrowserShim>;
    return {
      ...noopShim,
      ...partialBrowser,
      runtime: { ...noopShim.runtime, ...partialBrowser.runtime },
      contextMenus: partialBrowser.contextMenus ?? noopContextMenus,
    };
  }
  return chrome ? buildChromeShim(chrome) : noopShim;
}

export const browser: BrowserShim = new Proxy({} as BrowserShim, {
  get(_target, prop: string) {
    return (getActiveBrowser() as unknown as Record<string, unknown>)[prop];
  },
});
