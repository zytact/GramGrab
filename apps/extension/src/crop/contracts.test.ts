import { Schema } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import {
  CropSchema,
  cropPixels,
  fitAspect,
  FULL_FRAME,
  moveCrop,
  normalizeCrop,
  resizeCrop,
  rotateCropClockwise,
  stepCrop,
} from './contracts.ts';

const crop = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };

describe('crop', () => {
  it('accepts only a rectangle inside the frame', () => {
    const isCrop = Schema.is(CropSchema);
    expect(isCrop(crop)).toBe(true);
    expect(isCrop({ ...crop, x: 0.8 })).toBe(false);
    expect(isCrop({ ...crop, width: 0 })).toBe(false);
  });

  it('stores a whole-frame crop as no crop', () => {
    expect(normalizeCrop(FULL_FRAME)).toBeUndefined();
    expect(normalizeCrop(crop)).toBe(crop);
  });

  it('follows its region through four quarter turns back to where it started', () => {
    const turned = rotateCropClockwise(crop);
    expect(turned).toEqual({ x: 0.4, y: 0.1, width: 0.4, height: 0.3 });
    const full = [1, 2, 3].reduce(rotateCropClockwise, turned);
    expect(full.x).toBeCloseTo(crop.x);
    expect(full.y).toBeCloseTo(crop.y);
  });

  it('stays a valid crop when it sits on the bottom edge', () => {
    const height = 0.30004191191780444;
    const turned = rotateCropClockwise({ x: 0, y: 1 - height, width: 0.5, height });
    expect(Schema.is(CropSchema)(turned)).toBe(true);
  });

  it('converts to whole pixels that never leave the frame', () => {
    expect(cropPixels(crop, 1000, 500)).toEqual({ x: 100, y: 100, width: 300, height: 200 });
    expect(cropPixels({ x: 0.999, y: 0, width: 0.001, height: 1 }, 10, 10)).toEqual({
      x: 9,
      y: 0,
      width: 1,
      height: 10,
    });
  });

  it('moves without crossing an edge', () => {
    expect(moveCrop(crop, 1, -1)).toEqual({ ...crop, x: 0.7, y: 0 });
  });

  it('fits the largest crop of a preset aspect, centred on the current crop', () => {
    const square = fitAspect(FULL_FRAME, 1, 16 / 9);
    expect(square.height).toBe(1);
    expect(square.width * (16 / 9)).toBeCloseTo(1);
    expect(square.x).toBeCloseTo((1 - square.width) / 2);
    expect(fitAspect(FULL_FRAME, 9 / 16, 1)).toMatchObject({ height: 1, width: 9 / 16 });
  });

  it('resizes from a corner while holding the opposite corner', () => {
    expect(resizeCrop(crop, 'se', { x: 0.6, y: 0.9 })).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.5,
      height: expect.closeTo(0.7),
    });
    const flipped = resizeCrop(crop, 'nw', { x: 0.9, y: 0.9 });
    expect(flipped.x + flipped.width).toBeCloseTo(0.4);
    expect(flipped.width).toBeCloseTo(0.05);
  });

  it('keeps a locked aspect while resizing and stepping', () => {
    const lock = { ratio: 1, frameRatio: 2 };
    const resized = resizeCrop(crop, 'se', { x: 0.9, y: 0.3 }, lock);
    expect((resized.width * 2) / resized.height).toBeCloseTo(1);
    expect(resized.y + resized.height).toBeLessThanOrEqual(1);
    const stepped = stepCrop(resized, { dx: -1, dy: 0 }, true, lock);
    expect((stepped.width * 2) / stepped.height).toBeCloseTo(1);
    expect(stepped.width).toBeCloseTo(resized.width - 0.01);
  });
});
