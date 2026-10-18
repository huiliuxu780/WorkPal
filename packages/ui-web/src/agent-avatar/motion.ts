import type { AvatarActivity, AvatarCharacter } from "@rakazo/contracts";
import { easeInOut, easeOut, lerp } from "./easing.js";
import { clamp, clampPupil, R } from "./geometry.js";

export type MotionFrame = {
  body: { tx: number; ty: number; sx: number; sy: number; rot: number };
  eyes: { scale: number; blink: number };
  pupils: { tx: number; ty: number; opacity: number };
  symbol: { tx: number; ty: number; rot: number };
  prop: { scale: number; ty: number; rot: number };
  xeyes: { opacity: number };
  glow: number;
  cursor: number;
};

export type MotionContext = {
  character: AvatarCharacter;
  static?: boolean;
  /** Milliseconds since the last accepted pulse; omitted when no pulse is active. */
  pulseAgeMs?: number;
  /** Milliseconds since a new progress item or entry into working. */
  progressAgeMs?: number;
  /** Milliseconds since an approval reminder began. */
  reminderAgeMs?: number;
  /** Milliseconds since a scheduled character signature began. */
  signatureAgeMs?: number;
};

export const SIGNATURE_DURATION: Record<AvatarCharacter, number> = {
  dot: 1300,
  treble: 1600,
  wave: 1800,
  bounce: 1100,
};

const neutral = (): MotionFrame => ({
  body: { tx: 0, ty: 0, sx: 1, sy: 1, rot: 0 },
  eyes: { scale: 1, blink: 1 },
  pupils: { tx: 0, ty: 0, opacity: 1 },
  symbol: { tx: 0, ty: 0, rot: 0 },
  prop: { scale: 0, ty: 0, rot: 0 },
  xeyes: { opacity: 0 },
  glow: 0,
  cursor: 0,
});

export function hopAt(milliseconds: number, heightR: number): MotionFrame["body"] {
  const body = { tx: 0, ty: 0, sx: 1, sy: 1, rot: 0 };
  if (milliseconds < 0 || milliseconds >= 420) return body;
  if (milliseconds <= 60) {
    const k = easeOut(milliseconds / 60);
    return { ...body, sx: lerp(1, 1.08, k), sy: lerp(1, 0.92, k) };
  }
  if (milliseconds < 230) {
    const k = easeOut((milliseconds - 60) / 170);
    return { ...body, ty: -heightR * R * k, sx: lerp(1.08, 0.96, k), sy: lerp(0.92, 1.04, k) };
  }
  if (milliseconds < 400) {
    const k = easeInOut((milliseconds - 230) / 170);
    return {
      ...body,
      ty: -heightR * R * (1 - k),
      sx: lerp(0.96, 1.06, k),
      sy: lerp(1.04, 0.94, k),
    };
  }
  const k = (milliseconds - 400) / 20;
  return { ...body, sx: lerp(1.06, 1, k), sy: lerp(0.94, 1, k) };
}

function addHop(frame: MotionFrame, milliseconds: number, heightR: number) {
  const hop = hopAt(milliseconds, heightR);
  frame.body.ty += hop.ty;
  frame.body.sx *= hop.sx;
  frame.body.sy *= hop.sy;
}

function breathe(frame: MotionFrame, t: number, amplitude = 0.035) {
  const value = (1 - Math.cos((t / 3600) * Math.PI * 2)) / 2;
  frame.body.sy *= 1 + amplitude * value;
  frame.body.sx *= 1 / (1 + amplitude * value);
}

function sway(frame: MotionFrame, t: number, phase: number, amplitude = 1) {
  frame.symbol.rot += 4 * amplitude * Math.sin((t / 2600) * Math.PI * 2 + phase);
  frame.symbol.ty -= 0.02 * R * amplitude * Math.sin((t / 1800) * Math.PI * 2 + phase);
}

function blink(frame: MotionFrame, t: number, random: number) {
  const interval = 2500 + random * 3500;
  const offset = interval * random;
  const time = (t + offset) % interval;
  const blinkTime =
    time < 160 ? time : random < 0.15 && time >= 280 && time < 440 ? time - 280 : -1;
  if (blinkTime >= 0)
    frame.eyes.blink =
      blinkTime < 80 ? lerp(1, 0.1, blinkTime / 80) : lerp(0.1, 1, (blinkTime - 80) / 80);
}

function scheduledAge(
  t: number,
  random: number,
  minimum: number,
  maximum: number,
  duration: number,
): number {
  const wait = minimum + random * (maximum - minimum);
  const period = wait + duration;
  return (t % period) - wait;
}

