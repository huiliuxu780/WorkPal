import { spawn } from "node:child_process";

/**
 * Outgoing mail through the deployment-connected `agently-cli` binary
 * (QQ Agently mailbox). The OAuth identity lives in the host keychain, so this
 * is a deployment-level sender: every bot mails from the one signed-in address.
 * Human approval is enforced upstream — the run executor gates `send_email`
 * behind explicit per-send approval, which is why the CLI's own interactive
 * confirmation is skipped with `--confirmed`.
 */

export const AGENTLY_MAIL_MAX_RECIPIENTS = 20;
export const AGENTLY_MAIL_MAX_SUBJECT_CHARS = 200;
export const AGENTLY_MAIL_MAX_BODY_BYTES = 64 * 1024;
const MAIL_OUTPUT_LIMIT_BYTES = 262_144;

export interface AgentlyMailMessage {
  to: readonly string[];
  subject: string;
  text: string;
}

export interface AgentlyMailRunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type AgentlyMailInvocation = (
  args: readonly string[],
  signal: AbortSignal,
) => Promise<AgentlyMailRunResult>;

export interface AgentlyMailServiceOptions {
  bin?: string;
  /** Test seam: replaces the child-process spawn entirely. */
  invoke?: AgentlyMailInvocation;
  timeoutMs?: number;
}

export type AgentlyMailResult =
  | { ok: true; sent_to: string[]; message_id?: string }
  | { error: string; uncertain?: true };

function uncertainMailResult(): { error: string; uncertain: true } {
  return {
    error: "Mail sending was interrupted. It is unknown whether the recipient server accepted the message. Check the mailbox before sending again.",
    uncertain: true,
  };
}

const RECIPIENT_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export function validateOutgoingMail(message: AgentlyMailMessage): string | undefined {
  const recipients = message.to.map((address) => address.trim()).filter(Boolean);
  if (
    recipients.length < 1 ||
    recipients.length > AGENTLY_MAIL_MAX_RECIPIENTS ||
    recipients.some(
      (address) =>
        address.length > 320 || !RECIPIENT_PATTERN.test(address) || address !== address.trim(),
    )
  ) {
    return `Provide 1-${AGENTLY_MAIL_MAX_RECIPIENTS} valid recipient email addresses.`;
  }
  if (message.to.length !== recipients.length || new Set(recipients).size !== recipients.length) {
    return "Recipient addresses must be non-empty and unique.";
  }
  const subject = message.subject;
  if (!subject.trim() || subject.length > AGENTLY_MAIL_MAX_SUBJECT_CHARS) {
    return `Subject must be non-empty and at most ${AGENTLY_MAIL_MAX_SUBJECT_CHARS} characters.`;
  }
  if (!message.text.trim()) {
    return "The email body must not be empty.";
  }
  if (Buffer.byteLength(message.text, "utf8") > AGENTLY_MAIL_MAX_BODY_BYTES) {
    return `The email body must be at most ${Math.floor(AGENTLY_MAIL_MAX_BODY_BYTES / 1024)} KB.`;
  }
  return undefined;
}

/** Pull the JSON object out of CLI stdout; the binary may append hint lines. */
function parseJsonOutput(stdout: string): Record<string, unknown> | undefined {
  const text = stdout.trim();
  if (!text) return undefined;
  const candidates = [text];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      /* Try the next candidate. */
    }
  }
  return undefined;
}

function firstLine(value: string, limit: number): string {
  const line = value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)[0];
  if (!line) return "";
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

function failureText(run: AgentlyMailRunResult, payload?: Record<string, unknown>): string {
  const fromPayload = payload && typeof payload.error === "string" ? payload.error : undefined;
  const detail =
    fromPayload ||
    firstLine(run.stderr, 300) ||
    firstLine(run.stdout, 300) ||
    "the mail sender returned a failure without details.";
  return `Mail sending failed: ${detail}`;
}

function cliEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // The CLI needs a home for its keychain-backed token and a PATH to load
  // system libraries; nothing else from the backend environment is its business.
  const picked: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR"]) {
    const value = source[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked;
}

