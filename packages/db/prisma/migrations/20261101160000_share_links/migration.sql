-- Anonymous read-only links to published page families. The target family and
-- owner scope are stored so resolve can find the latest published version
-- without an authenticated actor; the page body is never copied here.
CREATE TABLE "share_links" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "artifactFamilyId" TEXT NOT NULL,
    "artifactName" TEXT NOT NULL,
    "botId" TEXT,
    "groupId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "share_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "share_links_token_key" ON "share_links"("token");
CREATE INDEX "share_links_spaceId_artifactFamilyId_idx" ON "share_links"("spaceId", "artifactFamilyId");
CREATE INDEX "share_links_expiresAt_idx" ON "share_links"("expiresAt");
