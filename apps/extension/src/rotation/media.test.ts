// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vite-plus/test';
import { drawModified } from './media.ts';

describe('drawModified', () => {
  it('turns first, then crops in the turned frame', () => {
    const context = { drawImage: vi.fn(), translate: vi.fn(), rotate: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D
    );
    const source = document.createElement('canvas');

    const canvas = drawModified(source, 400, 200, {
      rotation: 90,
      crop: { x: 0.5, y: 0.25, width: 0.5, height: 0.5 },
    })!;

    expect([canvas.width, canvas.height]).toEqual([100, 200]);
    expect(context.drawImage).toHaveBeenLastCalledWith(
      expect.any(HTMLCanvasElement),
      100,
      100,
      100,
      200,
      0,
      0,
      100,
      200
    );
  });
});
