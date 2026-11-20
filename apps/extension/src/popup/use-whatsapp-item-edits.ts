import { useCallback, type SetStateAction } from 'react';
import type { MediaItem } from './media-item';
import { DIRECT_EXPORT, SILENT_EXPORT } from '../whatsapp/mode';
import { useMediaEdits } from './use-media-edits';
import type { WhatsAppEdit } from './whatsapp-capture-state';

export function useWhatsAppItemEdits(
  patchEdit: (update: (edit: WhatsAppEdit) => WhatsAppEdit) => void
) {
  const setItems = useCallback(
    (update: SetStateAction<MediaItem[]>) =>
      patchEdit(current => {
        const [item] = typeof update === 'function' ? update([current.item]) : update;
        return item ? { ...current, item } : current;
      }),
    [patchEdit]
  );
  const { onRotate, onChangeCrop } = useMediaEdits(setItems);
  const toggleCrop = useCallback(
    () => patchEdit(current => ({ ...current, cropping: !current.cropping })),
    [patchEdit]
  );
  const toggleItem = useCallback(
    () =>
      patchEdit(current => ({
        ...current,
        item: { ...current.item, selected: !current.item.selected },
      })),
    [patchEdit]
  );
  const toggleRemoveAudio = useCallback(
    () =>
      patchEdit(current => ({
        ...current,
        exportChoice: current.exportChoice.mode === 'silent' ? DIRECT_EXPORT : SILENT_EXPORT,
      })),
    [patchEdit]
  );
  return { toggleItem, toggleRemoveAudio, toggleCrop, rotate: onRotate, changeCrop: onChangeCrop };
}
