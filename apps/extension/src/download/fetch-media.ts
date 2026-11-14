import { HttpError, NetworkError } from '../effect/errors.ts';
import { normalizeMediaTransferFailure } from '../errors/normalize.ts';

const networkFailure = (cause: unknown) =>
  normalizeMediaTransferFailure(new NetworkError({ cause }));

/** Reads a resolved media URL, throwing a media-transfer `OperationFailure` when it cannot. */
export async function fetchMedia(url: string): Promise<Blob> {
  const response = await fetch(url, { credentials: 'omit' }).catch(cause => {
    throw networkFailure(cause);
  });
  if (!response.ok)
    throw normalizeMediaTransferFailure(
      new HttpError({ status: response.status, message: response.statusText })
    );
  return response.blob().catch(cause => {
    throw networkFailure(cause);
  });
}
