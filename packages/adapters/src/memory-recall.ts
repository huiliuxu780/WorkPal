import type { MemoryFact, PrismaClient } from "@rakazo/db";

/**
 * First-party fact recall formatting and external-index tombstone filtering
 * (ME-01/ME-02). The external semantic provider is a rebuildable index, never
 * the authority: projected entries carry a fact-id marker, and recall drops
 * any projection whose fact is no longer active, so a deleted memory cannot
 * flow back to the model through a stale index even before cleanup finishes.
 */

export const FACT_PROJECTION_MARKER_PREFIX = "[wp-fact:";

const FACT_MARKER_PATTERN = /^\[wp-fact:([A-Za-z0-9_-]+)\]\s*/;

/** Content written to the external index for one active fact. */
export function buildFactProjectionContent(fact: {
  id: string;
  text: string;
  literalValues: unknown;
}): string {
  const literals = literalPairs(fact.literalValues);
  const body = literals.length > 0 ? `${fact.text} [${literals.join("; ")}]` : fact.text;
  return `${FACT_PROJECTION_MARKER_PREFIX}${fact.id}] ${body}`;
}

/** Fact body as recalled to the model: summarized text plus escaped literals. */
export function formatFactForRecall(fact: MemoryFact): string {
  const literals = literalPairs(fact.literalValues);
  return literals.length > 0 ? `${fact.text} [${literals.join("; ")}]` : fact.text;
}

function literalPairs(literalValues: unknown): string[] {
  if (!literalValues || typeof literalValues !== "object" || Array.isArray(literalValues)) {
    return [];
  }
  return Object.entries(literalValues as Record<string, unknown>)
    .filter(([, value]) => typeof value === "string")
    .map(([key, value]) => `${key}=${String(value)}`);
}

export interface RecalledEntry {
  memory: string;
  id?: string;
  provenance?: string;
  entity?: string;
}

/**
 * Drops external entries whose embedded fact marker points at a fact that is
 * not (or no longer) active in this space. Unmarked legacy entries pass
 * through unchanged — they remain untrusted recalled data, exactly as before.
 */
export async function filterStaleFactProjections(
  prisma: PrismaClient,
  results: RecalledEntry[],
  spaceId: string,
): Promise<RecalledEntry[]> {
  const markedIds = new Set<string>();
  for (const result of results) {
    const match = FACT_MARKER_PATTERN.exec(result.memory);
    if (match) markedIds.add(match[1]!);
  }
  if (markedIds.size === 0) return results;
  const facts = await prisma.memoryFact.findMany({
    where: { id: { in: [...markedIds] }, spaceId },
    select: { id: true, state: true, expiresAt: true },
  });
  const now = Date.now();
  const activeIds = new Set(
    facts
      .filter(
        (fact) =>
          fact.state === "active" &&
          (fact.expiresAt === null || fact.expiresAt.getTime() > now),
      )
      .map((fact) => fact.id),
  );
  return results.filter((result) => {
    const match = FACT_MARKER_PATTERN.exec(result.memory);
    if (!match) return true;
    return activeIds.has(match[1]!);
  });
}
