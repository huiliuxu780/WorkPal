import type { ThreadMessage } from "@rakazo/contracts";
import { Prisma, type PrismaClient } from "@rakazo/db";

type Db = PrismaClient | Prisma.TransactionClient;

export type LatestPublishedArtifactRow = {
  id: string;
  botId: string | null;
  groupId: string | null;
  runId: string | null;
  name: string;
  description: string | null;
  mimeType: string;
  size: number;
  storageKey: string;
  version: number;
  createdAt: Date;
};

/**
 * Latest version in each family that a message actually carries. The artifact
 * row is written before its message; an interrupted publish must not make an
 * older card stale while no new card exists.
 */
export async function latestPublishedFamilyVersions(
  prisma: Pick<Db, "$queryRaw">,
  familyIds: readonly string[],
): Promise<Map<string, number>> {
  if (familyIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Array<{ familyId: string; latestVersion: number }>>(
    Prisma.sql`
      SELECT COALESCE(a."rootArtifactId", a.id) AS "familyId",
             MAX(a.version)::int AS "latestVersion"
      FROM "artifacts" a
      WHERE COALESCE(a."rootArtifactId", a.id) IN (${Prisma.join(familyIds)})
        AND a."runId" IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM "messages" m
          WHERE m."runId" = a."runId"
            AND m."blocks" @> jsonb_build_array(jsonb_build_object('artifactId', a.id))
        )
      GROUP BY COALESCE(a."rootArtifactId", a.id)
    `,
  );
  return new Map(rows.map((row) => [row.familyId, Number(row.latestVersion)]));
}

export async function findLatestPublishedArtifactRow(
  prisma: Pick<Db, "$queryRaw">,
  scope: { spaceId: string; userId: string; botId?: string; groupId?: string },
  familyId: string,
): Promise<LatestPublishedArtifactRow | null> {
  const scopeFilter = scope.groupId
    ? Prisma.sql`AND a."groupId" = ${scope.groupId}`
    : Prisma.sql`AND a."botId" = ${scope.botId} AND a."groupId" IS NULL`;
  const rows = await prisma.$queryRaw<LatestPublishedArtifactRow[]>(Prisma.sql`
    SELECT a.id, a."botId", a."groupId", a."runId", a.name, a.description,
           a."mimeType", a.size, a."storageKey", a.version, a."createdAt"
    FROM "artifacts" a
    WHERE (a.id = ${familyId} OR a."rootArtifactId" = ${familyId})
      AND a."spaceId" = ${scope.spaceId}
      AND a."userId" = ${scope.userId}
      ${scopeFilter}
      AND a."runId" IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM "messages" m
        WHERE m."runId" = a."runId"
          AND m."blocks" @> jsonb_build_array(jsonb_build_object('artifactId', a.id))
      )
    ORDER BY a.version DESC, a."createdAt" DESC
    LIMIT 1
  `);
  return rows[0] ?? null;
}

/** Backfills family/version fields onto file blocks loaded from old rows. */
export async function enrichFileArtifactBlocks(
  prisma: Pick<Db, "artifact" | "$queryRaw">,
  messages: readonly ThreadMessage[],
): Promise<ThreadMessage[]> {
  const artifactIds = new Set<string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.kind === "file") artifactIds.add(block.artifactId);
    }
  }
  if (artifactIds.size === 0) return [...messages];

  const rows = await prisma.artifact.findMany({
    where: { id: { in: [...artifactIds] } },
    select: { id: true, rootArtifactId: true, version: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const families = [...new Set(rows.map((row) => row.rootArtifactId ?? row.id))];
  const latest = await latestPublishedFamilyVersions(prisma, families);

  return messages.map((message) => {
    let blocks = message.blocks;
    blocks.forEach((block, index) => {
      if (block.kind !== "file") return;
      const row = byId.get(block.artifactId);
      if (!row) return;
      const familyId = row.rootArtifactId ?? row.id;
      const latestVersion = latest.get(familyId) ?? row.version;
      if (
        block.rootArtifactId === familyId &&
        block.version === row.version &&
        block.latestVersion === latestVersion
      ) {
        return;
      }
      if (blocks === message.blocks) blocks = [...blocks];
      blocks[index] = { ...block, rootArtifactId: familyId, version: row.version, latestVersion };
    });
    return blocks === message.blocks ? message : { ...message, blocks };
  });
}
