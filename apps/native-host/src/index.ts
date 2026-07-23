import { createServer, Socket } from 'node:net';
import { chmod, rm } from 'node:fs/promises';
import { platform, userInfo } from 'node:os';
import { Effect, Schema } from 'effect';
import {
  CancelRequest,
  Completed,
  decodeEvent,
  decodeJsonFrame,
  encodeFrame,
  encodeJsonFrame,
  Event,
  FrameDecoder,
  localIpcEndpoint,
  PROTOCOL_VERSION,
  type RequestId,
  RequestId as RequestIdSchema,
  StatusResult,
} from '@gramgrab/protocol';

export { decodeEvent, decodeRequest, PROTOCOL_VERSION } from '@gramgrab/protocol';

const endpoint = localIpcEndpoint({
  platform: platform(),
  runtimeDirectory: process.env.XDG_RUNTIME_DIR,
  userId: platform() === 'win32' ? undefined : userInfo().uid,
  override: process.env.GRAMGRAB_IPC_PATH,
});
const clients = new Map<Socket, Set<RequestId>>();
const HOST_VERSION = '0.0.0';
const ClientEnvelope = Schema.Struct({
  version: Schema.Number,
  requestId: RequestIdSchema,
  _tag: Schema.optional(Schema.Literal('CancelRequest')),
});

async function socketIsActive(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = new Socket();
    const finish = (active: boolean) => {
      socket.destroy();
      resolve(active);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.connect(path);
  });
}

export async function prepareLocalIpcEndpoint(
  path: string,
  currentPlatform: string
): Promise<void> {
  if (currentPlatform === 'win32') return;
  if (await socketIsActive(path)) {
    throw new Error(`Another GramGrab native host already owns ${path}`);
  }
  await rm(path, { force: true });
}

function writeNative(payload: Uint8Array): void {
  process.stdout.write(encodeFrame(payload));
}

function enrichHostMetadata(payload: Uint8Array): Uint8Array {
  try {
    const event = Effect.runSync(decodeEvent(decodeJsonFrame(payload)));
    if (event.event._tag !== 'Completed' || event.event.result._tag !== 'StatusResult')
      return encodeFrame(payload);
    const status = event.event.result;
    return encodeJsonFrame(
      Schema.encodeSync(Event)(
        Event.make({
          version: event.version,
          requestId: event.requestId,
          event: Completed.make({
            result: StatusResult.make({
              browser: status.browser,
              extensionVersion: status.extensionVersion,
              hostVersion: HOST_VERSION,
              protocolVersion: status.protocolVersion,
              compatible: status.compatible,
            }),
          }),
        })
      )
    );
  } catch {
    return encodeFrame(payload);
  }
}

function cancelRequests(
  requestIds: ReadonlySet<RequestId>,
  write: (payload: Uint8Array) => void
): void {
  for (const requestId of requestIds) {
    const cancellation = Schema.encodeSync(CancelRequest)(
      CancelRequest.make({ version: PROTOCOL_VERSION, requestId })
    );
    write(new TextEncoder().encode(JSON.stringify(cancellation)));
  }
}

export function attachClient(
  socket: Socket,
  write: (payload: Uint8Array) => void = writeNative
): void {
  const requestIds = new Set<RequestId>();
  clients.set(socket, requestIds);
  const decoder = new FrameDecoder();
  socket.on('data', chunk => {
    try {
      if (typeof chunk === 'string') return socket.destroy();
      for (const frame of decoder.push(chunk)) {
        const envelope = Schema.decodeUnknownSync(ClientEnvelope)(decodeJsonFrame(frame));
        if (envelope._tag === 'CancelRequest') requestIds.delete(envelope.requestId);
        else requestIds.add(envelope.requestId);
        write(frame);
      }
    } catch {
      socket.destroy();
    }
  });
  socket.on('close', () => {
    clients.delete(socket);
    cancelRequests(requestIds, write);
  });
  socket.on('error', () => clients.delete(socket));
}

export async function startNativeHost(): Promise<void> {
  const nativeDecoder = new FrameDecoder();
  process.stdin.on('data', chunk => {
    try {
      if (typeof chunk === 'string') return process.stdin.destroy();
      for (const frame of nativeDecoder.push(chunk)) {
        const enriched = enrichHostMetadata(frame);
        const event = Effect.runSync(decodeEvent(decodeJsonFrame(frame)));
        if (event.event._tag === 'Completed' || event.event._tag === 'Rejected')
          for (const requestIds of clients.values()) requestIds.delete(event.requestId);
        for (const client of clients.keys()) client.write(enriched);
      }
    } catch {
      process.exitCode = 1;
      process.stdin.destroy();
    }
  });
  await prepareLocalIpcEndpoint(endpoint, platform());
  const server = createServer(attachClient);
  server.on('error', error => {
    console.error(`GramGrab native host failed: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(endpoint, async () => {
    if (platform() !== 'win32') {
      try {
        await chmod(endpoint, 0o600);
      } catch (error) {
        console.error(
          `GramGrab native host could not secure its local socket: ${error instanceof Error ? error.message : String(error)}`
        );
        process.exitCode = 1;
        server.close();
      }
    }
  });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    for (const client of clients.keys()) client.destroy();
    server.close(() => {
      if (platform() !== 'win32') void rm(endpoint, { force: true });
    });
  };
  process.stdin.on('end', close);
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
  if (process.stdin.readableEnded) close();
}

if (import.meta.main) void startNativeHost();
