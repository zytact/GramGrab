# Operation error model

GramGrab models user operations with schema-validated failures. Low-level producers keep precise causes, while `apps/extension/src/errors/presentation.ts` is the single executable source for user copy, recovery actions, retry rules, and silent-input retention.

`OperationFailure` contains a stable `code`, a `phase`, an item or batch `scope`, and an optional diagnostic cause. Causes are never ordinary UI copy. `OperationWarning` and skip codes use separate closed vocabularies.

## Identity and outcomes

An operation ID identifies one logical selected item. It stays stable through retries and original-download fallbacks. Every transport execution receives a fresh request ID. Silent temporary artifacts are owned by operation ID, so stale responses cannot take ownership of another attempt.

Outcomes are `pending`, `started`, `failed`, `skipped`, or `not-attempted`. `started` means the browser accepted the download request. Completion and later interruption remain the browser download UI's responsibility.

## Failure registry

The table is the compatibility contract. "Cause" means the producer retains a technical cause for
internal normalization. A copied report exposes only the structured failure code, phase, and scope;
causes are never ordinary UI copy or serialized report data.

| Code                                   | Scope | Manual retry                            | Actions                                                                  | Diagnostic                             | Classification           |
| -------------------------------------- | ----- | --------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------- | ------------------------ |
| `INPUT_INVALID_SOURCE_URL`             | batch | never                                   | none                                                                     | cause                                  | input                    |
| `SOURCE_USERNAME_UNRESOLVED`           | batch | never                                   | `open-in-instagram`                                                      | cause                                  | upstream                 |
| `SOURCE_MEDIA_NOT_FOUND`               | batch | never                                   | `open-in-instagram`                                                      | cause                                  | upstream                 |
| `IG_NOT_AUTHENTICATED`                 | batch | after user action                       | `open-in-instagram`, `refetch-source`                                    | cause                                  | upstream                 |
| `IG_ACCESS_FORBIDDEN`                  | batch | after user action                       | `open-in-instagram`, `refetch-source`                                    | cause                                  | upstream                 |
| `IG_RATE_LIMITED`                      | batch | after user action                       | `refetch-source`                                                         | cause                                  | upstream                 |
| `IG_RESPONSE_SHAPE_UNKNOWN`            | batch | never                                   | `copy-diagnostics`                                                       | cause, copy offered                    | upstream format          |
| `IG_REQUEST_REJECTED`                  | batch | never                                   | `open-in-instagram`, `copy-diagnostics`                                  | cause, copy offered                    | upstream protocol        |
| `SOURCE_NETWORK_FAILED`                | batch | once automatically, then manual refetch | `refetch-source`                                                         | cause                                  | network                  |
| `SOURCE_SERVER_FAILED`                 | batch | once automatically, then manual refetch | `refetch-source`                                                         | cause                                  | upstream server          |
| `SOURCE_UNEXPECTED_FAILURE`            | batch | once automatically                      | `refetch-source`, `copy-diagnostics`                                     | cause, copy offered                    | extension boundary       |
| `MEDIA_URL_EXPIRED`                    | item  | after refetch                           | `refetch-source`                                                         | cause                                  | upstream signed URL      |
| `MEDIA_NOT_FOUND`                      | item  | after refetch                           | `refetch-source`, `open-in-instagram`                                    | cause                                  | upstream media           |
| `MEDIA_DASH_ONLY_UNSUPPORTED`          | item  | never                                   | `copy-diagnostics`                                                       | cause, copy offered                    | media capability         |
| `INSTANT_NOT_ACTIVE`                   | item  | after refetch                           | `refetch-source`                                                         | cause                                  | upstream media           |
| `MEDIA_NETWORK_FAILED`                 | item  | once per operation                      | `retry-operation`, `refetch-source`                                      | cause                                  | network                  |
| `MEDIA_RESPONSE_EMPTY`                 | item  | once per operation                      | `retry-operation`, `refetch-source`                                      | cause                                  | network protocol         |
| `MEDIA_UNEXPECTED_FAILURE`             | item  | once per operation                      | `retry-operation`, `refetch-source`, `copy-diagnostics`                  | cause, copy offered                    | extension boundary       |
| `BROWSER_DOWNLOAD_BLOCKED`             | item  | after user action                       | `retry-operation`                                                        | cause                                  | browser                  |
| `BROWSER_DOWNLOAD_NETWORK_FAILED`      | item  | once per operation                      | `retry-operation`, `refetch-source`                                      | cause                                  | browser network          |
| `BROWSER_DOWNLOAD_FILE_FAILED`         | item  | after user action                       | `retry-operation`                                                        | cause                                  | browser storage          |
| `DOWNLOAD_UNEXPECTED_FAILURE`          | item  | once per operation                      | `retry-operation`, `copy-diagnostics`                                    | cause, copy offered                    | extension boundary       |
| `FRAME_METADATA_UNAVAILABLE`           | item  | once per operation                      | `retry-operation`, `download-original`                                   | cause                                  | media capability         |
| `FRAME_TIMEOUT`                        | item  | once per operation after internal retry | `retry-operation`, `download-original`                                   | cause                                  | media runtime            |
| `FRAME_NO_DECODABLE_FRAME`             | item  | never                                   | `download-original`                                                      | cause                                  | media capability         |
| `FRAME_CANVAS_UNAVAILABLE`             | item  | never                                   | `download-original`, `copy-diagnostics`                                  | cause, copy offered                    | browser capability       |
| `FRAME_IMAGE_ENCODING_FAILED`          | item  | never                                   | `download-original`, `copy-diagnostics`                                  | cause, copy offered                    | browser capability       |
| `FRAME_UNEXPECTED_FAILURE`             | item  | never                                   | `download-original`, `copy-diagnostics`                                  | cause, copy offered                    | extension boundary       |
| `SILENT_STORAGE_UNAVAILABLE`           | batch | never                                   | `reload-workspace`, `download-original`                                  | cause                                  | browser capability       |
| `SILENT_STORAGE_CAPACITY_EXCEEDED`     | item  | after user action                       | `retry-operation`, `download-original`                                   | cause                                  | browser storage          |
| `SILENT_MEMORY_CAPACITY_EXCEEDED`      | item  | never                                   | `download-original`                                                      | none                                   | in-memory media bound    |
| `SILENT_STORAGE_READ_FAILED`           | item  | never                                   | `refetch-source`, `download-original`                                    | cause                                  | browser storage          |
| `SILENT_STORAGE_WRITE_FAILED`          | item  | once per operation                      | `retry-operation`, `download-original`                                   | cause                                  | browser storage          |
| `SILENT_SOURCE_NO_VIDEO`               | item  | never                                   | `download-original`, `copy-diagnostics`                                  | cause, copy offered                    | upstream media           |
| `SILENT_INPUT_INSPECTION_FAILED`       | item  | never                                   | `download-original`, `copy-diagnostics`                                  | cause, copy offered                    | media capability         |
| `SILENT_COPY_FAILED`                   | item  | never with copy strategy                | `try-reencode`, `download-original`                                      | cause                                  | media processing         |
| `SILENT_H264_ENCODER_UNAVAILABLE`      | item  | never                                   | `download-original`                                                      | cause                                  | browser capability       |
| `SILENT_SOURCE_CONVERSION_UNSUPPORTED` | item  | never                                   | `download-original`, `copy-diagnostics`                                  | cause, copy offered                    | media capability         |
| `SILENT_REENCODE_FAILED`               | item  | never                                   | `download-original`, `copy-diagnostics`                                  | cause, copy offered                    | media processing         |
| `SILENT_UNEXPECTED_FAILURE`            | item  | never                                   | `download-original`, `copy-diagnostics`                                  | cause, copy offered                    | extension boundary       |
| `SILENT_OUTPUT_NO_VIDEO`               | item  | never                                   | `download-original`, `copy-diagnostics`                                  | cause, copy offered                    | extension validation     |
| `SILENT_OUTPUT_HAS_AUDIO`              | item  | never                                   | `download-original`, `copy-diagnostics`                                  | cause, copy offered                    | extension validation     |
| `SILENT_WORKER_UNAVAILABLE`            | item  | once per operation with fresh worker    | `retry-operation`, `download-original`                                   | cause                                  | browser worker lifecycle |
| `SILENT_WORKER_PROTOCOL_FAILURE`       | item  | never                                   | `download-original`, `copy-diagnostics`                                  | cause, copy offered                    | extension protocol       |
| `HISTORY_VERSION_UNSUPPORTED`          | batch | never                                   | none                                                                     | none                                   | history store version    |
| `HISTORY_ENTRY_NOT_FOUND`              | item  | never                                   | none                                                                     | none                                   | history store            |
| `HISTORY_ITEM_UNRESOLVED`              | item  | never                                   | `open-in-instagram`                                                      | none                                   | history reconciliation   |
| `HISTORY_STORE_FAILED`                 | batch | after user action                       | `retry-operation`                                                        | none                                   | history store            |
| `WHATSAPP_PAGE_ACCESS_FAILED`          | item  | after user action                       | `retry-operation`, `copy-diagnostics`                                    | structural                             | page access              |
| `WHATSAPP_STATUS_NOT_VISIBLE`          | item  | after user action                       | `retry-operation`                                                        | none                                   | acquisition              |
| `WHATSAPP_STATUS_UNSUPPORTED`          | item  | after user action                       | `retry-operation`                                                        | none                                   | acquisition              |
| `WHATSAPP_STATUS_NOT_READY`            | item  | after user action                       | `retry-operation`                                                        | none                                   | acquisition              |
| `WHATSAPP_STATUS_CHANGED`              | item  | after user action                       | `retry-operation`                                                        | none                                   | acquisition              |
| `WHATSAPP_FORMAT_CHANGED`              | item  | never                                   | `copy-diagnostics`                                                       | structural, copy offered               | acquisition format       |
| `WHATSAPP_ACQUISITION_FAILED`          | item  | once manually; after edit lease expiry  | normal: `retry-operation`, `copy-diagnostics`; expiry: `retry-operation` | structural; copy offered except expiry | extension boundary       |

