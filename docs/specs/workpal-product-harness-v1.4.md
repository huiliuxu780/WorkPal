# WorkPal Product Harness Spec v1.4

Status: **Architecture baseline — implementation must be split into smaller Implementation Specs.**

This document supersedes the earlier v1.3 chat draft. It intentionally narrows the design: WorkPal owns product orchestration and policy; AgentScope is the only production agent runtime. Users do not select execution modes.

## 1. Product boundary

WorkPal owns:

- Agent identity and system policy
- execution routing
- planning policy
- foreground vs durable execution policy
- permission/effect policy
- collaboration and group routing
- shared conversation context
- task/handoff context
- approvals, recovery, audit and observability

AgentScope owns:

- model/tool execution for one selected Agent Run
- per-agent runtime state and compression
- tool-loop mechanics exposed through the WorkPal bridge

AgentScope must not decide product-level routing, authorization, group speaker selection or durable task ownership.

## 2. RouteDecision is multi-dimensional

Do not implement `direct / action / planned / durable` as four mutually exclusive modes.

```ts
type RouteDecision = {
  reasoning: "direct" | "planned";
  execution: "foreground" | "durable";
  effect: "read_only" | "mutating";
  collaboration: "solo" | "delegate" | "group";
  confidence: number;
  reasons: string[];
};
```

These dimensions may coexist. Example: a long multi-step task that edits an external system may be
`planned + durable + mutating + delegate`.

The user never chooses these values manually.

## 3. Execution Router

The Router is a thin product decision layer, not a traditional intent-classification taxonomy.

Decision order:

1. deterministic signals when obvious;
2. lightweight semantic routing only when needed;
3. conservative fallback to the simplest safe path.

The Router answers only questions required to construct the Run:

- does this request need planning?
- can it finish in the interactive turn?
- can it create external effects?
- does it need another Agent or a group route?
- which Agent should speak or own the next stage?

The Router must not produce the final answer and must not become a second general-purpose Agent.

Initial rollout uses shadow mode: persist decisions and compare them with actual execution before allowing them to change runtime behavior.

## 4. Planning and Drill

`planned` means the selected Agent creates an internal execution plan before or during work.

Drill is **not** a top-level mode. It is an operation inside planned reasoning when a plan step has insufficient evidence, high uncertainty, conflicting results, or needs deeper investigation.

```text
request
  -> plan
      -> step
      -> step -> drill -> evidence
      -> step
  -> result
```

Plans are internal execution structures unless user interaction materially benefits from exposing progress.

## 5. Prompt architecture

Effective instructions are assembled from four layers:

- L0 Core Policy — WorkPal safety, permission, orchestration and behavioral invariants
- L1 Agent Identity — name, role, description, user-configured instructions
- L2 Runtime Context — tools, computer, group roster, memory, current resources
- L3 Execution Strategy — route decision, plan/handoff instructions, effect policy

Every Run must be traceable with at least:

- agent version or identity revision
- policy version
- RouteDecision
- effective prompt hash
- selected model
- tool/resource allow-list

A debug surface may show the assembled effective prompt. Do not rely on an opaque giant prompt string with no provenance.

## 6. Group chat: separate speaker routing from work ownership

Group chat has two independent concepts:

- **message speaker**: who should answer this message now
- **task owner**: who owns an ongoing stage of work

Do not infer one from the other.

Speaker routing precedence:

1. explicit `@Agent` -> that Agent
2. reply to a specific Agent message -> that Agent, unless the user explicitly redirects
3. reply to an active Ask/waiting Run -> that Run's Agent
4. clear capability match -> best specialist may answer directly
5. active collaboration stage -> current task owner when the message concerns that stage
6. ambiguous or genuinely multi-Agent request -> Coordinator

The Coordinator is a fallback orchestrator and synthesizer, **not** the default spokesperson.

A previous speaker does not automatically remain the next speaker.

## 7. Group context model

### 7.1 Shared Thread is the conversation source of truth

A group owns one shared Thread. Every group member may receive the authorized shared transcript window and shared compacted summary.

This is the correct base architecture and should be retained.

Do not copy one Agent's private chat history into the group Thread.

### 7.2 Agent runtime state stays isolated

AgentScope persistent state is keyed per Agent + Thread. Do not transfer Agent A's raw AgentScope state to Agent B.

A handoff transfers **work context**, not hidden model state, scratch reasoning, tool loop internals or private memory.

This protects identity isolation and prevents accidental context contamination.

### 7.3 Context bundle for a group turn

Before starting a selected Agent Run, WorkPal assembles:

