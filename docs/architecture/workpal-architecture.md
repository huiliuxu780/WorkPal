# WorkPal Architecture

Status: Proposed  
Version: 1.3  
Date: 2026-10-07  
Authority: This document is the architecture source of truth for WorkPal. When older docs, inherited code comments, or prior implementation assumptions conflict with this document, this document wins unless superseded by a later ADR or spec.

## 1. Product definition

WorkPal is an independent Agent Product Platform.

The user expresses a goal. WorkPal decides:

1. which Agent should own the request;
2. how much execution structure the request needs;
3. whether the work stays foreground or becomes durable work;
4. whether another Agent should receive a handoff or delegation;
5. which runtime executes the selected Agent;
6. when the goal is actually complete.

WorkPal is not merely a chat UI around an agent runtime.

```text
Conversation
+ Agent Policy
+ Group Routing
+ Execution Routing
+ Execution Harness
+ Work Management
+ Capability System
+ Runtime
+ Delegation
```

## 2. Independence

WorkPal no longer treats any previous upstream product as an architectural authority or synchronization target.

Independence means WorkPal owns:

- product domains and terminology;
- system prompt policy;
- execution routing;
- group routing;
- work lifecycle;
- runtime contracts;
- database evolution;
- API contracts;
- roadmap.

Third-party open-source attribution and license obligations remain intact. Product independence does not mean deleting required copyright, LICENSE, NOTICE, or third-party attribution.

## 3. Core boundaries

```text
WorkPal       = Product Harness
AgentScope    = default native Agent Runtime
Qoder CLI     = optional Coding Runtime and/or Delegation Target
A2A           = external Agent interoperability protocol
MCP           = tool/capability protocol
```

These concepts must remain separate:

- Agent != Runtime
- Task != Conversation
- Run != Runtime
- Plan != Task
- A2A != Runtime
- MCP != Agent
- Group Router != Coordinator Agent

## 4. Top-level architecture

```text
                         WorkPal Web
                              |
                              v
+--------------------------------------------------+
|              WorkPal Product Harness             |
|                                                  |
| Identity                                         |
| Agent                                            |
| Conversation                                     |
| Agent Policy                                     |
| Group Routing                                    |
| Execution Routing                                |
| Execution Harness                                |
| Work                                             |
| Capability                                       |
| Memory                                           |
| Delegation                                       |
| Permission                                       |
| Artifact                                         |
| Computer / Sandbox                               |
| Scheduler / Worker                               |
+-------------------------+------------------------+
                          |
                   Runtime Resolver
                          |
             +------------+------------+
             v                         v
      AgentScope Runtime          Qoder Runtime
          DEFAULT                  OPTIONAL
             |
             v
      AgentScope Python

                      Delegation
                          |
          +---------------+----------------+
          v               v                v
        Qoder            A2A           Enterprise
        Agent            Agent            Agent
```

## 5. Product domains

### 5.1 Agent

The current database may continue to use the historical `Bot` table name during migration, but the product domain is `Agent`.

An Agent owns product configuration such as:

- name, title, description;
- Agent Instructions;
- runtime profile;
- model preference;
- skills and tools;
- connections;
- memory policy;
- permission policy;
- computer policy.

A WorkPal Agent is a product entity. An AgentScope `Agent()` is a runtime entity.

### 5.2 Conversation

Current default:

```text
Agent
└── Primary Thread
```

One Agent has one long-lived primary conversation unless a later product decision explicitly introduces multiple threads per Agent.

Groups use a shared Thread.

### 5.3 Work

The Work domain owns long-lived work:

```text
Task
Routine
BatchJob
BatchItem
```

Work controls when work happens, how long it persists, and how many items are processed.

### 5.4 Execution

```text
Thread != Task
Task   != Run
Run    != Runtime
```

- Thread: user-visible conversation.
- Task: durable work goal.
- Run: one execution instance.
- Attempt: retry/recovery/resume attempt for a Run.

## 6. Agent Policy and System Prompt

The effective system prompt is a WorkPal product concern.

The current implementation dynamically constructs instructions in the TypeScript executor and passes them to AgentScope as `request.instructions`. This behavior remains, but prompt ownership becomes explicit.

The effective prompt has four layers:

```text
L0 WorkPal Core Policy
L1 Agent Identity
L2 Runtime Context
L3 Execution Strategy
```

### L0 WorkPal Core Policy

