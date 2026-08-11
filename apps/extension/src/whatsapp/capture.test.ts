import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { Either } from 'effect';
import { getDownloadCalls, getMockBrowser, resetBrowserMocks } from '../test/setup.ts';
import { createOperationId, createRequestId } from '../download/contracts.ts';
import { captureWhatsAppVisibleStatus } from './capture.ts';
import { encodeCanonicalBase64 } from './base64.ts';
import { decodeWhatsAppInbound } from './contracts.ts';
import { WHATSAPP_EDIT_LEASE_MS } from './limits.ts';

let revokeObjectUrl: ReturnType<typeof vi.fn>;

function makePort() {
  const messageListeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  return {
    name: 'gramgrab-whatsapp-capture-v1',
    postMessage: vi.fn(),
    disconnect: vi.fn(() => disconnectListeners.forEach(listener => listener())),
    onMessage: {
      addListener: vi.fn((listener: (message: unknown) => void) => messageListeners.add(listener)),
      removeListener: vi.fn((listener: (message: unknown) => void) =>
        messageListeners.delete(listener)
      ),
    },
    onDisconnect: {
      addListener: vi.fn((listener: () => void) => disconnectListeners.add(listener)),
      removeListener: vi.fn((listener: () => void) => disconnectListeners.delete(listener)),
    },
    emit: (message: unknown) => messageListeners.forEach(listener => listener(message)),
  };
}

function startMessage(port: ReturnType<typeof makePort>) {
  const first = port.postMessage.mock.calls[0]?.[0];
  if (!first) throw new Error('CaptureStart was not sent');
  const decoded = decodeWhatsAppInbound(first);
  if (Either.isLeft(decoded) || decoded.right.tag !== 'CaptureStart')
    throw new Error('Expected CaptureStart');
  return decoded.right;
}

