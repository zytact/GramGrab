import { Schema } from 'effect';
import { vi } from 'vite-plus/test';
import type { DownloadQuery } from '../lib/browser.ts';
import {
  Event,
  PROTOCOL_VERSION,
  Request,
  type Command,
  type EventPayload,
} from '@gramgrab/protocol';

type Listener = (
  msg: unknown,
  sender: unknown,
  sendResponse: (r: unknown) => void
) => boolean | void;

/** In-memory `storage.local`/`storage.session` that round-trips values like the browser does. */
class FakeStorageArea {
  readonly data = new Map<string, string>();
  failWrites = false;
  /** Rejects any write that would leave the area larger than this many bytes. */
  quotaBytes = Number.POSITIVE_INFINITY;

  get = vi.fn(async (keys?: unknown) => {
    const wanted =
      keys === undefined || keys === null
        ? [...this.data.keys()]
        : typeof keys === 'string'
          ? [keys]
          : Array.isArray(keys)
            ? keys.filter((key): key is string => typeof key === 'string')
            : Object.keys(keys as Record<string, unknown>);
    const result: Record<string, unknown> = {};
    for (const key of wanted) {
      const value = this.data.get(key);
      if (value !== undefined) result[key] = JSON.parse(value);
    }
    return result;
  });

  set = vi.fn(async (items: Record<string, unknown>) => {
    if (this.failWrites) throw new Error('QUOTA_BYTES quota exceeded');
    const next = new Map(this.data);
    for (const [key, value] of Object.entries(items)) next.set(key, JSON.stringify(value));
    const size = [...next.values()].reduce((total, value) => total + value.length, 0);
    if (size > this.quotaBytes) throw new Error('QUOTA_BYTES quota exceeded');
    for (const [key, value] of next) this.data.set(key, value);
  });

  remove = vi.fn(async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.data.delete(key);
  });

  read(key: string): unknown {
    const value = this.data.get(key);
    return value === undefined ? undefined : JSON.parse(value);
  }

  write(key: string, value: unknown): void {
    this.data.set(key, JSON.stringify(value));
  }
}

interface FakeDownload {
  id: number;
  url: string;
  filename?: string;
  saveAs?: boolean;
  state: 'in_progress' | 'complete' | 'interrupted';
  startTime: string;
  byExtensionId: string;
}

type EventHook<T extends (...args: never[]) => unknown> = {
  listeners: T[];
  addListener: (listener: T) => void;
  removeListener: (listener: T) => void;
  hasListener: (listener: T) => boolean;
};

function hook<T extends (...args: never[]) => unknown>(): EventHook<T> {
  const listeners: T[] = [];
  return {
    listeners,
    addListener: listener => void listeners.push(listener),
    removeListener: listener => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    hasListener: listener => listeners.includes(listener),
  };
}

/**
 * A fake browser faithful enough to run the real background worker against: storage persists
 * across worker reloads, alarms, notifications, permissions, downloads, and the native bridge are
 * observable, and everything external is replaceable per test.
 */
