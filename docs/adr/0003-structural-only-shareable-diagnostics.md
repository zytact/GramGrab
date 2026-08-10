# Shareable diagnostics are structural-only by default

GramGrab diagnostics that a person can copy or export use a closed, versioned structural report.
They do not carry raw URLs, source URLs, filenames, operation or request identifiers, arbitrary
causes, or full user-agent strings.

## Decision

Diagnostics are constructed from typed domain values into a dedicated Effect Schema. The constructor
keeps only the fields useful for support: extension and capture metadata, normalized browser and
platform descriptors, attempt counts, media kinds and outcomes, structural URL descriptors, and
closed failure and warning codes. A URL descriptor exposes no path or query values. It records only
its normalized hostname, path shape and extension, sorted query names, recognized signature
parameter presence, and parsed expiry state. An unparseable URL produces a parse-status descriptor
with no raw-value fallback. User-agent input is reduced to a browser family, major version, and
platform family.

The version-2 schema is also the only encoding boundary for the copied JSON. Reports are transient,
and a complete preview is shown before a person copies one. Diagnostics are not telemetry and are
not archived by GramGrab.

## Origin and alternatives

[ADR 0002](./0002-structural-only-whatsapp-diagnostics.md) established structural-only diagnostics
as a WhatsApp-specific response to private media references and person-identifying filenames. This
ADR generalizes that precedent to every shareable diagnostics surface, including Instagram, where a
signed CDN URL can act as a bypass credential even when the source itself is public.

Keeping the old general report and adding a redaction pass was rejected. It makes every new field a
potential privacy regression and requires the safety of copied output to depend on remembering a
filter. A dedicated schema has no field for a secret and makes the allowlist visible at the
construction boundary.

## Consequences

- Support receives structural evidence for URL parsing, signature presence, expiry, browser, and
  operation failures without receiving reusable media credentials or identifying names.
- The report version changes to 2. Reports are transient, so no migration path is required.
- New diagnostics fields require an explicit schema and constructor decision rather than inheriting
  arbitrary runtime values.
- Preview-before-copy remains mandatory, but its disclosure describes the structured information
  that can still be shared instead of warning about values that are no longer present.
