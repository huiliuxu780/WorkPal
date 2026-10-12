import { describe, expect, it, vi } from "vitest";
import {
  AGENTLY_MAIL_MAX_RECIPIENTS,
  type AgentlyMailInvocation,
  AgentlyMailService,
  validateOutgoingMail,
} from "./agently-mail.js";

const signal = AbortSignal.timeout(5_000);

function serviceWith(run: { code: number; stdout: string; stderr: string }) {
  const invoke = vi.fn<AgentlyMailInvocation>(async () => run);
  return { service: new AgentlyMailService({ invoke }), invoke };
}

describe("AgentlyMailService.send", () => {
  it("builds the non-interactive CLI call and parses the message id", async () => {
    const { service, invoke } = serviceWith({
      code: 0,
      stdout: '{"ok":true,"data":{"message_id":"msg_001"}}\ntip: agently-cli message +list',
      stderr: "",
    });
    const result = await service.send(
      { to: ["bob@example.com", "alice@example.com"], subject: "Hi", text: "Hello" },
      signal,
    );
    expect(result).toEqual({
      ok: true,
      sent_to: ["bob@example.com", "alice@example.com"],
      message_id: "msg_001",
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    const [args, passedSignal] = invoke.mock.calls[0]!;
    expect(passedSignal).toBe(signal);
    expect(args.slice(0, 2)).toEqual(["message", "+send"]);
    expect(args).toContain("--confirmed");
    expect(args).toEqual([
      "message",
      "+send",
      "--confirmed",
      "--subject",
      "Hi",
      "--body",
      "Hello",
      "--to",
      "bob@example.com",
      "--to",
      "alice@example.com",
    ]);
  });

  it("reports a failed exit with the first stderr line and without secrets", async () => {
    const { service } = serviceWith({
      code: 1,
      stdout: "",
      stderr:
        "SMTP relay refused\nDetail line that should not leak.\nDetail line that should not leak.",
    });
    const result = await service.send(
      { to: ["bob@example.com"], subject: "Hi", text: "Hello" },
      signal,
    );
    expect(result).toEqual({ error: "Mail sending failed: SMTP relay refused" });
  });

  it("treats a zero exit with ok:false as failure", async () => {
    const { service } = serviceWith({
      code: 0,
      stdout: '{"ok":false,"error":"daily send quota reached (50)"}',
      stderr: "",
    });
    const result = await service.send(
      { to: ["bob@example.com"], subject: "Hi", text: "Hello" },
      signal,
    );
    expect(result).toEqual({ error: "Mail sending failed: daily send quota reached (50)" });
  });

  it("maps a missing binary to an operator-facing error", async () => {
    const invoke = vi.fn<AgentlyMailInvocation>(async () => {
      throw new Error("ENOENT");
    });
    const service = new AgentlyMailService({ invoke });
    const result = await service.send(
      { to: ["bob@example.com"], subject: "Hi", text: "Hello" },
      signal,
    );
    expect(result).toEqual({
      error:
        "The mail sender (agently-cli) is unavailable on this server. Ask the operator to install it and complete agently-cli auth login.",
    });
  });

  it("rejects duplicate recipients without invoking the CLI", async () => {
    const { service, invoke } = serviceWith({
      code: 0,
      stdout: '{"ok":true,"data":{}}',
      stderr: "",
    });
    const result = await service.send(
      { to: ["bob@example.com", "bob@example.com"], subject: "Hi", text: "Hello" },
      signal,
    );
    expect(result).toEqual({ error: "Recipient addresses must be non-empty and unique." });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    [[], "1-20 valid recipient"],
    [["not-an-email"], "1-20 valid recipient"],
    [
      Array.from({ length: AGENTLY_MAIL_MAX_RECIPIENTS + 1 }, (_, i) => `a${i}@example.com`),
      "1-20 valid recipient",
    ],
    [["bob@example.com"], "Subject"],
  ] as const)("rejects body/subject issues before invoking the CLI", async (to, expectFragment) => {
    const { service, invoke } = serviceWith({ code: 0, stdout: "{}", stderr: "" });
    const result = await service.send(
      { to, subject: expectFragment === "Subject" ? "" : "Hi", text: "Hello" },
      signal,
    );
    expect(result).toEqual({ error: expect.stringContaining(expectFragment as string) });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects an oversized body", async () => {
    const { service } = serviceWith({ code: 0, stdout: "{}", stderr: "" });
    const result = await service.send(
      { to: ["bob@example.com"], subject: "Hi", text: "x".repeat(64 * 1024 + 1) },
      signal,
    );
    expect(result).toEqual({ error: expect.stringContaining("64 KB") });
  });

  it("validates multibyte body size in bytes, not characters", () => {
    expect(
      validateOutgoingMail({ to: ["bob@example.com"], subject: "Hi", text: "字".repeat(22_000) }),
    ).toContain("64 KB");
  });
});

describe("AgentlyMailService.account", () => {
  it("returns the primary alias from +me output", async () => {
    const { service } = serviceWith({
      code: 0,
      stdout:
        '{"ok":true,"data":{"aliases":[{"alias_id":"a1","email":"buzz@agent.qq.com","is_primary":true,"name":"buzz"},{"email":"other@agent.qq.com","is_primary":false}]}}\ntip: agently-cli message +list',
      stderr: "",
    });
    expect(await service.account(signal)).toEqual({ email: "buzz@agent.qq.com", name: "buzz" });
  });

  it("reports not signed in when the mailbox lists no alias", async () => {
    const { service } = serviceWith({
      code: 0,
      stdout: '{"ok":true,"data":{"aliases":[]}}',
      stderr: "",
    });
    expect(await service.account(signal)).toEqual({
      error: "Not signed in to Agently mail. Run: agently-cli auth login",
    });
  });
});
