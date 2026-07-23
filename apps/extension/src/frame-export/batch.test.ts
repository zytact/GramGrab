import { describe, expect, it } from 'vite-plus/test';
import { runFrameExportBatch } from './batch.ts';

describe('frame export batch', () => {
  it('caps concurrent jobs and preserves isolated failures', async () => {
    let active = 0;
    let maximum = 0;
    const results = await runFrameExportBatch([0, 1, 2], async index => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      if (index === 1) throw new Error('capture failed');
    });
    expect(maximum).toBeLessThanOrEqual(2);
    expect(results).toHaveLength(3);
    expect(results.find(result => result.index === 1)?.failure).toBeInstanceOf(Error);
  });
});
