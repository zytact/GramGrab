# WhatsApp fixture policy

This directory is intentionally empty of capture data. WhatsApp Visible Status tests construct
synthetic DOM nodes and byte streams in code. No raw or sanitized WhatsApp Web DOM capture, media,
contact data, URL, key, payload, screenshot, HAR, trace, storage export, or hash may be committed
here or elsewhere in the repository.

A real WhatsApp Web compatibility observation belongs only in the redacted durable-evidence shape
in [`docs/whatsapp-live-verification-evidence.md`](../../../../../docs/whatsapp-live-verification-evidence.md).
That evidence contains the structural fields permitted by the live-verification procedure, never a
fixture or a capture-derived artifact.
