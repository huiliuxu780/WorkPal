import { describe, expect, it } from "vitest";
import {
  containsOneTimeCode,
  containsSecretLikeContent,
  sharesVerbatimRun,
} from "./memory-content-safety.js";

describe("containsSecretLikeContent", () => {
  it.each([
    ["openai-style key", "call me with sk-abcdefghijklmnopqrstuvwxyz"],
    ["github token", "use ghp_ABCDEFGHIJKLMNOPQRSTUVWX for pushes"],
    ["aws key id", "the access key AKIAABCDEFGHIJKLMNOP works"],
    ["slack token", "bot token xoxb-1234567890-abcdefgh"],
    ["private key block", "-----BEGIN RSA PRIVATE KEY----- ..."],
    ["jwt", "header eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N"],
  ])("flags %s", (_label, text) => {
    expect(containsSecretLikeContent(text)).toBe(true);
  });

  it("does not flag ordinary prose", () => {
    expect(containsSecretLikeContent("Deploy window is Sunday morning")).toBe(false);
    expect(containsSecretLikeContent("喜欢用表格汇报状态")).toBe(false);
  });
});

describe("containsOneTimeCode", () => {
  it("flags codes in english and chinese phrasing", () => {
    expect(containsOneTimeCode("the verification code 483921 expires soon")).toBe(true);
    expect(containsOneTimeCode("门禁验证码 483921")).toBe(true);
    expect(containsOneTimeCode("OTP: 998877")).toBe(true);
  });
  it("does not flag ordinary numbers", () => {
    expect(containsOneTimeCode("server listens on port 8080")).toBe(false);
    expect(containsOneTimeCode("release train departs sundays")).toBe(false);
  });
});

describe("sharesVerbatimRun", () => {
  const source =
    "Please remember that our staging database host is db.staging.internal.example.com and restart it mondays";
  it("flags a 60-char verbatim copy of a source message", () => {
    expect(sharesVerbatimRun(source.slice(0, 80), [source])).toBe(true);
  });
  it("accepts a genuine summarized rewording", () => {
    expect(sharesVerbatimRun("Staging database restarts on Mondays", [source])).toBe(false);
  });
  it("ignores short candidates (below the run length)", () => {
    expect(sharesVerbatimRun("short", [source])).toBe(false);
  });
});
