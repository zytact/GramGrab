import { Schema } from 'effect';
import encodedProtocolConfig from './config.json';

const NonEmptyString = Schema.String.pipe(
  Schema.filter(value => value.trim().length > 0, { message: () => 'must not be empty' })
);
const InstagramEndpoint = NonEmptyString.pipe(
  Schema.filter(
    value => {
      try {
        const url = new URL(value);
        return (
          url.protocol === 'https:' &&
          url.hostname === 'www.instagram.com' &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    },
    { message: () => 'must be an HTTPS www.instagram.com URL without query or fragment' }
  )
);
class ProtocolClient extends Schema.Class<ProtocolClient>('ProtocolClient')({
  appId: NonEmptyString,
  asbdId: NonEmptyString,
}) {}

export class ProtocolRequest extends Schema.Class<ProtocolRequest>('ProtocolRequest')({
  endpoint: InstagramEndpoint,
  transport: Schema.Literal('query', 'form'),
}) {}

export class ProtocolCandidate extends Schema.Class<ProtocolCandidate>('ProtocolCandidate')({
  kind: Schema.Literal('doc_id', 'query_hash'),
  id: NonEmptyString,
  requests: Schema.Array(ProtocolRequest).pipe(
    Schema.filter(requests => requests.length > 0, { message: () => 'must not be empty' })
  ),
}) {}

export class ProtocolOperation extends Schema.Class<ProtocolOperation>('ProtocolOperation')({
  candidates: Schema.Array(ProtocolCandidate).pipe(
    Schema.filter(candidates => candidates.length > 0, { message: () => 'must not be empty' })
  ),
}) {}

export class ProtocolConfig extends Schema.Class<ProtocolConfig>('ProtocolConfig')({
  schemaVersion: Schema.Literal(1),
  client: ProtocolClient,
  operations: Schema.Struct({
    mediaByShortcode: ProtocolOperation,
    reelsMedia: ProtocolOperation,
  }),
}) {}

export const decodeProtocolConfig = Schema.decodeUnknownSync(ProtocolConfig);
export const protocolConfig = decodeProtocolConfig(encodedProtocolConfig);
