# Refreshing Instagram protocol metadata

GramGrab keeps public Instagram request metadata in
[`apps/extension/src/instagram-protocol/config.json`](../apps/extension/src/instagram-protocol/config.json). The extension and the
generated fixture capture script both consume this file, so protocol values must not be copied into
their source files.

The configuration contains only:

- the default Instagram App ID and ASBD ID
- operation-specific public app-ID overrides and friendly names
- GraphQL `doc_id`, `client_doc_id`, and `query_hash` candidates
- GraphQL endpoints and transports
- the fallback order for each existing request family

It must never contain cookies, CSRF or LSD tokens, usernames, account IDs, media identifiers,
request bodies, GraphQL variables, or fixture responses.

## Operation names

The updater requires an explicit operation because it does not classify captured traffic:

| Operation          | Existing GramGrab request family                        |
| ------------------ | ------------------------------------------------------- |
| `mediaByShortcode` | Posts, Reels, and sidecars fetched from a shortcode     |
| `reelsMedia`       | Stories and Highlights fetched through reels media data |
| `instantsFeed`     | The authenticated active Instants feed                  |

These are configuration keys for existing code paths. They do not represent separate discovery
problems, and values such as `shortcode`, `reel_ids`, and `highlight_reel_ids` are runtime inputs,
not protocol metadata.

## Capture a relevant request

Use a browser profile that is already logged in to Instagram:

1. Open DevTools and select the Network panel.
2. Trigger the GramGrab request family that needs updating:
   - open a Post, Reel, or sidecar for `mediaByShortcode`
   - open a Story or Highlight for `reelsMedia`
   - open the active Instants feed for `instantsFeed`
3. Select the relevant Instagram GraphQL request.
4. Choose **Copy** > **Copy as fetch**.

One relevant copied request is enough for each operation being refreshed. If both request families
need updating, repeat the updater once for each operation. You do not need separate requests for
images, videos, sidecars, Stories, and Highlights.

The copied request contains session credentials. Do not save it to a file, paste it into an issue or
chat, or commit it. The updater reads it only from stdin and never evaluates the copied JavaScript.

## Update the configuration

For Posts, Reels, and sidecars, run:

```bash
vp run update:ig-protocol --operation mediaByShortcode
```

For Stories and Highlights, run:

```bash
vp run update:ig-protocol --operation reelsMedia
```

For active Instants, run:

```bash
vp run update:ig-protocol --operation instantsFeed
```

Paste the complete Copy-as-fetch request into the waiting terminal, then press Ctrl-D to end stdin.
The updater extracts only the allowed public metadata, validates the resulting configuration through
Effect Schema, and atomically rewrites `apps/extension/src/instagram-protocol/config.json`.

The observed candidate becomes the first candidate for the selected operation. Existing candidates
remain behind it as ordered fallbacks. Running the updater for one operation does not replace the
other operation.

## Review and validate

Inspect the complete configuration change:

```bash
git diff HEAD -- apps/extension/src/instagram-protocol/config.json
```

Confirm that the diff contains only the allowed fields listed above. Then run the repository checks
in order:

```bash
vp check
vp test run
vp run fallow
```

The configuration-driven fallback tests must pass with the newly observed candidate order. Commit
the protocol JSON, updater, consumers, and tests together.

## Refresh fixtures when the response shape also changed

Protocol metadata and response fixtures solve different failures. Updating a request identifier may
restore the request without requiring new fixtures. If Instagram also changed the returned JSON
shape:

1. Configure private capture subjects in the repository-root `.env`.
2. Run `vp run generate:ig-fixtures`.
3. Paste `.local/capture-ig-fixtures.mjs` into DevTools on `https://www.instagram.com`.
4. Sanitize the downloaded responses before replacing files in
   `apps/extension/src/effect/__fixtures__/`.
5. Update the Effect response schemas and rerun the validation commands.

The generated fixture script embeds the same decoded protocol configuration, so it automatically
uses the newly captured candidate order.

## Troubleshooting

- **The command prints usage and exits:** use `vp run update:ig-protocol --operation <operation>`.
- **No `doc_id`, `client_doc_id`, or `query_hash`:** the copied request is not a supported GraphQL operation. Capture
  the request that returns the media data for the selected request family.
- **The wrong operation was selected:** restore the JSON from Git, then rerun the updater with the
  correct explicit operation. The updater deliberately does not guess.
- **The configuration fails to load:** do not bypass the Effect Schema decoder. Correct the JSON or
  capture a compatible request.
