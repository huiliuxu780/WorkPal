import { describe, expect, it } from "vitest";
import {
  attachedImageArtifactIds,
  encodeBotAvatarImage,
  normalizeEncodedBotAvatarImage,
  resolveUpdateBotAvatar,
} from "./bot-avatar.js";
import { builtinAgentTools } from "./builtin-tools.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

describe("bot avatar encoding", () => {
  it("encodes an attached image as a square webp data URL", async () => {
    const dataUrl = await encodeBotAvatarImage(PNG_1X1);
    expect(dataUrl.startsWith("data:image/webp;base64,")).toBe(true);
    expect(dataUrl.length).toBeGreaterThan("data:image/webp;base64,".length);
  });

  it("normalizes a valid direct upload and rejects invalid image data", async () => {
    const source = `data:image/png;base64,${PNG_1X1.toString("base64")}`;
    await expect(normalizeEncodedBotAvatarImage(source)).resolves.toMatch(
      /^data:image\/webp;base64,/,
    );
    await expect(normalizeEncodedBotAvatarImage("data:image/png;base64,AA==")).rejects.toThrow();
    await expect(normalizeEncodedBotAvatarImage("data:image/gif;base64,AAAA")).rejects.toThrow();
  });

  it("lists attached image artifact ids in order", () => {
    expect(
      attachedImageArtifactIds([
        { kind: "text", text: "hi" },
        { kind: "image", artifactId: "img-1", mimeType: "image/png", name: "a.png" },
        { kind: "image", artifactId: "img-2", mimeType: "image/jpeg", name: "b.jpg" },
      ]),
    ).toEqual(["img-1", "img-2"]);
  });

  it("resolves hex color writes", async () => {
    await expect(
      resolveUpdateBotAvatar({
        color: "#8B5CF6::shape_2",
        sourceImageArtifactIds: [],
        loadArtifact: async () => null,
      }),
    ).resolves.toEqual({ color: "#8B5CF6::shape_2" });
  });

  it("rejects remote URLs and missing attached images", async () => {
    await expect(
      resolveUpdateBotAvatar({
        color: "https://evil.example/x.png",
        sourceImageArtifactIds: [],
        loadArtifact: async () => null,
      }),
    ).resolves.toMatchObject({ error: expect.stringContaining("hex") });
    await expect(
      resolveUpdateBotAvatar({
        useAttachedImage: true,
        sourceImageArtifactIds: [],
        loadArtifact: async () => null,
      }),
    ).resolves.toEqual({ error: "No attached image on this message." });
  });

  it("loads only the requested space image", async () => {
    const loadArtifact = async (id: string) => (id === "img-2" ? new Uint8Array(PNG_1X1) : null);
    const fromId = await resolveUpdateBotAvatar({
      artifactId: "img-2",
      sourceImageArtifactIds: ["img-1", "img-2"],
      loadArtifact,
    });
    expect("color" in fromId && fromId.color.startsWith("data:image/webp;base64,")).toBe(true);

    const fromLatest = await resolveUpdateBotAvatar({
      useAttachedImage: true,
      sourceImageArtifactIds: ["img-1", "img-2"],
      loadArtifact,
    });
    expect("color" in fromLatest && fromLatest.color.startsWith("data:image/webp;base64,")).toBe(
      true,
    );

    await expect(
      resolveUpdateBotAvatar({
        artifactId: "other-space",
        sourceImageArtifactIds: ["img-2"],
        loadArtifact,
      }),
    ).resolves.toEqual({
      error: "Image is not in this space or is not an attached picture.",
    });
  });
});

describe("update_bot tool schema", () => {
  it("keeps avatar writes out of the general profile tool", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "update_bot");
    if (!tool) throw new Error("missing update_bot");
    const properties =
      (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(properties).sort()).toEqual([
      "description",
      "name",
      "notifyOnFinish",
      "title",
    ]);
    const change = builtinAgentTools.find((entry) => entry.name === "change_avatar");
    expect(change).toBeDefined();
    expect((change!.inputSchema as { oneOf?: unknown[] }).oneOf).toHaveLength(2);
  });
});
