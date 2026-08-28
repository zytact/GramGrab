export type WhatsAppExportItem = {
  readonly kind: 'photo' | 'video';
};

/**
 * The one export a person has chosen for a held capture. A frame and a silent re-encode are
 * alternatives, so a capture that is both cannot be written down.
 */
export type WhatsAppExportChoice =
  | { readonly mode: 'direct' }
  | { readonly mode: 'frame'; readonly timestampSeconds: number }
  | { readonly mode: 'silent' };

export type WhatsAppExportSelection =
  | { readonly mode: 'direct'; readonly filename: string }
  | { readonly mode: 'frame'; readonly filename: string; readonly frameTimestampSeconds: number }
  | { readonly mode: 'silent'; readonly filename: string };

export const DIRECT_EXPORT: WhatsAppExportChoice = { mode: 'direct' };
export const SILENT_EXPORT: WhatsAppExportChoice = { mode: 'silent' };

export function silentFilename(filename: string): string {
  const extensionIndex = filename.lastIndexOf('.');
  if (extensionIndex <= 0) return `${filename}-muted`;
  return `${filename.slice(0, extensionIndex)}-muted${filename.slice(extensionIndex)}`;
}

export function whatsappExportSelection(
  item: WhatsAppExportItem,
  choice: WhatsAppExportChoice,
  directFilename: string,
  frameFilename: string
): WhatsAppExportSelection {
  if (item.kind === 'photo') return { mode: 'direct', filename: directFilename };
  switch (choice.mode) {
    case 'frame':
      return {
        mode: 'frame',
        filename: frameFilename,
        frameTimestampSeconds: choice.timestampSeconds,
      };
    case 'silent':
      return { mode: 'silent', filename: silentFilename(directFilename) };
    case 'direct':
      return { mode: 'direct', filename: directFilename };
  }
}
