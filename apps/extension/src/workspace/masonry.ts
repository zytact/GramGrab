export function distributeMasonryItems<T>(
  items: readonly T[],
  columnCount: number,
  estimateHeight: (item: T) => number
): T[][] {
  const columns = Array.from({ length: Math.max(1, columnCount) }, () => [] as T[]);
  const heights = columns.map(() => 0);

  for (const item of items) {
    const column = heights.reduce(
      (shortest, height, index) => (height < heights[shortest]! ? index : shortest),
      0
    );
    columns[column]!.push(item);
    heights[column]! += estimateHeight(item);
  }

  return columns;
}
