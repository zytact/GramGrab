# CLI capability contract

This document inventories the public GramGrab operations covered by protocol version 1. It is a
behavior contract, not a promise that the CLI transport is implemented before phase 3.

## Item identity

Human-facing item numbers are 1-based and are accepted only as `HumanItemNumber`. Internal item
indexes are 0-based and remain a separate `InternalItemIndex`. An operation receives a stable
operation ID. Once the extension resolves a source, it correlates the human number with a
`MediaIdentity` containing the internal item index and, when Instagram provides one, the media ID.
A retry preserves the operation ID and resolved media identity while each transport request gets a
fresh request ID.

## Grammar

```text
gramgrab status [--json]
gramgrab help
gramgrab inspect SOURCE [--json]
gramgrab export SOURCE [--item NUMBER] [--mode direct] [--json]
gramgrab export SOURCE [--item NUMBER] --mode frame [--at SECONDS] [--json]
gramgrab export SOURCE [--item NUMBER] --mode silent --reencode forbid|allow|require [--json]
gramgrab export SOURCE --plan - [--json]
gramgrab history list [--json]
gramgrab history remove ENTRY_ID... [--json]
gramgrab history clear [--json]
gramgrab history redownload ENTRY_ID... [--json]
gramgrab debug get [--json]
gramgrab debug export [--json]
```

`SOURCE` may be a supported Instagram URL or a bare username. A bare username targets that
account's active Stories and must omit the leading `@`. For example, `gramgrab inspect instagram`
resolves `https://www.instagram.com/stories/instagram/`. To export a frame from the third Story,
run `gramgrab export instagram --item 3 --mode frame --at 5`.

`status` is the phase 3 transport probe. It uses a five-second bounded wait and reports the
browser family, extension version, native-host version, protocol version, and compatibility. The
native host is browser-started and relays length-prefixed JSON frames over a per-user Unix socket
on Linux and macOS or a named pipe on Windows. `GRAMGRAB_IPC_PATH` overrides the endpoint for
development and tests.

Development native-host manifest templates live in `apps/native-host/manifests`. The complete
compatibility, registration, migration, and troubleshooting guide is in `docs/cli-setup.md`.
Automatic registration remains out of scope. A second browser profile receives an explicit
collision error and cannot remove the live profile's endpoint.

Repeated item operations and `--plan -` support mixed batches. JSON mode never prompts. History
removal and clearing must be explicit commands. Silent re-encoding uses the request policy and does
not prompt in JSON mode. When `--item` is omitted, the CLI performs a fresh inspection and applies
the selected mode to every resolved item. When `--mode` is omitted, direct export is used. Frame
export defaults to timestamp 5 seconds and clamps to the last valid second for shorter videos.

JSON progress is newline-delimited on stderr. Numeric updates are coalesced to 0%, 25%, 50%, 75%,
and 100% milestones per item and phase. Phase changes are always emitted, and the terminal result
is emitted once on stdout. Exit 0 means full success, exit 1 means command rejection or at least one
unsuccessful item outcome, and exit 2 means argument, validation, or transport failure.

## Capability inventory

| Existing behavior                                                        | Protocol command or event                                 | Progress and edge behavior                                                                      |
| ------------------------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Resolve Post, shortcode Reel, Sidecar, Story, Highlight, or Avatar media | `Inspect`                                                 | `resolving`; source and Instagram failures retain their registered codes                        |
| Select one or more media items                                           | `Export.operations`                                       | Reject zero, negative, missing, or out-of-range human item numbers before execution             |
| Download an original image or video                                      | `DirectExport`                                            | `direct-download`; success means the browser accepted the download                              |
| Export a video frame                                                     | `FrameExport`                                             | `frame-metadata`, then `frame-export`; original download remains an explicit recovery action    |
| Remove audio by stream copy                                              | `SilentExport` with `forbid` or `allow`                   | `silent-inspection`, `silent-copy`, `silent-validation`; copy failure may offer re-encode       |
| Remove audio by re-encoding                                              | `SilentExport` with `allow` or `require`                  | `silent-reencode`; decline is a correlated `ItemSkipped` outcome                                |
| Run mixed direct, frame, and silent work                                 | One `Export` with multiple operations                     | Each event carries the request ID and item progress carries operation ID plus human item number |
| Retry or choose original/re-encode fallback                              | A new `Export` preserving operation ID and media identity | Every retry has a fresh request ID; recovery does not erase the prior outcome                   |
| List download history                                                    | `HistoryList`                                             | `history`; returns only the extension-owned durable history                                     |
| Remove selected history entries                                          | `HistoryRemove`                                           | Explicit entry IDs; partial or unknown IDs are reported, not silently broadened                 |
| Clear download history                                                   | `HistoryClear`                                            | Destructive action must be explicitly requested                                                 |
| Download from history                                                    | `HistoryRedownload`                                       | Uses extension resolution and download behavior, never CLI-side media fetching                  |
| Read supported diagnostics                                               | `DebugGet`                                                | `diagnostics`; diagnostic causes stay out of ordinary UI copy                                   |
| Export a diagnostic report                                               | `DebugExport`                                             | Preserves the existing preview and redaction policy                                             |
| Popup layout, workspace layout, navigation, selection controls           | UI-only                                                   | No protocol operation because these present operations rather than define new behavior          |

## Event and failure semantics

Every request decodes through `Request` and produces versioned `Event` envelopes. Long-running work
emits `Accepted`, zero or more `Progress` events, then `Completed` or `Rejected`. A completed mixed
batch contains correlated success, failure, or skipped outcomes per item.

Transport failures, browser or extension availability failures, request validation failures, and
command failures are distinct tagged variants. Existing operation failures retain the stable codes
from `docs/error-model.md`. Diagnostic causes are intentionally not part of the public protocol
failure payload.
