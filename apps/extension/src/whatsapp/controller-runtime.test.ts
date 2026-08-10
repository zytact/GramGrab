import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  acquireVisibleStatusBytes,
  ControllerFailure,
  decodeControllerOutbound,
  installWhatsAppController,
  inspectVisibleStatus,
} from './controller-runtime.ts';
import { WHATSAPP_MAX_CHUNK_BYTES } from './limits.ts';

function readyPhoto(document: Document) {
  const player = document.createElement('div');
  player.dataset.testid = 'status-player-uie';
  const backing = document.createElement('img');
  backing.src = 'data:image/jpeg;base64,backing';
  const foreground = document.createElement('img');
  foreground.src = 'blob:status-a';
  Object.defineProperty(foreground, 'complete', { configurable: true, value: true });
  Object.defineProperty(foreground, 'naturalWidth', { configurable: true, value: 640 });
  Object.defineProperty(foreground, 'naturalHeight', { configurable: true, value: 480 });
  player.append(backing, foreground);
  document.body.append(player);
  return { player, backing, foreground };
}

function readyVideo(document: Document) {
  const player = document.createElement('div');
  player.dataset.testid = 'status-player-uie';
  const video = document.createElement('video');
  video.dataset.testid = 'status-video';
  video.src = 'blob:status-video';
  video.poster = 'data:image/jpeg;base64,poster';
  Object.defineProperty(video, 'readyState', { configurable: true, value: 4 });
  Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1280 });
  Object.defineProperty(video, 'videoHeight', { configurable: true, value: 720 });
  Object.defineProperty(video, 'duration', { configurable: true, value: 12.5 });
  player.append(video);
  document.body.append(player);
  return { player, video };
}