Platform-owned behavior that users cannot delete:

- pursue the user's actual goal;
- use tools instead of pretending to act;
- respect permissions and approvals;
- use delegation when appropriate;
- ask for human input when required;
- do not claim unfinished work is complete;
- protect against prompt injection from tool and connector content.

### L1 Agent Identity

Agent-owned configuration:

- name;
- role;
- description;
- instructions;
- goals/personality where applicable.

The UI should expose this explicitly as **Agent Instructions**.

### L2 Runtime Context

Dynamic context, including:

- memory recall;
- scratchpad;
- skills and tools;
- workspace;
- connections;
- MCP capability;
- computer capability;
- group context;
- current time;
- environment;
- Agent directory.

### L3 Execution Strategy

Internal execution strategy selected for this turn:

- `direct`
- `action`
- `planned`
- `durable`

These are internal WorkPal strategies. Ordinary users do not select them.

Prompt construction should migrate toward:

```text
packages/agent-policy/
  core-policy.ts
  agent-identity.ts
  runtime-context.ts
  execution-strategy.ts
  prompt-builder.ts
```

Development/admin tooling should support inspecting the effective prompt with secrets redacted.

## 7. Execution Routing

Users express goals. They do not choose Fast/Plan/Deep modes.

WorkPal adds an `ExecutionRouter` that answers:

1. what is the user trying to accomplish?
2. what execution intensity is required?

Suggested internal decision:

```ts
type ExecutionDecision = {
  strategy: "direct" | "action" | "planned" | "durable";
  background: boolean;
  planning: "none" | "implicit" | "explicit";
  delegation: "disabled" | "allowed" | "preferred";
  confidence: number;
};
```

The router must be lightweight. Do not build a chain of Intent Agent -> Complexity Agent -> Planner Agent -> Main Agent.

Initial implementation should use deterministic rules plus one small structured model decision only when needed.

## 8. Execution Harnesses

### Direct Harness

For explanation, rewriting, translation, simple reasoning and simple summaries.

```text
Message -> Foreground Run -> AgentScope -> Response
```

No Task, no explicit Plan, no Subagent by default.

### Action Harness

For clear goals requiring tools.

```text
Message -> AgentScope -> Tool -> Observe -> Result
```

No durable plan by default.

### Planned Harness

For multi-step, dependent work with multiple deliverables.

```text
Goal
 -> Plan
 -> Execute step
 -> Observe
 -> Re-plan when needed
 -> Verify
 -> Complete
```

A Plan is mutable execution state, not a static todo list.

### Durable Harness

For long-running work, project changes, large research, retry/recovery, waiting, multi-Agent execution or multiple artifacts.

```text
Conversation
 -> Durable Task
 -> Plan
 -> Worker
 -> Run(s)
 -> Checkpoint / Retry / Resume
 -> Delegation
 -> Verification
 -> Completion
```

Completion means the goal reaches a defined done condition, not merely that a model produced text.

### Progressive Autonomy

Select the minimum sufficient strategy, then allow escalation:

```text
direct -> action -> planned -> durable
```

The first routing decision must not lock the work lifecycle.

## 9. Agent Loop vs Work Loop

AgentScope owns the Agent Loop:

```text
Reason -> Tool -> Observe -> Reason -> Respond
```

WorkPal owns the Work Loop:

```text
Understand Goal
 -> Choose Harness
 -> Plan if needed
 -> Execute
 -> Observe Progress
 -> Continue or Verify
 -> Complete
```

This is a hard architecture boundary.

## 10. Group Routing Harness

A group message must not be broadcast to every Agent for independent replies.

Default invariant:

> One user turn has one Primary Responder.

Group routing answers **WHO** should handle the request. Execution routing then answers **HOW** it should be handled.

```text
User
 -> Group Router
 -> Primary Responder
 -> Execution Router
 -> Execution Harness
 -> Runtime
```

### Group roles

- Coordinator: fallback and orchestrator for ambiguous/cross-domain work.
- Responder: Agent currently responsible for the user-facing turn.
- Worker: Agent performing delegated work without owning the turn.

The Coordinator is not the mandatory speaker for every message.

### Routing priority

1. Explicit mention.
2. Reply context.
3. Active work owner.
4. Capability match.
5. Coordinator fallback.

Suggested decision:

