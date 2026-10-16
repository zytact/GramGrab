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
      // A requested direct crop is consent to the re-encode it cannot happen without.
      const consented =
        requested?.mode._tag === 'SilentExport'
          ? requested.mode.reencode !== 'forbid'
          : requested?.mode._tag === 'DirectExport' && requested.crop !== undefined;
      return consented ? [operationId] : [];
    })
  );
}
