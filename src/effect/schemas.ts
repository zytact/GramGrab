import { Schema } from 'effect';

// ---------------------------------------------------------------------------
// Shortcode-media (post / reel) schemas
// ---------------------------------------------------------------------------

const DisplayResourceSchema = Schema.Struct({
  src: Schema.String,
  config_width: Schema.optional(Schema.Number),
  config_height: Schema.optional(Schema.Number),
});

const DimensionsSchema = Schema.Struct({
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
});

// Leaf-level nodes inside a sidecar (no nested sidecars in practice)
const SidecarChildNodeSchema = Schema.Struct({
  __typename: Schema.optional(Schema.String),
  is_video: Schema.optional(Schema.Boolean),
  display_url: Schema.optional(Schema.String),
  display_resources: Schema.optional(Schema.Array(DisplayResourceSchema)),
  dimensions: Schema.optional(DimensionsSchema),
});

export const ShortcodeNodeSchema = Schema.Struct({
  __typename: Schema.optional(Schema.String),
  is_video: Schema.optional(Schema.Boolean),
  shortcode: Schema.optional(Schema.String),
  id: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  taken_at_timestamp: Schema.optional(Schema.Number),
  display_url: Schema.optional(Schema.String),
  video_url: Schema.optional(Schema.String),
  display_resources: Schema.optional(Schema.Array(DisplayResourceSchema)),
  video_resources: Schema.optional(Schema.Array(DisplayResourceSchema)),
  dimensions: Schema.optional(DimensionsSchema),
  edge_sidecar_to_children: Schema.optional(
    Schema.Struct({
      edges: Schema.optional(Schema.Array(Schema.Struct({ node: SidecarChildNodeSchema }))),
    })
  ),
});

export type ShortcodeNode = Schema.Schema.Type<typeof ShortcodeNodeSchema>;
export type SidecarChildNode = Schema.Schema.Type<typeof SidecarChildNodeSchema>;

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
// web_profile_info schemas
// ---------------------------------------------------------------------------

export const WebProfileInfoUserSchema = Schema.Struct({
  id: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  pk: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  profile_pic_url_hd: Schema.optional(Schema.String),
  profile_pic_url: Schema.optional(Schema.String),
  profile_pic_dimensions: Schema.optional(
    Schema.Struct({
      width: Schema.optional(Schema.Number),
      height: Schema.optional(Schema.Number),
    })
  ),
});

export const WebProfileInfoResponseSchema = Schema.Struct({
  data: Schema.optional(Schema.Struct({ user: Schema.optional(WebProfileInfoUserSchema) })),
});

export type WebProfileInfoUser = Schema.Schema.Type<typeof WebProfileInfoUserSchema>;
