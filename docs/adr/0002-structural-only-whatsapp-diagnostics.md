# WhatsApp diagnostics are a distinct structural-only type

`docs/error-model.md` allows a diagnostic report to carry the source URL, temporary media URL, filename, and media metadata behind a preview-before-copy gate. For Instagram those fields describe a public post. For WhatsApp the same fields describe a private conversation and a decryptable media reference, and diagnostics exist to be pasted into public issue trackers. WhatsApp failures therefore build a separate diagnostic type that carries structural evidence only: the invariant that broke, node shape, browser and version, and redacted counts.

The type is distinct rather than a redaction pass over the general shape. A filter has to be updated every time someone adds a field, and the failure mode of forgetting is a leak; a type with nowhere to put a URL cannot carry one no matter what is added around it.

## Consequences

- WhatsApp failures lose the `filename` diagnostic field, which is intended - the filename is treated as person-identifying and never leaves the download.
- The registry entries for WhatsApp failure codes are governed by this shape. See `docs/whatsapp-privacy.md` for the full constraint set.
