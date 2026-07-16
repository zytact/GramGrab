import { describe, expect, it } from 'vite-plus/test';
import { createRequestId } from '../download/contracts.ts';
import { decodeSilentWorkerRequest, InspectSilentVideo } from './contracts.ts';

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
});
