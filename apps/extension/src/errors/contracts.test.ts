import { describe, expect, it } from 'vite-plus/test';
import { FAILURE_CODES, OperationFailure, decodeOperationFailure } from './contracts.ts';
import { FAILURE_PRESENTATION } from './presentation.ts';

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
});
