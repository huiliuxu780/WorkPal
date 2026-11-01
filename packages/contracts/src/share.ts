import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

export const SHARE_CUSTOM_DAYS_MIN = 1;
export const SHARE_CUSTOM_DAYS_MAX = 90;

/**
 * Lifetime presets for a public page link. There is deliberately no "never"
 * variant: the owner must always choose when the link stops working.
 */
export const ShareExpirySchema = z
  .object({
    preset: z.enum(["24h", "7d", "30d", "custom"]),
    customDays: z.number().int().min(SHARE_CUSTOM_DAYS_MIN).max(SHARE_CUSTOM_DAYS_MAX).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.preset === "custom" && value.customDays === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "customDays is required for a custom expiry",
        path: ["customDays"],
      });
    }
    if (value.preset !== "custom" && value.customDays !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "customDays is only valid for a custom expiry",
        path: ["customDays"],
      });
    }
  });
export type ShareExpiry = z.infer<typeof ShareExpirySchema>;

export const ShareLinkSchema = z.object({
  token: z.string().min(20).max(128),
  expiresAt: IsoDate,
  createdAt: IsoDate,
});
export type ShareLink = z.infer<typeof ShareLinkSchema>;

/** Owner-side view of one page family's sharing state. */
export const ShareOverviewSchema = z.object({
  spaceId: Id,
  familyId: Id,
  /** Unrevoked, unexpired public link; null when the page has none. */
  publicLink: ShareLinkSchema.nullable(),
});
export type ShareOverview = z.infer<typeof ShareOverviewSchema>;

/** Login-scoped Space link payload: readable by any member of that Space. */
export const SpaceShareViewSchema = z.strictObject({
  name: z.string(),
  html: z.string(),
});
export type SpaceShareView = z.infer<typeof SpaceShareViewSchema>;

export const PublicShareViewSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("ok"),
      name: z.string(),
      html: z.string(),
      expiresAt: IsoDate,
    })
    .strict(),
  z.object({ state: z.literal("revoked"), name: z.string() }).strict(),
  z.object({ state: z.literal("expired"), name: z.string() }).strict(),
  z.object({ state: z.literal("invalid") }).strict(),
]);
export type PublicShareView = z.infer<typeof PublicShareViewSchema>;
