# GramGrab feature map

One file per user-facing feature, written from the user's point of view: what it
is, how a person reaches it, how to drive it with `scripts/drive.mjs` or the
CLI, and what observable end state proves it works.

This map is the maintained source for what a verification run should cover. A
proof that drives one convenient entry point is incomplete when the map lists
others. Keep it honest as the app changes; `/maintain-verification-skill` is the
loop for that.

| Feature                                             | Surfaces                 | Needs an Instagram session |
| --------------------------------------------------- | ------------------------ | -------------------------- |
| [CLI bridge](./cli-bridge.md)                       | CLI, native host, worker | no                         |
| [Instagram acquisition](./instagram-acquisition.md) | popup, workspace, CLI    | yes                        |
| [Export modes](./export-modes.md)                   | popup, workspace, CLI    | yes, for real media        |
| [Download history](./download-history.md)           | popup, CLI               | no, to read; yes, to fill  |
| [WhatsApp Visible Status](./whatsapp-status.md)     | popup only               | no, needs WhatsApp Web     |

Two constraints shape every entry:

- The profile at `.local/verify-profile/` persists between runs, so the rows
  marked yes work once someone has run `scripts/signin.sh` and signed in by
  hand. A profile that has never been signed into fails those rows at
  authentication, which looks like a bug and is not one.
- WhatsApp acquisition has privacy rules that bind verification as much as code.
  `docs/whatsapp-privacy.md` and `docs/whatsapp-live-verification.md` are the
  contract. Do not improvise a WhatsApp run.
