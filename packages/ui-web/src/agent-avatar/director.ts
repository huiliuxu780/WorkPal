import { type AvatarActivity, type AvatarCharacter, avatarIdHash } from "@rakazo/contracts";
import { easeOut, lerp } from "./easing.js";
import { clamp } from "./geometry.js";
import { type MotionFrame, sample } from "./motion.js";

export type MotionPresentation = {
  frame: MotionFrame;
  state: AvatarActivity;
  outgoingState: AvatarActivity | null;
  outgoingScale: number;
  moving: boolean;
};

export type MotionEnvironment = {
  now(): number;
  requestFrame(callback: () => void): number;
  cancelFrame(id: number): void;
  visible(): boolean;
  reducedMotion(): boolean;
  onVisibilityChange(callback: () => void): () => void;
  onMotionChange(callback: () => void): () => void;
};

export type AvatarRegistration = {
  instanceKey: string;
  botId: string;
  character: AvatarCharacter;
  state: AvatarActivity;
  current: boolean;
  render(presentation: MotionPresentation): void;
};

type Entry = AvatarRegistration & {
  enteredAt: number;
  progressAt: number;
  pulseAt: number | null;
  lastPulseAt: number;
  reminderAt: number | null;
  nextReminderAt: number;
  reminderCount: number;
  transition: { from: MotionFrame; fromState: AvatarActivity; startedAt: number } | null;
  pending: { state: AvatarActivity; until: number } | null;
  skipEntrance: boolean;
  releaseAt: number | null;
  lastFrame: MotionFrame;
};

const motionPriority: Record<AvatarActivity, number> = {
  approval: 5,
  waiting: 4,
  working: 3,
  failed: 2,
  idle: 1,
};

const loopPeriod: Record<AvatarActivity, number> = {
  approval: 1600,
  waiting: 4000,
  working: 600,
  failed: 1300,
  idle: 3600,
};

function browserEnvironment(): MotionEnvironment {
  const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  return {
    now: () => performance.now(),
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (id) => window.cancelAnimationFrame(id),
    visible: () => document.visibilityState === "visible",
    reducedMotion: () => media?.matches ?? false,
    onVisibilityChange: (callback) => {
      document.addEventListener("visibilitychange", callback);
      return () => document.removeEventListener("visibilitychange", callback);
    },
    onMotionChange: (callback) => {
      media?.addEventListener("change", callback);
      return () => media?.removeEventListener("change", callback);
    },
  };
}

/** One page-wide clock. Animation allocation and all timers are paused while hidden. */
export class AvatarDirector {
  private readonly entries = new Map<string, Entry>();
  private readonly active = new Set<string>();
  private frameId: number | null = null;
  private logicalOffset = 0;
  private hiddenSince: number | null = null;
  private lastReminderAt = Number.NEGATIVE_INFINITY;
  private readonly unsubscribeVisibility: () => void;
  private readonly unsubscribeMotion: () => void;

  constructor(private readonly environment: MotionEnvironment) {
    this.unsubscribeVisibility = environment.onVisibilityChange(() => this.onEnvironmentChange());
    this.unsubscribeMotion = environment.onMotionChange(() => this.onEnvironmentChange());
    if (!environment.visible()) this.hiddenSince = environment.now();
  }

  private time(): number {
    return (this.hiddenSince ?? this.environment.now()) - this.logicalOffset;
  }

  private onEnvironmentChange() {
    const now = this.environment.now();
    if (!this.environment.visible()) {
      if (this.hiddenSince === null) this.hiddenSince = now;
      this.stopFrame();
      this.renderStatic();
      return;
    }
    if (this.hiddenSince !== null) {
      this.logicalOffset += now - this.hiddenSince;
      this.hiddenSince = null;
    }
    if (this.environment.reducedMotion()) {
      this.stopFrame();
      this.renderStatic();
    } else {
      this.wake();
    }
  }

  register(config: AvatarRegistration): () => void {
    const now = this.time();
    const frame = sample(config.state, 0, avatarIdHash(config.instanceKey) / 2 ** 32, {
      character: config.character,
      static: true,
    });
    const entry: Entry = {
      ...config,
      enteredAt: now,
      progressAt: now,
      pulseAt: null,
      lastPulseAt: Number.NEGATIVE_INFINITY,
      reminderAt: null,
      nextReminderAt: now + 3000,
      reminderCount: 0,
      transition: null,
      pending: null,
      skipEntrance: false,
      releaseAt: null,
      lastFrame: frame,
    };
    this.entries.set(config.instanceKey, entry);
    config.render({
      frame,
      state: config.state,
      outgoingState: null,
      outgoingScale: 0,
      moving: false,
    });
    this.wake();
    return () => {
      this.entries.delete(config.instanceKey);
      this.active.delete(config.instanceKey);
      if (this.entries.size === 0) this.stopFrame();
    };
  }