describe('isolated WhatsApp foreground extraction', () => {
  beforeEach(() => document.body.replaceChildren());
  afterEach(() => vi.unstubAllGlobals());

  it('selects the foreground blob photo and excludes its data backing image', async () => {
    const { foreground } = readyPhoto(document);
    const observation = inspectVisibleStatus(document);
    expect(observation.tag).toBe('ready');
    if (observation.tag !== 'ready') return;
    expect(observation.candidate.media).toBe(foreground);

    const bytes = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(bytes, { headers: { 'Content-Type': 'image/jpeg' } }))
    );
    const acquired = await acquireVisibleStatusBytes(observation.candidate, document);
    expect(acquired.mimeType).toBe('image/jpeg');
    expect([...acquired.bytes]).toEqual([...bytes]);
  });

  it('selects the active video and never treats its poster as media', async () => {
    const { video } = readyVideo(document);
    const observation = inspectVisibleStatus(document);
    expect(observation.tag).toBe('ready');
    if (observation.tag !== 'ready') return;
    expect(observation.candidate.media).toBe(video);
    expect(observation.candidate.durationMs).toBe(12_500);

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(new Uint8Array([5, 6]), { headers: { 'Content-Type': 'video/mp4' } })
        )
    );
    const acquired = await acquireVisibleStatusBytes(observation.candidate, document);
    expect(acquired.mimeType).toBe('video/mp4');
  });

  it('reports absent and unsupported players without scanning unrelated document media', () => {
    expect(inspectVisibleStatus(document)).toEqual({ tag: 'not-visible', reason: 'viewer-absent' });
    const player = document.createElement('div');
    player.dataset.testid = 'status-player-uie';
    player.textContent = 'STATUS_A';
    document.body.append(player);
    expect(inspectVisibleStatus(document)).toEqual({
      tag: 'unsupported',
      reason: 'unsupported-media',
    });
  });

  it('fails the advancement race rather than returning the next Status', async () => {
    const { foreground } = readyPhoto(document);
    const observation = inspectVisibleStatus(document);
    expect(observation.tag).toBe('ready');
    if (observation.tag !== 'ready') return;
    const fetchBlob = vi.fn().mockImplementation(() => {
      let first = true;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (first) {
            first = false;
            controller.enqueue(new Uint8Array([1, 2]));
            foreground.src = 'blob:next-status';
          } else {
            controller.enqueue(new Uint8Array([3, 4]));
            controller.close();
          }
        },
      });
      return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'image/jpeg' } }));
    });
    vi.stubGlobal('fetch', fetchBlob);
    await expect(acquireVisibleStatusBytes(observation.candidate, document)).rejects.toMatchObject({
      reason: 'status-changed',
    } satisfies Partial<ControllerFailure>);
    expect(fetchBlob).toHaveBeenCalledExactlyOnceWith(
      'blob:status-a',
      expect.objectContaining({ credentials: 'same-origin' })
    );
  });

  it('validates controller outbound envelopes as closed canonical JSON', () => {
    const base = {
      protocolVersion: 1,
      requestId: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      tag: 'CaptureChunk',
      sequence: 0,
      decodedLength: 1,
      payload: 'AQ==',
    };
    expect(decodeControllerOutbound(base)?.tag).toBe('CaptureChunk');
    expect(
      decodeControllerOutbound({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        tag: 'CaptureFailure',
        reason: 'not-visible',
      })?.tag
    ).toBe('CaptureFailure');
    expect(decodeControllerOutbound({ ...base, unexpected: true })).toBeUndefined();
    expect(decodeControllerOutbound({ ...base, payload: 'AQ' })).toBeUndefined();
  });

  it('streams a happy-path capture with one acknowledged chunk and final guard validation', async () => {
    readyPhoto(document);
    const runtimeListeners = new Set<(port: unknown) => void>();
    const runtime = {
      runtime: {
        onConnect: {
          addListener: (listener: (port: unknown) => void) => runtimeListeners.add(listener),
          removeListener: (listener: (port: unknown) => void) => runtimeListeners.delete(listener),
        },
      },
    };
    const messageListeners = new Set<(message: unknown) => void>();
    const disconnectListeners = new Set<() => void>();
    let disconnected = false;
    const outgoing: unknown[] = [];
    const port = {
      name: 'gramgrab-whatsapp-capture-v1',
      postMessage: (message: unknown) => outgoing.push(message),
      disconnect: () => {
        disconnected = true;
        disconnectListeners.forEach(listener => listener());
      },
      onMessage: {
        addListener: (listener: (message: unknown) => void) => messageListeners.add(listener),
        removeListener: (listener: (message: unknown) => void) => messageListeners.delete(listener),
      },
      onDisconnect: {
        addListener: (listener: () => void) => disconnectListeners.add(listener),
        removeListener: (listener: () => void) => disconnectListeners.delete(listener),
      },
    };
    vi.stubGlobal('browser', runtime);
    vi.stubGlobal('location', {
      protocol: 'https:',
      hostname: 'web.whatsapp.com',
      port: '',
    });
    const bytes = new Uint8Array(WHATSAPP_MAX_CHUNK_BYTES + 3);
    bytes.set([1, 2, 3]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(bytes, { headers: { 'Content-Type': 'image/jpeg' } }))
    );
    installWhatsAppController();
    expect(runtimeListeners.size).toBe(1);
    runtimeListeners.forEach(listener => listener(port));
    expect(messageListeners.size).toBe(1);
    const operationId = crypto.randomUUID();
    messageListeners.forEach(listener =>
      listener({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        operationId,
        tag: 'CaptureStart',
        maxMediaBytes: 64 * 1024 * 1024,
        maxChunkBytes: 256 * 1024,
        maxChunks: 256,
        maxUnacknowledgedChunks: 1,
        idleTimeoutMs: 5_000,
        transferTimeoutMs: 30_000,
        retentionMs: 60_000,
      })
    );
    await vi.waitFor(() =>
      expect(
        outgoing.some(message => decodeControllerOutbound(message)?.tag === 'CaptureChunk')
      ).toBe(true)
    );
    const chunks = () =>
      outgoing
        .map(message => decodeControllerOutbound(message))
        .filter(
          (
            message
          ): message is Extract<
            ReturnType<typeof decodeControllerOutbound>,
            { tag: 'CaptureChunk' }
          > => message?.tag === 'CaptureChunk'
        );
    expect(chunks()).toHaveLength(1);
    const firstChunk = chunks()[0];
    if (!firstChunk) throw new Error('Expected first chunk');
    messageListeners.forEach(listener =>
      listener({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        operationId,
        tag: 'ChunkAck',
        sequence: firstChunk.sequence,
      })
    );
    await vi.waitFor(() => expect(chunks()).toHaveLength(2));
    expect(chunks()[1]?.sequence).toBe(1);
    messageListeners.forEach(listener =>
      listener({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        operationId,
        tag: 'ChunkAck',
        sequence: 1,
      })
    );
    await vi.waitFor(() =>
      expect(
        outgoing.some(message => decodeControllerOutbound(message)?.tag === 'CaptureComplete')
      ).toBe(true)
    );
    const complete = outgoing.find(
      message => decodeControllerOutbound(message)?.tag === 'CaptureComplete'
    );
    expect(decodeControllerOutbound(complete)).toMatchObject({
      tag: 'CaptureComplete',
      chunkCount: 2,
      byteLength: bytes.length,
    });
    messageListeners.forEach(listener =>
      listener({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        operationId,
        tag: 'CaptureAccept',
        captureId: crypto.randomUUID(),
      })
    );
    expect(disconnected).toBe(true);
    expect(
      outgoing.some(message => decodeControllerOutbound(message)?.tag === 'CaptureFailure')
    ).toBe(false);
  });

  it('rejects a MIME and kind mismatch before any snapshot can be built', async () => {
    readyPhoto(document);
    const result = inspectVisibleStatus(document);
    if (result.tag !== 'ready') throw new Error('expected ready synthetic photo');
    const candidate = result.candidate;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'video/mp4' } })
        )
    );
    await expect(acquireVisibleStatusBytes(candidate, document)).rejects.toMatchObject({
      reason: 'format-changed',
    });
  });
});
