export interface FrameExportSetting {
  enabled: boolean;
  timestampSeconds: number;
}

export function maximumFrameSecond(durationSeconds: number): number | undefined {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return undefined;
  return Math.max(0, Math.ceil(durationSeconds) - 1);
}

export function defaultFrameSecond(durationSeconds: number): number {
  return Math.min(5, maximumFrameSecond(durationSeconds) ?? 0);
}

export function clampFrameSecond(timestampSeconds: number, durationSeconds: number): number {
  const maximum = maximumFrameSecond(durationSeconds);
  if (maximum === undefined) return 0;
  return Math.max(0, Math.min(maximum, Math.round(timestampSeconds)));
}

export function formatFrameTimestamp(timestampSeconds: number): string {
  const seconds = Math.max(0, Math.round(timestampSeconds));
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

export function frameTimestampAriaValue(timestampSeconds: number): string {
  const seconds = Math.max(0, Math.round(timestampSeconds));
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

export function frameFilename(filenameHint: string, timestampSeconds: number): string {
  return `${filenameHint}_frame_${formatFrameTimestamp(timestampSeconds).replace(':', '-')}.jpg`;
}
