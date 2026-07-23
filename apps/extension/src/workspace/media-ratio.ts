export const DEFAULT_MEDIA_RATIO = 4 / 3;

export function resolveMediaRatio(
  width: number | undefined,
  height: number | undefined,
  intrinsicWidth?: number,
  intrinsicHeight?: number
): number {
  if (isPositiveFinitePair(width, height)) return width! / height!;
  if (isPositiveFinitePair(intrinsicWidth, intrinsicHeight))
    return intrinsicWidth! / intrinsicHeight!;
  return DEFAULT_MEDIA_RATIO;
}

export function isPositiveFinitePair(
  width: number | undefined,
  height: number | undefined
): boolean {
  return Number.isFinite(width) && Number.isFinite(height) && width! > 0 && height! > 0;
}
