# WhatsApp Visible Status boundary coverage audit

This audit implements issue #131. Deterministic synthetic tests are the authoritative proof for
extension-owned boundaries. The live procedure in
[`whatsapp-live-verification.md`](./whatsapp-live-verification.md) is limited to browser and current
WhatsApp Web facts that cannot be simulated.

| Extension-owned boundary                                            | Authoritative synthetic coverage                                                                                                                                                            | Audit result                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Guarded foreground extraction and post-acquisition revalidation     | `whatsapp/controller-runtime.test.ts`: foreground blob photo, video instead of poster, guarded source replacement during streamed reads                                                     | Covered. The advancement race rejects with `status-changed`; it never returns a replacement Status. |
| Page-owned `blob:` streaming                                        | `whatsapp/controller-runtime.test.ts`: controller fetches the selected `blob:` photo/video with same-origin credentials and emits metadata before bytes                                     | Covered.                                                                                            |
| Bounded, ordered base64 chunks with one acknowledgement outstanding | `whatsapp/contracts.test.ts` and `whatsapp/controller-runtime.test.ts`: canonical bounded decode, two chunks, second chunk only after `ChunkAck`                                            | Covered.                                                                                            |
| Closed envelope and descriptor schemas                              | `whatsapp/contracts.test.ts`: excess keys, tag/kind/MIME mismatch, forbidden photo duration, malformed and zero-length chunks                                                               | Expanded and covered at the schema boundary.                                                        |
| Cancellation                                                        | `whatsapp/capture.test.ts`: popup-close cancellation rejects the pending capture and sends closed `CaptureCancel`                                                                           | Gap fixed.                                                                                          |
| Independent retention cleanup                                       | `whatsapp/capture.test.ts`: retention ceiling cancels an in-progress browser download and revokes its URL; accepted-but-undownloaded snapshots are released at the same independent ceiling | Expanded and covered.                                                                               |
| Seven acquisition failure codes                                     | `errors/whatsapp.test.ts`: every controller reason maps to code, phase, retry policy, and recovery actions                                                                                  | Covered.                                                                                            |
| Receipt-only History writes                                         | `history/repository.test.ts`, `background.test.ts`, and `whatsapp/capture.test.ts`: exact five-field receipt, reject excess keys, warning without blocking accepted download                | Covered.                                                                                            |
| Structural-only diagnostics                                         | `errors/whatsapp.test.ts`: closed branch plus adversarial URL, ID, contact, filename, key, payload, hash, and free-form fields                                                              | Expanded and covered.                                                                               |
| Manifest policy                                                     | `manifest.test.ts` and `verify:whatsapp-packages`: only `activeTab` plus `scripting`, no WhatsApp host permission or content script, controller entry present in both built packages        | Expanded and covered.                                                                               |
| Repository fixture policy                                           | `whatsapp/fixture-policy.test.ts` and `whatsapp/__fixtures__/README.md`: no WhatsApp capture fixtures may be committed, only synthetic DOM/byte inputs are permitted                        | Gap fixed.                                                                                          |

## Audit conclusions

No extension-owned boundary is intentionally left without an authoritative synthetic test. The
remaining proof obligation is a human-run, non-personal live matrix. It is not replaceable by a
unit test because it concerns current WhatsApp Web DOM compatibility, browser isolated-world access
to a page-owned `blob:`, actual `activeTab` injection and frame-0 port behavior, and parity between
built Chromium and Firefox packages.

The audited advancement guarantee is strict: after the guarded item changes, a capture may return
the originally guarded item only if it completed while that guard still matched. Otherwise it fails
as `WHATSAPP_STATUS_CHANGED`. It must never return a later Visible Status.
