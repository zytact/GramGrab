# WhatsApp Visible Status structural live verification

This is a **human-run** procedure for the facts synthetic tests cannot establish. It is not a
collection procedure. Follow [WhatsApp privacy constraints](./whatsapp-privacy.md),
[ADR 0001](./adr/0001-activetab-for-whatsapp-page-access.md), and
[ADR 0002](./adr/0002-structural-only-whatsapp-diagnostics.md), and
[ADR 0004](./adr/0004-whatsapp-edit-session-retention.md).

Synthetic tests remain authoritative for every extension-owned boundary. This procedure establishes
only whether current WhatsApp Web, Chromium, and Firefox meet the adopted contract.

## Preconditions

1. Build both packages from the reviewed revision:
   ```bash
   vp run build:chromium
   vp run build:firefox
   vp run verify:whatsapp-packages
   ```
2. Use separate dedicated QA WhatsApp accounts and a dedicated browser profile. Do not use a
   personal account, a real contact, production chat content, or an account with personal history.
3. Create exactly two purpose-made, generic test cards: one ordinary photo and one ordinary MP4
   video. They must contain no person, contact data, location, account name, meaningful text, or
   identifying visual material.
4. Load only the matching unpacked package into Chromium or Firefox. Confirm the generated manifest
   requests `activeTab` and `scripting`, and no WhatsApp host permission.
5. Open WhatsApp Web, open one test Status in the viewer, and invoke GramGrab from that active tab.
   Do not use DevTools, MAIN-world injection, a host-permission workaround, persistent storage, the
   workspace, a service-worker workaround, or any alternate transfer path.

## Matrix

Run every row for Chromium and then Firefox. Mark only `pass` or `fail`; use a symbolic failure code
only when GramGrab actually presented one. Do not record prose observations.

| Scenario                              | Required result                                                                                                                                                                                                                                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generic photo Status                  | The isolated controller reads the current foreground photo's page-owned `blob:` or same-origin source, transfers it over the frame-0 port, and the browser accepts one direct download.                                                                                                                   |
| Generic video Status                  | The isolated controller reads the active video player's page-owned `blob:` or same-origin source, not its poster, transfers it over the frame-0 port, and the browser accepts one direct download.                                                                                                        |
| Edit hero: photo and video            | Capture each generic card. The edit surface shows `Visible Status captured` and renders the photo as an image and the MP4 as a video in the single hero item; neither may fall back to a missing or poster-only preview.                                                                                  |
| Shown scrub frame equals saved frame  | Capture the generic MP4, enable `Frame`, and scrub to a non-zero timestamp. The shown preview seeks to that timestamp, and the accepted JPEG shows the same frame. Discard it immediately and retain no artifact.                                                                                         |
| Muted export has no audible track     | Capture the generic MP4, enable `Remove audio`, and accept the download. Inspect the muted MP4's tracks: it has a video track and no audio track. Discard it immediately and record only pass/fail.                                                                                                       |
| Mid-edit expiry and re-capture        | Leave a captured generic card in the edit surface until the flat 10-minute lease expires. Verify `Editing session expired` and `Your editing session expired after 10 minutes - capture the Visible Status again to continue.`, then use `Capture Visible Status again` and confirm the new hero renders. |
| Advancement race                      | Advance or close the viewer while capture is acquiring. The result is either the originally guarded item or `WHATSAPP_STATUS_CHANGED`; it is never the next Status.                                                                                                                                       |
| Cleanup after accepted download       | The captured bytes and extension-created blob URL are released, and no persistent media, workspace handoff, or service-worker ownership is used.                                                                                                                                                          |
| Cleanup after cancellation or failure | Close the popup, tab, or viewer during capture. Bytes are discarded and any extension-created blob URL is revoked.                                                                                                                                                                                        |

For every pass, verify the four structural cleanup booleans listed in the evidence schema. For every
fail, stop that browser's run. Do not diagnose by collecting any prohibited artifact.

## Durable evidence: exact schema

The sole durable live-run record is `docs/whatsapp-live-verification-evidence.md`. It may contain
only an array of objects conforming exactly to this shape. Omit `failureCode` when there was no
symbolic extension failure.

```ts
type LiveVerificationEvidence = {
  browser: 'chromium' | 'firefox';
  browserMajorVersion: number;
  extensionVersion: string;
  buildRevision: string;
  scenario:
    | 'photo-status'
    | 'video-status'
    | 'edit-hero'
    | 'frame-export'
    | 'silent-export'
    | 'lease-expiry-recapture'
    | 'advancement-race'
    | 'accepted-download-cleanup'
    | 'cancel-or-failure-cleanup';
  result: 'pass' | 'fail';
  failureCode?:
    | 'WHATSAPP_PAGE_ACCESS_FAILED'
    | 'WHATSAPP_STATUS_NOT_VISIBLE'
    | 'WHATSAPP_STATUS_UNSUPPORTED'
    | 'WHATSAPP_STATUS_NOT_READY'
    | 'WHATSAPP_STATUS_CHANGED'
    | 'WHATSAPP_FORMAT_CHANGED'
    | 'WHATSAPP_ACQUISITION_FAILED'
    | 'BROWSER_DOWNLOAD_BLOCKED'
    | 'BROWSER_DOWNLOAD_NETWORK_FAILED'
    | 'BROWSER_DOWNLOAD_FILE_FAILED'
    | 'DOWNLOAD_UNEXPECTED_FAILURE'
    | 'SILENT_MEMORY_CAPACITY_EXCEEDED'
    | 'SILENT_SOURCE_NO_VIDEO'
    | 'SILENT_SOURCE_CONVERSION_UNSUPPORTED'
    | 'SILENT_REENCODE_FAILED';
  cleanup: {
    bytesDiscarded: boolean;
    blobUrlCreated: boolean;
    blobUrlRevoked: boolean;
    retentionCeilingArmed: boolean;
  };
};
```

The evidence file permits no comments or additional fields for completed rows. Build metadata is
limited to the four named scalar fields. A row may not contain account, contact, Status, filename,
URL, identifier, timestamp, user-agent, or free text.

## Prohibitions

Never retain, commit, paste, upload, or otherwise preserve personal media, contact data, URLs, keys,
payloads, screenshots, DOM dumps, HAR, network output, console output, traces, storage exports,
hashes, downloaded files, file names, account identifiers, Status identifiers, or free-form notes.
Do not retain a recording, screenshot, copied diagnostic report, browser profile, or test card.

## Support disqualifiers

WhatsApp support remains **unproven and must not be claimed** if either browser requires any of the
following: MAIN-world access; a WhatsApp host permission; persistent storage; workspace handoff;
service-worker lifetime; an unbounded transfer; broader evidence collection than this document
allows; or any weakening of the adopted extraction, guard, acknowledgement, size, timeout, or
retention contract.

A missing, incomplete, failed, or prohibited evidence record is not a pass. It is an explicit blocker
until a human completes a compliant run on both browsers.
