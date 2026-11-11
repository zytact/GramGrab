import { describe, expect, it } from 'vite-plus/test';
import { createOperationId, createRequestId } from '../download/contracts.ts';
import { decodeSilentWorkerRequest, InspectSilentVideo, ProcessSilentVideo } from './contracts.ts';

describe('silent video worker protocol', () => {
  it('decodes correlated inspect and process requests', async () => {
    const operationId = createOperationId();
    const inspectRequest = InspectSilentVideo.make({
      operationId,
      requestId: createRequestId(),
      url: 'https://example.com/video.mp4',
      useCachedInput: false,
    });
    const processRequest = ProcessSilentVideo.make({
      operationId,
      requestId: createRequestId(),
      transcode: false,
      keepAudio: false,
    });
    await expect(decodeSilentWorkerRequest(inspectRequest)).resolves.toEqual(inspectRequest);
    await expect(decodeSilentWorkerRequest(processRequest)).resolves.toEqual(processRequest);
  });

  it('rejects malformed cross-thread messages', async () => {
    await expect(
      decodeSilentWorkerRequest({ _tag: 'inspect', requestId: 'bad' })
    ).rejects.toBeDefined();
  });
});
