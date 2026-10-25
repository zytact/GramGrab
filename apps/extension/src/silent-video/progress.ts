import { executorFor, type AttemptEntry } from '../download/attempt.ts';

const SILENT_PHASE_LABELS: Readonly<Record<string, string>> = {
  queued: 'Waiting to inspect video',
  inspecting: 'Inspecting video',
  processing: 'Removing audio',
  validating: 'Validating silent video',
  downloading: 'Download started',
};

const CROP_PHASE_LABELS: Readonly<Record<string, string>> = {
  ...SILENT_PHASE_LABELS,
  processing: 'Cropping video',
  validating: 'Validating cropped video',
};

export function silentProgressMessage(
  entries: readonly AttemptEntry[] | undefined
): string | undefined {
  const active = entries?.flatMap(entry =>
    executorFor(entry.operation) === 'video' && entry.outcome.status === 'pending'
      ? [{ ...entry.outcome, cropped: entry.operation.crop !== undefined }]
      : []
  );
  const progressState = ['processing', 'validating', 'inspecting', 'downloading', 'queued'].flatMap(
    phase => {
      const outcome = active?.find(candidate => candidate.phase === phase);
      return outcome ? [outcome] : [];
    }
  )[0];
  if (!progressState?.phase) return undefined;
  const label = (progressState.cropped ? CROP_PHASE_LABELS : SILENT_PHASE_LABELS)[
    progressState.phase
  ];
  if (!label) return undefined;
  if (progressState.phase === 'queued') return `${label}…`;
  if (progressState.phase === 'downloading') return label;
  return `${label}… ${Math.round((progressState.progress ?? 0) * 100)}%`;
}