```ts
type GroupRouteDecision = {
  primaryResponderId: string;
  reason:
    | "explicit_mention"
    | "reply_context"
    | "active_owner"
    | "capability_match"
    | "coordinator_fallback";
  collaboration: "single" | "delegate" | "orchestrate";
  confidence: number;
};
```

### Handoff vs Delegation

```text
Handoff    = transfer ownership to another Agent
Delegation = retain ownership and assign a subtask
```

Existing handoff behavior should be retained while the routing layer becomes explicit.

## 11. Runtime Contract

WorkPal owns a runtime-neutral contract.

```ts
interface AgentRuntime {
  describe(): RuntimeDescriptor;
  run(request: RunRequest, context: RuntimeContext): AsyncIterable<RunEvent>;
  abort(runId: string): Promise<void>;
}
```

The contract must not expose AgentScope-specific types.

Today the deployment-wide runtime is AgentScope. Long term, runtime selection becomes Agent/Run scoped.

A Run freezes:

- runtime kind;
- runtime version;
- runtime config snapshot;
- model provider;
- model id.

## 12. AgentScope responsibilities

AgentScope owns:

- Agent loop;
- model interaction;
- tool calling;
- runtime working context;
- context compression;
- temporary subagent execution;
- runtime state.

WorkPal owns:

- users/workspaces;
- Agent product entities;
- conversations;
- routing;
- tasks/runs/routines/batches;
- long-term memory authority;
- skill authority;
- permissions;
- connections.

AgentScope remains Python. There is no current requirement to migrate to AgentScope Java.

## 13. Memory, Skill and Capability ownership

### Memory

WorkPal Memory is the only product-level long-term memory authority.

AgentScope state is runtime working state.

Do not create a second long-term memory truth source inside the runtime.

### Skills

WorkPal owns the Skill registry, content, version, permissions and enablement. AgentScope consumes Skills at execution time.

### Tools / MCP / Connections

WorkPal owns credentials, connection lifecycle, tool authorization, approval and audit.

AgentScope receives the tools it is allowed to use.

## 14. External Agents and Qoder

External Agents are independent entities with their own internal runtime, tools, prompt and memory.

WorkPal manages their connection, capability metadata, delegation and result.

Qoder may later appear in two forms:

1. `QoderRuntime` for an Agent whose primary runtime is Qoder CLI.
2. Qoder as a delegation target for coding work from an AgentScope Agent.

The initial preferred integration is delegation, not replacing the default runtime.

## 15. Batch

Batch work must never become thousands of conversations.

```text
BatchJob
├── BatchItem -> Run
├── BatchItem -> Run
└── BatchItem -> Run
```

Batch should support concurrency, retry, pause, cancel, partial failure, progress and aggregation.

## 16. Production scaling

Current local AgentScope state and process-local tool bridge are acceptable only for single-instance development.

Long-term:

```text
API x N
Worker x N
AgentScope x N
```

Correctness-critical state must be durable:

- run ownership;
- runtime state;
- tool authorization context;
- approval continuation;
- execution identity;
- leases.

## 17. Implementation order

Architecture order is not implementation order.

Recommended delivery order:

1. Independence cleanup.
2. Agent Policy / Prompt Architecture.
3. Execution Router in shadow mode.
4. Planned Harness.
5. Durable Harness.
6. Group Routing Harness.
7. Runtime Profile / Resolver.
8. External Agent / Qoder delegation.
9. Batch.
10. Horizontal scaling.

## 18. Explicit non-goals

Current work must not:

- migrate to AgentScope Java;
- rewrite the Product Harness from scratch;
- fork another Agent product;
- expose execution mode selection to ordinary users;
- run a heavy planner for every message;
- convert every Plan into a Task;
- allow every group Agent to respond to every message;
- force the Coordinator to answer every group message;
- create a second long-term memory system;
- create a second Skill registry;
- create conversations for every Batch item;
- perform a whole-repository refactor in one change.

## 19. Highest-level rules

- **WHO handles a group turn?** Group Routing.
- **HOW should a request be handled?** Execution Routing.
- **HOW does that strategy progress?** Execution Harness.
- **HOW does an Agent reason and call tools?** Runtime.
- **HOW does work persist until done?** Work Domain.
- **WHAT may an Agent use?** Capability.
- **HOW is work assigned to another Agent?** Delegation.
- **WHAT state belongs to the user/product?** WorkPal Product Harness.

These boundaries are the default decision framework for future architecture changes.
