import { loadJpeg } from './avatar-jpeg.ts';

/**
 * The verified login's picture, held in worker memory only. The viewer query that verifies the
 * login carries its URL, so showing it costs no Instagram request.
 */
let viewerPicture:
  | { readonly accountId: string; readonly url: string; jpeg?: Promise<string | undefined> }
  | undefined;

export function noteViewerPicture(viewer: { accountId: string; pictureUrl?: string }): void {
  if (viewerPicture?.accountId === viewer.accountId && viewerPicture.url === viewer.pictureUrl)
    return;
  viewerPicture = viewer.pictureUrl
    ? { accountId: viewer.accountId, url: viewer.pictureUrl }
    : undefined;
}

export async function viewerJpeg(viewerId: string): Promise<string | undefined> {
  const picture = viewerPicture?.accountId === viewerId ? viewerPicture : undefined;
  const login = picture && (await (picture.jpeg ??= loadJpeg(picture.url)));
  if (picture && !login) picture.jpeg = undefined;
  return login;
}