```text
GroupTurnContext
  1. Core policy
  2. Selected Agent identity
  3. Group roster
  4. Shared thread window / shared compacted summary
  5. Current message
  6. Reply target / mention context
  7. Handoff packet, when present
  8. Active work-stage metadata, when present
  9. Selected Agent's own permitted memory/context
```

Shared transcript and structured handoff data are authoritative. Agent-local memory may help that Agent reason, but must not silently become shared group memory.

## 8. Handoff protocol

The existing handoff mechanism is a good transport primitive, but free-text `message` alone is not sufficient for reliable multi-Agent continuation.

A handoff message must carry a small structured packet in addition to human-readable text:

```ts
type HandoffPacket = {
  fromBotId: string;
  toBotId: string;
  rootRunId: string;
  parentRunId: string;
  objective: string;
  completed: string[];
  keyFindings: string[];
  artifactRefs: string[];
  openQuestions: string[];
  constraints: string[];
  nextAction: string;
  hop: number;
};
```

Rules:

- only durable conclusions, evidence, artifacts and next actions are transferred;
- never transfer hidden chain-of-thought;
- target Agent receives the packet plus the shared Thread;
- target Run records `rootRunId` / `parentRunId` so the chain is reconstructable;
- a handoff transfers ownership of that stage unless explicitly marked as parallel consultation;
- hop limits and loop protection remain required;
- completion/failure of each stage must be auditable.

For v1, do **not** introduce a new user-visible WorkItem object. Extend existing Run/handoff correlation first. Add a separate persistent collaboration entity only when parallel branches, durable resumability or user-visible task management requires it.

## 9. Current WorkPal implementation: retain vs change

### Retain

The current repository already has useful foundations:

- one shared Thread for a ChatGroup;
- group messages carry `botId`, `replyToMessageId` and Run links;
- group Runs read the shared Thread history;
- AgentScope state is persisted separately per `botId + threadId`;
- `handoff_to_bot` writes a handoff block and creates the target Agent's Task/Run;
- group roster context is injected into the selected Agent;
- hop limits already protect handoff loops.

These are compatible with this spec.

### Change

Current behavior is not sufficient as the final Group Harness:

- when no mention exists, routing currently falls back to the first group member;
- reply target is not yet a first-class routing signal;
- there is no capability/Coordinator routing layer;
- handoff context is mostly free text rather than structured work state;
- handoff-created Tasks/Runs do not expose a durable parent/root collaboration chain;
- “shared conversation history” exists, but “task-state handoff” is not yet a product contract.

Therefore: **reuse the current Thread/Run/handoff foundation; do not rewrite it, but add routing and structured context on top.**

## 10. Permission and effect policy

Effect is orthogonal to reasoning/execution mode.

- read-only operations may run automatically within granted resource scope;
- mutating operations pass through WorkPal permission and approval policy;
- AgentScope tool permissions only permit dispatch to the trusted backend bridge;
- the backend remains authoritative for credentials, resource scope, approvals and idempotency.

## 11. Source-of-truth cleanup is Phase 0

Before Harness implementation, repository guidance must stop contradicting the new product direction.

Phase 0 must make WorkPal product truth authoritative while preserving legally required upstream attribution.

At minimum review/update:

- `VISION.md`
- `README.md`
- `AGENTS.md`
- old fork/upstream operational docs
- product-visible Rakazo naming
- package naming only when technically worthwhile; do not mass-rename purely for appearance

Apache-2.0 LICENSE / copyright / NOTICE obligations are separate from product branding and must be preserved.

## 12. Implementation order

1. Independence / source-of-truth cleanup
2. Prompt Policy + effective-prompt traceability
3. RouteDecision schema + Router shadow mode
4. Group speaker router using mention/reply/waiting-run signals
5. Structured HandoffPacket + root/parent Run correlation
6. capability matching + Coordinator fallback
7. planned reasoning
8. durable execution policy
9. richer multi-Agent planning / parallel collaboration only when real use cases require it

Each item above receives its own Implementation Spec and tests. Coding Agents must not implement this entire architecture document as one change.

## 13. Acceptance scenarios

The architecture is not complete until these cases are deterministic:

- user asks a simple question in a group -> one suitable Agent answers; no Coordinator tax;
- user `@mentions` Agent B -> only B is woken unless an explicit multi-target request exists;
- user replies to Agent C -> C receives the turn even if another Agent spoke previously;
- Agent A hands a stage to B -> B receives shared transcript + structured handoff packet, while A's private runtime state remains inaccessible;
- B can finish the stage and post directly to the shared Thread;
- a new unrelated user question after B finishes is rerouted normally rather than sticking to B;
- a complex request spanning specialists invokes Coordinator/planning only when needed;
- handoff loops are bounded and recoverable;
- after restart/retry, the handoff chain and owner can be reconstructed from durable state.
