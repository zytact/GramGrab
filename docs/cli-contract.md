# CLI capability contract

This document inventories the public GramGrab operations covered by protocol version 2. It is a
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
gramgrab instants inspect [--json]
gramgrab export SOURCE [--item NUMBER] [--mode direct] [--json]
gramgrab export SOURCE [--item NUMBER] --mode frame [--at SECONDS] [--json]
gramgrab export SOURCE [--item NUMBER] --mode silent --reencode forbid|allow|require [--json]
gramgrab export SOURCE --plan - [--json]
gramgrab instants export [--item NUMBER] [--mode direct] [--json]
gramgrab instants export [--item NUMBER] --mode frame [--at SECONDS] [--json]
gramgrab instants export [--item NUMBER] --mode silent --reencode forbid|allow|require [--json]
gramgrab history list [--json]
gramgrab history remove ENTRY_ID... [--json]
gramgrab history clear [--json]
gramgrab history redownload ENTRY_ID... [--json]
gramgrab debug get [--json]
gramgrab debug export [--json]
gramgrab watch list [--json]
gramgrab watch show WATCH [--json]
gramgrab watch add TARGET --kinds K[,K] --actions A[,A] --accept-unattended [--json]
gramgrab watch set WATCH [--kinds K[,K]] [--actions A[,A]] [--json]
gramgrab watch pause|resume|delete WATCH... [--json]
```

`SOURCE` may be a supported Instagram URL or a bare username. A bare username targets that
account's active Stories and must omit the leading `@`. For example, `gramgrab inspect instagram`
resolves `https://www.instagram.com/stories/instagram/`. To export a frame from the third Story,
run `gramgrab export instagram --item 3 --mode frame --at 5`. WhatsApp Status URLs are recognized
as browser-extension-only and are rejected before CLI transport.

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
A `--plan` operation may also carry `rotation` (`90`, `180`, or `270`, clockwise), which the
extension applies to that item's output. History redownload reproduces a recorded rotation.
The `instants` commands never accept a Source. They inspect the authenticated active feed afresh,
preserve its server order, and apply the same item numbering and export-mode rules.

Watches (Beta) are standing instructions the extension owns; the CLI only manages them. Kinds are
`posts`, `stories`, `instants`, and `avatar`, and actions are `notify`, `download`, and `collect`.
`TARGET` is a username or profile URL. `WATCH` is a username or numeric account ID: all digits mean
an account ID, and `--account-id` or `--username` forces one reading. Selectors match only the
verified Instagram login's Watches; another login's Watch is `WATCH_NOT_FOUND`, and an unverifiable
login rejects every Watch command with `IG_NOT_AUTHENTICATED` and only the stored Watch count. Only
`add` resolves its target over the network. `add` requires `--accept-unattended` on every call;
without it the rejection carries the full disclosure. An identical repeated `add` returns the
existing Watch with `created: false`, and a different configuration is `WATCH_CONFIG_CONFLICT`
naming the existing Watch. `set` replaces the kinds or actions it is given, and each newly selected
kind's first check only records a baseline. Lifecycle commands report unknown selectors in
`unknownWatches` and still apply to the others.

A Posts check pages newest first, 12 Posts per page, and reads at most three pages per turn. It
stops at the last page or at the first page that reaches media too old to be new: Instagram is
assumed to list Posts newest first, so every later page would be older still. A Post already seen
never stops it. A longer check reports `catchUp: true` and continues from its cursor after the
round's other Watches, within the eligibility window it started with. The cursor lives only in the
browser session, so a browser restart starts the traversal again from the newest page, and
discoveries already recorded are not repeated. Out-of-order Posts, a Post repeated between pages,
a repeated cursor, or a page that claims more without a cursor fail the check with
`WATCH_CHECK_INCOMPLETE` and keep the baseline and last success. Reordering that does not break
that order where GramGrab can see it, such as an item missing beyond the stopping page, is an
accepted limit, not a guarantee of a complete snapshot.

An Instants check reads the verified login's own active Instants feed, once per round and shared by
every Watch in it, and keeps the items whose owner is the Watch's account, in any order. Coverage is
that feed: an Instant that never appeared in it, or left it before a check, is not found, and
nothing promises 30 days of Instants. One malformed or unknown item in the feed fails the Instants
check of every Watch that read it.

