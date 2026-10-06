import { vi } from 'vite-plus/test';
import type { ExtensionHarness } from './extension-harness.ts';
import type { createWatchInstagram } from './watch-instagram.ts';
import { createMemoryDirectory, workerAdapter } from './silent-browser.ts';
import { decodeSilentWorkerRequest } from '../silent-video/contracts.ts';
export async function processingBrowser(
  harness: ExtensionHarness,
  instagram: ReturnType<typeof createWatchInstagram>
) {
  const { browser } = await import('../lib/browser.ts');
  await harness.loadRunner();
  vi.spyOn(browser.windows, 'create').mockImplementation(async () => {
    await harness.loadRunner();
    return { id: 2, tabs: [{ id: 1 }] };
  });
  const original = vi.mocked(browser.downloads.download).getMockImplementation()!;
  vi.spyOn(browser.downloads, 'download').mockImplementation(async options => {
    const id = await original(options);
    const download = harness.downloads.find(download => download.id === id)!;
    download.state = 'complete';
    download.fileSize = 12;
    return id;
  });
  harness.setFetch((url, init) =>
    new URL(url).hostname.endsWith('instagram.com')
      ? instagram.handle(url, init)
      : new Response(new Blob(['media']))
  );
  const NativeURL = globalThis.URL;
  vi.stubGlobal(
    'URL',
    class extends NativeURL {
      static override createObjectURL() {
        return 'blob:prepared-media';
      }
      static override revokeObjectURL() {}
    }
  );
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
  vi.spyOn(HTMLMediaElement.prototype, 'duration', 'get').mockReturnValue(60);
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(640);
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(480);
  const seek = vi
    .spyOn(HTMLMediaElement.prototype, 'currentTime', 'set')
    .mockImplementation(function (this: HTMLMediaElement) {
      setTimeout(() => this.dispatchEvent(new Event('seeked')), 1);
    });
  const context = { drawImage: vi.fn(), translate: vi.fn(), rotate: vi.fn() };
  vi.stubGlobal('createImageBitmap', async () => ({ width: 640, height: 480, close: vi.fn() }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback =>
    callback(new Blob(['frame'], { type: 'image/jpeg' }))
  );
  return { seek, context };
}

export function silentBrowser() {
  const directory = createMemoryDirectory();
  vi.stubGlobal('Worker', workerAdapter.Worker);
  vi.stubGlobal('navigator', { storage: { getDirectory: () => Promise.resolve(directory) } });
  workerAdapter.onCreate = worker => {
    worker.onRequest = raw => {
      void decodeSilentWorkerRequest(raw).then(request => {
        const { operationId, requestId } = request;
        if (request._tag === 'inspect')
          worker.respond({
            _tag: 'inspected',
            preflight: {
              operationId,
              requestId,
              audioTrackCount: 1,
              videoCodec: 'av1',
              durationSeconds: 60,
              width: 640,
              height: 480,
              copyCompatible: false,
            },
          });
        else if (request._tag === 'process') {
          directory.files.set('output.mp4', ['silent']);
          worker.respond({
            _tag: 'processed',
            operationId,
            requestId,
            alreadySilent: false,
            opfsName: 'output.mp4',
          });
        } else worker.respond({ _tag: 'released', operationId, requestId });
      });
    };
  };
}
