import { Schema } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import { CropSchema, cropPixels, rotateCropClockwise } from './contracts.ts';

const crop = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };

describe('crop', () => {
  it('accepts only a rectangle inside the frame', () => {
    const isCrop = Schema.is(CropSchema);
    expect(isCrop(crop)).toBe(true);
    expect(isCrop({ ...crop, x: 0.8 })).toBe(false);
    expect(isCrop({ ...crop, width: 0 })).toBe(false);
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
});
