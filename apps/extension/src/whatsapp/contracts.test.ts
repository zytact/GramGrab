import { Either, Schema } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import { createOperationId, createRequestId } from '../download/contracts.ts';
import {
  CaptureChunk,
  CaptureStart,
  decodeWhatsAppDescriptor,
  decodeWhatsAppInbound,
  decodeWhatsAppOutbound,
  encodeWhatsAppInbound,
  createWhatsAppCaptureId,
  type WhatsAppCaptureDescriptor,
} from './contracts.ts';
import {
  decodeCanonicalBase64,
  encodeCanonicalBase64,
  splitIntoCanonicalBase64Chunks,
} from './base64.ts';
import {
  WHATSAPP_MAX_CHUNK_BYTES,
  WHATSAPP_MAX_CHUNKS,
  WHATSAPP_MAX_MEDIA_BYTES,
  WHATSAPP_MAX_VIDEO_DURATION_MS,
  WHATSAPP_MAX_DIMENSION,
  WHATSAPP_MIN_DIMENSION,
  WHATSAPP_PROTOCOL_VERSION,
  WHATSAPP_RETENTION_MS,
  WHATSAPP_TRANSFER_TIMEOUT_MS,
  WHATSAPP_IDLE_TIMEOUT_MS,
} from './limits.ts';

describe('WhatsApp capture contracts', () => {
  const operationId = createOperationId();
  const requestId = createRequestId();

  it('decodes the fixed CaptureStart contract and rejects excess properties', () => {
    const start = CaptureStart.make({
      protocolVersion: WHATSAPP_PROTOCOL_VERSION,
      requestId,
      operationId,
      tag: 'CaptureStart',
      maxMediaBytes: WHATSAPP_MAX_MEDIA_BYTES,
      maxChunkBytes: WHATSAPP_MAX_CHUNK_BYTES,
      maxChunks: WHATSAPP_MAX_CHUNKS,
      maxUnacknowledgedChunks: 1,
      idleTimeoutMs: WHATSAPP_IDLE_TIMEOUT_MS,
      transferTimeoutMs: WHATSAPP_TRANSFER_TIMEOUT_MS,
      retentionMs: WHATSAPP_RETENTION_MS,
    });
    const decoded = decodeWhatsAppInbound(encodeWhatsAppInbound(start));
    expect(Either.isRight(decoded)).toBe(true);
    expect(
      Either.isRight(decodeWhatsAppInbound(Object.assign({}, start, { secret: 'nope' })))
    ).toBe(false);
  });

  it('requires exact kind and MIME agreement in metadata and descriptors', () => {
    const metadata = {
      protocolVersion: 1,
      requestId,
      operationId,
      tag: 'CaptureMetadata',
      kind: 'photo',
      mimeType: 'video/mp4',
      byteLength: 1,
      width: WHATSAPP_MIN_DIMENSION,
      height: WHATSAPP_MIN_DIMENSION,
    };
    expect(Either.isRight(decodeWhatsAppOutbound(metadata))).toBe(false);
    const photo: WhatsAppCaptureDescriptor = {
      captureId: createWhatsAppCaptureId(),
      kind: 'photo',
      mimeType: 'image/jpeg',
      byteLength: 1,
      width: WHATSAPP_MIN_DIMENSION,
      height: WHATSAPP_MAX_DIMENSION,
      capturedAt: 1,
      retentionDeadline: 2,
    };
    expect(Either.isRight(decodeWhatsAppDescriptor(photo))).toBe(true);
    expect(
      Either.isRight(
        decodeWhatsAppDescriptor(
          Object.assign({}, photo, { durationMs: WHATSAPP_MAX_VIDEO_DURATION_MS })
        )
      )
    ).toBe(false);
  });

  it('accepts only canonical standard base64 and bounded decoded lengths', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254]);
    const encoded = encodeCanonicalBase64(bytes);
    expect(decodeCanonicalBase64(encoded)).toEqual(bytes);
    expect(decodeCanonicalBase64(encoded.replace(/=+$/u, ''))).toBeUndefined();
    expect(decodeCanonicalBase64('-w==')).toBeUndefined();
    expect(decodeCanonicalBase64(`${encoded} `)).toBeUndefined();
    expect(
      decodeCanonicalBase64(encodeCanonicalBase64(new Uint8Array(WHATSAPP_MAX_CHUNK_BYTES + 1)))
    ).toBeUndefined();
    const chunks = splitIntoCanonicalBase64Chunks(new Uint8Array([1, 2, 3, 4]), 2);
    expect(chunks.map(chunk => decodeCanonicalBase64(chunk)?.length)).toEqual([2, 2]);
  });

  it('rejects zero-length and malformed chunk envelopes before bytes are retained', () => {
    const base = {
      protocolVersion: 1,
      requestId,
      operationId,
      tag: 'CaptureChunk' as const,
      sequence: 0,
    };
    expect(
      Either.isRight(decodeWhatsAppOutbound({ ...base, decodedLength: 0, payload: 'AAAA' }))
    ).toBe(false);
    expect(
      Either.isRight(decodeWhatsAppOutbound({ ...base, decodedLength: 1, payload: '!!!!' }))
    ).toBe(false);
    expect(
      Either.isRight(decodeWhatsAppOutbound({ ...base, decodedLength: 1, payload: 'AB==' }))
    ).toBe(false);
    expect(Either.isRight(decodeWhatsAppOutbound({ ...base, decodedLength: 1, payload: '' }))).toBe(
      false
    );
    expect(
      Schema.decodeUnknownSync(CaptureChunk)({
        ...base,
        decodedLength: 1,
        payload: 'AA==',
      })
    ).toMatchObject({ sequence: 0 });
  });
});
