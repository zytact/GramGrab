import { HttpError, NetworkError } from '../effect/errors.ts';
import { normalizeMediaTransferFailure } from '../errors/normalize.ts';

/** Reads a resolved media URL, throwing a media-transfer `OperationFailure` when it cannot. */
export async function fetchMedia(url: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: 'omit' });
  } catch (cause) {
    throw normalizeMediaTransferFailure(new NetworkError({ cause }));
  }
  if (!response.ok)
    throw normalizeMediaTransferFailure(
      new HttpError({ status: response.status, message: response.statusText })
    );
  return response.blob();
}
