export const DEFAULT_MEDIA_RATIO = 4 / 3;

export function resolveMediaRatio(
  width: number | undefined,
  height: number | undefined,
  intrinsicWidth?: number,
  intrinsicHeight?: number
): number {
  if (isPositiveFinite(width) && isPositiveFinite(height)) return width / height;
  if (isPositiveFinite(intrinsicWidth) && isPositiveFinite(intrinsicHeight))
    return intrinsicWidth / intrinsicHeight;
  return DEFAULT_MEDIA_RATIO;
}

export function isPositiveFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

export function isPositiveFinitePair(
  width: number | undefined,
  height: number | undefined
): boolean {
  return isPositiveFinite(width) && isPositiveFinite(height);
}
