# Operation error model

GramGrab models user operations with schema-validated failures. Low-level producers keep precise causes, while `apps/extension/src/errors/presentation.ts` is the single executable source for user copy, recovery actions, retry rules, and silent-input retention.

`OperationFailure` contains a stable `code`, a `phase`, an item or batch `scope`, and an optional diagnostic cause. Causes are never ordinary UI copy. `OperationWarning` and skip codes use separate closed vocabularies.

## Identity and outcomes

An operation ID identifies one logical selected item. It stays stable through retries and original-download fallbacks. Every transport execution receives a fresh request ID. Silent temporary artifacts are owned by operation ID, so stale responses cannot take ownership of another attempt.

Outcomes are `pending`, `started`, `failed`, `skipped`, or `not-attempted`. `started` means the browser accepted the download request. Completion and later interruption remain the browser download UI's responsibility.

## Failure registry

The table is the compatibility contract. "Cause" means the technical cause may be included in an explicitly previewed diagnostic report, never ordinary UI copy.

| Code                                   | Scope | Manual retry                            | Actions                                 | Diagnostic          | Classification           |
| -------------------------------------- | ----- | --------------------------------------- | --------------------------------------- | ------------------- | ------------------------ |
| `INPUT_INVALID_INSTAGRAM_URL`          | batch | never                                   | none                                    | cause               | input                    |
| `SOURCE_USERNAME_UNRESOLVED`           | batch | never                                   | `open-in-instagram`                     | cause               | upstream                 |
| `SOURCE_MEDIA_NOT_FOUND`               | batch | never                                   | `open-in-instagram`                     | cause               | upstream                 |
| `IG_NOT_AUTHENTICATED`                 | batch | after user action                       | `open-in-instagram`, `refetch-source`   | cause               | upstream                 |
| `IG_ACCESS_FORBIDDEN`                  | batch | after user action                       | `open-in-instagram`, `refetch-source`   | cause               | upstream                 |
| `IG_RATE_LIMITED`                      | batch | after user action                       | `refetch-source`                        | cause               | upstream                 |
| `IG_RESPONSE_SHAPE_UNKNOWN`            | batch | never                                   | `copy-diagnostics`                      | cause, copy offered | upstream format          |
| `IG_REQUEST_REJECTED`                  | batch | never                                   | `open-in-instagram`, `copy-diagnostics` | cause, copy offered | upstream protocol        |
| `SOURCE_NETWORK_FAILED`                | batch | once automatically, then manual refetch | `refetch-source`                        | cause               | network                  |
| `SOURCE_SERVER_FAILED`                 | batch | once automatically, then manual refetch | `refetch-source`                        | cause               | upstream server          |
| `SOURCE_UNEXPECTED_FAILURE`            | batch | once automatically                      | `refetch-source`, `copy-diagnostics`    | cause, copy offered | extension boundary       |
| `MEDIA_URL_EXPIRED`                    | item  | after refetch                           | `refetch-source`                        | cause               | upstream signed URL      |
| `MEDIA_NOT_FOUND`                      | item  | after refetch                           | `refetch-source`, `open-in-instagram`   | cause               | upstream media           |
| `MEDIA_NETWORK_FAILED`                 | item  | once per operation                      | `retry-operation`, `refetch-source`     | cause               | network                  |
| `MEDIA_RESPONSE_EMPTY`                 | item  | once per operation                      | `retry-operation`, `refetch-source`     | cause               | network protocol         |
| `BROWSER_DOWNLOAD_BLOCKED`             | item  | after user action                       | `retry-operation`                       | cause               | browser                  |
| `BROWSER_DOWNLOAD_NETWORK_FAILED`      | item  | once per operation                      | `retry-operation`, `refetch-source`     | cause               | browser network          |
| `BROWSER_DOWNLOAD_FILE_FAILED`         | item  | after user action                       | `retry-operation`                       | cause               | browser storage          |
| `DOWNLOAD_UNEXPECTED_FAILURE`          | item  | once per operation                      | `retry-operation`, `copy-diagnostics`   | cause, copy offered | extension boundary       |
| `FRAME_METADATA_UNAVAILABLE`           | item  | once per operation                      | `retry-operation`, `download-original`  | cause               | media capability         |
| `FRAME_TIMEOUT`                        | item  | once per operation after internal retry | `retry-operation`, `download-original`  | cause               | media runtime            |
| `FRAME_NO_DECODABLE_FRAME`             | item  | never                                   | `download-original`                     | cause               | media capability         |
| `FRAME_CANVAS_UNAVAILABLE`             | item  | never                                   | `download-original`, `copy-diagnostics` | cause, copy offered | browser capability       |
| `FRAME_IMAGE_ENCODING_FAILED`          | item  | never                                   | `download-original`, `copy-diagnostics` | cause, copy offered | browser capability       |
| `FRAME_UNEXPECTED_FAILURE`             | item  | never                                   | `download-original`, `copy-diagnostics` | cause, copy offered | extension boundary       |
| `SILENT_STORAGE_UNAVAILABLE`           | batch | never                                   | `reload-workspace`, `download-original` | cause               | browser capability       |
| `SILENT_STORAGE_CAPACITY_EXCEEDED`     | item  | after user action                       | `retry-operation`, `download-original`  | cause               | browser storage          |
| `SILENT_STORAGE_READ_FAILED`           | item  | never                                   | `refetch-source`, `download-original`   | cause               | browser storage          |
| `SILENT_STORAGE_WRITE_FAILED`          | item  | once per operation                      | `retry-operation`, `download-original`  | cause               | browser storage          |
| `SILENT_SOURCE_NO_VIDEO`               | item  | never                                   | `download-original`, `copy-diagnostics` | cause, copy offered | upstream media           |
| `SILENT_INPUT_INSPECTION_FAILED`       | item  | never                                   | `download-original`, `copy-diagnostics` | cause, copy offered | media capability         |
| `SILENT_COPY_FAILED`                   | item  | never with copy strategy                | `try-reencode`, `download-original`     | cause               | media processing         |
| `SILENT_H264_ENCODER_UNAVAILABLE`      | item  | never                                   | `download-original`                     | cause               | browser capability       |
| `SILENT_SOURCE_CONVERSION_UNSUPPORTED` | item  | never                                   | `download-original`, `copy-diagnostics` | cause, copy offered | media capability         |
| `SILENT_REENCODE_FAILED`               | item  | never                                   | `download-original`, `copy-diagnostics` | cause, copy offered | media processing         |
| `SILENT_UNEXPECTED_FAILURE`            | item  | never                                   | `download-original`, `copy-diagnostics` | cause, copy offered | extension boundary       |
| `SILENT_OUTPUT_NO_VIDEO`               | item  | never                                   | `download-original`, `copy-diagnostics` | cause, copy offered | extension validation     |
| `SILENT_OUTPUT_HAS_AUDIO`              | item  | never                                   | `download-original`, `copy-diagnostics` | cause, copy offered | extension validation     |
| `SILENT_WORKER_UNAVAILABLE`            | item  | once per operation with fresh worker    | `retry-operation`, `download-original`  | cause               | browser worker lifecycle |
| `SILENT_WORKER_PROTOCOL_FAILURE`       | item  | never                                   | `download-original`, `copy-diagnostics` | cause, copy offered | extension protocol       |

Warnings are `HISTORY_SAVE_FAILED` and `SILENT_TEMPORARY_FILE_CLEANUP_UNCONFIRMED`. The skip code is `SILENT_REENCODE_DECLINED`.

## Diagnostics

Diagnostics use `diagnosticsVersion: 1` and are built per attempt. A preview must be shown before copying. The preview warns that JSON can include the Instagram source, temporary media URL, filename, media metadata, operation and request IDs, technical messages, and stacks.

Diagnostics never include cookies, request headers, browser storage contents, or unrelated session state. They are not uploaded, archived, or collected as telemetry.

## Adding a code

Every code requires a producer, schema literal, normalization rule, exhaustive presentation and recovery entry, diagnostic policy, documentation entry, and focused test. Do not select policy by matching arbitrary exception messages. String normalization is allowed only in adapters for browser APIs that expose string-only failures.