function signature(frame: MotionFrame, character: AvatarCharacter, age: number) {
  if (age < 0 || age >= SIGNATURE_DURATION[character]) return;
  if (character === "dot") {
    const beat = age % 650;
    frame.symbol.ty -= 0.32 * R * Math.sin((Math.PI * beat) / 650);
    if (beat > 560) {
      frame.body.sx *= 1.03;
      frame.body.sy *= 0.97;
    }
  } else if (character === "treble") {
    const beat = Math.sin((age / 533) * Math.PI * 2);
    frame.symbol.rot += 12 * beat;
    frame.body.rot += 2.5 * beat;
    frame.body.tx += 0.03 * R * beat;
    frame.body.ty -= 0.03 * R * Math.max(0, beat);
  } else if (character === "wave") {
    const wave = Math.sin((age / 900) * Math.PI * 2);
    frame.symbol.ty -= 0.1 * R * Math.sin((Math.PI * age) / 1800);
    frame.symbol.rot += 10 * wave;
    frame.symbol.tx += 0.05 * R * wave;
    frame.body.rot -= 2 * wave;
  } else {
    const first = age < 420;
    const hopAge = first ? age : age - 460;
    const hop = hopAt(hopAge, first ? 0.22 : 0.3);
    addHop(frame, hopAge, first ? 0.22 : 0.3);
    frame.symbol.ty += 0.6 * (hopAt(hopAge - 80, first ? 0.22 : 0.3).ty - hop.ty);
  }
}

function staticPose(state: AvatarActivity, character: AvatarCharacter): MotionFrame {
  const frame = neutral();
  if (state === "failed") {
    frame.body.ty = 0.06 * R;
    frame.body.sx = 1.03;
    frame.body.sy = 0.95;
    frame.symbol.ty = 0.04 * R;
    frame.symbol.rot = 8;
    frame.xeyes.opacity = 1;
    frame.pupils.opacity = 0;
  } else if (state !== "idle") {
    frame.prop.scale = 1;
    const target =
      state === "working" ? [0.09, 0.07] : state === "approval" ? [0.1, 0.04] : [0, -0.08];
    const pupil = clampPupil(character, target[0]!, target[1]!);
    frame.pupils.tx = pupil.x;
    frame.pupils.ty = pupil.y;
    if (state === "working") {
      frame.glow = 0.4;
      frame.cursor = 1;
    }
  }
  return frame;
}

