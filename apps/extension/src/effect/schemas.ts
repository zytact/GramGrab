import { Schema } from 'effect';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

const MediaResourceSchema = Schema.Struct({
  src: Schema.String,
  config_width: Schema.optional(Schema.Number),
  config_height: Schema.optional(Schema.Number),
});

const DimensionsSchema = Schema.Struct({
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
});

// ---------------------------------------------------------------------------
// Shortcode-media (post / reel) — tagged union on __typename
// ---------------------------------------------------------------------------

// Sidecar child nodes share a flat shape (no nested sidecars in practice).
// Image vs video within a sidecar is determined at runtime by is_video.
const SidecarChildNodeSchema = Schema.Struct({
  __typename: Schema.optional(Schema.String),
  id: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  is_video: Schema.optional(Schema.Boolean),
  display_url: Schema.optional(Schema.String),
  display_resources: Schema.optional(Schema.Array(MediaResourceSchema)),
  // Present when the child is a video. doc_id endpoint serves video_url;
  // older query_hash endpoints include video_resources.
  video_url: Schema.optional(Schema.String),
  video_resources: Schema.optional(Schema.Array(MediaResourceSchema)),
  dimensions: Schema.optional(DimensionsSchema),
});

const ShortcodeVideoSchema = Schema.Struct({
  __typename: Schema.Literal(
    'XDTGraphVideo',
    'GraphVideo',
    'Video',
    'XDTMediaVideo',
    'ClipsShareVideo'
  ),
  id: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  shortcode: Schema.optional(Schema.String),
  taken_at_timestamp: Schema.optional(Schema.Number),
  display_url: Schema.optional(Schema.String),
  display_resources: Schema.optional(Schema.Array(MediaResourceSchema)),
  // video_resources preferred over video_url when present. The doc_id endpoint
  // (PolarisPostRootQuery) only serves video_url; older query_hash endpoints
  // include video_resources. Decoder accepts either.
  video_resources: Schema.optional(Schema.Array(MediaResourceSchema)),
  video_url: Schema.optional(Schema.String),
  dimensions: Schema.optional(DimensionsSchema),
  is_video: Schema.optional(Schema.Boolean),
});

const ShortcodeImageSchema = Schema.Struct({
  __typename: Schema.Literal('XDTGraphImage', 'GraphImage', 'Image', 'XDTMediaImage'),
  id: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  shortcode: Schema.optional(Schema.String),
  taken_at_timestamp: Schema.optional(Schema.Number),
  display_url: Schema.optional(Schema.String),
  display_resources: Schema.optional(Schema.Array(MediaResourceSchema)),
  dimensions: Schema.optional(DimensionsSchema),
  is_video: Schema.optional(Schema.Boolean),
});

const ShortcodeSidecarSchema = Schema.Struct({
  __typename: Schema.Literal('XDTGraphSidecar', 'GraphSidecar', 'Sidecar', 'XDTMediaAlbum'),
  id: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  shortcode: Schema.optional(Schema.String),
  taken_at_timestamp: Schema.optional(Schema.Number),
  display_url: Schema.optional(Schema.String),
  edge_sidecar_to_children: Schema.optional(
    Schema.Struct({
      edges: Schema.optional(Schema.Array(Schema.Struct({ node: SidecarChildNodeSchema }))),
    })
  ),
  dimensions: Schema.optional(DimensionsSchema),
  is_video: Schema.optional(Schema.Boolean),
});

// Unknown passthrough — IG ships new typenames occasionally. Decode succeeds;
// normalizer skips the item and logs a console.warn with the typename.
const ShortcodeUnknownSchema = Schema.Struct({
  __typename: Schema.optional(Schema.String),
  id: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
});

const ShortcodeNodeSchema = Schema.Union(
  ShortcodeVideoSchema,
  ShortcodeImageSchema,
  ShortcodeSidecarSchema,
  ShortcodeUnknownSchema
);

export type ShortcodeNode = Schema.Schema.Type<typeof ShortcodeNodeSchema>;
export type ShortcodeVideo = Schema.Schema.Type<typeof ShortcodeVideoSchema>;
export type ShortcodeImage = Schema.Schema.Type<typeof ShortcodeImageSchema>;
export type ShortcodeSidecar = Schema.Schema.Type<typeof ShortcodeSidecarSchema>;

const ShortcodeDataSchema = Schema.Struct({
  xdt_shortcode_media: Schema.optional(ShortcodeNodeSchema),
  shortcode_media: Schema.optional(ShortcodeNodeSchema),
  media: Schema.optional(ShortcodeNodeSchema),
});

// Accepts both `{ data: { xdt_shortcode_media: ... } }` and top-level aliases
export const ShortcodeMediaResponseSchema = Schema.Struct({
  data: Schema.optional(ShortcodeDataSchema),
  xdt_shortcode_media: Schema.optional(ShortcodeNodeSchema),
  shortcode_media: Schema.optional(ShortcodeNodeSchema),
  media: Schema.optional(ShortcodeNodeSchema),
});

// ---------------------------------------------------------------------------
// Reels media (Stories and Highlights) - strict known shapes with unknown typename passthrough
// ---------------------------------------------------------------------------

const StoryCandidateSchema = Schema.Struct({
  url: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
});

const StoryItemFields = {
  __typename: Schema.Literal('XDTMediaDict'),
  pk: Schema.String,
  taken_at: Schema.Number,
  expiring_at: Schema.Number,
  original_width: Schema.Number,
  original_height: Schema.Number,
  image_versions2: Schema.Struct({ candidates: Schema.Array(StoryCandidateSchema) }),
} as const;

