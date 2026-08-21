import { useEffect } from 'react';
import { clampFrameSecond, type FrameExportSetting } from '../frame-export/timestamp';
import { type FrameRuntime, type ItemRuntimes } from './media-item';

function seekTarget(
  setting: FrameExportSetting,
  frame: FrameRuntime | undefined
): number | undefined {
  if (!setting.enabled || frame?.status !== 'ready' || frame.durationSeconds === undefined)
    return undefined;
  return clampFrameSecond(setting.timestampSeconds, frame.durationSeconds);
}

/** Keeps every enabled frame preview seeked to its selected timestamp. */
export function useFrameSeekEffect(
  frameSettings: Record<number, FrameExportSetting>,
  runtimes: ItemRuntimes,
  videoRefs: { current: Record<number, HTMLVideoElement | null> }
): void {
  useEffect(() => {
    for (const [key, setting] of Object.entries(frameSettings)) {
      const index = Number(key);
      const target = seekTarget(setting, runtimes[index]?.frame);
      const video = videoRefs.current[index];
      if (target === undefined || !video) continue;
      if (Math.abs(video.currentTime - target) > 0.01) video.currentTime = target;
    }
  }, [frameSettings, runtimes, videoRefs]);
}