  update(
    instanceKey: string,
    patch: Partial<Pick<AvatarRegistration, "state" | "current" | "character">>,
  ) {
    const entry = this.entries.get(instanceKey);
    if (!entry) return;
    if (patch.current !== undefined) entry.current = patch.current;
    if (patch.character !== undefined) entry.character = patch.character;
    if (patch.state !== undefined) this.requestState(entry, patch.state);
    this.wake();
  }

  private requestState(entry: Entry, next: AvatarActivity) {
    const now = this.time();
    if (next === entry.state) {
      if (next === "approval" || next === "failed") this.commitState(entry, next, now);
      return;
    }
    if (next !== "failed" && this.active.has(entry.instanceKey)) {
      const elapsed = now - entry.enteredAt;
      const hopAge =
        entry.state === "working" && elapsed < 1260
          ? elapsed % 420
          : entry.pulseAt == null
            ? -1
            : now - entry.pulseAt;
      if (hopAge >= 0 && hopAge < 420) {
        entry.pending = { state: next, until: now + Math.min(420 - hopAge, 420) };
        return;
      }
    }
    this.commitState(entry, next, now);
  }

  private commitState(entry: Entry, next: AvatarActivity, now: number) {
    entry.pending = null;
    entry.transition = { from: entry.lastFrame, fromState: entry.state, startedAt: now };
    entry.state = next;
    entry.enteredAt = now;
    entry.progressAt = now;
    entry.pulseAt = null;
    entry.skipEntrance = false;
    entry.releaseAt = null;
    if (next === "approval") {
      entry.reminderCount = 0;
      entry.reminderAt = null;
      entry.nextReminderAt = now + 3000;
    }
  }

  pulse(instanceKey: string): boolean {
    const entry = this.entries.get(instanceKey);
    if (entry?.state !== "working") return false;
    const now = this.time();
    if (now - entry.lastPulseAt < 2000) return false;
    entry.lastPulseAt = now;
    entry.pulseAt = now;
    this.wake();
    return true;
  }

  progress(instanceKey: string) {
    const entry = this.entries.get(instanceKey);
    if (entry?.state === "working") entry.progressAt = this.time();
  }

  private candidates(now: number): Entry[] {
    return [...this.entries.values()]
      .filter((entry) => entry.state !== "failed" || now - entry.enteredAt < 1300)
      .sort(
        (left, right) =>
          motionPriority[right.state] - motionPriority[left.state] ||
          Number(right.current) - Number(left.current) ||
          avatarIdHash(left.botId) - avatarIdHash(right.botId) ||
          left.instanceKey.localeCompare(right.instanceKey),
      );
  }

  private allocate(now: number): Set<string> {
    const wanted = this.candidates(now).slice(0, 3);
    const wantedKeys = new Set(wanted.map((entry) => entry.instanceKey));
    const held: Entry[] = [];
    for (const key of this.active) {
      const entry = this.entries.get(key);
      if (!entry || (entry.state === "failed" && now - entry.enteredAt >= 1300)) continue;
      if (!wantedKeys.has(key)) {
        if (entry.releaseAt === null) {
          const period = loopPeriod[entry.state];
          const elapsed = Math.max(0, now - entry.enteredAt);
          entry.releaseAt = now + (period - (elapsed % period));
        }
        if (now < entry.releaseAt) held.push(entry);
      }
    }
    const next = new Set(held.map((entry) => entry.instanceKey));
    for (const entry of this.candidates(now)) {
      if (next.size >= 3) break;
      if (!next.has(entry.instanceKey)) next.add(entry.instanceKey);
    }
    for (const key of next) {
      const entry = this.entries.get(key)!;
      if (!this.active.has(key) && now > entry.enteredAt + 30) entry.skipEntrance = true;
      if (wantedKeys.has(key)) entry.releaseAt = null;
    }
    return next;
  }

  private renderStatic() {
    this.active.clear();
    for (const entry of this.entries.values()) {
      const frame = sample(entry.state, 0, 0, { character: entry.character, static: true });
      entry.lastFrame = frame;
      entry.render({
        frame,
        state: entry.state,
        outgoingState: null,
        outgoingScale: 0,
        moving: false,
      });
    }
  }

  private interpolate(from: MotionFrame, to: MotionFrame, progress: number): MotionFrame {
    const mix = (a: number, b: number) => lerp(a, b, progress);
    return {
      body: {
        tx: mix(from.body.tx, to.body.tx),
        ty: mix(from.body.ty, to.body.ty),
        sx: mix(from.body.sx, to.body.sx),
        sy: mix(from.body.sy, to.body.sy),
        rot: mix(from.body.rot, to.body.rot),
      },
      eyes: {
        scale: mix(from.eyes.scale, to.eyes.scale),
        blink: mix(from.eyes.blink, to.eyes.blink),
      },
      pupils: {
        tx: mix(from.pupils.tx, to.pupils.tx),
        ty: mix(from.pupils.ty, to.pupils.ty),
        opacity: mix(from.pupils.opacity, to.pupils.opacity),
      },
      symbol: {
        tx: mix(from.symbol.tx, to.symbol.tx),
        ty: mix(from.symbol.ty, to.symbol.ty),
        rot: mix(from.symbol.rot, to.symbol.rot),
      },
      prop: {
        scale: mix(from.prop.scale, to.prop.scale),
        ty: mix(from.prop.ty, to.prop.ty),
        rot: mix(from.prop.rot, to.prop.rot),
      },
      xeyes: { opacity: mix(from.xeyes.opacity, to.xeyes.opacity) },
      glow: mix(from.glow, to.glow),
      cursor: mix(from.cursor, to.cursor),
    };
  }

