import type { ExportOperation } from '@gramgrab/protocol';
import type { ReencodeCandidate } from './batch.ts';

/**
 * The operations a CLI request already consented to re-encode: a silent export that does not
 * forbid it, and a direct crop, which cannot happen without one.
 */
export function approvedReencodeOperationIds(
  candidates: readonly ReencodeCandidate[],
  requestedById: ReadonlyMap<string, ExportOperation>
): ReadonlySet<string> {
  return new Set(
    candidates.flatMap(candidate => {
      const operationId = candidate.operation.operationId;
      const requested = requestedById.get(operationId);
      const consented =
        requested?.mode._tag === 'SilentExport'
          ? requested.mode.reencode !== 'forbid'
          : requested?.mode._tag === 'DirectExport' && requested.crop !== undefined;
      return consented ? [operationId] : [];
    })
  );
}
