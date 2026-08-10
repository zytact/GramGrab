# GramGrab

GramGrab resolves supported Instagram and WhatsApp media into items that a person can inspect and download. This context defines the product language shared by its browser extension and CLI.

## Language

### Download workflows

**Source**:
One explicit supported Instagram URL or username input.
_Avoid_: Input

**Multi-item download**:
Downloading multiple media items resolved from one Source.
_Avoid_: Batch download

**Multi-source download**:
Resolving and downloading media from multiple explicit Sources as one user-initiated operation.
_Avoid_: Batch download

**Export mode**:
The intentional form of a downloaded media item, such as its original form, an exported frame, or a silent video.
_Avoid_: Download type

**Export modifier**:
An optional transformation applied to the output of an Export mode without replacing that mode.
_Avoid_: Export mode

**Provenance stamping**:
An Export modifier that adds source-attribution details visibly to an output through a Provenance overlay. It introduces no transformation beyond the stamp unless the selected Export mode intentionally requires one.
_Avoid_: Watermarking, Export mode

**Provenance overlay**:
The fixed visual element produced by Provenance stamping: white text over a low-opacity black backing panel. Its backing remains translucent so overlapped media content stays visible.
_Avoid_: Watermark

### Media

**Post**:
A permanent Instagram shortcode-addressable media item containing an image, video, or Sidecar.
_Avoid_: Feed item

**Shortcode Reel**:
A short-form video Post addressed by an Instagram shortcode.
_Avoid_: Clip, Reel when the meaning is ambiguous

**Sidecar**:
A multi-item Post containing image or video children.
_Avoid_: Album, carousel, gallery

**Story**:
An ephemeral media item in an Instagram account's current 24-hour collection.
_Avoid_: Snap, Story Reel

**Status**:
An ephemeral media item in a WhatsApp contact's current 24-hour collection.
_Avoid_: Story, WhatsApp Story

**Visible Status**:
The single Status currently presented in WhatsApp Web's Status viewer.
_Avoid_: Current Status, selected Status

**Instant**:
A photo or video available through Instagram's active Instants feed.
_Avoid_: QuickSnap, Snap, Story

**Highlight**:
A curated, persistent collection of past Stories.
_Avoid_: Saved story

**Avatar**:
An Instagram account's profile image.
_Avoid_: Profile pic, DP

### Operations

**Failure code**:
A stable symbolic identifier for a user-operation failure.
_Avoid_: Error message

**Recovery action**:
A supported action a person can take after an operation fails, such as retrying or downloading the original.
_Avoid_: Button text

**Operation outcome**:
The honest state of one logical item: pending, started, failed, skipped, or not attempted.
_Avoid_: Result string

**Operation ID**:
The stable identity of one logical selected item across retries and fallbacks.
_Avoid_: Request ID

**Request ID**:
The identity of one transport execution.
_Avoid_: Operation ID
