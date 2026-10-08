import { afterEach, expect, it, vi } from 'vite-plus/test';
import { HistoryList } from '@gramgrab/protocol';
import { createExtensionHarness } from '../test/extension-harness.ts';
import { DOWNLOAD_HISTORY_KEY, DOWNLOAD_HISTORY_VERSION } from './contracts.ts';

const savedBrowser = globalThis.browser;

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.browser = savedBrowser;
});

it.each([
  { mode: { _tag: 'DirectExport' } },
  { mode: { _tag: 'FrameExport', timestampSeconds: 1.5 }, rotation: 90 },
  { mode: { _tag: 'SilentExport', reencode: 'require' }, rotation: 270 },
])(
  'lists persisted $mode._tag settings through the native History bridge',
  async requestedExport => {
    const harness = createExtensionHarness();
    harness.local.write(DOWNLOAD_HISTORY_KEY, {
      version: DOWNLOAD_HISTORY_VERSION,
      entries: [
        {
          id: 'instagram-history',
          origin: { kind: 'instants' },
          itemIndex: 0,
          mediaType: 'image',
          filenameHint: 'instagram',
          requestedExport,
          downloadedAt: 1,
          outcome: 'accepted',
        },
      ],
    });
    await harness.loadWorker();

    const terminal = await harness.command(HistoryList.make());
    if (terminal._tag !== 'Completed') throw new Error(JSON.stringify(terminal));
    expect(terminal).toMatchObject({
      _tag: 'Completed',
      result: {
        _tag: 'HistoryListResult',
        repaired: false,
        entries: [
          {
            id: 'instagram-history',
            requestedExport,
          },
        ],
      },
    });
  }
);
