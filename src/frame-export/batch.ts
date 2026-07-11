export interface FrameExportJobResult {
  index: number;
  error?: string;
}

export async function runFrameExportBatch(
  indexes: readonly number[],
  run: (index: number) => Promise<void>,
  concurrency = 2
): Promise<FrameExportJobResult[]> {
  const results: FrameExportJobResult[] = [];
  let next = 0;
  const worker = async () => {
    while (next < indexes.length) {
      const index = indexes[next++];
      if (index === undefined) return;
      try {
        await run(index);
        results.push({ index });
      } catch (error) {
        results.push({ index, error: String(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, indexes.length) }, worker));
  return results;
}
