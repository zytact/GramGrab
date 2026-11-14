import { Schema } from 'effect';

export class DirectExport extends Schema.TaggedClass<DirectExport>()('DirectExport', {}) {}

export class FrameExport extends Schema.TaggedClass<FrameExport>()('FrameExport', {
  timestampSeconds: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
}) {}

/** Whether a silent export may re-encode: never, when it must, or always. */
export const SilentReencode = Schema.Literal('forbid', 'allow', 'require');
export type SilentReencode = Schema.Schema.Type<typeof SilentReencode>;

export class SilentExport extends Schema.TaggedClass<SilentExport>()('SilentExport', {
  reencode: SilentReencode,
}) {}

export const ExportMode = Schema.Union(DirectExport, FrameExport, SilentExport);
export type ExportMode = Schema.Schema.Type<typeof ExportMode>;

/** An Export mode by name. */
export const ExportModeKind = Schema.Literal('direct', 'frame', 'silent');
export type ExportModeKind = Schema.Schema.Type<typeof ExportModeKind>;

/** How a retry recovers a failed export: download the original instead, or let a silent export re-encode. */
export const ExportRecovery = Schema.Literal('original', 'reencode');
export type ExportRecovery = Schema.Schema.Type<typeof ExportRecovery>;

export const Rotation = Schema.Literal(90, 180, 270);
export type Rotation = Schema.Schema.Type<typeof Rotation>;

const Fraction = Schema.Number.pipe(Schema.finite(), Schema.between(0, 1));

/** A crop rectangle as fractions of the frame after rotation, so it holds at any resolution. */
export const Crop = Schema.Struct({
  x: Fraction,
  y: Fraction,
  width: Fraction.pipe(Schema.positive()),
  height: Fraction.pipe(Schema.positive()),
}).pipe(
  Schema.filter(crop => crop.x + crop.width <= 1 + 1e-9 && crop.y + crop.height <= 1 + 1e-9, {
    message: () => 'A crop must lie inside the frame.',
  })
);
export type Crop = Schema.Schema.Type<typeof Crop>;

/** What to make of one item: its mode plus the rotation and crop applied to the output. */
export const ExportSettings = Schema.Struct({
  mode: ExportMode,
  rotation: Schema.optional(Rotation),
  crop: Schema.optional(Crop),
});
export type ExportSettings = Schema.Schema.Type<typeof ExportSettings>;

/** Whether the settings deliver the file exactly as Instagram serves it. */
export const deliversOriginal = (settings: ExportSettings): boolean =>
  settings.mode._tag === 'DirectExport' && !settings.rotation && !settings.crop;
