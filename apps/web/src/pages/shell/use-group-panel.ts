import type { ArtifactPage, GroupMembers, GroupRoutineSummary } from "@rakazo/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";

export type GroupArtifactItem = ArtifactPage["items"][number];

export type GroupPanelState = {
  members: GroupMembers | null;
  membersError: string | null;
  routines: readonly GroupRoutineSummary[] | null;
  routinesError: string | null;
  artifacts: readonly GroupArtifactItem[];
  artifactsError: string | null;
  artifactsLoading: boolean;
  nextCursor: string | null;
  loadMoreArtifacts: () => Promise<void>;
  reload: () => void;
};

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Request failed";
}

/**
 * Single read path for the group capsule and right panel; everything here goes
 * through the frozen GroupPanelQueries port exposed as rpc.groups.*.
 */
export function useGroupPanel(groupId: string | null): GroupPanelState {
  const [members, setMembers] = useState<GroupMembers | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [routines, setRoutines] = useState<readonly GroupRoutineSummary[] | null>(null);
  const [routinesError, setRoutinesError] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<readonly GroupArtifactItem[]>([]);
  const [artifactsError, setArtifactsError] = useState<string | null>(null);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const request = useRef(0);

  useEffect(() => {
    setMembers(null);
    setMembersError(null);
    setRoutines(null);
    setRoutinesError(null);
    setArtifacts([]);
    setArtifactsError(null);
    setNextCursor(null);
    if (!groupId) return;
    const id = ++request.current;

    rpc.groups.members
      .list({ groupId })
      .then((page) => {
        if (request.current !== id) return;
        setMembers(page);
        setMembersError(null);
      })
      .catch((cause: unknown) => {
        if (request.current !== id) return;
        setMembersError(errorMessage(cause));
      });

    rpc.groups.routines
      .list({ groupId })
      .then((rows) => {
        if (request.current !== id) return;
        setRoutines(rows);
        setRoutinesError(null);
      })
      .catch((cause: unknown) => {
        if (request.current !== id) return;
        setRoutinesError(errorMessage(cause));
      });

    setArtifactsLoading(true);
    rpc.groups.artifacts
      .list({ groupId, limit: 30 })
      .then((page) => {
        if (request.current !== id) return;
        setArtifacts(page.items);
        setNextCursor(page.nextCursor);
        setArtifactsError(null);
      })
      .catch((cause: unknown) => {
        if (request.current !== id) return;
        setArtifactsError(errorMessage(cause));
      })
      .finally(() => {
        if (request.current !== id) return;
        setArtifactsLoading(false);
      });
  }, [groupId, reloadToken]);

  const loadMoreArtifacts = useCallback(async () => {
    if (!groupId || !nextCursor || artifactsLoading) return;
    const id = request.current;
    setArtifactsLoading(true);
    try {
      const page = await rpc.groups.artifacts.list({
        groupId,
        cursor: nextCursor,
        limit: 30,
      });
      if (request.current !== id) return;
      setArtifacts((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
      setArtifactsError(null);
    } catch (cause) {
      if (request.current !== id) return;
      setArtifactsError(errorMessage(cause));
    } finally {
      if (request.current === id) setArtifactsLoading(false);
    }
  }, [groupId, nextCursor, artifactsLoading]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  return {
    members,
    membersError,
    routines,
    routinesError,
    artifacts,
    artifactsError,
    artifactsLoading,
    nextCursor,
    loadMoreArtifacts,
    reload,
  };
}
