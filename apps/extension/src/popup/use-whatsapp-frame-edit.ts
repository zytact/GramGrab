import { useCallback, useRef } from 'react';
import {
  clampFrameSecond,
  defaultFrameSecond,
  maximumFrameSecond,
} from '../frame-export/timestamp';
import type { WhatsAppCaptureHandle } from '../whatsapp/capture';
import { DIRECT_EXPORT } from '../whatsapp/mode';
import type { WhatsAppEdit } from './whatsapp-capture-state';

const METADATA_FAILURE = 'Could not load video metadata. Retry.';

/** Frame and preview editing for the single held WhatsApp capture, at video ref index 0. */
export function useWhatsAppFrameEdit({
  edit,
  patchEdit,
  handleRef,
  videoRefs,
}: {
  edit: WhatsAppEdit | undefined;
  patchEdit: (update: (edit: WhatsAppEdit) => WhatsAppEdit) => void;
  handleRef: { current: WhatsAppCaptureHandle | undefined };
  videoRefs: { current: Record<number, HTMLVideoElement | null> };
}) {
  /** The second to restore when the frame is chosen again, absent until one is chosen. */
  const chosenSecond = useRef<number | undefined>(undefined);
  const metadataGeneration = useRef(0);

  const setFrameDuration = useCallback(
    (durationSeconds: number) => {
      if (maximumFrameSecond(durationSeconds) === undefined) {
        patchEdit(current => ({
          ...current,
          frameRuntime: { status: 'failed', error: METADATA_FAILURE },
        }));
        return;
      }
      const requested = chosenSecond.current ?? defaultFrameSecond(durationSeconds);
      const timestampSeconds = clampFrameSecond(requested, durationSeconds);
      chosenSecond.current = timestampSeconds;
      patchEdit(current => ({
        ...current,
        frameRuntime: {
          ...current.frameRuntime,
          status: 'ready',
          durationSeconds,
          error: undefined,
        },
        ...(current.exportChoice.mode === 'frame'
          ? { exportChoice: { mode: 'frame' as const, timestampSeconds } }
          : {}),
      }));
    },
    [patchEdit]
  );

  const toggleFrame = useCallback(() => {
    const enabled = edit?.exportChoice.mode !== 'frame';
    patchEdit(current => ({
      ...current,
      exportChoice: enabled
        ? { mode: 'frame', timestampSeconds: chosenSecond.current ?? 0 }
        : DIRECT_EXPORT,
    }));
    if (!enabled) return;

    const video = videoRefs.current[0];
    if (video && maximumFrameSecond(video.duration) !== undefined) {
      setFrameDuration(video.duration);
      return;
    }
    patchEdit(current => ({
      ...current,
      frameRuntime: {
        ...current.frameRuntime,
        status: 'loading',
        error: undefined,
        warning: undefined,
      },
    }));
    video?.load();
  }, [edit?.exportChoice.mode, patchEdit, setFrameDuration, videoRefs]);

  const changeFrameTimestamp = useCallback(
    (timestampSeconds: number) => {
      const duration = edit?.frameRuntime?.durationSeconds;
      const chosen =
        duration === undefined
          ? Math.max(0, Math.round(timestampSeconds))
          : clampFrameSecond(timestampSeconds, duration);
      chosenSecond.current = chosen;
      patchEdit(current => ({
        ...current,
        exportChoice: { mode: 'frame', timestampSeconds: chosen },
        ...(current.frameRuntime
          ? {
              frameRuntime: {
                ...current.frameRuntime,
                status: 'ready' as const,
                error: undefined,
                warning: undefined,
              },
            }
          : {}),
      }));
    },
    [edit?.frameRuntime?.durationSeconds, patchEdit]
  );

  const previewError = useCallback(() => {
    patchEdit(current => ({
      ...current,
      previewFailed: true,
      frameRuntime: { ...current.frameRuntime, status: 'failed', error: METADATA_FAILURE },
    }));
  }, [patchEdit]);

  const retryFrameMetadata = useCallback(() => {
    const handle = handleRef.current;
    if (!handle) return;
    const generation = metadataGeneration.current + 1;
    metadataGeneration.current = generation;
    patchEdit(current => ({
      ...current,
      previewFailed: false,
      frameRuntime: {
        ...current.frameRuntime,
        status: 'loading',
        error: undefined,
        warning: undefined,
      },
    }));
    try {
      const objectUrl = handle.snapshot.objectUrl();
      patchEdit(current => ({ ...current, item: { ...current.item, url: objectUrl } }));
      const video = videoRefs.current[0];
      if (video && generation === metadataGeneration.current) {
        video.src = objectUrl;
        video.load();
      }
    } catch {
      patchEdit(current => ({
        ...current,
        frameRuntime: { status: 'failed', error: METADATA_FAILURE },
      }));
    }
  }, [handleRef, patchEdit, videoRefs]);

  /** Reset on a fresh capture: the next chosen frame starts at the default second. */
  const resetFrameDefaults = useCallback(() => {
    chosenSecond.current = undefined;
    metadataGeneration.current += 1;
  }, []);

  return {
    setFrameDuration,
    toggleFrame,
    changeFrameTimestamp,
    previewError,
    retryFrameMetadata,
    resetFrameDefaults,
  };
}
