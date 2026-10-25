import { Crop as CropSchema, type Crop } from '@gramgrab/protocol';

export { CropSchema, type Crop };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

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
