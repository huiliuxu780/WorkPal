import { clamp } from "./geometry.js";

export const lerp = (from: number, to: number, t: number): number =>
  from + (to - from) * clamp(t, 0, 1);

/** A sampled cubic Bezier y value at normalized x (not a third-order approximation). */
function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const sample = (t: number, a: number, b: number) => {
    const inv = 1 - t;
    return 3 * inv * inv * t * a + 3 * inv * t * t * b + t * t * t;
  };
  let low = 0;
  let high = 1;
  const wanted = clamp(x, 0, 1);
  for (let i = 0; i < 18; i += 1) {
    const mid = (low + high) / 2;
    if (sample(mid, x1, x2) < wanted) low = mid;
    else high = mid;
  }
  return sample((low + high) / 2, y1, y2);
}

export const easeOut = (t: number): number => cubicBezier(0.2, 0.8, 0.3, 1, t);
export const easeInOut = (t: number): number => cubicBezier(0.45, 0, 0.55, 1, t);
