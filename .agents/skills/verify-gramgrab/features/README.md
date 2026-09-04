# GramGrab feature map

One file per user-facing feature, written from the user's point of view: what it
is, how a person reaches it, how to drive it with `scripts/drive.mjs` or the
CLI, and what observable end state proves it works.

This map is the maintained source for what a verification run should cover. A
proof that drives one convenient entry point is incomplete when the map lists
others. Read [the full non-WhatsApp run](./non-whatsapp-run.md) when the request
is broad, names no narrower feature, or asks whether the whole app works. Keep
the map honest as the app changes; `/maintain-verification-skill` is the loop
for that.

| Feature                                             | Surfaces                 | Needs an Instagram session |
| --------------------------------------------------- | ------------------------ | -------------------------- |
| [CLI bridge](./cli-bridge.md)                       | CLI, native host, worker | no                         |
| [Instagram acquisition](./instagram-acquisition.md) | popup, workspace, CLI    | yes                        |
| [Workspace and context menus](./workspace.md)       | popup, workspace, browser menu | yes, to fetch         |
| [Export modes](./export-modes.md)                   | popup, workspace, CLI    | yes, for real media        |
| [Download history](./download-history.md)           | popup, CLI               | no, to read; yes, to fill  |
| [WhatsApp Visible Status](./whatsapp-status.md)     | popup only               | no, needs WhatsApp Web     |
| [Release artifacts](./release-artifacts.md)         | Chromium, Firefox, tools | no                         |

## Full-run coverage

The non-WhatsApp run covers every current user-facing branch through one of
three proof owners:

| Owner            | What it proves                                                                 |
| ---------------- | ------------------------------------------------------------------------------ |
| Live harness     | Chromium popup and workspace UI, real Instagram requests, downloads, history  |
| CLI harness      | Native bridge commands, source kinds, export modes, plans, and cancellation    |
| Build validation | Firefox output, packaged browser artifacts, packaged CLI and native host tools |

Active-tab detection and the actual toolbar popup require one short human
checkpoint because a CDP-opened tab becomes the active tab. Protocol timing,
history repair internals, and failure-policy exhaustiveness stay owned by their
focused tests. The full-run document names those checks and does not present a
different path as equivalent live proof.

Two constraints shape every entry:

- The profile at `.local/verify-profile/` persists between runs, so the rows
  marked yes work once someone has run `scripts/signin.sh` and signed in by
  hand. A profile that has never been signed into fails those rows at
  authentication, which looks like a bug and is not one.
- WhatsApp acquisition has privacy rules that bind verification as much as code.
  `docs/whatsapp-privacy.md` and `docs/whatsapp-live-verification.md` are the
  contract. Do not improvise a WhatsApp run.
