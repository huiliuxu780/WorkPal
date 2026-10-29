const REDACTED = "[Redacted]";
const REDACT_KEYS = new Set([
  "email",
  "prompt",
  "message",
  "messages",
  "body",
  "query",
  "rawheaders",
  "headers",
  "passwd",
  "api_key",
]);
const SECRET_KEY = /password|secret|token|authorization|cookie|credential|apikey/;

function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactSensitiveText(value);
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }
  if (value instanceof Error) {
    const output: Record<string, unknown> = {
      name: value.name || "Error",
      message: redactSensitiveText(value.message),
    };
    if (typeof value.stack === "string" && value.stack.length > 0) {
      output.stack = redactSensitiveText(value.stack);
    }
    if (value.cause !== undefined) {
      output.cause =
        typeof value.cause === "string"
          ? redactSensitiveText(value.cause)
          : redactValue(value.cause, seen);
    }
    return output;
  }
  if (value instanceof Date) return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = shouldRedactKey(key) ? REDACTED : redactValue(nested, seen);
  }
  return output;
}

export function redactBindings(bindings: Record<string, unknown>): Record<string, unknown> {
  return redactValue(bindings) as Record<string, unknown>;
}

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER = /\bBearer\s+[^\s"',;&]+/gi;
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:password|secret|token|authorization|apikey|api_key)[A-Za-z0-9_]*)\s*[:=]\s*\S+/gi;
const JSON_SECRET_FIELD =
  /"(password|passwd|secret|token|authorization|apikey|api_key|accesstoken|refreshtoken|email|cookie)"\s*:\s*"(?:\\.|[^"\\])*"/gi;
const BARE_SECRET =
  /\b(?:sk-(?:or-v1-)?[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:ak_|ck_)[A-Za-z0-9]+)\b/g;
// RUNTIME-RELIABILITY-01: a DSN carries credentials in its authority. The scheme
// survives so a failure is still attributable to the right integration.
const DSN = /\b([a-z][a-z0-9+.-]*):\/\/[^\s/:@]+:[^\s@]*@[^\s/?#]+/gi;
// Loopback, RFC1918, link-local and internal-name hosts identify a private
// network. The path survives so the call stays diagnosable.
const PRIVATE_URL =
  /\b([a-z][a-z0-9+.-]*):\/\/(?:[^\s/?#@]*@)?(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2}|\[[0-9a-f:]+\]|[^\s/?#@]*\.(?:local|internal|lan))(?::\d+)?/gi;
// Host paths identify the machine and the account running it. Container paths
// under /app are not host identity and are left alone.
const HOST_PATH = /(?:\/Users\/|\/home\/|\/var\/folders\/)[^\s"',;)\]}]+/g;
const WINDOWS_HOST_PATH = /\b[A-Za-z]:\\Users\\[^\s"',;)\]}]+/g;

export function redactSensitiveText(text: string): string {
  return text
    .replace(EMAIL, REDACTED)
    .replace(JSON_SECRET_FIELD, `"$1":"${REDACTED}"`)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(BARE_SECRET, REDACTED)
    .replace(DSN, `$1://${REDACTED}`)
    .replace(PRIVATE_URL, `$1://${REDACTED}`)
    .replace(HOST_PATH, REDACTED)
    .replace(WINDOWS_HOST_PATH, REDACTED);
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9_]/g, "");
  return REDACT_KEYS.has(normalized) || SECRET_KEY.test(normalized);
}
