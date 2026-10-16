import * as z from "zod";

export const Id = z.string().min(1);
export const IsoDate = z.string().datetime({ offset: true });

export const ActorSchema = z.object({
  userId: Id,
  spaceId: Id,
  email: z.string().email(),
  isDeploymentOwner: z.boolean(),
});
export type Actor = z.infer<typeof ActorSchema>;

export const BOT_COLORS = [
  "#3EC5A8",
  "#F5A03C",
  "#6A6BF5",
  "#9B5CF6",
  "#3B82F6",
  "#F2622A",
  "#D9508A",
] as const;

/** Rollback-compatible color; new character identity is assigned separately. */
export const DEFAULT_BOT_AVATAR_COLOR = "#0a0a0c";

export const RunStatus = z.enum([
  "queued",
  "leased",
  "running",
  "waiting_input",
  "waiting_takeover",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const WaitKind = z.enum(["input", "approval", "takeover"]);
export type WaitKind = z.infer<typeof WaitKind>;

/** What started a Run. Shared by RunSchema and the ExecutionSnapshot read model. */
export const RunTrigger = z.enum([
  "user",
  "routine",
  "delivery",
  "resume",
  "follow_up",
  "reaction",
  "call_end",
  "spawn",
  "skill",
  "bot_message",
  "webhook",
  "messaging",
  "cloud_agent",
  "created",
]);
export type RunTrigger = z.infer<typeof RunTrigger>;

// Existing rows can contain legacy failed/ambiguous/reconciled values; the
// executor currently writes approved/denied/executing/uncertain as well.
export const EffectStatus = z.enum([
  "intended",
  "approved",
  "denied",
  "executing",
  "completed",
  "uncertain",
  "failed",
  "ambiguous",
  "reconciled",
]);
export type EffectStatus = z.infer<typeof EffectStatus>;

export const MemoryScope = z.enum(["bot", "user"]);
export type MemoryScope = z.infer<typeof MemoryScope>;

export const SandboxKind = z.enum([
  "docker",
  "e2b",
  "daytona",
  "createos",
  "box",
  "desktop",
  "fake",
]);
export type SandboxKind = z.infer<typeof SandboxKind>;
