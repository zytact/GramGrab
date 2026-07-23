import type { ExportOperation } from '@gramgrab/protocol';
import type { ReencodeCandidate } from './batch.ts';

export function approvedReencodeOperationIds(
  candidates: readonly ReencodeCandidate[],
  requestedById: ReadonlyMap<string, ExportOperation>
): ReadonlySet<string> {
  return new Set(
    candidates.flatMap(candidate => {
      const operationId = candidate.operation.operationId;
      const requested = requestedById.get(operationId);
      return requested?.mode._tag === 'SilentExport' && requested.mode.reencode !== 'forbid'
        ? [operationId]
        : [];
    })
  );
}
