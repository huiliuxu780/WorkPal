# Upstream Synchronization

The fork keeps `main` as a clean mirror of Rakazo upstream. Fork product work belongs on `develop`
and topic branches. This makes upstream history easy to audit and prevents routine syncs from
mixing with product changes.

## Remote contract

```text
origin   https://github.com/huiliuxu780/rakazo.git
upstream https://github.com/elie222/rakazo.git
```

Verify before each sync:

```bash
git remote -v
git status --short --branch
```

Do not continue with an unexpected remote, branch, or uncommitted change. Preserve or finish local
work first; never discard it just to make the sync command succeed.

## Routine sync

```bash
git fetch --prune upstream

git switch main
git merge --ff-only upstream/main
git push origin main

git switch develop
git merge --no-ff main
git push origin develop
```

Use `--ff-only` on `main`. Because fork commits never land there, a non-fast-forward is evidence
that the branch contract was broken and should be investigated rather than hidden in a merge.

Use a merge from `main` into the shared `develop` branch. This preserves published history and
records exactly when upstream entered the fork. Do not routinely rebase shared `main` or `develop`;
rewriting them makes collaborators and deployments harder to reconcile. A private, unpublished
topic branch may be rebased onto updated `develop` before review.

## Baseline and comparison

The initial upstream baseline is:

```text
410950d9b11cfee484db7e96b168226c7b139859
```

Useful comparisons:

```bash
# Upstream changes since the fork baseline
git log --oneline 410950d9b11cfee484db7e96b168226c7b139859..upstream/main

# Fork product changes relative to the frozen baseline
git diff --stat 410950d9b11cfee484db7e96b168226c7b139859...develop

# Commits unique to either side before merging
git log --left-right --graph --oneline develop...upstream/main
```

## Sync review checklist

1. Read upstream release notes, migrations, environment changes and operational documentation.
2. Inspect changes in the high-conflict boundaries: Prisma schema, contracts, Executor/runtime,
   auth, Worker jobs, Computer lifecycle, Compose and shared UI.
3. Create a dedicated `chore/upstream-sync-YYYY-MM-DD` branch from current `develop` when the sync
   is non-trivial; merge updated `main` there first and resolve conflicts in review.
4. Preserve upstream behavior unless a fork decision is documented. Do not use conflict resolution
   as an opportunity for cleanup or redesign.
5. Run the proportional test matrix: `pnpm check`, `pnpm lint`, `pnpm test`, then relevant
   integration, E2E, AgentScope Java and topology tests for touched boundaries.
6. Re-run the baseline smoke path for authentication, Bot/Thread/Run, Routine, Worker and Computer.
7. Record the new upstream SHA and any intentionally retained fork divergence in the sync change.

## Conflict policy

- Prefer small, isolated fork modules and dependency injection at existing composition roots.
- Avoid repository-wide formatting, mass rename and file moves; they create conflict without
  product value.
- Keep contract and database changes backward-compatible when possible and separate their
  migrations from UI/product changes.
- If both upstream and the fork changed the same semantic boundary, stop and restate the intended
  behavior before resolving code. A clean textual merge can still be a semantic regression.
- Never resolve generated Prisma/client or lockfile conflicts by guessing. Resolve their sources,
  then regenerate with the repository-pinned toolchain.

## Rollback

If an upstream merge fails verification, do not force-push shared branches. Keep the failed sync on
its topic branch, document the blocker, and leave `develop` at the last verified commit. If a sync
was already merged, use a normal revert commit so published history and the reason remain visible.

## Why merge instead of rebasing shared branches

This policy optimizes for traceability and repeated upstream absorption, not a perfectly linear
graph. An explicit merge into `develop` identifies the upstream batch, avoids rewriting shared
history, and makes later regression bisection and rollback easier. The cost is extra merge commits;
that cost is smaller than rebasing a long-lived public fork with multiple collaborators and
deployments.
