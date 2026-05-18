import { Schema } from 'effect';

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
