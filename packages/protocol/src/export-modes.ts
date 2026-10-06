import { Schema } from 'effect';

export class DirectExport extends Schema.TaggedClass<DirectExport>()('DirectExport', {}) {}

export class FrameExport extends Schema.TaggedClass<FrameExport>()('FrameExport', {
  timestampSeconds: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
}) {}

export class SilentExport extends Schema.TaggedClass<SilentExport>()('SilentExport', {
  reencode: Schema.Literal('forbid', 'allow', 'require'),
}) {}

export const ExportMode = Schema.Union(DirectExport, FrameExport, SilentExport);
export type ExportMode = Schema.Schema.Type<typeof ExportMode>;
export const Rotation = Schema.Literal(90, 180, 270);
export type Rotation = Schema.Schema.Type<typeof Rotation>;

export const ExportSettings = Schema.Struct({
  mode: ExportMode,
  rotation: Schema.optional(Rotation),
});
export type ExportSettings = Schema.Schema.Type<typeof ExportSettings>;
