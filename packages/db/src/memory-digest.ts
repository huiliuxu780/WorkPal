import { createHash, createHmac } from "node:crypto";

/**
 * Server-keyed HMAC for evidence dedupe. A plain hash of short user content is
 * guessable and would leak the source text through the digest column, so
 * evidence digests are always keyed with material derived from the
 * deployment's encryption key (ME-01 M1).
 */
export function deriveMemoryDigestKey(encryptionKey: string): string {
  return createHash("sha256")
    .update(`workpal-memory-evidence-digest-v1\u0000${encryptionKey}`)
    .digest("hex");
}

export function memoryEvidenceDigest(digestKey: string, content: string): string {
  return createHmac("sha256", digestKey).update(content, "utf8").digest("hex");
}

/** Stable digest of a { shardId: version } map, independent of key order. */
export function sourceVersionDigest(sourceVersions: Record<string, number>): string {
  const canonical = Object.keys(sourceVersions)
    .sort()
    .map((shardId) => `${shardId}:${sourceVersions[shardId]}`)
    .join(",");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Deterministic identity of a proposition inside its scope: normalized text
 * (NFKC, case-folded, whitespace-collapsed, boundary punctuation trimmed).
 * This is the exact-dedupe anchor only; semantic conflicts are handled through
 * explicit corrections and supersede links, never by comparing body hashes.
 */
export function canonicalKeyFor(kind: string, text: string): string {
  const normalized = normalizeFactText(text);
  const digest = createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 40);
  return `${kind}:${digest}`;
}

export function normalizeFactText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\p{P}\p{S}\p{Z}]+/u, "")
    .replace(/[\p{P}\p{S}\p{Z}]+$/u, "")
    .trim();
}

/** Audit-safe digest of compaction inputs (transcript + previous summary). */
export function compactionInputDigest(digestKey: string, parts: string[]): string {
  const hmac = createHmac("sha256", digestKey);
  for (const part of parts) {
    hmac.update(part, "utf8");
    hmac.update("\u0000", "utf8");
  }
  return hmac.digest("hex");
}
