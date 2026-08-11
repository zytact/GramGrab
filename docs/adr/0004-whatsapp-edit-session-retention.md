# WhatsApp editing uses a flat, bounded in-memory lease

Interactive editing changes the WhatsApp lifecycle from capture-then-download to
capture-complete, edit session, and then download completion or lease expiry. The edit session owns
the captured bytes in memory while a person previews, scrubs, or starts a terminal export.

## Decision

The edit session has one absolute 10-minute lease measured from capture-complete. Interaction never
resets or extends it. Preview, frame scrubbing, and other free reads do not create a new lease
event. Terminal operations are pre-flight checked against the remaining lease and are refused when
their estimated completion would cross the deadline.

The memory bound is structural: one captured blob, the existing 64MB media cap, and eager release
when bytes are no longer needed. Bytes remain in memory only. No storage API, filesystem, OPFS
location, or new browser permission is introduced.

Mid-edit expiry reuses the existing `retention-expired` producer reason and
`WHATSAPP_ACQUISITION_FAILED` failure code. Its structural invariant selects edit-aware copy
(`Your editing session expired after 10 minutes - capture the Visible Status again to continue.`)
and a re-capture recovery action. A new failure code would duplicate retention semantics and expand
the compatibility contract without adding useful recovery behavior.

## Alternatives considered

An idle-reset lease was rejected because continuous scrubbing could keep private bytes alive
indefinitely. A memory-pressure permission was rejected because it would add access unrelated to
the user-invoked capture and does not provide a reliable cross-browser contract. A post-expiry
grace period was rejected because it would weaken the absolute privacy bound; terminal work must
pass the pre-flight guard before it starts.

## Consequences

- Acquisition transfer, idle, and absolute timers remain separate from the edit lease.
- A new capture releases any previous handle before accepting another one.
- Expiry releases the snapshot and blob URL immediately and presents a re-capture path.
- Future terminal operations can reuse the pure lease guard and add their own duration or peak-memory estimate.
