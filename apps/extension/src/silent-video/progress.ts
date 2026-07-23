import type { AttemptEntry } from '../download/attempt.ts';

const SILENT_PHASE_LABELS: Readonly<Record<string, string>> = {
  queued: 'Waiting to inspect video',
  inspecting: 'Inspecting video',
  processing: 'Removing audio',
  validating: 'Validating silent video',
  downloading: 'Download started',
};

export function silentProgressMessage(
  entries: readonly AttemptEntry[] | undefined
): string | undefined {
  const active = entries?.flatMap(entry =>
    entry.operation.mode === 'silent' && entry.outcome.status === 'pending' ? [entry.outcome] : []
  );
  const progressState = ['processing', 'validating', 'inspecting', 'downloading', 'queued'].flatMap(
    phase => {
      const outcome = active?.find(candidate => candidate.phase === phase);
      return outcome ? [outcome] : [];
    }
  )[0];
  if (!progressState?.phase) return undefined;
  const label = SILENT_PHASE_LABELS[progressState.phase];
  if (!label) return undefined;
  if (progressState.phase === 'queued') return `${label}…`;
  if (progressState.phase === 'downloading') return label;
  return `${label}… ${Math.round((progressState.progress ?? 0) * 100)}%`;
}
