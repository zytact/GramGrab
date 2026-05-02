/**
 * Unit tests for the browser compatibility shim (src/lib/browser.ts).
 *
 * Strategy: each test group saves/restores globalThis.browser and
 * globalThis.chrome, resets the module registry so the shim is
 * re-evaluated with the desired globals, then dynamically imports it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Helpers -------------------------------------------------------------------

type G = Record<string, unknown>;

async function loadShim() {
  const mod = await import('./browser');
  return mod.browser;
}

// We use vi.resetModules() + dynamic import so the shim re-evaluates
// globalThis on every test.

describe('browser shim', () => {
  let savedBrowser: unknown;
  let savedChrome: unknown;

  beforeEach(() => {
    savedBrowser = (globalThis as G)['browser'];
    savedChrome = (globalThis as G)['chrome'];
    vi.resetModules();
  });

  afterEach(() => {
    (globalThis as G)['browser'] = savedBrowser;
    (globalThis as G)['chrome'] = savedChrome;
    vi.resetModules();
  });

  // ── 1. Native `browser` present ──────────────────────────────────────────

  describe('when globalThis.browser is present', () => {
    it('delegates calls to the native browser object', async () => {
      const native = {
        runtime: {
          sendMessage: vi.fn().mockResolvedValue({ native: true }),
          onMessage: { addListener: vi.fn() },
        },
        tabs: { query: vi.fn().mockResolvedValue([{ id: 99 }]) },
        downloads: { download: vi.fn().mockResolvedValue(1) },
        storage: {
          get: vi.fn().mockResolvedValue({ a: 1 }),
          set: vi.fn().mockResolvedValue(undefined),
        },
      };
      (globalThis as G)['browser'] = native;
      (globalThis as G)['chrome'] = undefined;

      const shim = await loadShim();
      // Delegating runtime.sendMessage
      const msg = await shim.runtime.sendMessage({ type: 'TEST' });
      expect(msg).toEqual({ native: true });
      expect(native.runtime.sendMessage).toHaveBeenCalledWith({ type: 'TEST' });
      // Delegating tabs.query
      const tabs = await shim.tabs.query({ active: true });
      expect(tabs).toEqual([{ id: 99 }]);
    });
  });

  // ── 2. Chrome fallback ───────────────────────────────────────────────────

  describe('when only globalThis.chrome is present', () => {
    function makeChrome() {
      const runtime = {
        lastError: undefined as { message?: string } | undefined,
        sendMessage: vi.fn(),
        onMessage: { addListener: vi.fn() },
      };
      const tabs = { query: vi.fn() };
      const downloads = { download: vi.fn() };
      const storage = { local: { get: vi.fn(), set: vi.fn() } };
      return { runtime, tabs, downloads, storage };
    }

    beforeEach(() => {
      (globalThis as G)['browser'] = undefined;
    });

    it('wraps chrome.runtime.sendMessage into a Promise (success)', async () => {
      const chrome = makeChrome();
      chrome.runtime.sendMessage.mockImplementation((_msg: unknown, cb: (r: unknown) => void) =>
        cb({ ok: true })
      );
      (globalThis as G)['chrome'] = chrome;

      const shim = await loadShim();
      const result = await shim.runtime.sendMessage({ type: 'TEST' });
      expect(result).toEqual({ ok: true });
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        { type: 'TEST' },
        expect.any(Function)
      );
    });

    it('rejects sendMessage when chrome.runtime.lastError is set', async () => {
      const chrome = makeChrome();
      chrome.runtime.sendMessage.mockImplementation((_msg: unknown, cb: (r: unknown) => void) => {
        chrome.runtime.lastError = { message: 'Extension error' };
        cb(undefined);
        chrome.runtime.lastError = undefined;
      });
      (globalThis as G)['chrome'] = chrome;

      const shim = await loadShim();
      await expect(shim.runtime.sendMessage({})).rejects.toThrow('Extension error');
    });

    it('passes through runtime.onMessage.addListener', async () => {
      const chrome = makeChrome();
      (globalThis as G)['chrome'] = chrome;

      const shim = await loadShim();
      const listener = vi.fn();
      shim.runtime.onMessage.addListener(listener);
      expect(chrome.runtime.onMessage.addListener).toHaveBeenCalledWith(listener);
    });

    it('wraps chrome.tabs.query into a Promise (success)', async () => {
      const chrome = makeChrome();
      const fakeTabs = [{ id: 1, url: 'https://www.instagram.com/' }];
      chrome.tabs.query.mockImplementation((_q: unknown, cb: (tabs: unknown[]) => void) =>
        cb(fakeTabs)
      );
      (globalThis as G)['chrome'] = chrome;

      const shim = await loadShim();
      const tabs = await shim.tabs.query({ active: true, currentWindow: true });
      expect(tabs).toEqual(fakeTabs);
    });

    it('rejects tabs.query when chrome.runtime.lastError is set', async () => {
      const chrome = makeChrome();
      chrome.tabs.query.mockImplementation((_q: unknown, cb: (tabs: unknown[]) => void) => {
        chrome.runtime.lastError = { message: 'tabs error' };
        cb([]);
        chrome.runtime.lastError = undefined;
      });
      (globalThis as G)['chrome'] = chrome;

      const shim = await loadShim();
      await expect(shim.tabs.query({})).rejects.toThrow('tabs error');
    });

    it('wraps chrome.downloads.download into a Promise (success)', async () => {
      const chrome = makeChrome();
      chrome.downloads.download.mockImplementation((_opts: unknown, cb?: (id: number) => void) =>
        cb?.(42)
      );
      (globalThis as G)['chrome'] = chrome;

      const shim = await loadShim();
      const id = await shim.downloads.download({ url: 'https://example.com/file.jpg' });
      expect(id).toBe(42);
    });

    it('rejects downloads.download when chrome.runtime.lastError is set', async () => {
      const chrome = makeChrome();
      chrome.downloads.download.mockImplementation((_opts: unknown, cb?: (id: number) => void) => {
        chrome.runtime.lastError = { message: 'download failed' };
        cb?.(0);
        chrome.runtime.lastError = undefined;
      });
      (globalThis as G)['chrome'] = chrome;

      const shim = await loadShim();
      await expect(
        shim.downloads.download({ url: 'https://example.com/file.jpg' })
      ).rejects.toThrow('download failed');
    });

    it('wraps chrome.storage.local.get into a Promise', async () => {
      const chrome = makeChrome();
      chrome.storage.local.get.mockImplementation(
        (_keys: unknown, cb: (r: Record<string, unknown>) => void) => cb({ foo: 'bar' })
      );
      (globalThis as G)['chrome'] = chrome;

      const shim = await loadShim();
      const result = await shim.storage.get('foo');
      expect(result).toEqual({ foo: 'bar' });
    });

    it('wraps chrome.storage.local.set into a Promise', async () => {
      const chrome = makeChrome();
      chrome.storage.local.set.mockImplementation(
        (_items: Record<string, unknown>, cb?: () => void) => cb?.()
      );
      (globalThis as G)['chrome'] = chrome;

      const shim = await loadShim();
      await expect(shim.storage.set({ key: 'value' })).resolves.toBeUndefined();
    });
  });

  // ── 3. No browser, no chrome (test / SSR env) ────────────────────────────

  describe('when neither browser nor chrome is available', () => {
    beforeEach(() => {
      (globalThis as G)['browser'] = undefined;
      (globalThis as G)['chrome'] = undefined;
    });

    it('falls back to a no-op shim that returns resolved Promises', async () => {
      const shim = await loadShim();
      await expect(shim.runtime.sendMessage({})).resolves.toBeUndefined();
      await expect(shim.tabs.query({})).resolves.toEqual([]);
      await expect(shim.downloads.download({ url: '' })).resolves.toBe(0);
      await expect(shim.storage.get()).resolves.toEqual({});
      await expect(shim.storage.set({})).resolves.toBeUndefined();
    });

    it('no-op onMessage.addListener does not throw', async () => {
      const shim = await loadShim();
      expect(() => shim.runtime.onMessage.addListener(vi.fn())).not.toThrow();
    });
  });
});
