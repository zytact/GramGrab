import { connect } from 'node:net';
import { platform, userInfo } from 'node:os';
import { readFile } from 'node:fs/promises';
import { Effect, Schema } from 'effect';
import {
  DebugExport,
  DebugGet,
  DirectExport,
  Export,
  ExportOperation,
  FrameExport,
  HistoryClear,
  HistoryList,
  HistoryRedownload,
  HistoryRemove,
  HumanItemNumber,
  Inspect,
  OperationId,
  SilentExport,
  Status,
  decodeEvent,
  decodeJsonFrame,
  encodeJsonFrame,
  FrameDecoder,
  localIpcEndpoint,
  PROTOCOL_VERSION,
  Request,
  type Command,
  type EventPayload,
} from '@gramgrab/protocol';

export { decodeEvent, decodeRequest, PROTOCOL_VERSION } from '@gramgrab/protocol';

const endpoint = localIpcEndpoint({
  platform: platform(),
  runtimeDirectory: process.env.XDG_RUNTIME_DIR,
  userId: platform() === 'win32' ? undefined : userInfo().uid,
  override: process.env.GRAMGRAB_IPC_PATH,
});

export interface ParsedCli {
  readonly command: Command;
  readonly json: boolean;
}

function option(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index < 0 ? undefined : arguments_[index + 1];
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function requiredIds(values: readonly string[]): readonly string[] {
  if (values.length === 0) throw new Error('Missing ENTRY_ID.');
  return values;
}

function itemNumber(value: string | undefined) {
  return Schema.decodeUnknownSync(HumanItemNumber)(
    Number(required(value, 'Missing --item NUMBER.'))
  );
}

function operationId() {
  return Schema.decodeUnknownSync(OperationId)(crypto.randomUUID());
}

function exportOperation(arguments_: readonly string[]): ExportOperation {
  const mode = required(option(arguments_, '--mode'), 'Missing --mode direct|frame|silent.');
  const exportMode =
    mode === 'direct'
      ? DirectExport.make({})
      : mode === 'frame'
        ? FrameExport.make({
            timestampSeconds: Number(required(option(arguments_, '--at'), 'Missing --at SECONDS.')),
          })
        : mode === 'silent'
          ? SilentExport.make({
              reencode: Schema.decodeUnknownSync(Schema.Literal('forbid', 'allow', 'require'))(
                required(
                  option(arguments_, '--reencode'),
                  'Missing --reencode forbid|allow|require.'
                )
              ),
            })
          : undefined;
  if (!exportMode) throw new Error(`Unknown export mode: ${mode}`);
  return ExportOperation.make({
    operationId: operationId(),
    itemNumber: itemNumber(option(arguments_, '--item')),
    mode: exportMode,
  });
}

function exportCommand(arguments_: readonly string[]): Export {
  const sourceUrl = required(arguments_[1], 'Missing export SOURCE_URL.');
  if (option(arguments_, '--plan'))
    throw new Error('Structured plans must be loaded asynchronously with --plan - or a file path.');
  const itemIndexes = arguments_.flatMap((value, index) => (value === '--item' ? [index] : []));
  if (itemIndexes.length === 0) throw new Error('Missing --item NUMBER.');
  const operations = itemIndexes.map((start, index) =>
    exportOperation(arguments_.slice(start, itemIndexes[index + 1] ?? arguments_.length))
  );
  return Export.make({ sourceUrl, operations });
}

// fallow-ignore-next-line complexity
export function parseCliArguments(arguments_: readonly string[]): ParsedCli {
  const json = arguments_.includes('--json');
  const command = arguments_[0] ?? 'status';
  if (command === 'status') return { command: Status.make({}), json };
  if (command === 'inspect')
    return {
      command: Inspect.make({ sourceUrl: required(arguments_[1], 'Missing inspect SOURCE_URL.') }),
      json,
    };
  if (command === 'export') return { command: exportCommand(arguments_), json };
  if (command === 'history') {
    const action = arguments_[1];
    const entryIds = arguments_.slice(2).filter(value => value !== '--json');
    if (action === 'list') return { command: HistoryList.make({}), json };
    if (action === 'clear') return { command: HistoryClear.make({}), json };
    if (action === 'remove')
      return {
        command: HistoryRemove.make({
          entryIds: requiredIds(entryIds),
        }),
        json,
      };
    if (action === 'redownload')
      return {
        command: HistoryRedownload.make({
          entryIds: requiredIds(entryIds),
        }),
        json,
      };
    throw new Error('Usage: gramgrab history list|remove|clear|redownload');
  }
  if (command === 'debug') {
    if (arguments_[1] === 'get') return { command: DebugGet.make({}), json };
    if (arguments_[1] === 'export') return { command: DebugExport.make({}), json };
    throw new Error('Usage: gramgrab debug get|export');
  }
  throw new Error(`Unknown command: ${command}`);
}

async function parse(arguments_: readonly string[]): Promise<ParsedCli> {
  const plan = option(arguments_, '--plan');
  if (!plan) return parseCliArguments(arguments_);
  if (arguments_[0] !== 'export') throw new Error('--plan is only valid with export.');
  const input = plan === '-' ? await readStandardInput() : await readFile(plan, 'utf8');
  const value: unknown = JSON.parse(input);
  const sourceUrl = required(arguments_[1], 'Missing export SOURCE_URL.');
  const command = await Effect.runPromise(
    Schema.decodeUnknown(Export)({ sourceUrl, operations: value })
  );
  return { command, json: arguments_.includes('--json') };
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export function request(
  command: Command,
  onEvent: (event: EventPayload) => void,
  options: {
    readonly signal?: AbortSignal;
    readonly endpoint?: string;
    readonly acceptanceTimeoutMs?: number;
    readonly terminalTimeoutMs?: number;
  } = {}
): Promise<EventPayload> {
  const requestId = crypto.randomUUID();
  const value = Schema.decodeUnknownSync(Request)({
    version: PROTOCOL_VERSION,
    requestId,
    command,
  });
  return new Promise((resolve, reject) => {
    const socket = connect(options.endpoint ?? endpoint);
    const decoder = new FrameDecoder();
    let settled = false;
    let terminalTimeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(acceptanceTimeout);
      if (terminalTimeout) clearTimeout(terminalTimeout);
      options.signal?.removeEventListener('abort', abort);
      action();
    };
    const abort = () => {
      socket.destroy();
      finish(() => reject(new Error('Request cancelled.')));
    };
    const disconnected = () => {
      finish(() => reject(new Error('IPC disconnected before a terminal response.')));
    };
    const acceptanceTimeout = setTimeout(() => {
      socket.destroy();
      finish(() => reject(new Error('Timed out waiting for the extension.')));
    }, options.acceptanceTimeoutMs ?? 5_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    socket.on('connect', () => socket.write(encodeJsonFrame(Schema.encodeSync(Request)(value))));
    socket.on('data', chunk => {
      try {
        if (typeof chunk === 'string') return socket.destroy();
        for (const frame of decoder.push(chunk)) {
          const event = Effect.runSync(decodeEvent(decodeJsonFrame(frame)));
          if (event.requestId !== requestId) continue;
          onEvent(event.event);
          if (event.event._tag === 'Accepted') {
            clearTimeout(acceptanceTimeout);
            terminalTimeout = setTimeout(
              () => {
                socket.destroy();
                finish(() => reject(new Error('Timed out waiting for command completion.')));
              },
              options.terminalTimeoutMs ?? 30 * 60_000
            );
            continue;
          }
          if (event.event._tag === 'Progress') continue;
          socket.end();
          finish(() => resolve(event.event));
        }
      } catch (error) {
        socket.destroy();
        finish(() => reject(error));
      }
    });
    socket.on('error', error => {
      finish(() => reject(error));
    });
    socket.on('end', disconnected);
    socket.on('close', disconnected);
  });
}

function printProgress(event: EventPayload, json: boolean): void {
  if (event._tag !== 'Progress') return;
  process.stderr.write(
    json
      ? `${JSON.stringify({
          type: 'progress',
          operationId: event.operationId,
          itemNumber: event.itemNumber,
          phase: event.phase,
          progress: event.progress,
        })}\n`
      : `${event.phase}${event.itemNumber ? ` - item ${event.itemNumber}` : ''}${event.progress === undefined ? '' : ` - ${Math.round(event.progress * 100)}%`}\n`
  );
}

export async function runCli(arguments_: readonly string[], signal?: AbortSignal): Promise<void> {
  const parsed = await parse(arguments_);
  const event = await request(parsed.command, current => printProgress(current, parsed.json), {
    signal,
  });
  if (event._tag === 'Rejected') {
    process.stderr.write(`${JSON.stringify(event.failure)}\n`);
    process.exitCode = 1;
    return;
  }
  if (event._tag !== 'Completed') throw new Error(`Unexpected terminal event: ${event._tag}`);
  process.stdout.write(`${JSON.stringify(event.result, undefined, parsed.json ? undefined : 2)}\n`);
  if (
    event.result._tag === 'ExportResult' &&
    event.result.outcomes.some(outcome => outcome._tag !== 'ItemSucceeded')
  )
    process.exitCode = 1;
}

if (import.meta.main) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  runCli(process.argv.slice(2), controller.signal).catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      process.argv.includes('--json')
        ? `${JSON.stringify({ type: 'error', message })}\n`
        : `${message}\n`
    );
    process.exitCode = 2;
  });
}
