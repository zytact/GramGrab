import { Effect, Schema } from 'effect';
import { describe, expect, it, vi } from 'vite-plus/test';
import { getMockBrowser } from './test/setup.ts';
import {
  CancelRequest,
  Event,
  Inspect,
  PROTOCOL_VERSION,
  Request,
  RequestId,
} from '@gramgrab/protocol';
import {
  handleNativeMessage,
  startNativeBridge,
  unsupportedVersionEvent,
} from './native-bridge.ts';

describe('native bridge protocol negotiation', () => {
  it('stamps an unsupported-version rejection with the request version', () => {
    const requestId = Schema.decodeUnknownSync(RequestId)('10000000-0000-4000-8000-000000000001');
    const encoded = unsupportedVersionEvent({ version: 1, requestId });

    const decoded = Effect.runSync(Schema.decodeUnknown(Event)(encoded));

    expect(decoded.event).toMatchObject({
      _tag: 'Rejected',
      failure: { _tag: 'TransportFailure', code: 'PROTOCOL_VERSION_UNSUPPORTED' },
    });
  });
});

describe('native bridge cancellation', () => {
  it('registers a request before a back-to-back cancellation can arrive', () => {
    const request = Schema.decodeUnknownSync(Request)({
      version: PROTOCOL_VERSION,
      requestId: crypto.randomUUID(),
      command: Inspect.make({ sourceUrl: 'https://www.instagram.com/p/example/' }),
    });
    let signal: AbortSignal | undefined;
    startNativeBridge(async (_request, _emit, currentSignal) => {
      signal = currentSignal;
    });

    handleNativeMessage(Schema.encodeSync(Request)(request));
    handleNativeMessage(
      Schema.encodeSync(CancelRequest)(
        CancelRequest.make({ version: PROTOCOL_VERSION, requestId: request.requestId })
      )
    );

    expect(signal?.aborted).toBe(true);
  });
});

describe('native bridge request termination', () => {
  it('terminates a request whose handler rejects', async () => {
    const posted: unknown[] = [];
    const runtime = getMockBrowser().runtime as unknown as Record<string, unknown>;
    runtime.connectNative = () => ({
      postMessage: (message: unknown) => posted.push(message),
      onMessage: { addListener: () => {} },
      onDisconnect: { addListener: () => {} },
    });
    vi.resetModules();
    const bridge = await import('./native-bridge.ts');
    const request = Schema.decodeUnknownSync(Request)({
      version: PROTOCOL_VERSION,
      requestId: crypto.randomUUID(),
      command: Inspect.make({ sourceUrl: 'https://www.instagram.com/p/example/' }),
    });
    bridge.startNativeBridge(async () => {
      throw new Error('handler blew up');
    });

    bridge.handleNativeMessage(Schema.encodeSync(Request)(request));
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(1));

    expect(Schema.decodeUnknownSync(Event)(posted.at(-1)).event).toMatchObject({
      _tag: 'Rejected',
      failure: { _tag: 'ValidationFailure', message: 'handler blew up' },
    });
  });
});
