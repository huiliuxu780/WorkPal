import type { AvatarActivity, AvatarCharacter } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { AvatarDirector, type MotionEnvironment, type MotionPresentation } from "./director.js";
import { clampPupil, PUPIL_TRAVEL, R } from "./geometry.js";
import { hopAt, sample } from "./motion.js";

const characters: AvatarCharacter[] = ["dot", "treble", "wave", "bounce"];
const states: AvatarActivity[] = ["idle", "working", "approval", "waiting", "failed"];

describe("MOTION-SPEC sampling", () => {
  it("fades the ground shadow into work and out after a scheduled idle landing", () => {
    expect(sample("working", 0, 0.37, {character: "dot"}).shadow.opacity).toBe(0);
    expect(sample("working", 60, 0.37, {character: "dot"}).shadow.opacity).toBeGreaterThan(0);
    const firstIdleHop = 6000 + .37 * .7 * 8000;
    expect(sample("idle", firstIdleHop + 470, .37, {character: "dot"}).shadow.opacity).toBeGreaterThan(0);
    expect(sample("idle", firstIdleHop + 620, .37, {character: "dot"}).shadow.opacity).toBe(0);
  });

  it("follows the v0.7 failed shake, eye/symbol lags and airborne shadow", () => {
    for (const [time, degrees] of [
      [300, 0],
      [400, -6],
      [560, 4.5],
      [720, -2.5],
      [860, 1],
      [940, 0],
    ]) {
      const frame = sample("failed", time!, 0, { character: "dot", size: 58 });
      expect(frame.body.rot).toBeCloseTo(degrees!, 5);
      expect(frame.body.tx).toBeCloseTo((degrees! / 6) * 0.06 * R, 5);
      expect(frame.body.sy).toBeLessThanOrEqual(1.12);
    }
    const shake = sample("failed", 400, 0, { character: "dot" });
    expect(shake.xeyes.opacity).toBe(1);
    expect(shake.pupils.opacity).toBe(0);
    expect(shake.eyes.lagX).not.toBe(0);
    expect(shake.symbol.rot).not.toBe(0);
    expect(shake.shadow.opacity).toBe(0);
    expect(sample("failed", 150, 0, { character: "dot" }).shadow.opacity).toBeGreaterThan(0);
    expect(sample("working", 1500, 0, { character: "dot", static: true }).shadow.opacity).toBe(0);
  });

  it("hits the frozen working entry keyframe and stops after the failed one-shot", () => {
    const working = sample("working", 60, 0.4, { character: "dot" });
    expect(working.body.sx).toBeCloseTo(1.08, 2);
    expect(working.body.sy).toBeCloseTo(0.92, 2);
    const failed = sample("failed", 1300, 0.4, { character: "dot" });
    expect(failed.body.ty).toBeCloseTo(0.06 * R, 3);
    expect(failed.body.sy).toBeCloseTo(0.95, 3);
    expect(failed.xeyes.opacity).toBe(1);
    expect(sample("failed", 60_000, 0.4, { character: "dot" })).toEqual(failed);
  });

  it("has one shared proportional pupil clamp for every character", () => {
    for (const character of characters) {
      const { right, left, down, up } = PUPIL_TRAVEL[character];
      for (const [dx, dy] of [
        [0.09, 0.07],
        [0.18, -0.08],
        [-0.18, -0.08],
        [0.14, 0],
      ]) {
        const result = clampPupil(character, dx!, dy!);
        const x = result.x / R;
        const y = result.y / R;
        expect(
          Math.abs(x) / (x >= 0 ? right : left) + Math.abs(y) / (y >= 0 ? down : up),
        ).toBeLessThanOrEqual(1.00001);
        expect(x).toBeLessThanOrEqual(0.10001);
        if (dx && dy) expect(x / y).toBeCloseTo(dx / dy, 5);
      }
    }
  });

  it("keeps all timeline samples within squash, rotation, symbol and prop limits", () => {
    for (const character of characters)
      for (const state of states) {
        for (let t = 0; t <= 35_000; t += 37) {
          const frame = sample(state, t, 0.37, { character });
          expect(frame.body.sx).toBeGreaterThanOrEqual(0.9);
          expect(frame.body.sx).toBeLessThanOrEqual(1.1);
          expect(frame.body.sy).toBeGreaterThanOrEqual(0.9);
          expect(frame.body.sy).toBeLessThanOrEqual(1.1);
          expect(Math.abs(frame.body.rot)).toBeLessThanOrEqual(state === "failed" ? 6 : 5);
          expect(Math.abs(frame.symbol.rot)).toBeLessThanOrEqual(15);
          expect(Math.abs(frame.symbol.tx)).toBeLessThanOrEqual(0.35 * R);
          expect(Math.abs(frame.symbol.ty)).toBeLessThanOrEqual(0.35 * R);
          expect(frame.prop.scale).toBeGreaterThanOrEqual(0);
          expect(frame.prop.scale).toBeLessThanOrEqual(1.12);
          expect(frame.shadow.opacity).toBeGreaterThanOrEqual(0);
          expect(frame.shadow.opacity).toBeLessThanOrEqual(1);
        }
        const still = sample(state, 0, 0.1, { character, static: true });
        expect(sample(state, 50_000, 0.9, { character, static: true })).toEqual(still);
      }
    expect(hopAt(60, 0.18).sx).toBeCloseTo(1.08, 2);
  });

  it("slows work at 30 seconds and restores fast cadence on new progress", () => {
    const slow = sample("working", 31_350, 0.2, { character: "wave", progressAgeMs: 31_350 });
    const fresh = sample("working", 31_350, 0.2, { character: "wave", progressAgeMs: 100 });
    expect(slow.glow).toBeLessThanOrEqual(0.4);
    expect(fresh.glow).toBeGreaterThanOrEqual(slow.glow);
    expect(
      sample("working", 5000, 0.2, { character: "wave", pulseAgeMs: 100 }).body.ty,
    ).toBeLessThan(sample("working", 5000, 0.2, { character: "wave" }).body.ty);
  });
});

