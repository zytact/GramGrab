import { describe, expect, it } from 'vite-plus/test';
import { FAILURE_CODES, OperationFailure, decodeOperationFailure } from './contracts.ts';
import { FAILURE_PRESENTATION } from './presentation.ts';

const structuralEvidence = {
  extractionContractVersion: 1,
  invariant: 'player-marker',
  nodeShape: {
    playerCount: 1,
    imageCount: 0,
    blobImageCount: 0,
    dataImageCount: 0,
    videoCount: 1,
    markedVideoCount: 0,
    overflow: false,
  },
  mediaKind: 'unknown',
  readiness: 'unknown',
  sourceProtocolClass: 'none',
  dimensionState: 'unknown',
  playerState: 'single',
  guardState: 'unknown',
  bytesOwned: false,
  discardCompleted: true,
  blobUrlCreated: false,
  blobUrlRevoked: false,
  retentionCeilingArmed: false,
};

const whatsAppFailure = {
  platform: 'whatsapp',
  code: 'WHATSAPP_FORMAT_CHANGED',
  phase: 'whatsapp-extraction',
  scope: 'item',
  structuralEvidence,
};

const instagramFailure = {
  platform: 'instagram',
  code: 'IG_RESPONSE_SHAPE_UNKNOWN',
  phase: 'source',
  scope: 'batch',
};

describe('operation error contracts', () => {
  it('rejects unknown failure codes', async () => {
    await expect(
      decodeOperationFailure({ code: 'UNKNOWN', phase: 'source', scope: 'item' })
    ).rejects.toBeDefined();
  });

  it('has an exhaustive presentation and recovery policy', () => {
    expect(Object.keys(FAILURE_PRESENTATION).sort()).toEqual([...FAILURE_CODES].sort());
    for (const code of FAILURE_CODES) {
      expect(FAILURE_PRESENTATION[code].title).not.toBe('');
    }
  });

  it('preserves the invalid-source input policy', () => {
    expect(FAILURE_PRESENTATION.INPUT_INVALID_SOURCE_URL).toEqual({
      title: 'Use an Instagram link',
      explanation: 'Enter a valid Instagram link.',
      actions: [],
      retry: 'never',
      retainSilentInput: false,
    });
  });

  it('round-trips a schema-backed failure', async () => {
    const failure = OperationFailure.make({
      code: 'IG_RESPONSE_SHAPE_UNKNOWN',
      phase: 'source',
      scope: 'batch',
    });
    await expect(decodeOperationFailure(failure)).resolves.toEqual(failure);
  });

  it('decodes the closed WhatsApp branch', async () => {
    await expect(decodeOperationFailure(whatsAppFailure)).resolves.toMatchObject(whatsAppFailure);
  });

  it('decodes legacy Instagram failures into the Instagram branch', async () => {
    await expect(
      decodeOperationFailure({
        code: 'IG_RESPONSE_SHAPE_UNKNOWN',
        phase: 'source',
        scope: 'batch',
      })
    ).resolves.toMatchObject(instagramFailure);
  });

  it('rejects invalid platform, code, and evidence combinations', async () => {
    await expect(
      decodeOperationFailure({ ...whatsAppFailure, code: 'IG_RESPONSE_SHAPE_UNKNOWN' })
    ).rejects.toBeDefined();
    await expect(
      decodeOperationFailure({ ...instagramFailure, code: 'WHATSAPP_FORMAT_CHANGED' })
    ).rejects.toBeDefined();
    await expect(
      decodeOperationFailure({ ...instagramFailure, structuralEvidence })
    ).rejects.toBeDefined();
  });

  it('rejects WhatsApp free-form and identifier-bearing fields', async () => {
    for (const field of [
      { cause: { name: 'Error', message: 'secret message', stack: 'secret stack' } },
      { message: 'secret message' },
      { stack: 'secret stack' },
      { operationId: '00000000-0000-4000-8000-000000000001' },
      { metadata: { contactId: 'secret identifier' } },
    ]) {
      await expect(decodeOperationFailure({ ...whatsAppFailure, ...field })).rejects.toBeDefined();
    }
  });

  it('rejects all excess properties at the operation failure boundary', async () => {
    await expect(
      decodeOperationFailure({ ...instagramFailure, requestId: 'excess-request-id' })
    ).rejects.toBeDefined();
  });
});
