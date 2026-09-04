# Instagram fixture sanitizer

This sanitizer is the privacy boundary between local Instagram captures and committed Schema
fixtures. It keeps response structure realistic while replacing values that identify, describe, or
locate people and media. It fails closed: every observed path and primitive type must be present in
the reviewed policy before any output directory is changed.

## Architecture

- `policy.ts` defines the twelve-file contract and the declarative allowlist and denylist. Reusable
  fragments cover repeated person, media resource, Story item, Reel, and Post shapes.
- `entities.ts` discovers synthetic entities, correlates strong identifiers, and assigns stable
  numbers for one complete batch.
- `sanitize.ts` validates paths, builds the entity graph, transforms leaves, handles embedded
  address JSON, and checks structural postconditions.
- `workflow.ts` owns the Effect boundary: JSON parsing, typed failures, endpoint Schema decoding,
  staging, and directory transactions.
- `../sanitize-ig-fixtures.ts` is the thin command-line entry point. It selects fixed repository
  paths, accepts only `--write`, and renders value-free diagnostics.

The pure core never reads files or environment variables. Filesystem behavior is an Effect service
provided at the command-line edge, so transaction failures can be tested without weakening the
production workflow.

## Dual policy and unknown fields

Each rule pairs a normalized JSON path with its expected primitive type and one action:

- `preserve` copies approved structural values exactly.
- `entityField` replaces an identifier or descriptive field with a placeholder tied to a synthetic
  Person, Media, Location, or Audio entity.
- `url` emits a new HTTPS URL under `sanitized.invalid`.
- `opaque` replaces a whole cursor, token, preview, manifest, caption, or similar value.
- `embeddedAddressJson` parses and sanitizes a separately reviewed inner object.

Array indexes normalize to `[]`, so additional elements of an approved shape are accepted. Missing
optional fields, null values, and empty strings are accepted. A new key, an unreviewed embedded key,
or an unexpected non-null primitive type is rejected. A new literal on an approved structural path,
such as `__typename`, remains unchanged.

Container paths are accepted only when they lead to a reviewed leaf or are explicitly registered as
an empty or nullable container. The policy is intentionally hand-authored. Generating it from a raw
capture would turn observed private data into an implicit approval mechanism.

## Entities and correlation

The synthetic taxonomy is `PERSON`, `MEDIA`, `LOCATION`, and `AUDIO`. Opaque fields have their own
categories, such as `CURSOR`, `TRACKING_TOKEN`, and `MEDIA_PREVIEW`.

Correlation uses exact, namespace-aware identifiers:

- `id`, `pk`, `pk_id`, and `strong_id__` in Person records share the Instagram user-ID namespace.
- usernames, Facebook IDs, EIMU IDs, Media IDs, Post and shortcode Reel shortcodes, Location IDs,
  and Audio IDs remain separate namespaces.
- string and numeric forms normalize only within the same namespace.
- namespaces connect only when identifiers coexist in the same approved entity record.
- structural containment associates descriptive fields and URLs with their containing entity.

Full names, Avatar URLs, CDN URL similarity, fuzzy text, and hashes are never join keys.
`profile_pic_id` is Media identity, not Person identity. Exact joins are transitive and work across
files. A contradictory record with two different values in one namespace is rejected instead of
guessed.

Entity components are ordered by the first filename and structural occurrence in the fixed batch,
then numbered from one. Numbering is deterministic for the batch but is not persistent between
unrelated captures. No raw-to-synthetic mapping is written or derived from source hashes.

## Replacements and invariants

String replacements are explicit, for example `SANITIZED_PERSON_1_USERNAME` and
`SANITIZED_MEDIA_2_SHORTCODE`. Sensitive numbers use reserved deterministic ranges:

- Person: below `-1000000`
- Media: below `-2000000`
- Location: below `-3000000`
- Audio: below `-4000000`

Synthetic URLs use only `https://sanitized.invalid/`, an entity or resource role, a synthetic
number, and a field role. No original host, path, query, signature, or fragment survives. Opaque
values are numbered by category and first occurrence. Already sanitized placeholders and URLs are
preserved, making a second pass idempotent.

`address_json` is parsed before transformation. Its reviewed keys and JSON encoding remain, its
booleans, nulls, and empty strings remain, and non-empty address text becomes Location placeholders.
Other encoded or opaque fields are replaced as whole values.

After transformation, the sanitizer proves that object keys and their order, array lengths and
ordering, null placement, and primitive types are unchanged. Preserve rules must remain exactly
equal. Every non-empty denylisted value must match its replacement grammar. A failed invariant
aborts the batch.

## Workflow

The command always reads exactly these files from `.local/raw-fixtures/`:

`avatar.json`, `highlights-tray.json`, `highlights.json`, `instants-photo.json`,
`instants-video.json`, `instants-empty.json`, `shortcode-image.json`, `shortcode-sidecar.json`,
`shortcode-video.json`, `story.json`, and `web-profile-info.json`.

Run:

```bash
vp run sanitize:ig-fixtures
```

This parses all JSON with Effect Schema before recursive narrowing, validates and sanitizes the
complete batch, decodes every sanitized candidate through its existing endpoint Schema, and
regenerates `.local/sanitized-fixtures/`.

After reviewing staging, run:

```bash
vp run sanitize:ig-fixtures -- --write
```

The write path prepares a sibling directory, copies non-fixture destination files, writes all twelve
candidates, renames the existing destination to a backup, and renames the prepared directory into
place. If the final rename fails, the backup is restored. The twelve committed fixtures therefore
change together or not at all. Raw input is read-only and is never deleted automatically.

Diagnostics contain only filename, normalized path, expected type or contract, observed type or
error category, and category. They never contain a source value. Policy violations across the batch
are collected before returning.

## Effect and tests

Effect is used at boundaries rather than around the pure graph algorithm. JSON text is decoded with
`Schema.parseJson()`. Expected failures are tagged, typed errors. The filesystem service is provided
once at the CLI edge. Sanitized candidates are decoded in memory through `HdAvatarResponseSchema`,
`HighlightsTrayResponseSchema`, `ReelsMediaResponseSchema`, `ShortcodeMediaResponseSchema`, or
`WebProfileInfoResponseSchema` before staging.

Tests cover fail-closed policy behavior, exact and transitive correlation, namespace separation,
placeholder formats, numeric sentinels, URL replacement, embedded JSON, null and empty preservation,
determinism, idempotence, aggregate safe diagnostics, endpoint decoding, staging, full writes, and
rollback. A standing audit runs the sanitizer over committed fixtures again and requires every URL
to use `sanitized.invalid`. Test data is deliberately synthetic.

## Classifying a new path or type

1. Run the sanitizer and use its value-free aggregate diagnostics as the review queue.
2. Inspect the raw capture only on the local machine. Do not paste values into issues, source,
   snapshots, documentation, or logs.
3. Decide whether the path is structural and safe, sensitive, an entity identifier, an entity
   attribute, a URL, opaque data, or embedded JSON.
4. Confirm the expected non-null primitive type and whether a reusable shape owns the path.
5. For identifiers, select the narrow namespace and record boundary. Never infer a namespace from
   an `id` suffix alone.
6. Add the policy rule and a focused synthetic test together. If a new object shape is involved,
   classify all of its leaves before rerunning the full batch.
7. Run `vp check`, `vp test run`, and `vp run fallow`.

Preserved timestamps are deliberate regression evidence. CDN URLs are always replaced even when
signed and short-lived. GraphQL error messages remain because they are protocol diagnostics needed
by the fixture shape. `scans_profile` remains because it describes image encoding, not a person.
