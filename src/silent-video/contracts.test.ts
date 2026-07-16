import { describe, expect, it } from 'vite-plus/test';
import { createRequestId } from '../download/contracts.ts';
import { decodeSilentWorkerRequest, InspectSilentVideo, ProcessSilentVideo } from './contracts.ts';

describe('silent video worker protocol', () => {
  it('decodes a correlated inspection request', async () => {
    const request = InspectSilentVideo.make({
      requestId: createRequestId(),
      url: 'https://example.com/video.mp4',
    });
    await expect(decodeSilentWorkerRequest(request)).resolves.toEqual(request);
  });

  it('rejects malformed cross-thread messages', async () => {
    await expect(
      decodeSilentWorkerRequest({ _tag: 'inspect', requestId: 'bad' })
    ).rejects.toBeDefined();
  });

  it('processes the input cached by the correlated inspection', async () => {
    const request = ProcessSilentVideo.make({
      requestId: createRequestId(),
      transcode: false,
    });
    await expect(decodeSilentWorkerRequest(request)).resolves.toEqual(request);
  });
});
