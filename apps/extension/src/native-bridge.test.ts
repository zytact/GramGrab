import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import { Event, RequestId } from '@gramgrab/protocol';
import { unsupportedVersionEvent } from './native-bridge.ts';

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
