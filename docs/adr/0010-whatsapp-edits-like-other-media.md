# A captured WhatsApp Status edits like any other media

[ADR 0004](./0004-whatsapp-edit-session-retention.md) gave the WhatsApp edit session a flat 10-minute lease, kept captured bytes in memory only, and capped editing at one 64MB blob. Those rules made WhatsApp the one surface where Crop and Rotate could not be carried over (#425), because the shared export paths re-encode video through OPFS and take longer than a fixed lease allows for a long clip. The rules protected bytes the person had already chosen to capture and download, so they cost more than they bought.

This supersedes ADR 0004 and the media-handling and retention sections of `docs/whatsapp-privacy.md` as they applied to editing. It also replaces the human-only, no-artifact procedure in `docs/whatsapp-live-verification.md`.

## Decisions

- **No edit lease.** Captured bytes stay with the popup until the download starts or completes, a capture fails, a new capture replaces them, or the popup closes. Nothing expires them on a timer and nothing is refused for lack of time. The `retention-expired` reason, its edit-aware copy, and the `retentionCeilingArmed` diagnostic field are gone.
- **Editing uses the shared export paths.** A captured Status gets the same Rotate, Crop, Frame and Remove audio as an Instagram item, through the same code. No WhatsApp-only rule keeps that code in memory or under a memory budget after capture. WhatsApp exports run in the popup, so today they write their output to memory, but a shared path is free to use OPFS the way Instagram's worker does.
- **Acquisition is unchanged.** The 64MB cap, chunk bounds and transfer, idle and absolute timers still bound the page transfer, because they protect the port protocol, not the edit.
- **Live verification is agent-run.** An agent drives the verify-gramgrab harness, opens the real popup on the WhatsApp tab with CDP `Extensions.triggerAction`, and captures a Status from the linked account's feed. It picks a Status that shows no one from the account owner's own life: reposted memes, public images, places, or celebrities, influencers and models in public content are fine. Screenshots and exported files stay under `.local/verify-evidence/`. Contact names never go into the repo, a commit, or a PR.

Every other rule in `docs/whatsapp-privacy.md` stands: `activeTab` page access, one click per capture, the view-receipt disclosure, name-free filenames, receipt-only History, structural-only diagnostics, popup-only surfaces, and the CLI boundary. #426 tracks whether those change.

## Consequences

- The edit hero can sit open as long as the popup does. Closing the popup still releases everything.
- A crop or a long re-encode can take as long as it needs.
- WhatsApp export failures still produce structural diagnostics only (ADR 0002). The WhatsApp export code maps a shared-path failure onto the WhatsApp branch instead of passing its cause along.
- The harness drives Chromium only, so Firefox parity is unproven until a harness drives Firefox. The human-run procedure covered both browsers but never produced a single evidence row.
