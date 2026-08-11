export type WhatsAppExportMode = 'direct' | 'frame' | 'silent';

export type WhatsAppExportItem = {
  readonly kind: 'photo' | 'video';
};

export function exportMode(
  item: WhatsAppExportItem,
  frameEnabled: boolean,
  removeAudio: boolean
): WhatsAppExportMode {
  if (item.kind === 'photo') return 'direct';
  if (frameEnabled) return 'frame';
  if (removeAudio) return 'silent';
  return 'direct';
}

export function silentFilename(filename: string): string {
  const extensionIndex = filename.lastIndexOf('.');
  if (extensionIndex <= 0) return `${filename}-muted`;
  return `${filename.slice(0, extensionIndex)}-muted${filename.slice(extensionIndex)}`;
}

export function whatsappExportSelection(
  item: WhatsAppExportItem,
  frameEnabled: boolean,
  removeAudio: boolean,
  directFilename: string,
  frameFilename: string
): { readonly mode: WhatsAppExportMode; readonly filename: string } {
  const mode = exportMode(item, frameEnabled, removeAudio);
  if (mode === 'frame') return { mode, filename: frameFilename };
  if (mode === 'silent') return { mode, filename: silentFilename(directFilename) };
  return { mode, filename: directFilename };
}
