import { useMemo, type Dispatch, type SetStateAction } from 'react';
import { normalizeCrop, rotateCropClockwise, type Crop } from '../crop/contracts';
import { nextRotation } from '../rotation/contracts';
import type { MediaItem } from './media-item';

/** Rotate and crop for every surface that edits media items before export. */
export function useMediaEdits<T extends MediaItem>(setItems: Dispatch<SetStateAction<T[]>>) {
  return useMemo(() => {
    const edit = (index: number, change: (item: T) => T) =>
      setItems(previous => previous.map(item => (item.index === index ? change(item) : item)));
    return {
      /** Turns an item a quarter clockwise, and its crop with it so it stays on its subject. */
      onRotate: (index: number) =>
        edit(index, item => ({
          ...item,
          rotation: nextRotation(item.rotation),
          crop: item.crop && rotateCropClockwise(item.crop),
        })),
      onChangeCrop: (index: number, crop: Crop | undefined) =>
        edit(index, item => ({ ...item, crop: crop && normalizeCrop(crop) })),
    };
  }, [setItems]);
}