/** Pure deterministic sample. All coordinates are in the frozen 100×100 SVG viewBox. */
export function sample(
  state: AvatarActivity,
  tSinceEnter: number,
  rng: number,
  ctx: MotionContext,
): MotionFrame {
  if (ctx.static) return staticPose(state, ctx.character);
  const frame = neutral();
  const t = Math.max(0, tSinceEnter);
  const phase = clamp(rng, 0, 0.999999);
  const look = (dx: number, dy: number) => {
    const pupil = clampPupil(ctx.character, dx, dy);
    frame.pupils.tx = pupil.x;
    frame.pupils.ty = pupil.y;
  };

  if (state === "idle") {
    breathe(frame, t);
    sway(frame, t, phase * Math.PI * 2);
    const sigAge =
      ctx.signatureAgeMs ?? scheduledAge(t, phase, 9000, 18000, SIGNATURE_DURATION[ctx.character]);
    if (sigAge >= 0 && sigAge < SIGNATURE_DURATION[ctx.character]) {
      signature(frame, ctx.character, sigAge);
    } else {
      const glanceAge = scheduledAge(t, 1 - phase, 3000, 7000, 1400);
      if (glanceAge >= 0 && glanceAge < 1400) {
        const weight =
          glanceAge < 250
            ? easeOut(glanceAge / 250)
            : glanceAge < 1150
              ? 1
              : 1 - easeInOut((glanceAge - 1150) / 250);
        const direction = phase < 0.5 ? -1 : 1;
        look(0.14 * direction * weight, 0);
        frame.body.rot += 2 * direction * weight;
      }
      const hopAge = scheduledAge(t, phase * 0.7, 6000, 14000, 420);
      if (hopAge >= 0 && hopAge < 420) addHop(frame, hopAge, 0.08);
    }
    blink(frame, t, phase);
  } else if (state === "working") {
    if (t < 1260) {
      addHop(frame, t % 420, 0.18);
    } else {
      const slow = (ctx.progressAgeMs ?? t) >= 30_000;
      const period = slow ? 1200 : 600;
      const beat = (t - 1260) % period;
      const nod = beat < 180 ? Math.sin((Math.PI * beat) / 180) : 0;
      frame.body.ty += 0.03 * R * nod;
      frame.body.sy *= 1 - 0.03 * nod;
      frame.body.sx *= 1 + 0.03 * nod;
      const symbolBeat = (t - 1340 + period) % period;
      if (symbolBeat < 200) {
        const follow = Math.sin((Math.PI * symbolBeat) / 200);
        frame.symbol.ty += 0.025 * R * follow;
        frame.symbol.rot += 3 * follow;
      }
      frame.glow = 0.25 + (slow ? 0.15 : 0.35) * nod;
      frame.cursor = (t - 1260) % 1000 < 500 ? 1 : 0;
      const pulse = ctx.pulseAgeMs;
      if (pulse !== undefined && pulse >= 0 && pulse < 420) addHop(frame, pulse, 0.18);
      else {
        const sigAge =
          ctx.signatureAgeMs ??
          scheduledAge(t, phase, 15000, 25000, SIGNATURE_DURATION[ctx.character]);
        signature(frame, ctx.character, sigAge);
      }
    }
    look(0.09, 0.07);
    const u = clamp(t / 320, 0, 1);
    frame.prop.scale = u < 0.6 ? lerp(0, 1.12, easeOut(u / 0.6)) : lerp(1.12, 1, (u - 0.6) / 0.4);
  } else if (state === "approval" || state === "waiting") {
    breathe(frame, t, 0.025);
    sway(frame, t, phase * Math.PI * 2, 0.6);
    const u = clamp(t / 320, 0, 1);
    frame.prop.scale = u < 0.6 ? lerp(0, 1.12, easeOut(u / 0.6)) : lerp(1.12, 1, (u - 0.6) / 0.4);
    look(
      state === "approval" ? 0.1 * easeOut(t / 200) : 0,
      state === "approval" ? 0.04 * easeOut(t / 200) : -0.08 * easeOut(t / 200),
    );
    blink(frame, t, phase);
    if (state === "approval") {
      if (t > 320) frame.prop.ty = 0.05 * R * Math.sin(((t - 320) / 1600) * Math.PI * 2);
      const reminder = ctx.reminderAgeMs;
      if (reminder !== undefined && reminder >= 0 && reminder < 900) {
        const wave = Math.sin((reminder / 900) * Math.PI * 6);
        frame.prop.rot = 14 * wave;
        frame.prop.scale *= 1 + 0.1 * Math.abs(wave);
        frame.body.rot += 3 * Math.sin((Math.PI * reminder) / 900);
        addHop(frame, reminder - 100, 0.08);
        if (reminder < 450) look(0, 0);
      }
    } else if (t > 320) {
      const cycle = (t - 320) % 8000;
      const side = cycle < 4000 ? 1 : -1;
      const part = cycle % 4000;
      const bend = easeInOut(part / 500);
      frame.body.rot += lerp(-side * 4, side * 4, bend);
      frame.prop.rot = side * 8 * bend;
      let glance = 0;
      if (part > 2600 && part < 3200)
        glance = -side * 0.18 * Math.sin((Math.PI * (part - 2600)) / 600);
      look(side * 0.05 + glance, -0.08);
    }
  } else {
    if (t < 180) {
      const k = easeOut(t / 180);
      frame.body.ty = -0.14 * R * k;
      frame.body.sx = 1 - 0.07 * k;
      frame.body.sy = 1 + 0.08 * k;
      frame.eyes.scale = 1 + 0.12 * k;
      frame.symbol.ty = -0.06 * R * k;
    } else if (t < 330) {
      const k = easeInOut((t - 180) / 150);
      frame.body.ty = -0.14 * R * (1 - k);
      frame.body.sx = lerp(0.93, 1.05, k);
      frame.body.sy = lerp(1.08, 0.95, k);
      frame.eyes.scale = lerp(1.12, 1, k);
    } else if (t < 780) {
      const pointsX = [0, 0.08, -0.08, 0.05, -0.03, 0];
      const pointsR = [0, 3, -3, 2, -1, 0];
      const at = ((t - 330) / 450) * 5;
      const index = Math.min(4, Math.floor(at));
      frame.body.tx = lerp(pointsX[index]!, pointsX[index + 1]!, at - index) * R;
      frame.body.rot = lerp(pointsR[index]!, pointsR[index + 1]!, at - index);
    }
    if (t >= 780) {
      frame.xeyes.opacity = easeOut((t - 780) / 120);
      frame.pupils.opacity = 1 - frame.xeyes.opacity;
    }
    if (t > 900) {
      const k = easeInOut((t - 900) / 400);
      frame.body.ty += 0.06 * R * k;
      frame.body.sx *= 1 + 0.03 * k;
      frame.body.sy *= 1 - 0.05 * k;
      frame.symbol.ty += 0.04 * R * k;
      frame.symbol.rot += 8 * k;
    }
  }

  frame.body.sx = clamp(frame.body.sx, 0.9, 1.1);
  frame.body.sy = clamp(frame.body.sy, 0.9, 1.1);
  frame.body.rot = clamp(frame.body.rot, -5, 5);
  frame.symbol.rot = clamp(frame.symbol.rot, -15, 15);
  frame.symbol.tx = clamp(frame.symbol.tx, -0.35 * R, 0.35 * R);
  frame.symbol.ty = clamp(frame.symbol.ty, -0.35 * R, 0.35 * R);
  frame.prop.scale = clamp(frame.prop.scale, 0, 1.12);
  return frame;
}
