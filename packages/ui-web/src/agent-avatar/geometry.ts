import type { AvatarCharacter } from "@rakazo/contracts";

export const R = 31.25;
export const BODY_CENTER = { x: 50, y: 57.8125 } as const;
export const BODY_FOOT = { x: 50, y: BODY_CENTER.y + R } as const;

/** Safe R-unit pupil travel with the MOTION-SPEC's 64px one-pixel margin. */
export const PUPIL_TRAVEL: Record<
  AvatarCharacter,
  { right: number; left: number; down: number; up: number }
> = {
  dot: { right: 0.084, left: 0.392, down: 0.155, up: 0.136 },
  treble: { right: 0.084, left: 0.392, down: 0.155, up: 0.136 },
  wave: { right: 0.052, left: 0.273, down: 0.139, up: 0.107 },
  bounce: { right: 0.081, left: 0.392, down: 0.11, up: 0.19 },
};

/**
 * A conservative L1 bound shortens both axes by one factor. Independent axis
 * clamps can push a pupil outside the irregular eye white on a diagonal.
 */
export function clampPupil(
  character: AvatarCharacter,
  dxR: number,
  dyR: number,
): { x: number; y: number } {
  const limit = PUPIL_TRAVEL[character];
  const maxX = dxR >= 0 ? Math.min(limit.right, 0.1) : limit.left;
  const maxY = dyR >= 0 ? limit.down : limit.up;
  const budget = Math.abs(dxR) / maxX + Math.abs(dyR) / maxY;
  const scale = budget > 1 ? 1 / budget : 1;
  return { x: dxR * scale * R, y: dyR * scale * R };
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
