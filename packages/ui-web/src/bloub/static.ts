/**
 * Local adaptation layer for the vendored bloub engine (see ./README.md).
 *
 * Reproduces the site's customizer view — one static frame composed from a
 * shape profile + an expression — using exactly the engine's geometry:
 * `closedPath(toPoints(sil))` for the body, and per-eye tangent matrices
 * (eyePoses × tilt, blinkScale, radius-fitted position, eyefit decalage)
 * as rendered by `BotEngine`. The eyes are true holes punched through the
 * body (mask), like x.ai's original, so the page background shows through.
 */
import { blinkScale, eyePoses } from "./face";
import { decalageDesYeux } from "./eyefit";
import { clamp, r2 } from "./math";
import { DEFAULT_SHAPE, SHAPE_BY_ID } from "./skins";
import { capsulePath, closedPath, radiusAtAngle, toPoints, type Silhouette } from "./shape";
import { DEFAULT_EXPRESSION, EXPRESSION_BY_ID } from "./expressions";
import { RAYON } from "./repere";
import type { StateId } from "./states";

/** The customizer view is the idle state with the chosen expression. */
const STATIC_STATE: StateId = "idle";

export interface BloubEyeRender {
  d: string;
  matrix: string;
  alpha: number;
}

export interface BloubStaticFrame {
  bodyPath: string;
  eyes: BloubEyeRender[];
}

const cache = new Map<string, BloubStaticFrame>();

export function bloubStaticFrame(shape: string, expression: string): BloubStaticFrame {
  const key = `${shape}|${expression}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const sh = SHAPE_BY_ID.get(shape) ?? SHAPE_BY_ID.get(DEFAULT_SHAPE)!;
  const expr = EXPRESSION_BY_ID.get(expression) ?? EXPRESSION_BY_ID.get(DEFAULT_EXPRESSION)!;
  const sil: Silhouette = { radii: sh.radii, rot: 0, cx: 0, cy: 0, sx: 1, sy: 1 };
  const bodyPath = closedPath(toPoints(sil, RAYON));
  const decalage = decalageDesYeux(sh.radii, STATIC_STATE, expr.id);
  const poses = eyePoses(expr.gaze, RAYON, expr.split);
  const eyes: BloubEyeRender[] = [];
  for (let i = 0; i < 2; i += 1) {
    const e = poses[i];
    const cfg = expr.eyes[i];
    if (!e || !cfg || e.depth <= 0.02) continue;
    const fit = radiusAtAngle(sil.radii, Math.atan2(e.y, e.x) - sil.rot);
    const phi = ((cfg.tilt ?? 0) * Math.PI) / 180;
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);
    const ax = e.a * cp + e.c * sp;
    const ay = e.b * cp + e.d * sp;
    const cx2 = -e.a * sp + e.c * cp;
    const cy2 = -e.b * sp + e.d * cp;
    const k = blinkScale(cfg.open);
    eyes.push({
      d: capsulePath(cfg.w * RAYON, cfg.h * RAYON),
      matrix: `matrix(${r2(ax)},${r2(ay * k)},${r2(cx2)},${r2(cy2 * k)},${r2(
        e.x * fit + decalage.x * RAYON,
      )},${r2(e.y * fit + decalage.y * RAYON)})`,
      alpha: clamp(e.depth / 0.12),
    });
  }
  const frame = { bodyPath, eyes };
  cache.set(key, frame);
  return frame;
}

/** Re-exported for the Avatar Studio pickers (shape/expression id lists). */
export { DEFAULT_EXPRESSION, DEFAULT_SHAPE };
export const BLOUB_SHAPE_IDS = [...SHAPE_BY_ID.keys()];
export const BLOUB_EXPRESSION_IDS = [...EXPRESSION_BY_ID.keys()];