Warnings are `HISTORY_SAVE_FAILED` and `SILENT_TEMPORARY_FILE_CLEANUP_UNCONFIRMED`. The skip code is `SILENT_REENCODE_DECLINED`.

A saved file whose history entry could not be written is `HISTORY_SAVE_FAILED`, a warning, not a
failure: the export succeeded. The `HISTORY_*` failure codes cover the opposite case, where the
download-history store itself cannot answer. The store is shared by every platform and holds names a
WhatsApp receipt must never expose, so `HISTORY_*` failures carry no diagnostic cause at all and
`phase` is `history`.

`MEDIA_UNEXPECTED_FAILURE` is the media-transfer sibling of the other `*_UNEXPECTED_FAILURE` codes.
It covers a direct read of an already-resolved media URL that failed for a reason HTTP status does
not classify, including a message this build could not read.

`retention-expired` remains a producer reason rather than a new failure code. It normalizes to
`WHATSAPP_ACQUISITION_FAILED` with structural invariant `retention-expired`, and uses the
edit-aware presentation: "Your editing session expired after 10 minutes - capture the Visible Status
again to continue." Its recovery action is `retry-operation`, which is the re-capture affordance.

The WhatsApp in-memory silent-video path reuses the applicable `SILENT_*` processing codes and the
`silent-inspection` / `silent-reencode` phases. WhatsApp failures retain structural diagnostics only;
they never serialize mediabunny exceptions or arbitrary error text. Peak input-plus-output refusal
uses `SILENT_MEMORY_CAPACITY_EXCEEDED`, not a browser-storage or browser-download code.
Because WhatsApp capture bytes are released on terminal-operation failure, its `SILENT_*`
presentations offer re-capture rather than the Instagram path's cached-original recovery.