  private renderMoving(entry: Entry, now: number) {
    const elapsed = Math.max(0, now - entry.enteredAt);
    const startAt = entry.skipEntrance
      ? entry.state === "working"
        ? 1260
        : entry.state === "approval" || entry.state === "waiting"
          ? 320
          : 0
      : 0;
    const age = elapsed + startAt;
    if (
      entry.state === "approval" &&
      entry.reminderCount < 3 &&
      now >= entry.nextReminderAt &&
      now >= this.lastReminderAt + 2000
    ) {
      entry.reminderAt = now;
      entry.reminderCount += 1;
      entry.nextReminderAt = now + 30_000;
      this.lastReminderAt = now;
    }
    const frame = sample(entry.state, age, avatarIdHash(entry.instanceKey) / 2 ** 32, {
      character: entry.character,
      progressAgeMs: now - entry.progressAt,
      ...(entry.pulseAt !== null ? { pulseAgeMs: now - entry.pulseAt } : {}),
      ...(entry.reminderAt !== null ? { reminderAgeMs: now - entry.reminderAt } : {}),
    });
    let outgoingState: AvatarActivity | null = null;
    let outgoingScale = 0;
    let result = frame;
    if (entry.transition) {
      const transitionAge = now - entry.transition.startedAt;
      if (transitionAge >= 480) entry.transition = null;
      else {
        outgoingState = entry.transition.fromState;
        const crossFade =
          (outgoingState === "approval" && entry.state === "waiting") ||
          (outgoingState === "waiting" && entry.state === "approval");
        outgoingScale = 1 - easeOut(transitionAge / (crossFade ? 200 : 160));
        if (entry.state !== "failed" && transitionAge < 200) {
          result = this.interpolate(entry.transition.from, frame, easeOut(transitionAge / 200));
        }
        if (outgoingState === "failed" && transitionAge < 120) {
          result.xeyes.opacity = Math.max(result.xeyes.opacity, 1 - transitionAge / 120);
          result.pupils.opacity = 1 - result.xeyes.opacity;
        }
      }
    }
    entry.lastFrame = result;
    entry.render({
      frame: result,
      state: entry.state,
      outgoingState,
      outgoingScale: clamp(outgoingScale, 0, 1),
      moving: true,
    });
  }

  private tick = () => {
    this.frameId = null;
    if (!this.environment.visible() || this.environment.reducedMotion()) {
      this.renderStatic();
      return;
    }
    const now = this.time();
    for (const entry of this.entries.values()) {
      if (entry.pending && now >= entry.pending.until)
        this.commitState(entry, entry.pending.state, now);
    }
    const next = this.allocate(now);
    this.active.clear();
    for (const key of next) this.active.add(key);
    for (const entry of this.entries.values()) {
      if (this.active.has(entry.instanceKey)) this.renderMoving(entry, now);
      else {
        const frame = sample(entry.state, 0, 0, { character: entry.character, static: true });
        entry.lastFrame = frame;
        entry.render({
          frame,
          state: entry.state,
          outgoingState: null,
          outgoingScale: 0,
          moving: false,
        });
      }
    }
    if (this.candidates(now).length > 0) this.frameId = this.environment.requestFrame(this.tick);
  };

  private wake() {
    if (
      this.frameId === null &&
      this.entries.size > 0 &&
      this.environment.visible() &&
      !this.environment.reducedMotion()
    ) {
      this.frameId = this.environment.requestFrame(this.tick);
    } else if (this.environment.reducedMotion()) this.renderStatic();
  }

  private stopFrame() {
    if (this.frameId !== null) this.environment.cancelFrame(this.frameId);
    this.frameId = null;
  }

  /** Test diagnostics; never exposed as product state. */
  get movingKeys(): readonly string[] {
    return [...this.active];
  }
  get reminderStarts(): number {
    return [...this.entries.values()].reduce((sum, entry) => sum + entry.reminderCount, 0);
  }

  dispose() {
    this.stopFrame();
    this.entries.clear();
    this.active.clear();
    this.unsubscribeVisibility();
    this.unsubscribeMotion();
  }
}

let singleton: AvatarDirector | null = null;
export function avatarDirector(): AvatarDirector {
  if (typeof window === "undefined") throw new Error("AvatarDirector requires a browser");
  if (singleton === null) singleton = new AvatarDirector(browserEnvironment());
  return singleton;
}
