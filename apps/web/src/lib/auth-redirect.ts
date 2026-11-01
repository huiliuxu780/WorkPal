/**
 * Only same-origin absolute paths are valid post-auth destinations; protocol
 * relative (`//host`) and absolute URLs would turn the login page into an
 * open redirect.
 */
export function safeNextPath(value: string | null | undefined): string | null {
  if (!value?.startsWith("/") || value.startsWith("//")) return null;
  return value;
}