export function createExtensionHarness() {
  const local = new FakeStorageArea();
  const session = new FakeStorageArea();
  const downloads: FakeDownload[] = [];
  let nextDownloadId = 1;
  const nativeMessages: unknown[] = [];
  const nativeSubscribers = new Set<(message: unknown) => void>();
  const notifications = new Map<string, { title: string; message: string; iconUrl: string }>();
  const alarms = new Map<
    string,
    { name: string; periodInMinutes?: number; scheduledTime: number }
  >();
  const grantedPermissions = new Set<string>();
  let messageListener: Listener | undefined;
  let nativeListener: ((message: unknown) => void) | undefined;
  let badge = '';
  let downloadFailure: Error | undefined;
  let notificationFailure: Error | undefined;
  let iconFailure = false;

  const onStartup = hook<() => void>();
  const onInstalled = hook<(details: { reason: string }) => void>();
  const onAlarm = hook<(alarm: { name: string }) => void>();
  const onNotificationClicked = hook<(id: string) => void>();
  const onDownloadChanged = hook<(delta: { id: number; state?: { current?: string } }) => void>();

  const fakeBrowser = {
    runtime: {
      getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
      getManifest: vi.fn(() => ({ version: 'test' })),
      sendMessage: vi.fn((message: unknown) => send(message)),
      openOptionsPage: vi.fn(async () => undefined),
      onMessage: { addListener: vi.fn((listener: Listener) => (messageListener = listener)) },
      onStartup,
      onInstalled,
      connectNative: vi.fn(() => ({
        postMessage: (message: unknown) => {
          nativeMessages.push(message);
          for (const subscriber of nativeSubscribers) subscriber(message);
        },
        disconnect: () => undefined,
        onMessage: {
          addListener: (listener: (message: unknown) => void) => (nativeListener = listener),
        },
        onDisconnect: { addListener: () => undefined },
      })),
    },
    tabs: {
      query: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: 1 })),
      update: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
    windows: {
      create: vi.fn(async () => ({ id: 2, tabs: [{ id: 1 }] })),
      update: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
    downloads: {
      download: vi.fn(async (options: { url: string; filename?: string; saveAs?: boolean }) => {
        if (downloadFailure) throw downloadFailure;
        const id = nextDownloadId++;
        downloads.push({
          id,
          ...options,
          state: 'in_progress',
          startTime: new Date(Date.now()).toISOString(),
          byExtensionId: 'test',
        });
        return id;
      }),
      cancel: vi.fn(async () => undefined),
      search: vi.fn(async (query: DownloadQuery) =>
        downloads.filter(
          download =>
            (query.id === undefined || download.id === query.id) &&
            (query.startedAfter === undefined || download.startTime > query.startedAfter) &&
            (query.state === undefined || download.state === query.state)
        )
      ),
      onChanged: onDownloadChanged,
    },
    storage: local,
    sessionStorage: session,
    cookies: { get: vi.fn(async () => ({ value: 'csrf-token' })) },
    alarms: {
      create: vi.fn(
        async (name: string, info: { periodInMinutes?: number; delayInMinutes?: number }) => {
          alarms.set(name, {
            name,
            ...(info.periodInMinutes ? { periodInMinutes: info.periodInMinutes } : {}),
            scheduledTime: Date.now() + (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60_000,
          });
        }
      ),
      get: vi.fn(async (name: string) => alarms.get(name)),
      clear: vi.fn(async (name: string) => alarms.delete(name)),
      onAlarm,
    },
    notifications: {
      create: vi.fn(
        async (id: string, options: { title: string; message: string; iconUrl: string }) => {
          if (notificationFailure) throw notificationFailure;
          if (iconFailure && options.iconUrl.startsWith('data:'))
            throw new Error('Unable to download all specified images.');
          notifications.set(id, options);
          return id;
        }
      ),
      clear: vi.fn(async (id: string) => notifications.delete(id)),
      onClicked: onNotificationClicked,
    },
    permissions: {
      contains: vi.fn(async (query: { permissions?: string[] }) =>
        (query.permissions ?? []).every(permission => grantedPermissions.has(permission))
      ),
      request: vi.fn(async (query: { permissions?: string[] }) => {
        for (const permission of query.permissions ?? []) grantedPermissions.add(permission);
        return true;
      }),
    },
    action: {
      setBadgeText: vi.fn(async ({ text }: { text: string }) => {
        badge = text;
      }),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
    },
    contextMenus: {
      create: vi.fn(),
      removeAll: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      refresh: vi.fn(async () => undefined),
      onClicked: { addListener: vi.fn() },
      onShown: { addListener: vi.fn() },
    },
  };

  /** Replaces `fetch` for the test. Unhandled requests fail loudly. */
  function setFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    globalThis.fetch = Object.assign(
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        handler(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          init
        )
      ),
      { preconnect: vi.fn() }
    );
  }

  /** Imports a fresh background worker against the retained fake browser state. */
  async function loadWorker() {
    vi.resetModules();
    messageListener = undefined;
    nativeListener = undefined;
    onStartup.listeners.length = 0;
    onInstalled.listeners.length = 0;
    onAlarm.listeners.length = 0;
    onNotificationClicked.listeners.length = 0;
    globalThis.browser = fakeBrowser;
    await import('../background.ts');
  }

  function send<T = unknown>(message: unknown): Promise<T> {
    if (!messageListener) throw new Error('Background worker is not loaded');
    const listener = messageListener;
    return new Promise(resolve => {
      if (!listener(message, {}, response => resolve(response as T))) resolve(undefined as T);
    });
  }

  /** Sends a protocol command through the native bridge and resolves with its terminal event. */
  function command(
    value: Command,
    onEvent: (event: EventPayload) => void = () => undefined
  ): Promise<EventPayload> {
    if (!nativeListener) throw new Error('Native bridge is not connected');
    const requestId = Schema.decodeUnknownSync(Request.fields.requestId)(crypto.randomUUID());
    const terminal = new Promise<EventPayload>(resolve => {
      const subscriber = (message: unknown) => {
        const event = Schema.decodeUnknownSync(Event)(message);
        if (event.requestId !== requestId) return;
        onEvent(event.event);
        if (event.event._tag !== 'Completed' && event.event._tag !== 'Rejected') return;
        nativeSubscribers.delete(subscriber);
        resolve(event.event);
      };
      nativeSubscribers.add(subscriber);
    });
    nativeListener(
      Schema.encodeSync(Request)(
        Request.make({ version: PROTOCOL_VERSION, requestId, command: value })
      )
    );
    return terminal;
  }

  return {
    browser: fakeBrowser,
    local,
    session,
    downloads,
    notifications,
    alarms,
    nativeMessages,
    grantedPermissions,
    get badge() {
      return badge;
    },
    failDownloads(error: Error | undefined) {
      downloadFailure = error;
    },
    failNotifications(error: Error | undefined) {
      notificationFailure = error;
    },
    failNotificationIcons(value: boolean) {
      iconFailure = value;
    },
    setFetch,
    loadWorker,
    send,
    command,
    fireStartup: () => onStartup.listeners.forEach(listener => listener()),
    fireInstalled: (reason = 'install') =>
      onInstalled.listeners.forEach(listener => listener({ reason })),
    fireAlarm: (name: string) => onAlarm.listeners.forEach(listener => listener({ name })),
    clickNotification: (id: string) =>
      onNotificationClicked.listeners.forEach(listener => listener(id)),
  };
}

export type ExtensionHarness = ReturnType<typeof createExtensionHarness>;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
