# Provenance overlay prototype

This throwaway page compares three fixed Provenance overlay layouts across portrait, landscape,
square, small-image, video, and exported-frame shapes.

Run it with:

```bash
vp dev
```

Open `http://localhost:5173/provenance-overlay-prototype.html?variant=A&fields=3`.

- `variant=A` - Caption block
- `variant=B` - Lower third
- `variant=C` - Corner ledger
- `fields=2` - Username and UTC posted time
- `fields=3` - Username, UTC posted time, and location label

Use the floating arrows or the keyboard arrow keys to switch variants. The backing-opacity slider is
also stored in the URL so an exact candidate can be shared.

## Decision

Variant A, Caption block, is selected at its default 58% black backing opacity.

- Anchor the compact panel at the bottom-left with an inset based on media width.
- Keep the panel content-sized with a maximum width of 78% so long values wrap without clipping or
  ellipsis.
- Set the username as the bold primary line. Set UTC posted time and the optional location label as
  smaller secondary lines, with tabular numerals for time.
- Use white text and a white left rule over the translucent black panel.
- Scale inset, padding, rule width, and typography proportionally with output width while retaining
  minimum legibility on small outputs.
- Omit the location line when no label exists. The same hierarchy and placement serves both the
  two-field and three-field forms.
