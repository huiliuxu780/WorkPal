import { describe, expect, it } from "vitest";
import {
  containsMemoryRefusal,
  containsOneTimeCode,
  containsSecretLikeContent,
  isMemoryAuthorizationQuote,
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

describe("containsMemoryRefusal", () => {
  it.each([
    "Please summarize this web page. Do not save anything as memory.",
    "don't remember this conversation",
    "Answer briefly, without saving anything.",
    "never store my preferences",
    "总结网页，不要保存记忆",
    "别记这个",
    "请勿记录本次对话",
    "不用保存这些内容",
  ])("flags an explicit refusal: %s", (text) => {
    expect(containsMemoryRefusal(text)).toBe(true);
  });

  it.each([
    "remember that the deploy host is alpha",
    "Do you recall what we decided about the deploy window?",
    "I don't recall the exact hostname, check the docs",
    "save the report to the shared drive",
    "记住部署窗口是周日",
  ])("does not flag ordinary or affirmative phrasing: %s", (text) => {
    expect(containsMemoryRefusal(text)).toBe(false);
  });
});

describe("isMemoryAuthorizationQuote (review R2)", () => {
  it.each([
    "remember that the deploy window is Sunday",
    "Please remember the milk",
    "remember this: staging restarts mondays",
    "Summarize the page. Remember that I prefer Fridays.",
    "make a note of the new host",
    "note this down for the release",
    "keep this in mind for the release",
    "don't forget to record the outcome",
    "save this to memory",
    "Please store that decision in your memory",
    "add the deploy window to your memory",
    "记住部署窗口是周日",
    "帮我记一下这个决定",
    "别忘了周五发报告",
    "把这条保存到记忆里",
    "记入备忘",
  ])("accepts an explicit long-term-memory request: %s", (quote) => {
    expect(isMemoryAuthorizationQuote(quote)).toBe(true);
  });

  it.each([
    "Please summarize this web page.",
    "The user prefers reports sent every Friday.",
    "what is the release schedule?",
    "I remember that day fondly",
    "we decided to save the report to the drive",
    "don't save this as a memory",
    "我记得部署窗口的事",
    "总结一下这个网页",
    // Review R3: ambiguous storage directives are file/data operations, not
    // long-term-memory authorization — they must demote to candidates.
    "Save this invoice as a PDF in Downloads.",
    "Save that decision for later",
    "Store the report in the shared drive",
    "note the changes in the document",
    "Record the meeting and upload it",
    "请把这条保存起来",
    "把发票保存到下载目录",
    "把这个文件存一下",
  ])("refuses a quote that is not a long-term-memory request: %s", (quote) => {
    expect(isMemoryAuthorizationQuote(quote)).toBe(false);
  });
});
