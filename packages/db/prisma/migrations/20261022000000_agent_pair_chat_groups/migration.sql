-- RT-02 expand step: fixed Agent pair identity.
--
-- One pair of Bots inside a Space owns exactly one long-lived agent_pair
-- ChatGroup and Thread, no matter who contacts first. Every existing row is a
-- user-managed group, so kind backfills to 'standard' and pairKey stays NULL:
-- no row is rewritten and no current reader changes behaviour.
--
-- The unordered pair identity lives in a partial unique index instead of a
-- plain unique pair, because standard groups carry no pairKey and must stay
-- unlimited. pairKey is a SHA-256 over the sorted Bot ids, so A->B and B->A
-- resolve to one key and a rename or avatar change cannot move a pair onto a
-- different identity. The kind CHECK keeps a misspelt kind from escaping both
-- the partial index and the standard-group read filters; the pairKey CHECK
-- keeps the discriminator and the identity column from drifting apart.

ALTER TABLE "chat_groups" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE "chat_groups" ADD COLUMN "pairKey" TEXT;

ALTER TABLE "chat_groups" ADD CONSTRAINT "chat_groups_kind_chk" CHECK (
    "kind" IN ('standard', 'agent_pair')
);

ALTER TABLE "chat_groups" ADD CONSTRAINT "chat_groups_pair_key_chk" CHECK (
    ("kind" = 'agent_pair') = ("pairKey" IS NOT NULL)
);

CREATE UNIQUE INDEX "chat_groups_spaceId_pairKey_agent_pair"
    ON "chat_groups"("spaceId", "pairKey")
    WHERE "kind" = 'agent_pair';
