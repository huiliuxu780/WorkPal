import { describe, expect, it } from "vitest";
import {
  outboundChannelForEffect,
  outboundDraftContentFromEffectRequest,
  outboundDraftFingerprint,
} from "./outbound-drafts.js";

describe("outbound draft projection helpers", () => {
  it("fingerprints the exact content and changes with any field", () => {
    const base = {
      recipients: ["ada@example.test"],
      subject: "Weekly digest",
      body: "Hello",
    };
    expect(outboundDraftFingerprint(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(outboundDraftFingerprint(base)).toBe(outboundDraftFingerprint({ ...base }));
    expect(outboundDraftFingerprint({ ...base, body: "Hello!" })).not.toBe(
      outboundDraftFingerprint(base),
    );
    expect(
      outboundDraftFingerprint({ ...base, recipients: ["ada@example.test", "lin@example.test"] }),
    ).not.toBe(outboundDraftFingerprint(base));
  });

  it("reads only a valid email effect request", () => {
    expect(
      outboundDraftContentFromEffectRequest({
        to: ["ada@example.test"],
        subject: "Weekly digest",
        text: "Hello",
      }),
    ).toEqual({
      recipients: ["ada@example.test"],
      subject: "Weekly digest",
      body: "Hello",
    });
    // A non-email tool request never becomes an outbound draft.
    expect(outboundDraftContentFromEffectRequest({ token: "secret" })).toBeNull();
    expect(outboundDraftContentFromEffectRequest({ to: [], subject: "x", text: "y" })).toBeNull();
    expect(
      outboundDraftContentFromEffectRequest({
        to: "ada@example.test",
        subject: "Weekly digest",
        text: "Hello",
      }),
    ).toMatchObject({ recipients: ["ada@example.test"] });
    expect(
      outboundDraftContentFromEffectRequest({
        to: ["ada@example.test"],
        subject: "  ",
        text: "Hello",
      }),
    ).toBeNull();
  });

  it("maps only send_email to the email channel", () => {
    expect(outboundChannelForEffect("send_email")).toBe("email");
    expect(outboundChannelForEffect("send_sms")).toBeNull();
    expect(outboundChannelForEffect("tool")).toBeNull();
  });
});