function spawnAgentlyCli(bin: string, timeoutMs: number): AgentlyMailInvocation {
  return (args, signal) =>
    new Promise<AgentlyMailRunResult>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(bin, [...args], {
          stdio: ["ignore", "pipe", "pipe"],
          env: cliEnvironment(process.env),
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      let stdout = "";
      let stderr = "";
      const append = (buffer: string, chunk: Buffer | string): string =>
        buffer.length >= MAIL_OUTPUT_LIMIT_BYTES ? buffer : buffer + String(chunk);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      };
      let timedOut = false;
      const onAbort = () => child.kill("SIGKILL");
      const timer = setTimeout(() => {
        timedOut = true;
        onAbort();
      }, timeoutMs);
      signal.addEventListener("abort", onAbort, { once: true });
      child.once("error", (error) => {
        cleanup();
        reject(error);
      });
      child.once("close", (code) => {
        cleanup();
        resolve({ code: code ?? -1, stdout, stderr, timedOut });
      });
    });
}

export class AgentlyMailService {
  private readonly bin: string;
  private readonly invoke: AgentlyMailInvocation;
  private readonly timeoutMs: number;

  constructor(options: AgentlyMailServiceOptions = {}) {
    this.bin = options.bin?.trim() || "agently-cli";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.invoke = options.invoke ?? spawnAgentlyCli(this.bin, this.timeoutMs);
  }

  describe() {
    return {
      id: "agently-cli",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { transactional: true },
    };
  }

  async send(message: AgentlyMailMessage, signal: AbortSignal): Promise<AgentlyMailResult> {
    const invalid = validateOutgoingMail(message);
    if (invalid) return { error: invalid };
    const recipients = [...new Set(message.to.map((address) => address.trim()))];
    const args = [
      "message",
      "+send",
      "--confirmed",
      "--subject",
      message.subject,
      "--body",
      message.text,
    ];
    for (const address of recipients) args.push("--to", address);
    let run: AgentlyMailRunResult;
    try {
      run = await this.invoke(args, signal);
    } catch {
      if (signal.aborted) return uncertainMailResult();
      return {
        error:
          "The mail sender (agently-cli) is unavailable on this server. Ask the operator to install it and complete agently-cli auth login.",
      };
    }
    if (run.timedOut || signal.aborted || run.code < 0) return uncertainMailResult();
    const payload = parseJsonOutput(run.stdout);
    if (run.code !== 0 || payload?.ok === false) {
      return { error: failureText(run, payload) };
    }
    const data =
      payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data)
        ? (payload.data as Record<string, unknown>)
        : {};
    const messageId =
      typeof data.message_id === "string"
        ? data.message_id
        : typeof data.id === "string"
          ? data.id
          : undefined;
    return { ok: true, sent_to: recipients, ...(messageId ? { message_id: messageId } : {}) };
  }

  /** The primary alias of the signed-in mailbox. Never includes tokens. */
  async account(
    signal: AbortSignal,
  ): Promise<{ email: string; name?: string } | { error: string }> {
    let run: AgentlyMailRunResult;
    try {
      run = await this.invoke(["+me"], signal);
    } catch {
      return { error: "The mail sender (agently-cli) is unavailable on this server." };
    }
    if (run.code !== 0) {
      return { error: failureText(run, parseJsonOutput(run.stdout)) };
    }
    const payload = parseJsonOutput(run.stdout);
    const data =
      payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data)
        ? (payload.data as Record<string, unknown>)
        : undefined;
    const aliases = Array.isArray(data?.aliases) ? (data!.aliases as unknown[]) : [];
    const entries = aliases.filter(
      (alias): alias is Record<string, unknown> =>
        Boolean(alias) && typeof alias === "object" && !Array.isArray(alias),
    );
    const primary = entries.find((alias) => alias.is_primary === true) ?? entries[0];
    const email = primary && typeof primary.email === "string" ? primary.email : undefined;
    if (!email) {
      return { error: "Not signed in to Agently mail. Run: agently-cli auth login" };
    }
    return { email, ...(typeof primary?.name === "string" ? { name: primary.name } : {}) };
  }
}
