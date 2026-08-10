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

export interface PortEvent<T> {
  addListener: (callback: T) => void;
  removeListener: (callback: T) => void;
}

export interface NativePort {
  name?: string;
  postMessage: (message: unknown) => void;
  disconnect: () => void;
  onMessage: PortEvent<(message: unknown) => void>;
  onDisconnect: PortEvent<() => void>;
}

export interface ExecuteScriptDetails {
  target: { tabId: number; frameIds: number[] };
  files: string[];
  world: 'ISOLATED';
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
    connect: (tabId: number, connectInfo: { frameId?: number; name?: string }) => NativePort;
    create: (createProperties: { url: string; active?: boolean }) => Promise<{ id?: number }>;
    update: (tabId: number, updateProperties: { active?: boolean; url?: string }) => Promise<void>;
    sendMessage: (tabId: number, message: unknown) => Promise<unknown>;
    remove: (tabId: number) => Promise<void>;
    onRemoved: PortEvent<(tabId: number) => void>;
    onUpdated: PortEvent<(tabId: number, changeInfo: { url?: string; status?: string }) => void>;
  };
  scripting: {
    executeScript: (details: ExecuteScriptDetails) => Promise<unknown[]>;
  };
  downloads: {
    download: (options: { url: string; filename?: string; saveAs?: boolean }) => Promise<number>;
    cancel: (downloadId: number) => Promise<void>;
    search: (query: {
      id?: number;
    }) => Promise<{ id: number; state?: string; fileSize?: number }[]>;
    onChanged: PortEvent<(delta: DownloadDelta) => void>;
  };
  storage: {
    get: (keys?: unknown) => Promise<Record<string, unknown>>;
    set: (items: Record<string, unknown>) => Promise<void>;
    remove: (keys: string | string[]) => Promise<void>;
  };
  sessionStorage: {
    get: (keys?: unknown) => Promise<Record<string, unknown>>;
    set: (items: Record<string, unknown>) => Promise<void>;
    remove: (keys: string | string[]) => Promise<void>;
  };
  cookies: {
    get: (details: { url: string; name: string }) => Promise<{ value: string } | null>;
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
    connect?: (id: number, connectInfo?: { frameId?: number; name?: string }) => NativePort;
    create: (q: unknown, cb: (tab: unknown) => void) => void;
    update: (id: number, q: unknown, cb: () => void) => void;
    sendMessage: (id: number, message: unknown, cb: (response: unknown) => void) => void;
    remove: (id: number, cb: () => void) => void;
    onRemoved?: PortEvent<(tabId: number) => void>;
    onUpdated?: PortEvent<(tabId: number, changeInfo: { url?: string; status?: string }) => void>;
  };
  scripting?: {
    executeScript: (details: ExecuteScriptDetails, callback?: (results: unknown[]) => void) => void;
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
    cancel?: (downloadId: number, callback?: () => void) => void;
    search: (
      query: { id?: number },
      callback: (items: { id: number; state?: string; fileSize?: number }[]) => void
    ) => void;
    onChanged: PortEvent<(delta: DownloadDelta) => void>;
  };
  storage: {
    local: {
      get: (keys: unknown, cb: (result: Record<string, unknown>) => void) => void;
      set: (items: Record<string, unknown>, cb?: () => void) => void;
      remove: (keys: string | string[], cb?: () => void) => void;
    };
    session?: {
      get: (keys: unknown, cb: (result: Record<string, unknown>) => void) => void;
      set: (items: Record<string, unknown>, cb?: () => void) => void;
      remove: (keys: string | string[], cb?: () => void) => void;
    };
  };
  cookies: {
    get: (
      details: { url: string; name: string },
      callback: (cookie: { value: string } | null) => void
    ) => void;
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
    connect?: (tabId: number, connectInfo: { frameId?: number; name?: string }) => NativePort;
    create: (createProperties: { url: string; active?: boolean }) => Promise<{ id?: number }>;
    update: (
      tabId: number,
      updateProperties: { active?: boolean; url?: string }
    ) => Promise<unknown>;
    sendMessage: (tabId: number, message: unknown) => Promise<unknown>;
    remove: (tabId: number) => Promise<void>;
    onRemoved?: PortEvent<(tabId: number) => void>;
    onUpdated?: PortEvent<(tabId: number, changeInfo: { url?: string; status?: string }) => void>;
  };
  scripting?: {
    executeScript: (details: ExecuteScriptDetails) => Promise<unknown[]>;
  };
  downloads: {
    download: (options: { url: string; filename?: string; saveAs?: boolean }) => Promise<number>;
    cancel?: (downloadId: number) => Promise<void>;
    search: (query: {
      id?: number;
    }) => Promise<{ id: number; state?: string; fileSize?: number }[]>;
    onChanged: PortEvent<(delta: DownloadDelta) => void>;
  };
  storage: {
    local: {
      get: (keys?: unknown) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
      remove: (keys: string | string[]) => Promise<void>;
    };
    session?: {
      get: (keys?: unknown) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
      remove: (keys: string | string[]) => Promise<void>;
    };
  };
  cookies: {
    get: (details: { url: string; name: string }) => Promise<{ value: string } | null>;
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
  const session = chrome.storage.session;
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
      connect: (tabId, connectInfo) => chrome.tabs.connect?.(tabId, connectInfo) ?? noopNativePort,
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
      onRemoved: chrome.tabs.onRemoved ?? noopTabRemoved,
      onUpdated: chrome.tabs.onUpdated ?? noopTabUpdated,
    },
    scripting: {
      executeScript: details =>
        new Promise((resolve, reject) => {
          if (!chrome.scripting) {
            reject(new Error('The scripting permission is unavailable.'));
            return;
          }
          chrome.scripting.executeScript(details, results => {
            const err = lastError(chrome.runtime);
            if (err) reject(err);
            else resolve(results);
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
      cancel: downloadId =>
        new Promise((resolve, reject) => {
          if (!chrome.downloads.cancel) {
            reject(new Error('The downloads cancel API is unavailable.'));
            return;
          }
          chrome.downloads.cancel(downloadId, () => {
            const err = lastError(chrome.runtime);
            if (err) reject(err);
            else resolve();
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
    sessionStorage: session
      ? {
          get: keys =>
            new Promise((resolve, reject) => {
              session.get(keys, result => {
                const err = lastError(chrome.runtime);
                if (err) reject(err);
                else resolve(result);
              });
            }),
          set: items => callbackPromise(chrome, callback => session.set(items, callback)),
          remove: keys => callbackPromise(chrome, callback => session.remove(keys, callback)),
        }
      : unavailableSessionStorage,
    cookies: {
      get: details =>
        new Promise((resolve, reject) => {
          chrome.cookies.get(details, cookie => {
            const err = lastError(chrome.runtime);
            if (err) reject(err);
            else resolve(cookie);
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
      connect: (tabId, connectInfo) => native.tabs.connect?.(tabId, connectInfo) ?? noopNativePort,
      create: createProperties => native.tabs.create(createProperties),
      update: async (tabId, updateProperties) => {
        await native.tabs.update(tabId, updateProperties);
      },
      sendMessage: (tabId, message) => native.tabs.sendMessage(tabId, message),
      remove: tabId => native.tabs.remove(tabId),
      onRemoved: native.tabs.onRemoved ?? noopTabRemoved,
      onUpdated: native.tabs.onUpdated ?? noopTabUpdated,
    },
    scripting: native.scripting ?? noopScripting,
    downloads: {
      ...native.downloads,
      cancel:
        native.downloads.cancel ??
        (() => Promise.reject(new Error('The downloads cancel API is unavailable.'))),
    },
    storage: native.storage.local,
    sessionStorage: native.storage.session ?? unavailableSessionStorage,
    cookies: native.cookies ?? noopCookies,
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

const noopTabRemoved: BrowserShim['tabs']['onRemoved'] = {
  addListener: () => {},
  removeListener: () => {},
};

const noopTabUpdated: BrowserShim['tabs']['onUpdated'] = {
  addListener: () => {},
  removeListener: () => {},
};

const noopScripting: BrowserShim['scripting'] = {
  executeScript: () => Promise.reject(new Error('The scripting API is unavailable.')),
};

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
  onMessage: { addListener: () => {}, removeListener: () => {} },
  onDisconnect: { addListener: () => {}, removeListener: () => {} },
};

const noopRuntimeStartup: BrowserShim['runtime']['onStartup'] = {
  addListener: () => {},
};

const noopCookies: BrowserShim['cookies'] = {
  get: () => Promise.resolve(null),
};

const unavailableSessionStorage: BrowserShim['sessionStorage'] = {
  get: () => Promise.reject(new Error('Session storage is unavailable.')),
  set: () => Promise.reject(new Error('Session storage is unavailable.')),
  remove: () => Promise.reject(new Error('Session storage is unavailable.')),
};

const noopStorage: BrowserShim['storage'] = {
  get: () => Promise.resolve({}),
  set: () => Promise.resolve(),
  remove: () => Promise.resolve(),
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
    connect: () => noopNativePort,
    create: () => Promise.resolve({}),
    update: () => Promise.resolve(),
    sendMessage: () => Promise.resolve(undefined),
    remove: () => Promise.resolve(),
    onRemoved: noopTabRemoved,
    onUpdated: noopTabUpdated,
  },
  scripting: {
    executeScript: () => Promise.reject(new Error('The scripting API is unavailable.')),
  },
  downloads: {
    download: () => Promise.resolve(0),
    cancel: () => Promise.resolve(),
    search: () => Promise.resolve([]),
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
  storage: noopStorage,
  sessionStorage: noopStorage,
  cookies: noopCookies,
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
