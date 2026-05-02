/**
 * Service-worker-safe media utilities.
 *
 * FileReader and URL.createObjectURL are document-oriented APIs unavailable in
 * Chromium MV3 service workers. These helpers provide equivalent functionality
 * using only APIs that are available in both document and worker contexts.
 */

/**
 * Convert a Blob to a base64-encoded data URL without using FileReader.
 * Works in service workers, document scripts, and Node/jsdom test environments.
 */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  const ab = await blob.arrayBuffer();
  const bytes = new Uint8Array(ab);
  let binary = '';
  // Process in chunks to avoid stack overflow on large blobs
  const CHUNK = 8192;
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

/**
 * Serialize a JSON value to a base64 data URL suitable for browser.downloads.download().
 * Does not use URL.createObjectURL — safe in service workers.
 */
export function jsonToDataUrl(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  // UTF-8 → latin1 passthrough via encodeURIComponent + percent-decode trick
  const latin1 = encodeURIComponent(json).replace(/%([0-9A-F]{2})/gi, (_m, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  return `data:application/json;base64,${btoa(latin1)}`;
}
