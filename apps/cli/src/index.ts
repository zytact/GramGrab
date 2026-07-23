import { connect } from 'node:net';
import { platform, userInfo } from 'node:os';
import { Effect, Schema } from 'effect';
import {
  decodeEvent,
  decodeJsonFrame,
  encodeJsonFrame,
  FrameDecoder,
  localIpcEndpoint,
  PROTOCOL_VERSION,
  Request,
  type EventPayload,
} from '@gramgrab/protocol';

export { decodeEvent, decodeRequest, PROTOCOL_VERSION } from '@gramgrab/protocol';

const endpoint = localIpcEndpoint({
  platform: platform(),
  runtimeDirectory: process.env.XDG_RUNTIME_DIR,
  userId: platform() === 'win32' ? undefined : userInfo().uid,
  override: process.env.GRAMGRAB_IPC_PATH,
});

function request(command: { readonly _tag: 'Status' } | { readonly _tag: 'Echo'; value: unknown }) {
  const requestId = crypto.randomUUID();
  const value = Schema.decodeUnknownSync(Request)({
    version: PROTOCOL_VERSION,
    requestId,
    command,
  });
  return new Promise<EventPayload>((resolve, reject) => {
    const socket = connect(endpoint);
    const decoder = new FrameDecoder();
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out waiting for the extension.'));
    }, 5_000);
    socket.on('connect', () => socket.write(encodeJsonFrame(Schema.encodeSync(Request)(value))));
    socket.on('data', chunk => {
      try {
        if (typeof chunk === 'string') return socket.destroy();
        for (const frame of decoder.push(chunk)) {
          const event = Effect.runSync(decodeEvent(decodeJsonFrame(frame)));
          if (event.requestId !== requestId || event.event._tag === 'Accepted') continue;
          clearTimeout(timeout);
          socket.end();
          resolve(event.event);
        }
      } catch (error) {
        clearTimeout(timeout);
        socket.destroy();
        reject(error);
      }
    });
    socket.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

export async function runCli(arguments_: readonly string[]): Promise<void> {
  const [command, argument] = arguments_;
  const event = await request(
    command === 'echo'
      ? { _tag: 'Echo', value: argument === undefined ? null : JSON.parse(argument) }
      : { _tag: 'Status' }
  );
  if (event._tag === 'Rejected') {
    process.stderr.write(`${JSON.stringify(event.failure)}\n`);
    process.exitCode = 1;
    return;
  }
  if (event._tag !== 'Completed') throw new Error(`Unexpected terminal event: ${event._tag}`);
  process.stdout.write(`${JSON.stringify(event.result, undefined, 2)}\n`);
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
