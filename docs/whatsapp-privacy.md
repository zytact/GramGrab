# WhatsApp acquisition privacy and security constraints

These constraints govern acquisition of a WhatsApp **Visible Status**. They are binding on every ticket and change that touches the WhatsApp path. Where a constraint can be made unrepresentable in the type system it must be, and runtime tests cover only the edges types cannot reach.

The structural decisions behind two of these live in [ADR 0001](./adr/0001-activetab-for-whatsapp-page-access.md) and [ADR 0002](./adr/0002-structural-only-whatsapp-diagnostics.md).

## Page access

GramGrab reaches `https://web.whatsapp.com/` through `activeTab` and `scripting`. It declares no WhatsApp `host_permissions`, persistent or optional. Access exists only for the tab a person invoked GramGrab on, and only from that invocation.

## User intent

One click, one capture. There is no session-armed mode that stays live while a person moves through Statuses, and no second per-capture confirmation - the invocation is the intent. Acquisition never begins from a timer, an observer, or any signal other than a direct invocation on the tab being viewed.

## View receipts

View receipts are controlled by WhatsApp. GramGrab causes no additional receipt and must never claim, imply, or advertise anonymous viewing. A one-time disclosure appears in the popup on the first WhatsApp-eligible tab and gates the first capture. It is not repeated per capture.

## Media handling

Captured bytes live in memory only. They are never written to `storage`, IndexedDB, OPFS, the filesystem, or any other GramGrab-controlled location. The only permitted destination is the download the person asked for.

Export modes that require persisting bytes are unavailable for WhatsApp media and are stated as an explicit limitation rather than left as a silent gap.

## Retention

Captured bytes and their blob URLs are revoked:

- on download completion,
- on every failure path,
- on popup close or tab close,
- unconditionally at a short ceiling of roughly 60 seconds,

whichever comes first. This bound is independent of capture invalidation caused by WhatsApp advancing, replacing, or closing the Status, which is a validity concern owned by the extraction contract. The two must not share a timer.

## Filenames

Filenames carry no contact display name. They use a name-free descriptor and a timestamp. A filename is the most-copied and least-controlled text GramGrab emits; once it reaches a backup index it is not recoverable.

## History

A WhatsApp history record contains exactly: source, media kind, timestamp, saved filename, and outcome. It contains no contact display name, WhatsApp-internal identifier, media key, signed URL, `captureId`, or thumbnail.

WhatsApp history entries expose no re-download affordance. The record is a receipt, not a handle.

## Diagnostics

WhatsApp failures produce a distinct structural-only diagnostic type with no field capable of holding a URL, name, or identifier. See [ADR 0002](./adr/0002-structural-only-whatsapp-diagnostics.md).

## Surfaces

WhatsApp capture, disclosure, and history are popup-only and absent from the workspace. One predicate governs all three: WhatsApp appears only where it can be acted on. The workspace runs in its own tab and cannot hold `activeTab` access to WhatsApp, so surfacing WhatsApp there would offer an action that cannot exist.

## CLI boundary

WhatsApp acquisition is browser-extension-only. The CLI advertises this in help text rather than only failing when someone tries. A WhatsApp URL passed to the CLI produces a distinct "recognized, but not available on this surface" failure code. It must not reuse the invalid-URL code, which would tell a person their valid URL is malformed.

## Enforcement

- Prefer type-level enforcement: a diagnostic type with no URL-shaped field, a capture handle with no serialization path, a history record schema that rejects extra keys.
- Test the runtime edges types cannot reach: no WhatsApp bytes reach storage APIs, blob URLs are revoked on every failure path, the retention ceiling fires.
- Documentation and code review are not enforcement.