describe('WhatsApp popup-owned capture transfer', () => {
  beforeEach(() => {
    resetBrowserMocks();
    getMockBrowser().tabs.query.mockResolvedValue([
      { id: 44, url: 'https://web.whatsapp.com/status' },
    ]);
    getMockBrowser().scripting.executeScript.mockResolvedValue([]);
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:extension-owned'),
    });
    revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectUrl,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetBrowserMocks();
  });

  it('rejects a non-WhatsApp active tab before injection', async () => {
    getMockBrowser().tabs.query.mockResolvedValue([
      { id: 44, url: 'https://web.whatsapp.com.evil.example/status' },
    ]);
    await expect(captureWhatsAppVisibleStatus()).rejects.toMatchObject({
      reason: 'page-access-failed',
    });
    expect(getMockBrowser().scripting.executeScript).not.toHaveBeenCalled();
    expect(getMockBrowser().tabs.connect).not.toHaveBeenCalled();
  });

  it('rejects a controller envelope that reuses the popup request identity', async () => {
    const port = makePort();
    getMockBrowser().tabs.connect.mockReturnValue(port);
    const pending = captureWhatsAppVisibleStatus();
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalled());
    const start = startMessage(port);
    port.emit({
      protocolVersion: 1,
      requestId: start.requestId,
      operationId: start.operationId,
      tag: 'CaptureMetadata',
      kind: 'photo',
      mimeType: 'image/jpeg',
      byteLength: 1,
      width: 1,
      height: 1,
    });
    await expect(pending).rejects.toMatchObject({ reason: 'transfer-failed' });
  });

  it('releases the snapshot and object URL immediately after download acceptance', async () => {
    const port = makePort();
    getMockBrowser().tabs.connect.mockReturnValue(port);
    const pending = captureWhatsAppVisibleStatus();
    await vi.waitFor(() => expect(getMockBrowser().scripting.executeScript).toHaveBeenCalled());
    expect(getMockBrowser().tabs.query).toHaveBeenCalledWith({
      active: true,
      currentWindow: true,
    });
    expect(getMockBrowser().scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 44, frameIds: [0] },
      files: ['js/whatsapp-controller.js'],
      world: 'ISOLATED',
    });
    expect(getMockBrowser().tabs.connect).toHaveBeenCalledWith(44, {
      frameId: 0,
      name: 'gramgrab-whatsapp-capture-v1',
    });

    const start = startMessage(port);
    const payload = new Uint8Array([7, 8, 9]);
    port.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: start.operationId,
      tag: 'CaptureMetadata',
      kind: 'photo',
      mimeType: 'image/jpeg',
      byteLength: payload.length,
      width: 640,
      height: 480,
    });
    port.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: start.operationId,
      tag: 'CaptureChunk',
      sequence: 0,
      decodedLength: payload.length,
      payload: encodeCanonicalBase64(payload),
    });
    const ack = port.postMessage.mock.calls.at(-1)?.[0];
    expect(ack).toMatchObject({ tag: 'ChunkAck', sequence: 0 });
    port.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: start.operationId,
      tag: 'CaptureComplete',
      chunkCount: 1,
      byteLength: payload.length,
    });

    const handle = await pending;
    expect(handle.descriptor.kind).toBe('photo');
    expect(handle.snapshot.blob.size).toBe(payload.length);
    expect(JSON.stringify(port.postMessage.mock.calls)).not.toContain('Blob');

    let resolveHistory: ((result: { saved: true }) => void) | undefined;
    getMockBrowser().runtime.sendMessage.mockReturnValueOnce(
      new Promise(resolve => {
        resolveHistory = resolve;
      })
    );
    const downloading = handle.download();
    await vi.waitFor(() => expect(getDownloadCalls()).toHaveLength(1));
    expect(revokeObjectUrl).toHaveBeenCalledExactlyOnceWith('blob:extension-owned');
    expect(getMockBrowser().runtime.sendMessage).toHaveBeenCalledWith({
      type: 'RECORD_WHATSAPP_HISTORY',
      receipt: {
        source: 'whatsapp',
        mediaKind: 'photo',
        timestamp: expect.any(Number),
        savedFilename: handle.filename,
        outcome: 'accepted',
      },
    });
    const receipt = getMockBrowser().runtime.sendMessage.mock.calls[0]?.[0] as {
      receipt: Record<string, unknown>;
    };
    expect(Object.keys(receipt.receipt).sort()).toEqual([
      'mediaKind',
      'outcome',
      'savedFilename',
      'source',
      'timestamp',
    ]);
    expect(JSON.stringify(receipt.receipt)).not.toContain(handle.descriptor.captureId);
    expect(getMockBrowser().storage.set).not.toHaveBeenCalled();
    if (!resolveHistory) throw new Error('Expected History persistence to be pending.');
    resolveHistory({ saved: true });
    const download = await downloading;
    expect(download.downloadId).toBe(1);
    expect(download.warning).toBeUndefined();
    const onChanged = getMockBrowser().downloads.onChanged.addListener.mock.calls.at(-1)?.[0] as
      | ((delta: { id: number; state?: { current?: string } }) => void)
      | undefined;
    if (!onChanged) throw new Error('Download listener was not registered');
    onChanged({ id: download.downloadId, state: { current: 'complete' } });
    handle.release();
    expect(revokeObjectUrl).toHaveBeenCalledExactlyOnceWith('blob:extension-owned');
  });

  it('returns HISTORY_SAVE_FAILED without blocking an accepted download', async () => {
    const port = makePort();
    getMockBrowser().tabs.connect.mockReturnValue(port);
    getMockBrowser().runtime.sendMessage.mockRejectedValueOnce(new Error('history unavailable'));
    const pending = captureWhatsAppVisibleStatus();
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalled());
    const start = startMessage(port);
    port.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: start.operationId,
      tag: 'CaptureMetadata',
      kind: 'photo',
      mimeType: 'image/jpeg',
      byteLength: 1,
      width: 1,
      height: 1,
    });
    port.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: start.operationId,
      tag: 'CaptureChunk',
      sequence: 0,
      decodedLength: 1,
      payload: 'AQ==',
    });
    port.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: start.operationId,
      tag: 'CaptureComplete',
      chunkCount: 1,
      byteLength: 1,
    });

    const download = await (await pending).download();
    expect(download).toMatchObject({
      downloadId: 1,
      warning: { code: 'HISTORY_SAVE_FAILED' },
    });
    expect(getDownloadCalls()).toHaveLength(1);
  });

  it('discards every byte when sequence, chunk-length, or aggregate-length validation fails', async () => {
    const port = makePort();
    getMockBrowser().tabs.connect.mockReturnValue(port);
    const pending = captureWhatsAppVisibleStatus();
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalled());
    const start = startMessage(port);
    port.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: start.operationId,
      tag: 'CaptureMetadata',
      kind: 'photo',
      mimeType: 'image/png',
      byteLength: 1,
      width: 1,
      height: 1,
    });
    port.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: start.operationId,
      tag: 'CaptureChunk',
      sequence: 1,
      decodedLength: 1,
      payload: 'AQ==',
    });
    await expect(pending).rejects.toMatchObject({ reason: 'transfer-failed' });
    expect(getDownloadCalls()).toHaveLength(0);
    expect(port.postMessage.mock.calls.some(call => call[0]?.tag === 'CaptureAccept')).toBe(false);

    const mismatchedChunkPort = makePort();
    getMockBrowser().tabs.connect.mockReturnValue(mismatchedChunkPort);
    const mismatchedChunk = captureWhatsAppVisibleStatus();
    await vi.waitFor(() => expect(mismatchedChunkPort.postMessage).toHaveBeenCalled());
    const mismatchedChunkStart = startMessage(mismatchedChunkPort);
    mismatchedChunkPort.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: mismatchedChunkStart.operationId,
      tag: 'CaptureMetadata',
      kind: 'photo',
      mimeType: 'image/png',
      byteLength: 1,
      width: 1,
      height: 1,
    });
    mismatchedChunkPort.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: mismatchedChunkStart.operationId,
      tag: 'CaptureChunk',
      sequence: 0,
      decodedLength: 2,
      payload: 'AQ==',
    });
    await expect(mismatchedChunk).rejects.toMatchObject({ reason: 'transfer-failed' });
    expect(
      mismatchedChunkPort.postMessage.mock.calls.some(call => call[0]?.tag === 'CaptureAccept')
    ).toBe(false);

    const mismatchedAggregatePort = makePort();
    getMockBrowser().tabs.connect.mockReturnValue(mismatchedAggregatePort);
    const mismatchedAggregate = captureWhatsAppVisibleStatus();
    await vi.waitFor(() => expect(mismatchedAggregatePort.postMessage).toHaveBeenCalled());
    const mismatchedAggregateStart = startMessage(mismatchedAggregatePort);
    mismatchedAggregatePort.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: mismatchedAggregateStart.operationId,
      tag: 'CaptureMetadata',
      kind: 'photo',
      mimeType: 'image/png',
      byteLength: 2,
      width: 1,
      height: 1,
    });
    mismatchedAggregatePort.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: mismatchedAggregateStart.operationId,
      tag: 'CaptureChunk',
      sequence: 0,
      decodedLength: 1,
      payload: 'AQ==',
    });
    mismatchedAggregatePort.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: mismatchedAggregateStart.operationId,
      tag: 'CaptureComplete',
      chunkCount: 1,
      byteLength: 2,
    });
    await expect(mismatchedAggregate).rejects.toMatchObject({ reason: 'transfer-failed' });
    expect(
      mismatchedAggregatePort.postMessage.mock.calls.some(call => call[0]?.tag === 'CaptureAccept')
    ).toBe(false);
  });

  it('cancels a pending capture with a closed cancellation envelope on popup close', async () => {
    const port = makePort();
    getMockBrowser().tabs.connect.mockReturnValue(port);
    const pending = captureWhatsAppVisibleStatus();
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalled());

    window.dispatchEvent(new Event('pagehide'));

    await expect(pending).rejects.toMatchObject({ reason: 'cancelled' });
    expect(port.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
      tag: 'CaptureCancel',
      reason: 'popup-closed',
    });
  });

  it('releases capture bytes and cancels an active browser download at the lease ceiling', async () => {
    vi.useFakeTimers();
    const port = makePort();
    getMockBrowser().tabs.connect.mockReturnValue(port);
    const pending = captureWhatsAppVisibleStatus();
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalled());
    const start = startMessage(port);
    port.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: start.operationId,
      tag: 'CaptureMetadata',
      kind: 'photo',
      mimeType: 'image/webp',
      byteLength: 1,
      width: 1,
      height: 1,
    });
    port.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: start.operationId,
      tag: 'CaptureChunk',
      sequence: 0,
      decodedLength: 1,
      payload: 'AQ==',
    });
    port.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: start.operationId,
      tag: 'CaptureComplete',
      chunkCount: 1,
      byteLength: 1,
    });
    const handle = await pending;
    await handle.download();
    vi.advanceTimersByTime(WHATSAPP_EDIT_LEASE_MS);
    expect(getMockBrowser().downloads.cancel).toHaveBeenCalledWith(1);
    expect(revokeObjectUrl).toHaveBeenCalledExactlyOnceWith('blob:extension-owned');
  });

  it('releases an accepted-but-undownloaded snapshot at the independent retention ceiling', async () => {
    vi.useFakeTimers();
    const port = makePort();
    getMockBrowser().tabs.connect.mockReturnValue(port);
    const pending = captureWhatsAppVisibleStatus();
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalled());
    const start = startMessage(port);
    port.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: start.operationId,
      tag: 'CaptureMetadata',
      kind: 'photo',
      mimeType: 'image/jpeg',
      byteLength: 1,
      width: 1,
      height: 1,
    });
    port.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: start.operationId,
      tag: 'CaptureChunk',
      sequence: 0,
      decodedLength: 1,
      payload: 'AQ==',
    });
    port.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: start.operationId,
      tag: 'CaptureComplete',
      chunkCount: 1,
      byteLength: 1,
    });
    const handle = await pending;

    vi.advanceTimersByTime(WHATSAPP_EDIT_LEASE_MS);

    expect(() => handle.snapshot.blob).toThrow('released');
    expect(getMockBrowser().downloads.cancel).not.toHaveBeenCalled();
  });

  it('starts one non-resetting edit lease at capture-complete and reports its expiry', async () => {
    vi.useFakeTimers();
    const port = makePort();
    getMockBrowser().tabs.connect.mockReturnValue(port);
    const onLeaseExpired = vi.fn();
    const pending = captureWhatsAppVisibleStatus({ onLeaseExpired });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalled());
    const start = startMessage(port);
    port.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: start.operationId,
      tag: 'CaptureMetadata',
      kind: 'photo',
      mimeType: 'image/jpeg',
      byteLength: 1,
      width: 1,
      height: 1,
    });
    port.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: start.operationId,
      tag: 'CaptureChunk',
      sequence: 0,
      decodedLength: 1,
      payload: 'AQ==',
    });
    port.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: start.operationId,
      tag: 'CaptureComplete',
      chunkCount: 1,
      byteLength: 1,
    });

    const handle = await pending;
    expect(handle.descriptor.retentionDeadline - handle.descriptor.capturedAt).toBe(
      WHATSAPP_EDIT_LEASE_MS
    );
    vi.advanceTimersByTime(WHATSAPP_EDIT_LEASE_MS - 1);
    expect(handle.snapshot.blob.size).toBe(1);
    expect(onLeaseExpired).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onLeaseExpired).toHaveBeenCalledOnce();
    await expect(handle.download()).rejects.toMatchObject({ reason: 'retention-expired' });
  });

  it('releases the owned snapshot when the popup closes', async () => {
    const port = makePort();
    getMockBrowser().tabs.connect.mockReturnValue(port);
    const pending = captureWhatsAppVisibleStatus();
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalled());
    const start = startMessage(port);
    port.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: start.operationId,
      tag: 'CaptureMetadata',
      kind: 'photo',
      mimeType: 'image/jpeg',
      byteLength: 1,
      width: 1,
      height: 1,
    });
    port.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: start.operationId,
      tag: 'CaptureChunk',
      sequence: 0,
      decodedLength: 1,
      payload: 'AQ==',
    });
    port.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: start.operationId,
      tag: 'CaptureComplete',
      chunkCount: 1,
      byteLength: 1,
    });
    const handle = await pending;
    window.dispatchEvent(new Event('pagehide'));
    expect(() => handle.snapshot.blob).toThrow('released');
  });

  it('requires an explicit retry click to retain operation identity with a fresh request identity', async () => {
    const operationId = createOperationId();
    const firstRequestId = createRequestId();
    const firstPort = makePort();
    getMockBrowser().tabs.connect.mockReturnValue(firstPort);
    const first = captureWhatsAppVisibleStatus({ operationId, requestId: firstRequestId });
    await vi.waitFor(() => expect(firstPort.postMessage).toHaveBeenCalled());
    const firstStart = startMessage(firstPort);
    expect(firstStart).toMatchObject({ operationId, requestId: firstRequestId });
    firstPort.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId,
      tag: 'CaptureFailure',
      reason: 'not-visible',
    });
    await expect(first).rejects.toMatchObject({ reason: 'not-visible' });

    expect(getMockBrowser().scripting.executeScript).toHaveBeenCalledTimes(1);
    const retryRequestId = createRequestId();
    const retryPort = makePort();
    getMockBrowser().tabs.connect.mockReturnValue(retryPort);
    const retry = captureWhatsAppVisibleStatus({ operationId, requestId: retryRequestId });
    await vi.waitFor(() => expect(retryPort.postMessage).toHaveBeenCalled());
    const retryStart = startMessage(retryPort);
    expect(retryStart).toMatchObject({ operationId, requestId: retryRequestId });
    expect(retryStart.requestId).not.toBe(firstStart.requestId);
    retryPort.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId,
      tag: 'CaptureFailure',
      reason: 'not-visible',
    });
    await expect(retry).rejects.toMatchObject({ reason: 'not-visible' });
    expect(getMockBrowser().scripting.executeScript).toHaveBeenCalledTimes(2);
  });

  it('keeps the capture identity private to the descriptor and never sends the snapshot', async () => {
    const port = makePort();
    getMockBrowser().tabs.connect.mockReturnValue(port);
    const pending = captureWhatsAppVisibleStatus();
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalled());
    const start = startMessage(port);
    port.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: start.operationId,
      tag: 'CaptureMetadata',
      kind: 'video',
      mimeType: 'video/mp4',
      byteLength: 1,
      width: 1280,
      height: 720,
      durationMs: 1_000,
    });
    port.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: start.operationId,
      tag: 'CaptureChunk',
      sequence: 0,
      decodedLength: 1,
      payload: 'AQ==',
    });
    port.emit({
      protocolVersion: 1,
      requestId: createRequestId(),
      operationId: start.operationId,
      tag: 'CaptureComplete',
      chunkCount: 1,
      byteLength: 1,
    });
    const handle = await pending;
    expect(handle.descriptor.captureId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(Object.keys(handle.descriptor)).not.toContain('blob');
  });
});
