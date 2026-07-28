import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import type { CallExpression, Expression, ObjectExpression, Property, SpreadElement } from 'acorn';
import { Schema } from 'effect';
import {
  ProtocolCandidate,
  ProtocolConfig,
  ProtocolRequest,
  decodeProtocolConfig,
} from '../src/instagram-protocol/config.ts';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../../..');
const defaultConfigPath = resolve(
  repositoryRoot,
  'apps/extension/src/instagram-protocol/config.json'
);

const OperationName = Schema.Literal('mediaByShortcode', 'reelsMedia', 'instantsFeed');
export type OperationName = Schema.Schema.Type<typeof OperationName>;

export class ProtocolObservation extends Schema.Class<ProtocolObservation>('ProtocolObservation')({
  appId: Schema.NonEmptyString,
  asbdId: Schema.optional(Schema.NonEmptyString),
  friendlyName: Schema.optional(Schema.NonEmptyString),
  candidate: ProtocolCandidate,
}) {}

const decodeObservation = Schema.decodeUnknownSync(ProtocolObservation);

function staticString(expression: Expression | SpreadElement | undefined): string | undefined {
  return expression?.type === 'Literal' && typeof expression.value === 'string'
    ? expression.value
    : undefined;
}

function propertyName(property: Property): string | undefined {
  if (property.computed) return undefined;
  if (property.key.type === 'Identifier') return property.key.name;
  if (property.key.type === 'Literal' && typeof property.key.value === 'string') {
    return property.key.value;
  }
  return undefined;
}

function objectProperty(object: ObjectExpression, expectedName: string): Expression | undefined {
  for (const property of object.properties) {
    if (
      property.type === 'Property' &&
      property.kind === 'init' &&
      propertyName(property)?.toLowerCase() === expectedName.toLowerCase()
    ) {
      return property.value;
    }
  }
  return undefined;
}

function findFetchCall(source: string): CallExpression {
  let program;
  try {
    program = parse(source, { ecmaVersion: 'latest' });
  } catch {
    throw new Error('Input is not a valid Copy-as-fetch request');
  }
  const statement = program.body[0];
  if (
    program.body.length !== 1 ||
    statement?.type !== 'ExpressionStatement' ||
    statement.expression.type !== 'CallExpression' ||
    statement.expression.callee.type !== 'Identifier' ||
    statement.expression.callee.name !== 'fetch'
  ) {
    throw new Error('Input must contain exactly one Copy-as-fetch request');
  }
  return statement.expression;
}

function extractHeaders(options: ObjectExpression): ReadonlyMap<string, string> {
  const headersExpression = objectProperty(options, 'headers');
  if (headersExpression?.type !== 'ObjectExpression') {
    throw new Error('Copy-as-fetch request must contain a literal headers object');
  }

  const headers = new Map<string, string>();
  for (const property of headersExpression.properties) {
    if (property.type !== 'Property' || property.kind !== 'init') continue;
    const name = propertyName(property)?.toLowerCase();
    const value = staticString(property.value);
    if (name && value !== undefined) headers.set(name, value);
  }
  return headers;
}

function requiredHeader(headers: ReadonlyMap<string, string>, name: string): string {
  const value = headers.get(name)?.trim();
  if (!value) throw new Error(`Copy-as-fetch request is missing ${name}`);
  return value;
}

function extractIdentifier(parameters: URLSearchParams): {
  readonly kind: 'doc_id' | 'query_hash' | 'client_doc_id';
  readonly id: string;
} {
  const docId = parameters.get('doc_id')?.trim();
  const queryHash = parameters.get('query_hash')?.trim();
  const clientDocumentId = parameters.get('client_doc_id')?.trim();
  const identifiers = [docId, queryHash, clientDocumentId].filter(Boolean);
  if (identifiers.length !== 1) {
    throw new Error('Request must contain exactly one doc_id, query_hash, or client_doc_id');
  }
  if (docId) return { kind: 'doc_id', id: docId };
  if (queryHash) return { kind: 'query_hash', id: queryHash };
  return { kind: 'client_doc_id', id: clientDocumentId ?? '' };
}

function instagramRequest(call: CallExpression): { url: URL; options: ObjectExpression } {
  const endpointSource = staticString(call.arguments[0]);
  const options = call.arguments[1];
  if (!endpointSource || options?.type !== 'ObjectExpression') {
    throw new Error('Copy-as-fetch request must use a literal URL and options object');
  }
  let url: URL;
  try {
    url = new URL(endpointSource);
  } catch {
    throw new Error('Copy-as-fetch request contains an invalid URL');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'www.instagram.com') {
    throw new Error('Copy-as-fetch request must target https://www.instagram.com');
  }
  return { url, options };
}

function requestParameters(
  url: URL,
  options: ObjectExpression
): { transport: 'query' | 'form'; parameters: URLSearchParams } {
  const method = (staticString(objectProperty(options, 'method')) ?? 'GET').toUpperCase();
  if (method === 'GET') return { transport: 'query', parameters: url.searchParams };
  if (method !== 'POST') throw new Error('Only GET and POST Copy-as-fetch requests are supported');
  const body = staticString(objectProperty(options, 'body'));
  if (body === undefined) {
    throw new Error('POST Copy-as-fetch request must contain a literal form body');
  }
  return { transport: 'form', parameters: new URLSearchParams(body) };
}