## Diagnostics

Diagnostics use `diagnosticsVersion: 2` and are built per attempt from a closed allowlist. A preview
must be shown before copying. Instagram reports retain the extension version, capture time, normalized
browser and platform descriptors, attempt and retry counts, media kinds, outcomes, structural media
URL descriptors, and structured failure or warning codes. WhatsApp reports are a separate discriminated
`platform: "whatsapp"` branch with epoch capture time, a validated extension version, normalized
browser descriptor, failure code and phase, and closed structural evidence only. They cannot represent
URLs, contact identifiers, filenames, operation/request IDs, or free-form causes. URL descriptors
contain only a normalized hostname, path shape, extension, sorted query-parameter names, recognized
signature-parameter presence, and parsed expiry state. Reports never contain source URLs, signed media
URLs, filenames, operation or request IDs, arbitrary causes, or full user-agent strings. Parsing failures
produce a parse-status descriptor and never fall back to the input value.

Diagnostics never include cookies, request headers, browser storage contents, or unrelated session
state. They are not uploaded, archived, or collected as telemetry.

## Adding a code

Every code requires a producer, schema literal, normalization rule, exhaustive presentation and recovery entry, diagnostic policy, documentation entry, and focused test. Do not select policy by matching arbitrary exception messages. String normalization is allowed only in adapters for browser APIs that expose string-only failures.
