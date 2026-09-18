import { Rotation as RotationSchema, type Rotation } from '@gramgrab/protocol';

export { RotationSchema, type Rotation };

const CYCLE = [undefined, 90, 180, 270] as const;
const QUARTER_TURNS = [0, 90, 180, 270] as const;

export const nextRotation = (rotation: Rotation | undefined): Rotation | undefined =>
  CYCLE[(CYCLE.indexOf(rotation) + 1) % CYCLE.length];

export const swapsAxes = (rotation: Rotation | undefined): boolean =>
  rotation === 90 || rotation === 270;

/** Adds a requested turn to the turn a video track already declares in its metadata. */
export const combineRotations = (
  existing: (typeof QUARTER_TURNS)[number],
  rotation: Rotation | undefined
): (typeof QUARTER_TURNS)[number] => QUARTER_TURNS[((existing + (rotation ?? 0)) / 90) % 4] ?? 0;
