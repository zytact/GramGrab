import { describe, expect, it } from 'vite-plus/test';
import { createOperationId, createRequestId } from '../download/contracts.ts';
import { decodeSilentWorkerRequest, InspectSilentVideo, ProcessSilentVideo } from './contracts.ts';

describe('silent video worker protocol', () => {
  it('decodes correlated inspect and process requests', async () => {
    const operationId = createOperationId();
    const inspect = InspectSilentVideo.make({
      operationId,
      requestId: createRequestId(),
      url: 'https://example.com/video.mp4',
      useCachedInput: false,
    });
    const process = ProcessSilentVideo.make({
      operationId,
      requestId: createRequestId(),
      transcode: false,
      keepAudio: false,
    });
    await expect(decodeSilentWorkerRequest(inspect)).resolves.toEqual(inspect);
    await expect(decodeSilentWorkerRequest(process)).resolves.toEqual(process);
  });

  it('rejects malformed cross-thread messages', async () => {
    await expect(
      decodeSilentWorkerRequest({ _tag: 'inspect', requestId: 'bad' })
    ).rejects.toBeDefined();
  });
});