class FakeEnvironment implements MotionEnvironment {
  time = 0;
  isVisible = true;
  isReduced = false;
  frames = new Map<number, () => void>();
  next = 1;
  visibilityListener = () => {};
  motionListener = () => {};
  now() {
    return this.time;
  }
  requestFrame(callback: () => void) {
    const id = this.next++;
    this.frames.set(id, callback);
    return id;
  }
  cancelFrame(id: number) {
    this.frames.delete(id);
  }
  visible() {
    return this.isVisible;
  }
  reducedMotion() {
    return this.isReduced;
  }
  onVisibilityChange(callback: () => void) {
    this.visibilityListener = callback;
    return () => {
      this.visibilityListener = () => {};
    };
  }
  onMotionChange(callback: () => void) {
    this.motionListener = callback;
    return () => {
      this.motionListener = () => {};
    };
  }
  step(milliseconds: number) {
    this.time += milliseconds;
    const callbacks = [...this.frames.values()];
    this.frames.clear();
    for (const callback of callbacks) callback();
    expect(this.frames.size).toBeLessThanOrEqual(1);
  }
  setVisible(visible: boolean) {
    this.isVisible = visible;
    this.visibilityListener();
  }
  setReduced(reduced: boolean) {
    this.isReduced = reduced;
    this.motionListener();
  }
}

