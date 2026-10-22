import type { AvatarActivity, GroupMembers } from "@rakazo/contracts";
import { AgentAvatar, type AgentAvatarSize, cn } from "@rakazo/ui-web";

export function agentActivity(status: string): AvatarActivity {
  if (status === "failed") return "failed";
  if (status === "running" || status === "queued" || status === "interrupted") return "working";
  return "idle";
}

type Slot = { x: number; y: number; d: AgentAvatarSize | number; z: number };

type ClusterLayout = {
  user: Slot;
  agents: Slot[];
};

/** Prototype `docs/roundtable/prototype/index.html` capsule-avatar-cluster geometry. */
const CAPSULE: ClusterLayout = {
  user: { x: 0, y: 0, d: 22, z: 1 },
  agents: [
    { x: 17, y: 0, d: 24, z: 5 },
    { x: 4, y: 10, d: 24, z: 3 },
    { x: 28, y: 10, d: 24, z: 4 },
    { x: 36, y: 1, d: 24, z: 2 },
    { x: 52, y: 0, d: 18, z: 2 },
    { x: 52, y: 16, d: 18, z: 2 },
  ],
};

/** Prototype panel-entity-avatar geometry. */
const PANEL: ClusterLayout = {
  user: { x: 0, y: 0, d: 32, z: 1 },
  agents: [
    { x: 29, y: 0, d: 35, z: 5 },
    { x: 8, y: 24, d: 35, z: 3 },
    { x: 43, y: 24, d: 35, z: 4 },
    { x: 57, y: 2, d: 32, z: 2 },
    { x: 78, y: 0, d: 24, z: 2 },
    { x: 78, y: 32, d: 24, z: 2 },
  ],
};

function clusterBox(layout: ClusterLayout, agentCount: number) {
  const used: Slot[] = [layout.user, ...layout.agents.slice(0, agentCount)];
  const width = used.reduce((max, slot) => Math.max(max, slot.x + slot.d), 0);
  const height = used.reduce((max, slot) => Math.max(max, slot.y + slot.d), 0);
  return { width, height };
}

function userInitial(name: string): string {
  return Array.from(name.trim())[0] ?? "?";
}

export function GroupIdentityCluster({
  members,
  variant,
  className,
}: {
  members: GroupMembers;
  variant: "capsule" | "panel";
  className?: string;
}) {
  const layout = variant === "capsule" ? CAPSULE : PANEL;
  const agents = members.agents.slice(0, layout.agents.length);
  const { width, height } = clusterBox(layout, agents.length);
  const ring = variant === "capsule" ? "ring-card" : "ring-background";
  const surface = variant === "capsule" ? "card" : "background";
  const label = [members.currentUser.name, ...agents.map((agent) => agent.name)].join(", ");

  return (
    <span
      role="img"
      aria-label={label}
      data-testid="group-identity-cluster"
      data-variant={variant}
      className={cn("relative select-none", className)}
      style={{ width, height, flex: "none" }}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute grid place-items-center overflow-hidden rounded-full bg-muted text-muted-foreground ring-2",
          ring,
        )}
        style={{
          left: layout.user.x,
          top: layout.user.y,
          width: layout.user.d,
          height: layout.user.d,
          zIndex: layout.user.z,
        }}
      >
        {members.currentUser.image ? (
          <img
            src={members.currentUser.image}
            alt=""
            className="size-full object-cover"
            draggable={false}
          />
        ) : (
          <span style={{ fontSize: Math.round(Number(layout.user.d) * 0.42) }}>
            {userInitial(members.currentUser.name)}
          </span>
        )}
      </span>
      {agents.map((agent, index) => {
        const slot = layout.agents[index];
        if (!slot) return null;
        return (
          <span
            key={agent.botId}
            aria-hidden="true"
            className={cn("absolute rounded-full shadow-sm ring-2", ring)}
            style={{ left: slot.x, top: slot.y, zIndex: slot.z }}
          >
            <AgentAvatar
              botId={agent.botId}
              character={agent.avatarCharacter}
              bodyColor={agent.avatarBodyColor}
              name={agent.name}
              size={slot.d as AgentAvatarSize}
              activity={agentActivity(agent.status)}
              surface={surface}
              ariaHidden
              focusable={false}
            />
          </span>
        );
      })}
    </span>
  );
}
