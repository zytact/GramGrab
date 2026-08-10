import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import {
  decodeEvent as decodeCliEvent,
  decodeRequest as decodeCliRequest,
} from '../../../apps/cli/src/index.ts';
import {
  decodeEvent as decodeExtensionEvent,
  decodeRequest as decodeExtensionRequest,
} from '../../../apps/extension/src/index.ts';
import {
  decodeEvent as decodeNativeHostEvent,
  decodeRequest as decodeNativeHostRequest,
} from '../../../apps/native-host/src/index.ts';
import {
  Event,
  FAILURE_CODES,
  HumanItemNumber,
  InternalItemIndex,
  OperationId,
  Request,
  RequestId,
} from '../src/index.ts';
import {
  eventFixtures,
  operationId,
  requestFixtures,
  requestId,
  retryRequestId,
} from './fixtures.ts';

const participantRequestDecoders = [
  decodeExtensionRequest,
  decodeCliRequest,
  decodeNativeHostRequest,
];
const participantEventDecoders = [decodeExtensionEvent, decodeCliEvent, decodeNativeHostEvent];

describe('protocol version 1', () => {
  it('decodes every command fixture identically in all participants', () => {
    for (const fixture of requestFixtures) {
      const expected = Schema.decodeUnknownSync(Request)(fixture);
      for (const decode of participantRequestDecoders) {
        expect(Effect.runSync(decode(fixture))).toEqual(expected);
      }
    }
  });

  it('decodes every event, result, outcome, and failure fixture in all participants', () => {
    for (const fixture of eventFixtures) {
      const expected = Schema.decodeUnknownSync(Event)(fixture);
      for (const decode of participantEventDecoders) {
        expect(Effect.runSync(decode(fixture))).toEqual(expected);
      }
    }
  });

  it('keeps human item numbers 1-based and internal item indexes 0-based', () => {
    expect(() => Schema.decodeUnknownSync(HumanItemNumber)(0)).toThrow();
    expect(() => Schema.decodeUnknownSync(InternalItemIndex)(-1)).toThrow();
    expect(Schema.decodeUnknownSync(InternalItemIndex)(0)).toBe(0);
  });

  it('rejects unsupported protocol versions and out-of-range progress', () => {
    expect(() =>
      Schema.decodeUnknownSync(Request)({
        version: 2,
        requestId,
        command: { _tag: 'HistoryList' },
      })
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(Event)({
        version: 1,
        requestId,
        event: { _tag: 'Progress', phase: 'resolving', progress: 1.01 },
      })
    ).toThrow();
  });

  it('preserves operation identity while transport retries receive fresh request identities', () => {
    const exportFixture = requestFixtures.find(
      fixture =>
        typeof fixture === 'object' &&
        fixture !== null &&
        'command' in fixture &&
        typeof fixture.command === 'object' &&
        fixture.command !== null &&
        '_tag' in fixture.command &&
        fixture.command._tag === 'Export'
    );
    const original = Schema.decodeUnknownSync(Request)(exportFixture);
    const encoded = Schema.encodeSync(Request)(original);
    const retry = Schema.decodeUnknownSync(Request)({
      ...encoded,
      requestId: retryRequestId,
    });

    expect(original.requestId).not.toBe(retry.requestId);
    if (original.command._tag !== 'Export' || retry.command._tag !== 'Export') {
      throw new Error('Expected export fixtures');
    }
    expect(original.command.operations[0]?.operationId).toBe(operationId);
    expect(retry.command.operations[0]?.operationId).toBe(operationId);
  });

  it('exports canonical branded identities and the complete failure registry', () => {
    expect(Schema.decodeUnknownSync(RequestId)(requestId)).toBe(requestId);
    expect(Schema.decodeUnknownSync(OperationId)(operationId)).toBe(operationId);
    expect(FAILURE_CODES).toContain('INPUT_INVALID_SOURCE_URL');
    expect(FAILURE_CODES).toContain('SILENT_REENCODE_FAILED');
    expect(FAILURE_CODES).toContain('MEDIA_DASH_ONLY_UNSUPPORTED');
    expect(FAILURE_CODES).toContain('INSTANT_NOT_ACTIVE');
    expect(FAILURE_CODES).toContain('WHATSAPP_PAGE_ACCESS_FAILED');
    expect(FAILURE_CODES).toContain('WHATSAPP_ACQUISITION_FAILED');
    expect(FAILURE_CODES).toHaveLength(49);
  });
});