Avatar and Posts checks first confirm the account's current username by its account ID and follow
a confirmed rename. An Avatar check then finds the account's exact record in Instagram search and
compares its opaque picture ID with the last one seen. A new ID is a change even when the picture
looks the same, and returning to an earlier picture counts again. A rotated picture URL is not a
change. A missing or ambiguous picture ID fails the check and keeps the last one. How Instagram
reports a removed or default picture, and whether other endpoints share this ID, has not been
observed, so those cases fail closed rather than count as changes.

JSON progress is newline-delimited on stderr. Numeric updates are coalesced to 0%, 25%, 50%, 75%,
and 100% milestones per item and phase. Phase changes are always emitted, and the terminal result
is emitted once on stdout. Exit 0 means full success, exit 1 means command rejection, at least one
unsuccessful item outcome, or an unknown Watch selector, and exit 2 means argument, validation, or
transport failure.

## Capability inventory

| Existing behavior                                                        | Protocol command or event                                 | Progress and edge behavior                                                                       |
| ------------------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Resolve Post, shortcode Reel, Sidecar, Story, Highlight, or Avatar media | `Inspect`                                                 | `resolving`; source and Instagram failures retain their registered codes                         |
| Inspect the authenticated active Instants feed                           | `InstantsInspect`                                         | `resolving`; no Source or seen-state mutation                                                    |
| Export active Instant photos and videos                                  | `InstantsExport.operations`                               | Fresh inspection supplies signed URLs and stable media identity                                  |
| Select one or more media items                                           | `Export.operations`                                       | Reject zero, negative, missing, or out-of-range human item numbers before execution              |
| Download an original image or video                                      | `DirectExport`                                            | `direct-download`; success means the browser accepted the download                               |
| Export a video frame                                                     | `FrameExport`                                             | `frame-metadata`, then `frame-export`; original download remains an explicit recovery action     |
| Remove audio by stream copy                                              | `SilentExport` with `forbid` or `allow`                   | `silent-inspection`, `silent-copy`, `silent-validation`; copy failure may offer re-encode        |
| Remove audio by re-encoding                                              | `SilentExport` with `allow` or `require`                  | `silent-reencode`; decline is a correlated `ItemSkipped` outcome                                 |
| Run mixed direct, frame, and silent work                                 | One `Export` with multiple operations                     | Each event carries the request ID and item progress carries operation ID plus human item number  |
| Retry or choose original/re-encode fallback                              | A new `Export` preserving operation ID and media identity | Every retry has a fresh request ID; recovery does not erase the prior outcome                    |
| List download history                                                    | `HistoryList`                                             | `history`; returns only the extension-owned durable history                                      |
| Remove selected history entries                                          | `HistoryRemove`                                           | Explicit entry IDs; partial or unknown IDs are reported, not silently broadened                  |
| Clear download history                                                   | `HistoryClear`                                            | Destructive action must be explicitly requested                                                  |
| Download from history                                                    | `HistoryRedownload`                                       | Uses extension resolution and download behavior, never CLI-side media fetching                   |
| Read supported diagnostics                                               | `DebugGet`                                                | `diagnostics`; structural-only version-2 report                                                  |
| Export a diagnostic report                                               | `DebugExport`                                             | Exports the structural-only version-2 report                                                     |
| List and inspect Watches                                                 | `WatchList`, `WatchShow`                                  | Verifies the signed-in login first; another login's Watches appear only as a count               |
| Add a Watch                                                              | `WatchAdd`                                                | Requires the per-call disclosure acknowledgement; duplicates return or point to the existing one |
| Change a Watch's kinds or actions                                        | `WatchSet`                                                | Replaces the supplied sets; initialized baselines are kept                                       |
| Pause, resume, or delete Watches                                         | `WatchLifecycle`                                          | Unknown selectors are reported per Watch; deletion keeps files and History                       |
| Popup layout, workspace layout, navigation, selection controls           | UI-only                                                   | No protocol operation because these present operations rather than define new behavior           |

## Event and failure semantics

Every request decodes through `Request` and produces versioned `Event` envelopes. Long-running work
emits `Accepted`, zero or more `Progress` events, then `Completed` or `Rejected`. A completed mixed
batch contains correlated success, failure, or skipped outcomes per item.

Transport failures, browser or extension availability failures, request validation failures, and
command failures are distinct tagged variants. Existing operation failures retain the stable codes
from `docs/error-model.md`. Diagnostic causes are intentionally not part of the public protocol
failure payload.
