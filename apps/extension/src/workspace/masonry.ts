export function distributeMasonryItems<T>(
  items: readonly T[],
  columnCount: number,
  estimateHeight: (item: T) => number
): T[][] {
  const columns = Array.from({ length: Math.max(1, columnCount) }, () => ({
    items: [] as T[],
    height: 0,
  }));

  for (const item of items) {
    const shortest = columns.reduce((best, column) =>
      column.height < best.height ? column : best
    );
    shortest.items.push(item);
    shortest.height += estimateHeight(item);
  }

  return columns.map(column => column.items);
}