export function extractProtocolObservation(source: string): ProtocolObservation {
  const { url, options } = instagramRequest(findFetchCall(source));
  const { transport, parameters } = requestParameters(url, options);
  const identifier = extractIdentifier(parameters);
  const headers = extractHeaders(options);
  const request = Schema.decodeUnknownSync(ProtocolRequest)({
    endpoint: `${url.origin}${url.pathname}`,
    transport,
  });

  return decodeObservation({
    appId: requiredHeader(headers, 'x-ig-app-id'),
    asbdId: headers.get('x-asbd-id')?.trim() || undefined,
    friendlyName:
      headers.get('x-fb-friendly-name')?.trim() ||
      parameters.get('fb_api_req_friendly_name')?.trim() ||
      undefined,
    candidate: {
      ...identifier,
      requests: [request],
    },
  });
}

function sameRequest(left: ProtocolRequest, right: ProtocolRequest): boolean {
  return left.endpoint === right.endpoint && left.transport === right.transport;
}

function mergeCandidates(
  config: ProtocolConfig,
  operation: OperationName,
  observation: ProtocolObservation
) {
  const current = config.operations[operation]?.candidates ?? [];
  const matching = current.find(
    candidate =>
      candidate.kind === observation.candidate.kind && candidate.id === observation.candidate.id
  );
  const observedRequest = observation.candidate.requests[0];
  if (!observedRequest) throw new Error('Observed candidate has no request transport');
  const requests = [
    observedRequest,
    ...(matching?.requests.filter(request => !sameRequest(request, observedRequest)) ?? []),
  ];
  return [
    { kind: observation.candidate.kind, id: observation.candidate.id, requests },
    ...current.filter(
      candidate =>
        candidate.kind !== observation.candidate.kind || candidate.id !== observation.candidate.id
    ),
  ];
}

function mergedOperations(
  config: ProtocolConfig,
  operation: OperationName,
  observation: ProtocolObservation,
  candidates: ReturnType<typeof mergeCandidates>
) {
  const operations = {
    mediaByShortcode:
      operation === 'mediaByShortcode' ? { candidates } : config.operations.mediaByShortcode,
    reelsMedia: operation === 'reelsMedia' ? { candidates } : config.operations.reelsMedia,
    ...(config.operations.instantsFeed ? { instantsFeed: config.operations.instantsFeed } : {}),
  };
  if (operation !== 'instantsFeed') return operations;
  return {
    ...operations,
    instantsFeed: {
      appId: observation.appId,
      friendlyName: observation.friendlyName,
      candidates,
    },
  };
}

function mergeObservation(
  config: ProtocolConfig,
  operation: OperationName,
  observation: ProtocolObservation
): ProtocolConfig {
  const candidates = mergeCandidates(config, operation, observation);
  const client =
    operation === 'instantsFeed'
      ? config.client
      : {
          appId: observation.appId,
          asbdId: observation.asbdId ?? config.client.asbdId,
        };

  return decodeProtocolConfig({
    schemaVersion: config.schemaVersion,
    client,
    operations: mergedOperations(config, operation, observation, candidates),
  });
}

export async function updateProtocolConfig({
  source,
  operation,
  configPath = defaultConfigPath,
}: {
  readonly source: string;
  readonly operation: OperationName;
  readonly configPath?: string;
}): Promise<ProtocolConfig> {
  const observation = extractProtocolObservation(source);
  const current = decodeProtocolConfig(JSON.parse(await readFile(configPath, 'utf8')));
  const updated = mergeObservation(current, operation, observation);
  const output = `${JSON.stringify(updated, null, 2)}\n`;
  const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;

  await mkdir(dirname(configPath), { recursive: true });
  try {
    await writeFile(temporaryPath, output, 'utf8');
    await rename(temporaryPath, configPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return updated;
}

export function parseOperation(arguments_: readonly string[]): OperationName {
  const normalizedArguments = arguments_[0] === '--' ? arguments_.slice(1) : arguments_;
  if (normalizedArguments.length !== 2 || normalizedArguments[0] !== '--operation') {
    throw new Error(
      'Usage: vp run update:ig-protocol --operation <mediaByShortcode|reelsMedia|instantsFeed>'
    );
  }
  return Schema.decodeUnknownSync(OperationName)(normalizedArguments[1]);
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let source = '';
  for await (const chunk of process.stdin) {
    if (typeof chunk !== 'string') throw new Error('Could not read Copy-as-fetch input');
    source += chunk;
  }
  if (!source.trim()) throw new Error('Paste one Copy-as-fetch request into stdin');
  return source;
}

async function runCommand(): Promise<void> {
  const operation = parseOperation(process.argv.slice(2));
  const source = await readStdin();
  const updated = await updateProtocolConfig({ source, operation });
  const candidate = updated.operations[operation]?.candidates[0];
  if (!candidate) throw new Error('Updated operation has no protocol candidate');
  process.stdout.write(
    `Updated ${operation} with ${candidate.kind}=${candidate.id} in ${defaultConfigPath}\n`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCommand().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Protocol update failed'}\n`);
    process.exitCode = 1;
  });
}
