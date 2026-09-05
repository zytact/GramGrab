import { describe, expect, it } from 'vite-plus/test';
import { throttleProgress, type ProgressTick } from './throttle.ts';

function collector() {
  const ticks: ProgressTick<string>[] = [];
  let clock = 0;
  const emit = throttleProgress(
    tick => ticks.push(tick),
    () => clock,
    100
  );
  return {
    ticks,
    advance: (ms: number) => {
      clock += ms;
    },
    emit,
  };
}

describe('silent video progress throttle', () => {
  it('drops intermediate ticks inside one interval', () => {
    const { ticks, emit } = collector();
    emit({ phase: 'processing', progress: 0.1 });
    emit({ phase: 'processing', progress: 0.2 });
    emit({ phase: 'processing', progress: 0.3 });
    expect(ticks).toEqual([{ phase: 'processing', progress: 0.1 }]);
  });

  it('emits again once the interval has passed', () => {
    const { ticks, advance, emit } = collector();
    emit({ phase: 'processing', progress: 0.1 });
    advance(100);
    emit({ phase: 'processing', progress: 0.4 });
    expect(ticks).toHaveLength(2);
  });

  it('always emits a phase change', () => {
    const { ticks, emit } = collector();
    emit({ phase: 'inspecting', progress: 0.5 });
    emit({ phase: 'processing', progress: 0.5 });
    emit({ phase: 'validating', progress: 1 });
    expect(ticks.map(tick => tick.phase)).toEqual(['inspecting', 'processing', 'validating']);
  });

  it('emits the tick that completes a phase but not the ones repeating it', () => {
    const { ticks, emit } = collector();
    emit({ phase: 'processing', progress: 0.2 });
    emit({ phase: 'processing', progress: 1 });
    emit({ phase: 'processing', progress: 1 });
    emit({ phase: 'processing', progress: 1 });
    expect(ticks).toEqual([
      { phase: 'processing', progress: 0.2 },
      { phase: 'processing', progress: 1 },
    ]);
  });
});
