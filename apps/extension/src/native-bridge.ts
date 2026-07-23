import { Schema } from 'effect';
import {
  Accepted,
  CancelRequest,
  Completed,
  EchoResult,
  Event,
  PROTOCOL_VERSION,
  Rejected,
  Request,
  RequestId,
  StatusResult,
  TransportFailure,
  ValidationFailure,
} from '@gramgrab/protocol';
import { browser, type NativePort } from './lib/browser.ts';

const HOST_NAME = 'dev.zytact.gramgrab';
const HOST_VERSION = '0.0.0';
const MAX_RECONNECT_DELAY_MS = 30_000;
const RequestEnvelope = Schema.Struct({ version: Schema.Number, requestId: RequestId });
type RequestEnvelope = Schema.Schema.Type<typeof RequestEnvelope>;

let port: NativePort | undefined;
let reconnectDelay = 1_000;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let commandHandler:
  | ((
      request: Request,
      emit: (
        event: Accepted | Completed | Rejected | import('@gramgrab/protocol').Progress
      ) => void,
      signal: AbortSignal
    ) => Promise<void>)
  | undefined;
const activeRequests = new Map<RequestId, AbortController>();

function browserName(): 'chromium' | 'firefox' | 'unknown' {
  const userAgent = globalThis.navigator?.userAgent ?? '';
  if (/Firefox/i.test(userAgent)) return 'firefox';
  if (/Chrom(?:e|ium)/i.test(userAgent)) return 'chromium';
  return 'unknown';
}

function post(
  requestId: RequestId,
  event: Accepted | Completed | Rejected | import('@gramgrab/protocol').Progress
): void {
  port?.postMessage(
    Schema.encodeSync(Event)(Event.make({ version: PROTOCOL_VERSION, requestId, event }))
  );
}

function rejectUnsupportedVersion(message: unknown): boolean {
  const decoded = Schema.decodeUnknownEither(RequestEnvelope)(message);
  if (decoded._tag === 'Left') return false;
  const envelope = decoded.right;
  if (envelope.version === PROTOCOL_VERSION) return false;
  port?.postMessage(unsupportedVersionEvent(envelope));
  return true;
}

export function unsupportedVersionEvent(envelope: RequestEnvelope) {
  return {
    version: envelope.version,
    requestId: envelope.requestId,
    event: Schema.encodeSync(Rejected)(
      Rejected.make({
        failure: TransportFailure.make({ code: 'PROTOCOL_VERSION_UNSUPPORTED' }),
      })
    ),
  };
}

export function handleNativeMessage(message: unknown): void {
  const cancellation = Schema.decodeUnknownEither(CancelRequest)(message);
  if (cancellation._tag === 'Right') {
    activeRequests.get(cancellation.right.requestId)?.abort();
    return;
  }
  if (rejectUnsupportedVersion(message)) return;
  const decoded = Schema.decodeUnknownEither(Request)(message);
  if (decoded._tag === 'Left') {
    const envelope = Schema.decodeUnknownEither(RequestEnvelope)(message);
    if (envelope._tag === 'Left') return;
    post(
      envelope.right.requestId,
      Rejected.make({
        failure: ValidationFailure.make({ message: String(decoded.left) }),
      })
    );
    return;
  }
  const request = decoded.right;
  post(request.requestId, Accepted.make({}));
  const result =
    request.command._tag === 'Status'
      ? StatusResult.make({
          browser: browserName(),
          extensionVersion: browser.runtime.getManifest().version ?? 'unknown',
          hostVersion: HOST_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          compatible: true,
        })
      : request.command._tag === 'Echo'
        ? EchoResult.make({ value: request.command.value })
        : undefined;
  if (result) {
    post(request.requestId, Completed.make({ result }));
    return;
  }
  if (commandHandler) {
    const controller = new AbortController();
    activeRequests.set(request.requestId, controller);
    void commandHandler(
      request,
      event => {
        if (!controller.signal.aborted) post(request.requestId, event);
      },
      controller.signal
    ).finally(() => activeRequests.delete(request.requestId));
    return;
  }
  post(
    request.requestId,
    Rejected.make({
      failure: TransportFailure.make({ code: 'PROTOCOL_VERSION_UNSUPPORTED' }),
    })
  );
}

function scheduleReconnect(): void {
  for (const controller of activeRequests.values()) controller.abort();
  activeRequests.clear();
  port = undefined;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
}

function connect(): void {
  reconnectTimer = undefined;
  try {
    const next = browser.runtime.connectNative(HOST_NAME);
    port = next;
    next.onMessage.addListener(handleNativeMessage);
    next.onDisconnect.addListener(scheduleReconnect);
    reconnectDelay = 1_000;
  } catch {
    scheduleReconnect();
  }
}

export function startNativeBridge(handler: NonNullable<typeof commandHandler>): void {
  commandHandler = handler;
  if (!port && !reconnectTimer) connect();
}