const StoryImageItemSchema = Schema.Struct({
  ...StoryItemFields,
  media_type: Schema.Literal(1),
});

const StoryVideoItemSchema = Schema.Struct({
  ...StoryItemFields,
  media_type: Schema.Literal(2),
  // Story video versions carry no dimensions; the item's original size describes them.
  video_versions: Schema.Array(Schema.Struct({ url: Schema.String })),
});

const StoryUnknownItemSchema = Schema.Struct({
  __typename: Schema.String.pipe(
    Schema.filter(value => value !== 'XDTMediaDict', {
      message: () => 'known Story typename must match its strict shape',
    })
  ),
});

const StoryItemSchema = Schema.Union(
  StoryImageItemSchema,
  StoryVideoItemSchema,
  StoryUnknownItemSchema
);

export type StoryImageItem = Schema.Schema.Type<typeof StoryImageItemSchema>;
export type StoryVideoItem = Schema.Schema.Type<typeof StoryVideoItemSchema>;

const ReelSchema = Schema.Struct({
  id: Schema.String,
  items: Schema.Array(StoryItemSchema),
});

export const ReelsMediaResponseSchema = Schema.Struct({
  data: Schema.Struct({
    xdt_api__v1__feed__reels_media: Schema.Struct({ reels_media: Schema.Array(ReelSchema) }),
  }),
});

export type ReelItem = Schema.Schema.Type<typeof ReelSchema>;

// ---------------------------------------------------------------------------
// highlights_tray schemas
// ---------------------------------------------------------------------------

const CoverImageVersionSchema = Schema.Struct({
  url: Schema.String,
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
});

const CoverMediaSchema = Schema.Struct({
  full_image_version: Schema.optional(Schema.NullOr(CoverImageVersionSchema)),
  cropped_image_version: Schema.optional(Schema.NullOr(CoverImageVersionSchema)),
});

const HighlightsTrayItemSchema = Schema.Struct({
  id: Schema.Union(Schema.String, Schema.Number),
  title: Schema.optional(Schema.String),
  cover_media: CoverMediaSchema,
});

export const HighlightsTrayResponseSchema = Schema.Struct({
  tray: Schema.Array(HighlightsTrayItemSchema),
});

export type HighlightsTrayItem = Schema.Schema.Type<typeof HighlightsTrayItemSchema>;

// ---------------------------------------------------------------------------
// Active Instants - strict known shapes with unknown typename passthrough
// ---------------------------------------------------------------------------

const InstantCandidateSchema = Schema.Struct({
  width: Schema.Number,
  height: Schema.Number,
  url: Schema.String,
});

const InstantUserSchema = Schema.Struct({
  id: Schema.String,
  username: Schema.String,
  full_name: Schema.String,
  profile_pic_url: Schema.String,
});

const InstantCaptionSchema = Schema.Struct({
  __typename: Schema.Literal('XDTCommentDict'),
  strong_id__: Schema.String,
  pk: Schema.String,
  text: Schema.String,
});

const InstantPromptInfoSchema = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
});

const InstantQuickSnapInfoSchema = Schema.Struct({
  filter_key: Schema.optional(Schema.String),
});

const InstantBaseFields = {
  __typename: Schema.Literal('XDTMediaDict'),
  id: Schema.String,
  taken_at: Schema.Number,
  source_type: Schema.Number,
  audience: Schema.String,
  caption: Schema.NullOr(InstantCaptionSchema),
  user: InstantUserSchema,
  quick_snap_info: InstantQuickSnapInfoSchema,
  prompt_info: Schema.NullOr(InstantPromptInfoSchema),
  wearable_attribution_info: Schema.Null,
} as const;

export const InstantPhotoSchema = Schema.Struct({
  ...InstantBaseFields,
  media_type: Schema.Literal(1),
  image_versions2: Schema.Struct({ candidates: Schema.Array(InstantCandidateSchema) }),
  video_versions: Schema.Null,
  video_dash_manifest: Schema.Null,
  video_duration: Schema.Null,
});

export const InstantVideoSchema = Schema.Struct({
  ...InstantBaseFields,
  media_type: Schema.Literal(2),
  image_versions2: Schema.NullOr(
    Schema.Struct({ candidates: Schema.Array(InstantCandidateSchema) })
  ),
  video_versions: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        width: Schema.Number,
        height: Schema.Number,
        type: Schema.Number,
        url: Schema.String,
      })
    )
  ),
  video_dash_manifest: Schema.NullOr(Schema.String),
  video_duration: Schema.NullOr(Schema.Number),
});

const InstantUnknownSchema = Schema.Struct({
  __typename: Schema.String.pipe(
    Schema.filter(value => value !== 'XDTMediaDict', {
      message: () => 'known Instant typename must match its strict shape',
    })
  ),
  id: Schema.optional(Schema.String),
});

const InstantItemSchema = Schema.Union(
  InstantPhotoSchema,
  InstantVideoSchema,
  InstantUnknownSchema
);

export const InstantsFeedResponseSchema = Schema.Struct({
  data: Schema.Struct({
    xdt_get_quick_snaps: Schema.Struct({
      items_ordered_by_time: Schema.Array(InstantItemSchema),
      sample_items: Schema.Array(InstantItemSchema),
    }),
  }),
});

export type InstantItem = Schema.Schema.Type<typeof InstantItemSchema>;
export type InstantPhoto = Schema.Schema.Type<typeof InstantPhotoSchema>;
export type InstantVideo = Schema.Schema.Type<typeof InstantVideoSchema>;
