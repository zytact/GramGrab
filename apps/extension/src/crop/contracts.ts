import { Crop as CropSchema, type Crop } from '@gramgrab/protocol';

export { CropSchema, type Crop };

export const FULL_FRAME: Crop = { x: 0, y: 0, width: 1, height: 1 };

/** The smallest side a crop may shrink to, as a fraction of the frame. */
const MIN_CROP_SIDE = 0.05;

/** Width-to-height ratios offered next to a free-form rectangle. */
export const ASPECT_PRESETS = [
  { label: '1:1', ratio: 1 },
  { label: '4:5', ratio: 4 / 5 },
  { label: '9:16', ratio: 9 / 16 },
] as const;

export type CropHandle = 'nw' | 'ne' | 'sw' | 'se';

/** A pixel width-to-height `ratio` a crop keeps, on a frame of `frameRatio`. */
export interface AspectLock {
  readonly ratio: number;
  readonly frameRatio: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * A crop that keeps the whole frame is no crop, so it is dropped rather than stored. Selector
 * arithmetic can drift a hair past an edge, which the schema rejects, so the rest is clamped.
 */
export function normalizeCrop(crop: Crop): Crop | undefined {
  if (crop.width >= 0.999 && crop.height >= 0.999) return undefined;
  const x = clamp(crop.x, 0, 1);
  const y = clamp(crop.y, 0, 1);
  return { x, y, width: Math.min(crop.width, 1 - x), height: Math.min(crop.height, 1 - y) };
}

/**
 * The same region after the frame turns a quarter clockwise, which keeps a crop on its subject.
 * `x` is clamped because floating point can land a hair below zero for a crop on the bottom edge.
 */
export const rotateCropClockwise = (crop: Crop): Crop => ({
  x: Math.max(0, 1 - crop.y - crop.height),
  y: crop.x,
  width: crop.height,
  height: crop.width,
});

/** The crop in whole pixels of a `width` by `height` frame, never empty and never outside it. */
export function cropPixels(crop: Crop, width: number, height: number) {
  const x = clamp(Math.round(crop.x * width), 0, width - 1);
  const y = clamp(Math.round(crop.y * height), 0, height - 1);
  return {
    x,
    y,
    width: clamp(Math.round(crop.width * width), 1, width - x),
    height: clamp(Math.round(crop.height * height), 1, height - y),
  };
}

/** Keeps a crop's size and moves it by a fraction of the frame, stopping at the edges. */
export const moveCrop = (crop: Crop, dx: number, dy: number): Crop => ({
  ...crop,
  x: clamp(crop.x + dx, 0, 1 - crop.width),
  y: clamp(crop.y + dy, 0, 1 - crop.height),
});

/**
 * The largest crop of `aspect` (pixel width over height) that fits a frame of `frameRatio`,
 * centred where `crop` was centred.
 */
export function fitAspect(crop: Crop, aspect: number, frameRatio: number): Crop {
  const width = Math.min(1, aspect / frameRatio);
  const height = (width * frameRatio) / aspect;
  return {
    x: clamp(crop.x + crop.width / 2 - width / 2, 0, 1 - width),
    y: clamp(crop.y + crop.height / 2 - height / 2, 0, 1 - height),
    width,
    height,
  };
}

/**
 * Drags one corner of a crop to a point, holding the opposite corner. With `aspect`, the
 * rectangle keeps that pixel ratio and takes the largest size the point and frame allow.
 */
export function resizeCrop(
  crop: Crop,
  handle: CropHandle,
  point: { x: number; y: number },
  aspect?: AspectLock
): Crop {
  const west = handle === 'nw' || handle === 'sw';
  const north = handle === 'nw' || handle === 'ne';
  const anchorX = west ? crop.x + crop.width : crop.x;
  const anchorY = north ? crop.y + crop.height : crop.y;
  const roomX = west ? anchorX : 1 - anchorX;
  const roomY = north ? anchorY : 1 - anchorY;
  let width = clamp(west ? anchorX - point.x : point.x - anchorX, MIN_CROP_SIDE, roomX);
  let height = clamp(north ? anchorY - point.y : point.y - anchorY, MIN_CROP_SIDE, roomY);
  if (aspect) {
    const heightPerWidth = aspect.frameRatio / aspect.ratio;
    width = Math.min(Math.max(width, height / heightPerWidth), roomX, roomY / heightPerWidth);
    height = width * heightPerWidth;
  }
  return {
    x: west ? anchorX - width : anchorX,
    y: north ? anchorY - height : anchorY,
    width,
    height,
  };
}

const KEY_STEP = 0.01;

/**
 * One arrow-key step: moves the crop, or with `resize` grows or shrinks it from its bottom-right
 * corner. A locked aspect resizes both sides together.
 */
export function stepCrop(
  crop: Crop,
  { dx, dy }: { dx: number; dy: number },
  resize: boolean,
  aspect?: AspectLock
): Crop {
  if (!resize) return moveCrop(crop, dx * KEY_STEP, dy * KEY_STEP);
  const right = crop.x + crop.width;
  const bottom = crop.y + crop.height;
  if (!aspect)
    return resizeCrop(crop, 'se', { x: right + dx * KEY_STEP, y: bottom + dy * KEY_STEP });
  const grow = (dx || dy) * KEY_STEP;
  return resizeCrop(
    crop,
    'se',
    { x: right + grow, y: bottom + (grow * aspect.frameRatio) / aspect.ratio },
    aspect
  );
}
