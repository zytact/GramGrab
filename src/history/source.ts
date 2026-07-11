import { canonicalizeInstagramUrl } from '../workspace/contracts.ts';
import type { HistorySourceKind } from './contracts.ts';

export interface HistorySource {
  url: string;
  kind: HistorySourceKind;
}

/** Canonical identity intentionally omits Post's UI-only img_index selection. */
export function historySource(value: string): HistorySource | null {
  const canonical = canonicalizeInstagramUrl(value);
  if (!canonical) return null;
  const url = new URL(canonical.url);
  url.searchParams.delete('img_index');
  return { url: url.toString(), kind: canonical.target.type };
}