describe("AvatarDirector", () => {
  it("keeps cross-eyes through an explicitly repeated failed entrance", () => {
    const env = new FakeEnvironment();
    const director = new AvatarDirector(env);
    let frame: MotionPresentation | undefined;
    director.register({
      instanceKey: "failed",
      botId: "failed",
      character: "dot",
      state: "failed",
      current: false,
      render: (p) => {
        frame = p;
      },
    });
    env.step(1240);
    director.update("failed", { state: "failed" });
    env.step(200);
    expect(frame!.frame.xeyes.opacity).toBe(1);
    expect(frame!.frame.pupils.opacity).toBe(0);
    director.dispose();
  });

  it("uses one clock and at most three slots with state priority before current Bot", () => {
    const env = new FakeEnvironment();
    const director = new AvatarDirector(env);
    const register = (key: string, state: AvatarActivity, current = false) =>
      director.register({
        instanceKey: key,
        botId: key,
        character: "dot",
        state,
        current,
        render: () => {},
      });
    register("approval", "approval");
    register("waiting", "waiting");
    register("work", "working");
    register("current-failed", "failed", true);
    expect(env.frames.size).toBe(1);
    env.step(16);
    expect(director.movingKeys).toEqual(expect.arrayContaining(["approval", "waiting", "work"]));
    expect(director.movingKeys).not.toContain("current-failed");
    expect(director.movingKeys).toHaveLength(3);
    director.dispose();
    expect(env.frames.size).toBe(0);
  });

  it("releases failed one-shot slots and pauses without catching up reminders", () => {
    const env = new FakeEnvironment();
    const director = new AvatarDirector(env);
    const last = new Map<string, MotionPresentation>();
    for (const [key, state] of [
      ["approval-a", "approval"],
      ["approval-b", "approval"],
      ["failed", "failed"],
      ["idle", "idle"],
    ] as const) {
      director.register({
        instanceKey: key,
        botId: key,
        character: "dot",
        state,
        current: false,
        render: (value) => {
          last.set(key, value);
        },
      });
    }
    env.step(16);
    expect(director.movingKeys).toContain("failed");
    env.step(1300);
    expect(director.movingKeys).not.toContain("failed");
    expect(director.movingKeys).toContain("idle");
    expect(last.get("failed")?.moving).toBe(false);
    env.step(1684); // logical 3000ms: only one approval may remind.
    expect(director.reminderStarts).toBe(1);
    env.step(2000);
    expect(director.reminderStarts).toBe(2);
    env.setVisible(false);
    expect(env.frames.size).toBe(0);
    env.step(120_000);
    expect(director.reminderStarts).toBe(2);
    env.setVisible(true);
    env.step(16);
    expect(director.reminderStarts).toBe(2);
    env.setReduced(true);
    expect(env.frames.size).toBe(0);
    expect([...last.values()].every((value) => !value.moving)).toBe(true);
    director.dispose();
  });

  it("limits each approval to three staggered reminders at least 30 seconds apart", () => {
    const env = new FakeEnvironment();
    const director = new AvatarDirector(env);
    for (const key of ["a", "b"]) {
      director.register({
        instanceKey: key,
        botId: key,
        character: "wave",
        state: "approval",
        current: false,
        render: () => {},
      });
    }
    for (const tick of [3000, 2000, 28_000, 2000, 28_000, 2000, 60_000]) {
      env.step(tick);
    }
    expect(director.reminderStarts).toBe(6);
    env.step(120_000);
    expect(director.reminderStarts).toBe(6);
    director.dispose();
  });

  it("drops pulses inside two seconds, waits for a hop landing, and lets failure interrupt", () => {
    const env = new FakeEnvironment();
    const director = new AvatarDirector(env);
    const observed: MotionPresentation[] = [];
    director.register({
      instanceKey: "one",
      botId: "one",
      character: "dot",
      state: "working",
      current: true,
      render: (value) => observed.push(value),
    });
    env.step(100);
    expect(director.pulse("one")).toBe(true);
    expect(director.pulse("one")).toBe(false);
    director.update("one", { state: "waiting" });
    env.step(319);
    expect(observed.at(-1)?.state).toBe("working");
    env.step(1);
    expect(observed.at(-1)?.state).toBe("waiting");
    director.update("one", { state: "failed" });
    env.step(1);
    expect(observed.at(-1)?.state).toBe("failed");
    expect(observed.at(-1)?.outgoingState).toBe("waiting");
    director.dispose();
  });

  it("cancels a queued transition when the state reverts before landing", () => {
    const env = new FakeEnvironment();
    const director = new AvatarDirector(env);
    const observed: MotionPresentation[] = [];
    director.register({
      instanceKey: "revert",
      botId: "revert",
      character: "dot",
      state: "working",
      current: true,
      render: (value) => observed.push(value),
    });
    // Queue a waiting transition mid-hop (elapsed < 1260, hopAge < 420).
    env.step(100);
    director.pulse("revert");
    director.update("revert", { state: "waiting" });
    env.step(100);
    expect(observed.at(-1)?.state).toBe("working");
    // Activity reverts before the queued transition lands. Without clearing
    // entry.pending on the revert, the tick after the deadline commits the
    // stale waiting state and the avatar disagrees with its data-state
    // until the next activity change (PR #53 review P2).
    director.update("revert", { state: "working" });
    env.step(400);
    expect(observed.some((value) => value.state === "waiting")).toBe(false);
    expect(observed.at(-1)?.state).toBe("working");
    director.dispose();
  });
});
