import { describe, expect, it } from 'vite-plus/test';
import { combineRotations, nextRotation, type Rotation } from './contracts.ts';

describe('rotation', () => {
  it('cycles clockwise through every quarter turn back to unrotated', () => {
    const turns: (Rotation | undefined)[] = [undefined, 90, 180, 270];
    expect(turns.map(nextRotation)).toEqual([90, 180, 270, undefined]);
  });

  it('adds a requested turn to a video track rotation modulo a full turn', () => {
    expect(combineRotations(0, undefined)).toBe(0);
    expect(combineRotations(90, 90)).toBe(180);
    expect(combineRotations(270, 180)).toBe(90);
  });
});
