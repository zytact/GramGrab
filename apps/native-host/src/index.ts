import { createServer, type Socket } from 'node:net';
import { chmod, rm } from 'node:fs/promises';
import { platform, userInfo } from 'node:os';
import { Effect, Schema } from 'effect';
import {
  Completed,
  decodeEvent,
  decodeJsonFrame,
  encodeFrame,
  encodeJsonFrame,
  Event,
  FrameDecoder,
  localIpcEndpoint,
  StatusResult,
} from '@gramgrab/protocol';

export { decodeEvent, decodeRequest, PROTOCOL_VERSION } from '@gramgrab/protocol';

const endpoint = localIpcEndpoint({
  platform: platform(),
  runtimeDirectory: process.env.XDG_RUNTIME_DIR,
  userId: platform() === 'win32' ? undefined : userInfo().uid,
  override: process.env.GRAMGRAB_IPC_PATH,
});
const clients = new Set<Socket>();
const HOST_VERSION = '0.0.0';

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

function attachClient(socket: Socket): void {
  clients.add(socket);
  const decoder = new FrameDecoder();
  socket.on('data', chunk => {
    try {
      if (typeof chunk === 'string') return socket.destroy();
      for (const frame of decoder.push(chunk)) writeNative(frame);
    } catch {
      socket.destroy();
    }
  });
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
}

export async function startNativeHost(): Promise<void> {
  const nativeDecoder = new FrameDecoder();
  process.stdin.on('data', chunk => {
    try {
      if (typeof chunk === 'string') return process.stdin.destroy();
      for (const frame of nativeDecoder.push(chunk)) {
        const enriched = enrichHostMetadata(frame);
        for (const client of clients) client.write(enriched);
      }
    } catch {
      process.exitCode = 1;
      process.stdin.destroy();
    }
  });
  if (platform() !== 'win32') await rm(endpoint, { force: true });
  const server = createServer(attachClient);
  server.on('error', error => {
    console.error(`GramGrab native host failed: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(endpoint, async () => {
    if (platform() !== 'win32') await chmod(endpoint, 0o600);
  });
  const close = () => server.close();
  process.stdin.on('end', close);
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
}

if (import.meta.main) void startNativeHost();
