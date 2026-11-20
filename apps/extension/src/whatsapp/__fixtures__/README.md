# WhatsApp fixture policy

This directory is intentionally empty of capture data. WhatsApp Visible Status tests construct
synthetic DOM nodes and byte streams in code. No raw or sanitized WhatsApp Web DOM capture, media,
contact data, URL, key, payload, screenshot, HAR, trace, storage export, or hash may be committed
here or elsewhere in the repository.

Live WhatsApp Web runs follow [`docs/whatsapp-live-verification.md`](../../../../../docs/whatsapp-live-verification.md)
and keep their artifacts under the git-ignored `.local/verify-evidence/`, never in a fixture.
