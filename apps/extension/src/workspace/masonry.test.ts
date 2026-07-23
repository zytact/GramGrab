import { describe, expect, it } from 'vite-plus/test';
import { distributeMasonryItems } from './masonry';

describe('distributeMasonryItems', () => {
  it('places each next item in the shortest column', () => {
    const items = [100, 300, 100, 100];
    expect(distributeMasonryItems(items, 2, item => item)).toEqual([[100, 100, 100], [300]]);
  });

  it('keeps every item in a single column when space is limited', () => {
    expect(distributeMasonryItems(['a', 'b'], 1, () => 1)).toEqual([['a', 'b']]);
  });

  it('falls back to one column when the requested count is not positive', () => {
    expect(distributeMasonryItems(['a', 'b'], 0, () => 1)).toEqual([['a', 'b']]);
  });

  it('preserves source order when columns have equal estimated heights', () => {
    expect(distributeMasonryItems(['a', 'b', 'c', 'd'], 2, () => 1)).toEqual([
      ['a', 'c'],
      ['b', 'd'],
    ]);
  });

  it('returns the requested empty columns when there are no items', () => {
    expect(distributeMasonryItems([], 3, () => 1)).toEqual([[], [], []]);
  });
});
