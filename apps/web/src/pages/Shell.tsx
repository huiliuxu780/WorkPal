import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type {
  ActivityItem,
  AgentSkillCatalogEntry,
  Bot,
  BotSection,
  CollaborationReceiptBlock,
  ComputerMode,
  ComputerReleaseReason,
  ComputerStatus,
  Connection,
  ConnectionCatalogItem,
  Group,
  Me,
  ProductEvent,
  Routine,
  Run,
  SearchHit,
  Space,
  SpaceMemoryConfig,
  TaughtSkill,
  ThreadMessage,
  ThreadSnapshot,
  UsageRange,
  VoiceStatus,
} from "@rakazo/contracts";
import {
  ATTACHMENT_ALLOWED_MIME_TYPES,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  canReactToThreadMessage,
  MESSAGE_REACTIONS,
  type MessageReaction,
  normalizeCreateBotProfile,
} from "@rakazo/contracts";
import {
  attachmentsForThread,
  buildComposerMentionOptions,
  type ComposerMention,
  clampMentionHighlightIndex,
  cronFromPreset,
  GROUP_MENTION_CLARIFICATION_CODE,
  groupBotsForSidebar,
  groupVoiceChats,
  inferAttachmentMimeType,
  isActive,
  isPeerReceiptBlocks,
  isRunTerminalEvent,
  isToolActivityBlock,
  mentionChipKey,
  mentionStillInPrompt,
  mergeExecutionsByRun,
  nestRosterByParent,
  plainTextFromMarkdown,
  projectMessageReactions,
  reorderBotTo,
  resolveComposerSendPlan,
  resolveMentionPickerKey,
  runThreadSubscription,
  SLASH_ACTIONS,
  type SlashActionId,
  searchHitThreadTarget,
  serializeComposerPrompt,
  speechFromBlocks,
  stripMentionToken,
  truncateSlashDescription,
  userVisibleMessages,
  voiceDisplayBlockFromGroup,
  withLiveStreamingProgress,
} from "@rakazo/core";
import {
  BotAvatar,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  GroupAvatar,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Popover,
  PopoverContent,
  PopoverTrigger,
  resolvePersonaColorDef,
  useAvatarCatalog,
} from "@rakazo/ui-web";
import {
  ArrowDown,
  ArrowUp,
  Bell,
  Box,
  ChevronDown,
  Clock,
  Copy,
  FolderOpen,
  Gauge,
  LayoutGrid,
  Lock,
  LogOut,
  Maximize2,
  Menu,
  Mic,
  Monitor,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Pencil,
  Plus,
  Puzzle,
  Reply,
  Search,
  Settings,
  Smile,
  Square,
  TextQuote,
  Trash2,
  X,
} from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  Fragment,
  lazy,
  type MutableRefObject,
  memo,
  type ReactNode,
  type RefObject,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArtifactFileCard } from "../components/ArtifactFileCard";
import { AskCard } from "../components/AskCard";
import { BackgroundTaskActivity } from "../components/activity/BackgroundTaskActivity";
import { MessageText } from "../components/ai/AgentMentionText";
import {
  DisplayBlockList,
  DisplayBlockView,
  displayBlockMessageIndex,
  groupDisplayBlocksByMessage,
  VoiceDisplay,
} from "../components/ai/display/DisplayBlockView";
import { PeerReceiptRow } from "../components/ai/PeerReceiptRow";
import { GroupDestinationReceipt } from "../components/ai/GroupDestinationReceipt";
import { GroupMembershipFailureCard } from "../components/ai/interactions/ActionApprovalCard";
import { PublicDelegationMessage } from "../components/ai/PublicDelegationMessage";
import { CloudAgentCard } from "../components/CloudAgentCard";
import { ComputerMaintenanceActions } from "../components/ComputerMaintenanceActions";
import {
  ComputersUnavailableHint,
  computersAreUnavailable,
} from "../components/ComputersUnavailableHint";
import { ComputerUpdateProgress } from "../components/ComputerUpdateProgress";
import { CallCard } from "../components/call/CallCard";
import { VoiceChatCard } from "../components/call/VoiceChatCard";
import { ComputerWorkspace } from "../components/computer/ComputerWorkspace";
import { MessageHoverMetadata } from "../components/MessageHoverMetadata";
import { ModelTreePicker } from "../components/ModelTreePicker";
import {
  LIVE_TOOL_STEP_WINDOW,
  StandaloneToolActivity,
  ToolActivityDisclosure,
  ToolOnlyNarration,
  ToolSteps,
} from "../components/ToolActivityDisclosure";
import { SkillDraftCard } from "../components/teach/SkillDraftCard";
import { TeachCaptureOverlay } from "../components/teach/TeachCaptureOverlay";
import { TeachComputerOverlayControl } from "../components/teach/TeachComputerOverlay";
import { TeachRecordingChrome, TeachStopButton } from "../components/teach/TeachRecordingChrome";
import { readActivityMode, writeActivityMode } from "../lib/activity-mode";
import {
  backgroundActivityItems,
  inlineActivityItems,
  liveActivityItems,
} from "../lib/activity-view";
import type { ArtifactTarget } from "../lib/artifact-open";
import { askDraftKey } from "../lib/ask-draft";
import { authClient } from "../lib/auth";
import { takeInitialBootstrap } from "../lib/bootstrap";
import {
  BOTS_SIDEBAR_EDGE_DRAG_PX,
  readBotsSidebarCollapsed,
  writeBotsSidebarCollapsed,
} from "../lib/bots-sidebar-pref";
import {
  deliverBrowserNotification as deliverNativeBrowserNotification,
  requestBrowserNotificationPermission,
  shouldNotifyBrowser,
} from "../lib/browser-notifications";
import { startCall, useCallSession } from "../lib/call-session";
import { newClientId } from "../lib/client-id";
import {
  embeddableScreenUrl,
  loadComputerScreen,
  screenIframeSandbox,
} from "../lib/computer-screen";
import { publishComputerCommand } from "../lib/computer-workspace";
import { desktopBridge } from "../lib/desktop";
import {
  EXECUTION_NAV_INTENT_EVENT,
  rosterAttentionIntent,
  setExecutionNavIntent,
} from "../lib/execution-nav";
import { scheduleFocusPrompt } from "../lib/focus-prompt";
import { localTimezone } from "../lib/local-timezone";
import { copyableMessageText } from "../lib/message-text";
import { messageProviderLabel } from "../lib/messaging";
import { useConnectedModelOptions } from "../lib/model-options";
import {
  isFileDrag,
  isFilePaste,
  readFileAsBase64,
  revokePendingAttachmentPreviews,
} from "../lib/pending-attachments";
import { markAfterPaint, markOnce } from "../lib/performance";
import { projectPublicDelegations } from "../lib/public-collaboration";
import {
  groupPeerReceipts,
  type PeerReceiptGroup,
  type PeerReceiptTarget,
} from "../lib/peer-receipts";
import { quoteDraftForSelection } from "../lib/quote-selection";
import { getResponseStreamingEnabled, subscribeResponseStreaming } from "../lib/response-streaming";
import { clearSpaceSelection, rpc, selectedSpaceId, selectSpace } from "../lib/rpc";
import { readSeenRunErrorIds, rememberSeenRunErrorId } from "../lib/run-error-storage";
import { isRunActive, runStatusLabel, runStatusTextClass } from "../lib/run-status";
import { sharedInflight } from "../lib/shared-inflight";
import {
  activeThreadRuns,
  applyThreadSendReceipt,
  clearActiveThreadRuns,
  computerPanelAutoBoot,
  computerPanelAutoUsesBoot,
  computerPanelNeedsMaintenance,
  computerTakeoverBlocked,
  isComputerStatusEvent,
  isSessionControlLifecycleEvent,
  isThreadSnapshotEvent,
  prependThreadMessagePage,
  reconcileRefreshedThread,
  reduceComputerStatus,
  reduceThreadSnapshot,
  threadRunError,
  userHoldsComputerControl,
} from "../lib/thread-events";
import { getToolActivityEnabled, subscribeToolActivity } from "../lib/tool-activity-preference";
import {
  isToolOnlyNarration,
  messageHasVisibleBlocks,
  renderableMessageBlocks,
  shouldRenderToolCard,
  toolStepCount,
} from "../lib/tool-activity-view";
import {
  transcriptCanSnapAfterFrame,
  transcriptIsNearEnd,
  transcriptMovedDown,
} from "../lib/transcript-scroll";
import { speaker } from "../lib/tts";
import { createUsageLoader, type UsageLoader, type UsageLoadState } from "../lib/usage-loader";
import { ActivityList } from "./ActivityList";
import type { ContextMenuPosition } from "./BotContextMenu";
import { CreateGroupForm, GroupSettings, memberName } from "./GroupPanel";
import { HostComputerPrompt } from "./HostComputerPrompt";
import {
  draftFromRoutine,
  emptyRoutineDraft,
  type RoutineDraftState,
  RoutineEditor,
  RoutineListHeader,
  RoutineListRow,
  routineNeedsOneShotArm,
} from "./RoutineEditor";
import type { SettingsSection } from "./SettingsOverlay";
import { SpaceSearchResults } from "./SpaceSearch";
import { BotSettings, CreateBotForm } from "./shell/bot-panel";
import { BotCreatePicker } from "./shell/bot-picker";
import { CommandPalette, isCommandPaletteHotkey } from "./shell/command-palette";
import {
  ClearConversationDialog,
  DeleteBotDialog,
  DeleteItemDialog,
  NewBotSectionDialog,
  NewSpaceDialog,
  PickerInfoDialog,
  RenameBotSectionDialog,
} from "./shell/dialogs";
import { GroupIdentityCluster } from "./shell/group-identity-cluster";
import { GroupPanel, type GroupPanelTab } from "./shell/group-panel";
import {
  AppConnectCard,
  ArtifactImage,
  ChartBlockView,
  ChoiceCard,
  McpApprovalCard,
} from "./shell/message-cards";
import { useExecutionTranscript } from "./shell/use-execution-transcript";
import { type GroupArtifactItem, useGroupPanel } from "./shell/use-group-panel";
import { WindowChrome } from "./WindowChrome";

const BotContextMenu = lazy(() =>
  import("./BotContextMenu").then((module) => ({ default: module.BotContextMenu })),
);
const MessagingSettingsOverlay = lazy(() =>
  import("./MessagingSettingsOverlay").then((module) => ({
    default: module.MessagingSettingsOverlay,
  })),
);
const SettingsOverlay = lazy(() =>
  import("./SettingsOverlay").then((module) => ({ default: module.SettingsOverlay })),
);
const PeerMessagesOverlay = lazy(() =>
  import("./PeerMessagesOverlay").then((module) => ({ default: module.PeerMessagesOverlay })),
);
const PluginsOverlay = lazy(() =>
  import("./PluginsOverlay").then((module) => ({ default: module.PluginsOverlay })),
);
const McpServersOverlay = lazy(() =>
  import("./McpServersOverlay").then((module) => ({ default: module.McpServersOverlay })),
);

type Panel =
  | "computer"
  | "settings"
  | "routine"
  | "create"
  | "create-group"
  | "group"
  | "group-settings"
  | null;

type PendingAttachment = {
  id: string;
  threadKey: string;
  file: File;
  previewUrl?: string;
};

type PendingBrowserNotification = {
  event: Pick<ProductEvent, "id" | "type" | "threadId" | "botId" | "payload">;
  botId: string;
  botName: string;
  groupNotification: boolean;
};

const ATTACHMENT_ACCEPT = ATTACHMENT_ALLOWED_MIME_TYPES.join(",");
/** Identity colour for bots the roster no longer knows about. */
const FALLBACK_BOT_COLOR = "#85858A";

/**
 * Sidebar refocus (UX-01B acceptance 12): reads the ONE trusted avatar state
 * source (`AvatarCatalogProvider` via `useAvatarCatalog`) for a roster row —
 * never a second status source, never the roster's raw `chat.status` string.
 * Render-prop so the per-row hook lives in its own component while the row
 * button keeps its existing drag/click handlers.
 */
function RosterRowCatalog({
  botId,
  children,
}: {
  botId: string | null;
  children: (state: ReturnType<typeof useAvatarCatalog>["state"] | null) => ReactNode;
}) {
  const catalog = useAvatarCatalog(botId ?? "");
  return <>{children(botId ? (catalog.state ?? null) : null)}</>;
}

const THREAD_SNAPSHOT_TIMEOUT_MS = 2_000;
/** Bound Settings leave so a hung voice status refresh cannot block dismissal. */
const VOICE_STATUS_REFRESH_TIMEOUT_MS = 10_000;
const MOBILE_SIDEBAR_SWIPE_EDGE_PX = 32;
const MOBILE_SIDEBAR_SWIPE_DISTANCE_PX = 56;

function threadSnapshotSignal(parent: AbortSignal): AbortSignal {
  return AbortSignal.any([parent, AbortSignal.timeout(THREAD_SNAPSHOT_TIMEOUT_MS)]);
}

function voiceStatusRefreshTimeout(): Promise<never> {
  return new Promise((_, reject) => {
    AbortSignal.timeout(VOICE_STATUS_REFRESH_TIMEOUT_MS).addEventListener("abort", () => {
      reject(new DOMException("Voice status refresh timed out", "TimeoutError"));
    });
  });
}

function collapsedSidebarSectionsStorageKey(userId: string | null | undefined): string | null {
  if (!userId) return null;
  return `rakazo:collapsed-sidebar-sections:${userId}`;
}

function collapsedRosterParentsStorageKey(userId: string | null | undefined): string | null {
  if (!userId) return null;
  return `rakazo:collapsed-roster-parents:${userId}`;
}

function readCollapsedIdSet(storageKey: string | null): Set<string> {
  if (!storageKey) return new Set();
  try {
    const value = window.localStorage.getItem(storageKey);
    const keys: unknown = value ? JSON.parse(value) : [];
    return new Set(
      Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [],
    );
  } catch {
    return new Set();
  }
}

function toggleCollapsedIdSet(
  previous: ReadonlySet<string>,
  id: string,
  storageKey: string | null,
): Set<string> {
  const next = new Set(previous);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  if (storageKey) {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify([...next]));
    } catch {
      // Keep the UI usable when storage is unavailable.
    }
  }
  return next;
}

function readCollapsedSidebarSections(userId: string | null | undefined): Set<string> {
  return readCollapsedIdSet(collapsedSidebarSectionsStorageKey(userId));
}

function readCollapsedRosterParents(userId: string | null | undefined): Set<string> {
  return readCollapsedIdSet(collapsedRosterParentsStorageKey(userId));
}

export function ShellPage() {
  const { t } = useLingui();
  const { botId, groupId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // Mirrors searchParams for effects that only need to read it once on run,
  // not re-run on every unrelated query-param change (e.g. the SSE subscribe
  // effect below, which should only restart when the active bot changes).
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;
  // Stable mirror of the route mode for callbacks (refreshBots) that must not
  // be re-created when the Shell switches route modes.
  const session = authClient.useSession();
  const userId = session.data?.user.id;
  const [groups, setGroups] = useState<Group[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const botsRef = useRef(bots);
  botsRef.current = bots;
  const botOrderEpochRef = useRef(0);
  const pendingBotOrderRef = useRef<string[] | null>(null);
  const savingBotOrderRef = useRef(false);
  const [botSections, setBotSections] = useState<BotSection[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [archivedBots, setArchivedBots] = useState<Bot[]>([]);
  const [archivedGroups, setArchivedGroups] = useState<Group[]>([]);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [collapsedSidebarSections, setCollapsedSidebarSections] = useState(() => new Set<string>());
  const [collapsedRosterParents, setCollapsedRosterParents] = useState(() => new Set<string>());

  useEffect(() => {
    setCollapsedSidebarSections(readCollapsedSidebarSections(userId));
    setCollapsedRosterParents(readCollapsedRosterParents(userId));
  }, [userId]);
  useEffect(() => {
    setBotsSidebarCollapsed(readBotsSidebarCollapsed(userId));
  }, [userId]);
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const snapshotRef = useRef<ThreadSnapshot | null>(null);
  const streamResponses = useSyncExternalStore(
    subscribeResponseStreaming,
    getResponseStreamingEnabled,
    () => false,
  );
  const streamResponsesRef = useRef(streamResponses);
  streamResponsesRef.current = streamResponses;
  const showToolActivity = useSyncExternalStore(
    subscribeToolActivity,
    getToolActivityEnabled,
    () => true,
  );
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [replyTarget, setReplyTarget] = useState<ThreadMessage | null>(null);
  const [replyQuote, setReplyQuote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [groupTab, setGroupTab] = useState<GroupPanelTab>("details");
  const [settingsTab, setSettingsTab] = useState<"detail" | "library" | "computer">("detail");
  const [peerConversation, setPeerConversation] = useState<{
    peerBotId: string;
    peerBotName: string;
    sourceReceiptMessageId: string;
    pairThreadId: string;
    messageId: string;
  } | null>(null);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [routinesBotId, setRoutinesBotId] = useState<string | null>(null);
  const [taughtSkills, setTaughtSkills] = useState<TaughtSkill[]>([]);
  const [taughtSkillsBotId, setTaughtSkillsBotId] = useState<string | null>(null);
  const [agentSkills, setAgentSkills] = useState<AgentSkillCatalogEntry[]>([]);
  const [mentionRoutines, setMentionRoutines] = useState<Array<Routine & { botName?: string }>>([]);
  const [mentionConnectors, setMentionConnectors] = useState<
    Array<{
      id: string;
      name: string;
      authStatus: "connected" | "needs_auth";
      connectionId?: string;
    }>
  >([]);
  const [teachBusy, setTeachBusy] = useState(false);
  const [computer, setComputer] = useState<ComputerStatus | null>(null);
  const computerRef = useRef<ComputerStatus | null>(null);
  const threadRefreshEpoch = useRef(0);
  const groupRefreshEpoch = useRef(0);
  const botsRefreshEpoch = useRef(0);
  const botsRefreshApplied = useRef(0);
  const archivedBotsRefreshEpoch = useRef(0);
  const botsRefreshInFlight = useRef(0);
  // A very fast run can finish over SSE while its threads.send response is still
  // returning. Do not let that late receipt resurrect terminal work as queued.
  const terminalRunReceipts = useRef(new Set<string>());
  // Last-known computer/screen per bot, so switching back to an already-seen
  // bot paints its computer pane instantly instead of blanking it while the
  // thread + screen RPCs round-trip again (see refreshThread / refreshComputerScreen).
  const computerCacheRef = useRef(
    new Map<string, { computer: ComputerStatus | null; screenUrl: string | null }>(),
  );
  // Caps computerCacheRef so a long session that opens many distinct bots
  // over time doesn't accumulate one entry per bot forever. Re-inserting on
  // every update keeps Map iteration order as least-recently-used first, so
  // eviction drops the bot that's been out of view longest.
  const COMPUTER_CACHE_LIMIT = 20;

  function cacheComputerFor(
    botId: string,
    patch: Partial<{ computer: ComputerStatus | null; screenUrl: string | null }>,
  ) {
    const cache = computerCacheRef.current;
    const prev = cache.get(botId) ?? { computer: null, screenUrl: null };
    cache.delete(botId);
    cache.set(botId, { ...prev, ...patch });
    if (cache.size > COMPUTER_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  function commitSnapshot(next: ThreadSnapshot | null) {
    snapshotRef.current = next;
    setSnapshot(withLiveStreamingProgress(next, streamResponsesRef.current));
  }

  useEffect(() => {
    setSnapshot(withLiveStreamingProgress(snapshotRef.current, streamResponses));
  }, [streamResponses]);

  function commitComputer(next: ComputerStatus | null) {
    computerRef.current = next;
    setComputer(next);
  }

  function updateSnapshot(update: (prev: ThreadSnapshot | null) => ThreadSnapshot | null) {
    commitSnapshot(update(snapshotRef.current));
  }
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [messagingSettingsOpen, setMessagingSettingsOpen] = useState(false);
  const [messagingSurfaceEnabled, setMessagingSurfaceEnabled] = useState(false);
  const [messagingProviders, setMessagingProviders] = useState<string[]>([]);
  const [memoryProviderConfig, setMemoryProviderConfig] = useState<
    SpaceMemoryConfig | null | undefined
  >(undefined);
  const memoryProviderConfigRevision = useRef(0);
  const call = useCallSession();
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [dismissedRunErrorIds, setDismissedRunErrorIds] =
    useState<ReadonlySet<string>>(readSeenRunErrorIds);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const mobileSidebarSwipeRef = useRef<{ startX: number; startY: number } | null>(null);
  const [draggedBotId, setDraggedBotId] = useState<string | null>(null);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [botsSidebarCollapsed, setBotsSidebarCollapsed] = useState(false);
  const focusPromptAbortRef = useRef<AbortController | null>(null);
  const focusPromptBotIdRef = useRef<string | null>(null);
  const botsSidebarEdgeDragRef = useRef<{ startX: number; mode: "expand" | "collapse" } | null>(
    null,
  );
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const [pickerInfoTopic, setPickerInfoTopic] = useState<"group" | "space" | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    function closeMobileSidebar() {
      if (desktop.matches) setMobileSidebarOpen(false);
    }
    closeMobileSidebar();
    desktop.addEventListener("change", closeMobileSidebar);
    return () => desktop.removeEventListener("change", closeMobileSidebar);
  }, []);
  const [activityMode, setActivityMode] = useState(readActivityMode);
  const toggleActivityMode = useCallback(() => {
    setActivityMode((on) => {
      const next = !on;
      writeActivityMode(next);
      return next;
    });
  }, []);
  const [botMenu, setBotMenu] = useState<{
    kind: "bot" | "group";
    id: string;
    position: ContextMenuPosition;
  } | null>(null);
  // The context menu anchors to the pointer, so return focus to the row that opened it.
  const botMenuAnchor = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (botMenu || !botMenuAnchor.current) return;
    botMenuAnchor.current.focus();
    botMenuAnchor.current = null;
  }, [botMenu]);
  const [deleteTarget, setDeleteTarget] = useState<Bot | null>(null);
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<Group | null>(null);
  const [deleteSpaceTarget, setDeleteSpaceTarget] = useState<Space | null>(null);
  const [spaceMenu, setSpaceMenu] = useState<{
    id: string;
    position: ContextMenuPosition;
  } | null>(null);
  const spaceMenuAnchor = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (spaceMenu || !spaceMenuAnchor.current) return;
    spaceMenuAnchor.current.focus();
    spaceMenuAnchor.current = null;
  }, [spaceMenu]);
  const closeSpaceMenu = useCallback(() => setSpaceMenu(null), []);
  const [clearTarget, setClearTarget] = useState<
    { kind: "bot"; chat: Bot } | { kind: "group"; chat: Group } | null
  >(null);
  const [newSectionTarget, setNewSectionTarget] = useState<
    { kind: "bot"; chat: Bot } | { kind: "group"; chat: Group } | null
  >(null);
  const [renameSectionTarget, setRenameSectionTarget] = useState<{
    section: BotSection;
    spaceId: string;
  } | null>(null);
  const [sectionMenu, setSectionMenu] = useState<{
    section: BotSection;
    spaceId: string;
    position: ContextMenuPosition;
  } | null>(null);
  const sectionMenuAnchor = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (sectionMenu || !sectionMenuAnchor.current) return;
    sectionMenuAnchor.current.focus();
    sectionMenuAnchor.current = null;
  }, [sectionMenu]);
  const closeSectionMenu = useCallback(() => setSectionMenu(null), []);
  const [booting, setBooting] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [initialBotsLoaded, setInitialBotsLoaded] = useState(false);
  const [bootstrapMe, setBootstrapMe] = useState<Me | null>();
  const [routineDraft, setRoutineDraft] = useState<RoutineDraftState>(emptyRoutineDraft());
  const [routineWebhookSecret, setRoutineWebhookSecret] = useState<string | null>(null);
  const [editingRoutine, setEditingRoutine] = useState<Routine | null>(null);
  const [deleteRoutineTarget, setDeleteRoutineTarget] = useState<Routine | null>(null);
  const [savingRoutine, setSavingRoutine] = useState(false);
  const [runningRoutine, setRunningRoutine] = useState(false);
  const [routineError, setRoutineError] = useState<string | null>(null);
  const [screenUrl, setScreenUrl] = useState<string | null>(null);
  const [computerOpen, setComputerOpen] = useState(false);
  const [computerBotId, setComputerBotId] = useState<string | undefined>();
  const computerOpenRef = useRef(false);
  const computerBotIdRef = useRef<string | undefined>(undefined);
  const computerBootEpoch = useRef(0);
  const openComputerRef = useRef<(botId?: string) => Promise<boolean>>(async () => false);
  const [computerViewport, setComputerViewport] = useState<{
    height: number;
    offsetTop: number;
  } | null>(null);
  const [computerError, setComputerError] = useState<string | null>(null);
  // Screen-load failures can sit beside a still-valid embed URL; boot and
  // takeover failures must stay visible even when a URL remains.
  const [computerErrorFromScreen, setComputerErrorFromScreen] = useState(false);
  useEffect(() => {
    if (!computerOpen) {
      setComputerViewport(null);
      return;
    }
    const viewport = window.visualViewport;
    if (!viewport) return;
    const sync = () => {
      setComputerViewport({ height: viewport.height, offsetTop: viewport.offsetTop });
    };
    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
    };
  }, [computerOpen]);
  useEffect(() => {
    if (!session.data?.user) return;
    let cancelled = false;
    void rpc.messaging
      .status()
      .then((status) => {
        if (!cancelled) {
          setMessagingSurfaceEnabled(status.enabled);
          setMessagingProviders(status.providers);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session.data?.user]);
  const [usageState, setUsageState] = useState<UsageLoadState>({
    range: "all",
    summary: null,
    loading: false,
    error: false,
  });
  const usageLoaderRef = useRef<UsageLoader | null>(null);
  if (!usageLoaderRef.current) {
    // Fenced loader: late responses from older ranges are dropped and a failed
    // request clears the summary instead of mixing ranges and results.
    usageLoaderRef.current = createUsageLoader(
      (range) => rpc.usage.modelStats({ range }),
      setUsageState,
    );
  }
  const loadUsage = (range: UsageRange) => usageLoaderRef.current!.load(range);
  const autoBooted = useRef<string | null>(null);
  const routineSavePending = useRef(false);
  const webhookSecretProvisionRef = useRef(new Map<string, Promise<string>>());
  const ensureWebhookSecret = (botId: string) =>
    sharedInflight(webhookSecretProvisionRef.current, botId, async () => {
      const result = await rpc.bots.rotateWebhookSecret({ botId });
      setRoutineWebhookSecret(result.secret);
      setBots((current) =>
        current.map((bot) => (bot.id === botId ? { ...bot, webhookConfigured: true } : bot)),
      );
      return result.secret;
    });
  const routineSaveRequest = useRef(0);
  const routineRunPending = useRef(false);
  const bootstrappedThread = useRef<ThreadSnapshot | null>(null);
  const expandedHistoryThread = useRef<string | null>(null);
  const historyEpoch = useRef(0);
  const jumpGeneration = useRef(0);
  const [scrollRequest, setScrollRequest] = useState<{
    messageId: string;
    nonce: number;
  } | null>(null);
  const clearScrollRequest = useCallback(() => setScrollRequest(null), []);
  const initiallyScrolledThread = useRef<string | null>(null);
  const messageScroll = useRef<HTMLDivElement>(null);
  const pinnedAroundRef = useRef<{
    botId?: string;
    groupId?: string;
    messageId: string;
    threadId: string;
    messages: ThreadMessage[];
    olderCursor: number | null;
  } | null>(null);
  const manuallyUnread = useRef(new Set<string>());
  const readVisibleGroups = useRef(new Set<string>());
  const notifiedBrowserEvents = useRef(new Set<string>());
  const pendingBrowserNotifications = useRef(new Map<string, PendingBrowserNotification>());
  const computerVisible = useRef(false);
  computerVisible.current = (panel === "settings" && settingsTab === "computer") || computerOpen;
  const autoSpoken = useRef<string | null>(null);
  const autoSpokenBotId = useRef<string | null>(null);

  const inGroup = Boolean(groupId);
  const active = inGroup ? undefined : (bots.find((b) => b.id === botId) ?? bots[0]);
  const computerBot =
    (computerBotId ? bots.find((bot) => bot.id === computerBotId) : undefined) ?? active;
  computerOpenRef.current = computerOpen;
  computerBotIdRef.current = computerBotId ?? active?.id;
  const activeGroup = groups.find((group) => group.id === groupId);
  const groupPanel = useGroupPanel(inGroup ? (groupId ?? null) : null);
  useEffect(() => {
    if (!inGroup && panel === "group") setPanel(null);
  }, [inGroup, panel]);
  useEffect(() => {
    if (panel === "group") groupPanel.reload();
  }, [panel, groupPanel.reload]);
  const activePendingAttachments = useMemo(
    () => attachmentsForThread(pendingAttachments, inGroup ? groupId : active?.id),
    [active?.id, groupId, inGroup, pendingAttachments],
  );
  const activeRoutines = !inGroup && routinesBotId === active?.id ? routines : [];
  const activeTaughtSkills = taughtSkillsBotId === active?.id ? taughtSkills : [];
  const recordingSkill = activeTaughtSkills.find((skill) => skill.status === "recording") ?? null;
  const routeBotId = useRef<string | undefined>(botId);
  routeBotId.current = botId;
  const routeGroupId = useRef<string | undefined>(groupId);
  routeGroupId.current = groupId;
  const activeBotId = useRef<string | undefined>(inGroup ? undefined : active?.id);
  activeBotId.current = inGroup ? undefined : active?.id;
  const activeGroupId = useRef<string | undefined>(groupId);
  activeGroupId.current = groupId;
  const screenRequest = useRef(0);
  const contextBot =
    botMenu?.kind === "bot" ? bots.find((bot) => bot.id === botMenu.id) : undefined;
  const contextGroup =
    botMenu?.kind === "group" ? groups.find((group) => group.id === botMenu.id) : undefined;
  const contextChat = contextBot ?? contextGroup;
  const closeBotMenu = useCallback(() => setBotMenu(null), []);
  const updateBotUnread = useCallback((id: string, unread: boolean) => {
    setBots((current) => {
      const bot = current.find((candidate) => candidate.id === id);
      if (!bot || bot.unread === unread) return current;
      return current.map((candidate) =>
        candidate.id === id ? { ...candidate, unread } : candidate,
      );
    });
  }, []);
  const markBotRead = useCallback(
    async (id: string) => {
      await rpc.threads.markRead({ botId: id });
      manuallyUnread.current.delete(id);
      updateBotUnread(id, false);
    },
    [updateBotUnread],
  );
  const markBotUnread = useCallback(
    async (id: string) => {
      manuallyUnread.current.add(id);
      try {
        await rpc.threads.markUnread({ botId: id });
      } catch (err) {
        manuallyUnread.current.delete(id);
        throw err;
      }
      updateBotUnread(id, true);
    },
    [updateBotUnread],
  );
  // A bot the user marked unread by hand stays unread until they open it again,
  // otherwise the auto-read below would undo the action on the next window focus.
  const markBotReadIfVisible = useCallback(
    (id: string) => {
      if (manuallyUnread.current.has(id)) return;
      if (document.visibilityState === "visible" && document.hasFocus()) {
        void markBotRead(id).catch(() => undefined);
      }
    },
    [markBotRead],
  );
  const deliverBrowserNotification = useCallback((pending: PendingBrowserNotification): boolean => {
    const currentBot = botsRef.current.find((bot) => bot.id === pending.botId);
    if (!currentBot || typeof Notification === "undefined") return true;
    const result = deliverNativeBrowserNotification(
      pending.event,
      currentBot.name || pending.botName,
      {
        enabled: pending.groupNotification || currentBot.notifyOnFinish,
        pageVisible: document.visibilityState === "visible",
        windowFocused: document.hasFocus(),
        permission: Notification.permission,
        notifiedEventIds: notifiedBrowserEvents.current,
        show: (title, body, tag) => new Notification(title, { body, tag }),
      },
    );
    return result !== "pending";
  }, []);
  const flushPendingBrowserNotifications = useCallback(() => {
    for (const [threadId, pending] of pendingBrowserNotifications.current) {
      if (deliverBrowserNotification(pending)) {
        pendingBrowserNotifications.current.delete(threadId);
      }
    }
  }, [deliverBrowserNotification]);
  const notifyBrowserForEvent = useCallback(
    (
      event: Pick<ProductEvent, "id" | "type" | "threadId" | "seq" | "botId" | "payload">,
      subscribedThreadId: string | undefined,
      initialCursor: number,
      streamReady: boolean,
      botName: string,
      enabled: boolean,
      groupNotification: boolean,
    ) => {
      const botId = event.botId;
      if (typeof botId !== "string") return;
      const eligible = shouldNotifyBrowser(event, {
        subscribedThreadId: subscribedThreadId ?? "",
        initialCursor,
        streamReady,
        pageVisible: document.visibilityState === "visible",
        windowFocused: document.hasFocus(),
        permission: "granted",
        notifiedEventIds: notifiedBrowserEvents.current,
      });
      if (!eligible || !enabled) return;
      const pending = {
        event,
        botId,
        botName,
        groupNotification,
      } satisfies PendingBrowserNotification;
      if (typeof Notification === "undefined" || Notification.permission === "denied") return;
      if (Notification.permission === "default") {
        pendingBrowserNotifications.current.set(event.threadId, pending);
        return;
      }
      if (deliverBrowserNotification(pending)) {
        pendingBrowserNotifications.current.delete(event.threadId);
      } else {
        pendingBrowserNotifications.current.set(event.threadId, pending);
      }
    },
    [deliverBrowserNotification],
  );

  const refreshBots = useCallback(
    async (includeArchived = false, replaceBotOrder = false) => {
      markOnce("rk:renderer:bots-request-start");
      const request = ++botsRefreshEpoch.current;
      const botOrderEpoch = botOrderEpochRef.current;
      const preserveBotOrder = savingBotOrderRef.current || pendingBotOrderRef.current !== null;
      const archivedRequest = includeArchived ? ++archivedBotsRefreshEpoch.current : null;
      botsRefreshInFlight.current += 1;
      try {
        const [navigation, archived, archivedGroupList] = await Promise.all([
          rpc.spaces.list(),
          includeArchived ? rpc.bots.listArchived() : Promise.resolve(null),
          includeArchived ? rpc.groups.listArchived() : Promise.resolve(null),
        ]);
        const { bots: list, botSections: sections, groups: groupList } = navigation.current;
        markOnce("rk:renderer:bots-response");
        const botsFresh = request === botsRefreshEpoch.current;
        const archivedFresh =
          archivedRequest != null && archivedRequest === archivedBotsRefreshEpoch.current;
        // A newer non-archived refresh can win the bots epoch while an older
        // includeArchived request still owns archivedBotsRefreshEpoch — apply
        // whichever slices are still current.
        if (!botsFresh && !archivedFresh) return;
        if (archivedFresh && archived) setArchivedBots(archived);
        if (archivedFresh && archivedGroupList) setArchivedGroups(archivedGroupList);
        if (!botsFresh) return;
        if (
          botOrderEpoch === botOrderEpochRef.current &&
          (replaceBotOrder || (!preserveBotOrder && !savingBotOrderRef.current))
        ) {
          setBots(list);
        }
        setBotSections(sections);
        setGroups(groupList);
        setSpaces(navigation.spaces);
        setInitialBotsLoaded(true);
        botsRefreshApplied.current = request;
        if (
          includeArchived &&
          list.length === 0 &&
          archived?.length === 0 &&
          groupList.length === 0 &&
          archivedGroupList?.length === 0 &&
          !navigation.spaces.some((space) => space.hasContent)
        ) {
          // Only the very first bot everywhere needs onboarding. An empty
          // current space with content elsewhere stays in the app so the
          // space can be switched to or deleted instead of trapping the user.
          navigate("/onboarding", { replace: true });
          return;
        }
        const currentGroupId = routeGroupId.current;
        if (currentGroupId) {
          if (!groupList.some((group) => group.id === currentGroupId)) {
            navigate(firstThreadRoute(list, groupList), { replace: true });
          }
          return;
        }
        const currentBotId = routeBotId.current;
        if (!currentBotId || !list.some((bot) => bot.id === currentBotId)) {
          navigate(firstThreadRoute(list, groupList), { replace: true });
        }
      } finally {
        botsRefreshInFlight.current -= 1;
      }
    },
    [navigate],
  );

  function snapTranscriptToEndAfterFrame() {
    const queuedElement = messageScroll.current;
    if (!queuedElement) return;
    const queuedScrollTop = queuedElement.scrollTop;
    window.requestAnimationFrame(() => {
      const element = messageScroll.current;
      if (transcriptCanSnapAfterFrame(element, queuedElement, queuedScrollTop)) {
        queuedElement.scrollTop = queuedElement.scrollHeight;
      }
    });
  }

  async function refreshGroupThread(id: string, signal?: AbortSignal) {
    const scrollElement = messageScroll.current;
    const stickToEnd = !scrollElement || transcriptIsNearEnd(scrollElement);
    markOnce("rk:renderer:thread-request-start");
    const request = ++groupRefreshEpoch.current;
    const snap = await rpc.threads.get({ groupId: id }, signal ? { signal } : undefined);
    markOnce("rk:renderer:thread-response");
    if (activeGroupId.current !== id || request !== groupRefreshEpoch.current) return snap;
    const reconciled = reconcileRefreshedThread(
      snapshotRef.current,
      snap,
      computerRef.current,
      expandedHistoryThread.current === snap.threadId,
    );
    commitSnapshot(reconciled.snapshot);
    if (!computerOpenRef.current) commitComputer(null);
    setRoutines([]);
    setRoutinesBotId(null);
    // Keep the search-jump viewport; expandedHistoryThread merge still accepts live messages.
    if (
      stickToEnd &&
      (!scrollElement || transcriptIsNearEnd(scrollElement)) &&
      expandedHistoryThread.current !== snap.threadId
    ) {
      snapTranscriptToEndAfterFrame();
    }
    return snap;
  }

  async function refreshThread(id: string, signal?: AbortSignal) {
    const scrollElement = messageScroll.current;
    const stickToEnd = !scrollElement || transcriptIsNearEnd(scrollElement);
    markOnce("rk:renderer:thread-request-start");
    const epoch = historyEpoch.current;
    const request = ++threadRefreshEpoch.current;
    // Apply threads.get as soon as it returns so stop/takeover status is not held behind
    // routines/skills/screen fetches (progress can advance the cursor meanwhile).
    const snap = await rpc.threads.get({ botId: id }, signal ? { signal } : undefined);
    markOnce("rk:renderer:thread-response");
    if (
      activeBotId.current !== id ||
      epoch !== historyEpoch.current ||
      request !== threadRefreshEpoch.current
    ) {
      return snap;
    }
    const reconciled = reconcileRefreshedThread(
      snapshotRef.current,
      snap,
      computerRef.current,
      expandedHistoryThread.current === snap.threadId,
    );
    commitSnapshot(reconciled.snapshot);
    commitComputer(reconciled.computer);
    cacheComputerFor(id, { computer: reconciled.computer });
    if (
      stickToEnd &&
      (!scrollElement || transcriptIsNearEnd(scrollElement)) &&
      expandedHistoryThread.current !== snap.threadId
    ) {
      snapTranscriptToEndAfterFrame();
    }
    void Promise.all([
      rpc.routines.list({ botId: id }).catch(() => null),
      rpc.skills.list({ botId: id }).catch(() => null),
      refreshComputerScreen(id).catch(() => null),
    ]).then(([routines, skills]) => {
      if (
        activeBotId.current !== id ||
        epoch !== historyEpoch.current ||
        request !== threadRefreshEpoch.current
      ) {
        return;
      }
      if (routines) {
        setRoutines(routines);
        setRoutinesBotId(id);
      }
      if (skills) {
        setTaughtSkills(skills);
        setTaughtSkillsBotId(id);
      }
    });
    return snap;
  }

  async function refreshComputerScreen(id: string) {
    if (!computerVisible.current) return null;
    const request = ++screenRequest.current;
    return loadComputerScreen({
      load: () => rpc.computer.screenUrl({ botId: id }),
      isCurrent: () =>
        request === screenRequest.current &&
        (activeBotId.current === id || computerBotIdRef.current === id) &&
        computerVisible.current,
      commit: (screen) => {
        setScreenUrl(screen.url);
        setComputerError(screen.error);
        setComputerErrorFromScreen(Boolean(screen.error));
        cacheComputerFor(id, { screenUrl: screen.url });
      },
      fallbackError: t`Could not connect to the computer screen`,
    });
  }

  async function loadOlderMessages() {
    const targetBotId = inGroup ? undefined : active?.id;
    const targetGroupId = inGroup ? groupId : undefined;
    const snapshotMatchesTarget = targetGroupId
      ? snapshot?.groupId === targetGroupId
      : snapshot?.botId === targetBotId;
    if (
      (!targetBotId && !targetGroupId) ||
      !snapshotMatchesTarget ||
      snapshot?.olderCursor == null ||
      loadingOlder
    )
      return;
    pinnedAroundRef.current = null;
    const scrollElement = messageScroll.current;
    const previousHeight = scrollElement?.scrollHeight ?? 0;
    const epoch = historyEpoch.current;
    const before = snapshot.olderCursor;
    setLoadingOlder(true);
    try {
      const page = await rpc.threads.messages({
        ...(targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! }),
        before,
      });
      if (
        epoch !== historyEpoch.current ||
        activeBotId.current !== targetBotId ||
        activeGroupId.current !== targetGroupId
      )
        return;
      expandedHistoryThread.current = page.threadId;
      updateSnapshot((prev) => prependThreadMessagePage(prev, page));
      window.requestAnimationFrame(() => {
        const element = messageScroll.current;
        if (element) element.scrollTop += element.scrollHeight - previousHeight;
      });
    } finally {
      setLoadingOlder(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const providerConfigRevision = memoryProviderConfigRevision.current;
    void rpc.memory
      .providerConfig()
      .then((providerConfig) => {
        if (!cancelled && memoryProviderConfigRevision.current === providerConfigRevision) {
          setMemoryProviderConfig(providerConfig);
        }
      })
      .catch(() => {
        if (!cancelled && memoryProviderConfigRevision.current === providerConfigRevision) {
          setMemoryProviderConfig(null);
        }
      });
    const appliedAtStart = botsRefreshApplied.current;
    void takeInitialBootstrap(botId)
      .then((bootstrap) => {
        if (cancelled) return;
        const groupList = bootstrap.groups;
        setBootstrapMe(bootstrap.me);
        // Skip list/route writes only if a later refreshBots() successfully
        // committed (failed refreshes bump epoch but not botsRefreshApplied).
        const applyBotLists = appliedAtStart === botsRefreshApplied.current;
        if (applyBotLists) {
          setBots(bootstrap.bots);
          setBotSections(bootstrap.botSections);
          setArchivedBots(bootstrap.archivedBots);
          setArchivedGroups(bootstrap.archivedGroups);
          setGroups(groupList);
          setSpaces(bootstrap.spaces);
          setInitialBotsLoaded(true);
        }
        if (!groupId && bootstrap.thread) {
          bootstrappedThread.current = bootstrap.thread;
          commitSnapshot(bootstrap.thread);
          commitComputer(bootstrap.thread.computer ?? null);
          setRoutines(bootstrap.routines);
          setRoutinesBotId(bootstrap.thread.botId ?? null);
          markOnce("rk:renderer:bots-response");
          markOnce("rk:renderer:thread-response");
        }
        if (!applyBotLists) return;
        if (
          bootstrap.bots.length === 0 &&
          bootstrap.archivedBots.length === 0 &&
          groupList.length === 0 &&
          bootstrap.archivedGroups.length === 0 &&
          !bootstrap.spaces.some((space) => space.hasContent)
        ) {
          navigate("/onboarding", { replace: true });
          return;
        }
        if (groupId) {
          if (!groupList.some((group) => group.id === groupId)) {
            navigate(firstThreadRoute(bootstrap.bots, groupList), { replace: true });
          }
          return;
        }
        const selectedBotId = bootstrap.thread?.botId ?? bootstrap.bots[0]?.id;
        if (selectedBotId && selectedBotId !== botId) {
          navigate(`/app/${selectedBotId}`, { replace: true });
        }
      })
      .catch(() => {
        if (cancelled) return;
        setBootstrapMe(null);
        void refreshBots(true);
      });
    let refreshTimer: number | undefined;
    const refreshVisibleBots = () => {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void refreshBots().catch(() => undefined), 50);
    };
    window.addEventListener("focus", refreshVisibleBots);
    document.addEventListener("visibilitychange", refreshVisibleBots);
    // Poll skips while a refresh is in flight; focus/visibility and event-driven
    // callers still bump botsRefreshEpoch so only the latest response applies.
    const poll = window.setInterval(() => {
      if (botsRefreshInFlight.current > 0) return;
      refreshVisibleBots();
    }, 3_000);
    return () => {
      cancelled = true;
      window.clearTimeout(refreshTimer);
      window.clearInterval(poll);
      window.removeEventListener("focus", refreshVisibleBots);
      document.removeEventListener("visibilitychange", refreshVisibleBots);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void rpc.agentSkills
      .list()
      .then((skills) => {
        if (!cancelled) setAgentSkills(skills);
      })
      .catch(() => {
        if (!cancelled) setAgentSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshAgentSkills = useCallback(() => {
    void rpc.agentSkills
      .list()
      .then(setAgentSkills)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void rpc.voice
      .status()
      .then(setVoiceStatus)
      .catch(() => undefined);
    const unsubSpeech = speaker.subscribe((state) => {
      setSpeakingMessageId(state.status === "idle" ? null : (state.messageId ?? null));
    });
    return () => {
      unsubSpeech();
    };
  }, []);

  useEffect(() => {
    if (!active || !snapshot || snapshot.botId !== active.id) return;
    const lastBot = [...snapshot.messages].reverse().find((message) => message.role === "bot");
    if (autoSpokenBotId.current !== active.id) {
      autoSpokenBotId.current = active.id;
      autoSpoken.current = lastBot?.id ?? null;
      return;
    }
    if (call?.botId === active.id || !active.autoSpeak) {
      autoSpoken.current = lastBot?.id ?? null;
      return;
    }
    if (snapshot.run && ["running", "queued", "leased"].includes(snapshot.run.status)) return;
    if (!lastBot || lastBot.id === autoSpoken.current) return;
    const text = speechFromBlocks(lastBot.blocks);
    if (!text) return;
    autoSpoken.current = lastBot.id;
    void speaker.speak(text, { botId: active.id, messageId: lastBot.id });
  }, [
    snapshot?.messages,
    snapshot?.run?.status,
    snapshot?.botId,
    active?.autoSpeak,
    active?.id,
    call?.botId,
  ]);

  useEffect(() => {
    if (!active) return;
    // Opening a bot clears the manual unread flag so it can auto-read again.
    manuallyUnread.current.delete(active.id);
    const markVisibleBotRead = () => {
      markBotReadIfVisible(active.id);
    };
    markVisibleBotRead();
    window.addEventListener("focus", markVisibleBotRead);
    document.addEventListener("visibilitychange", markVisibleBotRead);
    return () => {
      window.removeEventListener("focus", markVisibleBotRead);
      document.removeEventListener("visibilitychange", markVisibleBotRead);
    };
  }, [active?.id, markBotReadIfVisible]);

  useEffect(() => {
    if (!active) return;
    const pendingJump = searchParamsRef.current.get("m");
    if (!pendingJump) {
      pinnedAroundRef.current = null;
    }
    screenRequest.current += 1;
    setComputerError(null);
    setComputerErrorFromScreen(false);
    const cached = computerCacheRef.current.get(active.id);
    if (cached) {
      // Paint the last-known computer instantly; refreshThread/refreshComputerScreen
      // below still run and reconcile with fresh data in the background.
      setScreenUrl(cached.screenUrl);
      commitComputer(cached.computer);
    } else {
      setScreenUrl(null);
    }
    expandedHistoryThread.current = null;
    historyEpoch.current += 1;
    const abort = new AbortController();
    void runThreadSubscription({
      signal: abort.signal,
      loadInitial: async () => {
        const primed = bootstrappedThread.current;
        bootstrappedThread.current = null;
        // Pending search jumps load the around-page separately; avoid replacing it with latest.
        return primed?.botId === active.id
          ? primed
          : pendingJump
            ? rpc.threads.get({ botId: active.id }, { signal: threadSnapshotSignal(abort.signal) })
            : refreshThread(active.id, threadSnapshotSignal(abort.signal));
      },
      loadHead: () =>
        rpc.threads.head({ botId: active.id }, { signal: threadSnapshotSignal(abort.signal) }),
      refresh: () => refreshThread(active.id, threadSnapshotSignal(abort.signal)),
      currentSnapshot: () => snapshotRef.current,
      subscribe: (cursor) =>
        rpc.threads.subscribe({ botId: active.id, cursor }, { signal: abort.signal }),
      beforeEvent: (event) => {
        if (isRunTerminalEvent(event) && event.runId) {
          terminalRunReceipts.current.add(event.runId);
          if (terminalRunReceipts.current.size > 100) {
            const oldest = terminalRunReceipts.current.values().next().value;
            if (oldest !== undefined) terminalRunReceipts.current.delete(oldest);
          }
        }
      },
      applyEvent: (event) =>
        applyThreadEvent(event, commitSnapshot, commitComputer, snapshotRef, computerRef, botsRef),
      onEvent: (event, initial) => {
        const currentBot = botsRef.current.find((bot) => bot.id === active.id);
        notifyBrowserForEvent(
          event,
          initial.threadId,
          initial.cursor,
          true,
          currentBot?.name ?? active.name,
          currentBot?.notifyOnFinish ?? false,
          false,
        );
        if (event.type === "thread.cleared") {
          expandedHistoryThread.current = null;
          pinnedAroundRef.current = null;
          historyEpoch.current += 1;
        }
        if (event.type === "bot.archived") {
          void refreshBots(true).catch(() => undefined);
        } else if (
          event.type === "bot.spawned" ||
          event.type === "bot.deleted" ||
          event.type === "bot.updated" ||
          event.type === "run.started" ||
          isRunTerminalEvent(event) ||
          event.type === "thread.cleared"
        ) {
          void refreshBots().catch(() => undefined);
        }
        if (event.type === "thread.message.created") {
          const blocks = (event.payload.blocks as Array<{ kind?: string }>) ?? [];
          if (
            blocks.some((block) => block.kind === "child_bot" || block.kind === "avatar_change")
          ) {
            void refreshBots().catch(() => undefined);
          }
          if (blocks.some((block) => block.kind === "avatar_change")) {
            window.dispatchEvent(new Event("workpal:avatar-refresh"));
          }
          if (event.payload.role === "bot") markBotReadIfVisible(active.id);
        }
        if (
          isRunTerminalEvent(event) ||
          event.type === "run.waiting_input" ||
          event.type === "skill.teaching.stopped"
        ) {
          // waiting_input: reconcile ask cards if a stale post-send refresh raced SSE.
          void refreshThread(active.id).catch(() => undefined);
        } else if (isComputerStatusEvent(event)) {
          if (isSessionControlLifecycleEvent(event)) {
            // The session-control card is derived from the authoritative
            // snapshot; a screen-only refresh leaves it stale or missing.
            void refreshThread(active.id).catch(() => undefined);
          }
          void refreshComputerScreen(active.id).catch(() => undefined);
        }
      },
    });
    return () => {
      abort.abort();
    };
  }, [active?.id, markBotReadIfVisible, notifyBrowserForEvent]);

  useEffect(() => {
    if (!groupId || !activeGroup) return;
    manuallyUnread.current.delete(activeGroup.id);
    readVisibleGroups.current.delete(groupId);
    const markVisibleGroupRead = () => {
      if (
        document.visibilityState !== "visible" ||
        !document.hasFocus() ||
        readVisibleGroups.current.has(groupId)
      )
        return;
      readVisibleGroups.current.add(groupId);
      void rpc.threads
        .markRead({ groupId })
        .then(() => {
          setGroups((current) => {
            const group = current.find((candidate) => candidate.id === groupId);
            if (!group?.unread) return current;
            return current.map((candidate) =>
              candidate.id === groupId ? { ...candidate, unread: false } : candidate,
            );
          });
        })
        .catch(() => {
          readVisibleGroups.current.delete(groupId);
        });
    };
    markVisibleGroupRead();
    window.addEventListener("focus", markVisibleGroupRead);
    document.addEventListener("visibilitychange", markVisibleGroupRead);
    const pendingJump = searchParamsRef.current.get("m");
    if (!pendingJump) {
      pinnedAroundRef.current = null;
      expandedHistoryThread.current = null;
    }
    historyEpoch.current += 1;
    const abort = new AbortController();
    void runThreadSubscription({
      signal: abort.signal,
      loadInitial: () =>
        pendingJump
          ? rpc.threads.get({ groupId }, { signal: threadSnapshotSignal(abort.signal) })
          : refreshGroupThread(groupId, threadSnapshotSignal(abort.signal)),
      loadHead: () => rpc.threads.head({ groupId }, { signal: threadSnapshotSignal(abort.signal) }),
      refresh: () => refreshGroupThread(groupId, threadSnapshotSignal(abort.signal)),
      currentSnapshot: () => snapshotRef.current,
      subscribe: (cursor) => rpc.threads.subscribe({ groupId, cursor }, { signal: abort.signal }),
      applyEvent: (event) =>
        applyThreadEvent(
          event,
          commitSnapshot,
          (next) => {
            if (isComputerStatusEvent(event) && event.botId !== computerBotIdRef.current) return;
            commitComputer(next);
          },
          snapshotRef,
          computerRef,
          botsRef,
        ),
      onEvent: (event, initial) => {
        const eventBot = botsRef.current.find((bot) => bot.id === event.botId);
        notifyBrowserForEvent(
          event,
          initial.threadId,
          initial.cursor,
          true,
          eventBot?.name ?? activeGroup.name,
          true,
          true,
        );
        if (event.type === "thread.message.created" && event.payload.role === "bot") {
          readVisibleGroups.current.delete(groupId);
          markVisibleGroupRead();
          const blocks = (event.payload.blocks as Array<{ kind?: string }>) ?? [];
          if (blocks.some((block) => block.kind === "avatar_change")) {
            window.dispatchEvent(new Event("workpal:avatar-refresh"));
            void refreshBots().catch(() => undefined);
          }
        }
        if (
          event.type === "run.started" ||
          event.type === "bot.updated" ||
          isRunTerminalEvent(event)
        ) {
          void refreshBots().catch(() => undefined);
        }
        if (isRunTerminalEvent(event) || event.type === "run.waiting_input") {
          // waiting_input: reconcile ask cards if a stale post-send refresh raced SSE.
          void refreshGroupThread(groupId).catch(() => undefined);
        }
      },
    });
    return () => {
      window.removeEventListener("focus", markVisibleGroupRead);
      document.removeEventListener("visibilitychange", markVisibleGroupRead);
      abort.abort();
    };
  }, [activeGroup?.id, groupId, notifyBrowserForEvent]);

  const sidebarGroups = useMemo(() => {
    const needle = query.toLowerCase();
    const sidebarSpaces =
      spaces.length > 0
        ? spaces.map((space) =>
            space.id === bootstrapMe?.spaceId ? { ...space, bots, groups, botSections } : space,
          )
        : bootstrapMe
          ? [
              {
                id: bootstrapMe.spaceId,
                name: "Personal",
                isDefault: true,
                hasContent: true,
                canDelete: false,
                bots,
                groups,
                botSections,
              },
            ]
          : [];
    const showSpaceNames = sidebarSpaces.length > 1;
    return sidebarSpaces.flatMap((space) => {
      const visibleBots = space.bots.filter((bot) =>
        `${bot.name} ${bot.title ?? ""} ${bot.preview ?? ""}`.toLowerCase().includes(needle),
      );
      const visibleGroups = space.groups.filter((group) =>
        `${group.name} ${group.preview}`.toLowerCase().includes(needle),
      );
      const sections = groupBotsForSidebar(
        [
          ...visibleBots.map((chat) => ({ kind: "bot" as const, chat })),
          ...visibleGroups.map((chat) => ({ kind: "group" as const, chat })),
        ].map((item) => ({
          ...item,
          id: item.chat.id,
          parentBotId: item.kind === "bot" ? item.chat.parentBotId : null,
          pinned: item.chat.pinned,
          sectionId: item.chat.sectionId,
        })),
        space.botSections,
      ).map((group, index) => ({
        ...group,
        sectionId: group.key.startsWith("section:") ? group.key.slice("section:".length) : null,
        key: showSpaceNames ? `space:${space.id}:${group.key}` : group.key,
        title: showSpaceNames
          ? group.title
            ? `${space.name} · ${group.title}`
            : space.name
          : group.title,
        showLock: showSpaceNames,
        emptySpaceId: undefined as string | undefined,
        spaceId: space.id,
        spaceName: space.name,
        canDeleteSpace: index === 0 && space.canDelete === true,
      }));
      if (sections.length > 0) return sections;
      // Keep empty spaces selectable; chat clicks are the only switch control.
      if (!showSpaceNames) return [];
      if (needle && (space.bots.length > 0 || space.groups.length > 0)) return [];
      return [
        {
          key: `space:${space.id}:empty`,
          title: space.name,
          bots: [],
          sectionId: null,
          showLock: true,
          emptySpaceId: space.id,
          spaceId: space.id,
          spaceName: space.name,
          canDeleteSpace: space.canDelete === true,
        },
      ];
    });
  }, [bootstrapMe, botSections, bots, groups, spaces, query]);

  const openSpaceChat = useCallback(
    (spaceId: string, path: string) => {
      setMobileSidebarOpen(false);
      const previousSpaceId = selectedSpaceId();
      // Persist the active space (including primary) so voice/RPC headers match the chat.
      const selectionStored = selectSpace(spaceId);
      if (!selectionStored) return;
      const previousEffective = previousSpaceId ?? bootstrapMe?.spaceId;
      const boundaryChanged = previousEffective !== spaceId;
      // Soft-navigate within the same space; reload only when the auth boundary changes
      // so bootstrapped bots/groups match the request header.
      if (boundaryChanged) {
        window.location.assign(path);
        return;
      }
      navigate(path);
    },
    [bootstrapMe?.spaceId, navigate],
  );
  const flushBotOrder = useCallback(async () => {
    if (savingBotOrderRef.current) return;
    savingBotOrderRef.current = true;
    try {
      while (pendingBotOrderRef.current) {
        const botIds = pendingBotOrderRef.current;
        pendingBotOrderRef.current = null;
        try {
          await rpc.bots.reorder({ botIds });
        } catch {
          // Keep a newer order queued during this failed save; only roll back
          // when nothing else is pending.
          if (pendingBotOrderRef.current === null) {
            await refreshBots(false, true).catch(() => undefined);
          }
        }
      }
    } finally {
      savingBotOrderRef.current = false;
      // A reorder may have arrived while saving=true and returned early.
      if (pendingBotOrderRef.current) {
        void flushBotOrder();
      }
    }
  }, [refreshBots]);
  const reorderRosterBot = useCallback(
    (sourceId: string, targetId: string, groupBotIds: string[]) => {
      if (!groupBotIds.includes(sourceId) || !groupBotIds.includes(targetId)) return;
      const current = botsRef.current;
      const reordered = reorderBotTo(current, sourceId, targetId);
      if (reordered === current) return;
      const next = [...reordered];
      botOrderEpochRef.current += 1;
      botsRef.current = next;
      setBots(next);
      pendingBotOrderRef.current = next.map((bot) => bot.id);
      void flushBotOrder();
    },
    [flushBotOrder],
  );
  const toggleSidebarSection = useCallback(
    (key: string) => {
      setCollapsedSidebarSections((previous) =>
        toggleCollapsedIdSet(previous, key, collapsedSidebarSectionsStorageKey(userId)),
      );
    },
    [userId],
  );
  const toggleRosterParent = useCallback(
    (botId: string) => {
      setCollapsedRosterParents((previous) =>
        toggleCollapsedIdSet(previous, botId, collapsedRosterParentsStorageKey(userId)),
      );
    },
    [userId],
  );
  const spaceQuery = query.trim();
  const showSpaceSearch = spaceQuery.length > 0;

  useEffect(() => {
    if (!showSpaceSearch) {
      setSearchHits([]);
      setSearchLoading(false);
      return;
    }
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      setSearchLoading(true);
      void rpc.search
        .query({ q: spaceQuery })
        .then((result) => {
          if (!abort.signal.aborted) setSearchHits(result.hits);
        })
        .catch(() => {
          if (!abort.signal.aborted) setSearchHits([]);
        })
        .finally(() => {
          if (!abort.signal.aborted) setSearchLoading(false);
        });
    }, 200);
    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [showSpaceSearch, spaceQuery]);

  async function jumpToSearchHit(hit: SearchHit) {
    setQuery("");
    setSearchHits([]);
    const params = new URLSearchParams();
    if (hit.messageId) params.set("m", hit.messageId);
    if (hit.routineId) params.set("routine", hit.routineId);
    navigate({
      pathname: hit.groupId ? `/app/g/${hit.groupId}` : `/app/${hit.botId}`,
      search: params.toString() ? `?${params.toString()}` : undefined,
    });
  }

  async function jumpToMessage(target: { botId?: string; groupId?: string; messageId: string }) {
    const threadTarget = searchHitThreadTarget(target);
    const epoch = historyEpoch.current;
    jumpGeneration.current += 1;
    const jumpId = jumpGeneration.current;
    const [snap, page] = await Promise.all([
      rpc.threads.get(threadTarget),
      rpc.threads.messages({ ...threadTarget, around: { messageId: target.messageId } }),
    ]);
    // The epoch check drops a jump that raced a conversation clear (or a bot switch): applying
    // the fetched page would pin deleted messages that every later refresh keeps restoring.
    // jumpId drops an older jump that finished after a newer click.
    if (epoch !== historyEpoch.current || jumpId !== jumpGeneration.current) return;
    if (target.groupId && activeGroupId.current !== target.groupId) return;
    if (target.botId && activeBotId.current !== target.botId) return;
    const targetInPage = userVisibleMessages(page.messages, { includePeerReceipts: true }).some(
      (message) => message.id === target.messageId,
    );
    expandedHistoryThread.current = targetInPage ? page.threadId : null;
    pinnedAroundRef.current = targetInPage
      ? {
          ...threadTarget,
          messageId: target.messageId,
          threadId: page.threadId,
          messages: page.messages,
          olderCursor: page.olderCursor,
        }
      : null;
    if (targetInPage) initiallyScrolledThread.current = page.threadId;
    // The around-page carries the summaries of its own Runs (HISTORY-001):
    // merging them keeps a jumped-to Execution Card server-driven even when
    // the Run sits outside the thread's recent window (anchor jump).
    const mergedExecutions = targetInPage
      ? mergeExecutionsByRun(page.executions, snap.executions)
      : snap.executions;
    commitSnapshot({
      ...snap,
      messages: targetInPage ? page.messages : snap.messages,
      olderCursor: targetInPage ? page.olderCursor : snap.olderCursor,
      ...(mergedExecutions ? { executions: mergedExecutions } : {}),
    });
    if (threadTarget.botId) {
      commitComputer(snap.computer ?? null);
      // Don't block parent-scroll on routines metadata; a list failure must not abort the jump.
      void rpc.routines
        .list({ botId: threadTarget.botId })
        .then((routines) => {
          if (epoch !== historyEpoch.current || jumpId !== jumpGeneration.current) return;
          if (activeBotId.current !== threadTarget.botId) return;
          setRoutines(routines);
          setRoutinesBotId(threadTarget.botId);
        })
        .catch(() => undefined);
    } else {
      commitComputer(null);
      setRoutines([]);
      setRoutinesBotId(null);
    }
    if (targetInPage) {
      // The transcript owns the scroll: it retries until the pinned row is
      // mounted and unfollows the tail, so live commits cannot cancel it.
      setScrollRequest({ messageId: target.messageId, nonce: jumpId });
    } else {
      window.requestAnimationFrame(() => {
        if (epoch !== historyEpoch.current || jumpId !== jumpGeneration.current) return;
        const element = messageScroll.current;
        if (element) {
          element.scrollTop = element.scrollHeight;
          initiallyScrolledThread.current = page.threadId;
        }
      });
    }
  }

  useEffect(() => {
    const messageId = searchParams.get("m");
    const routineId = searchParams.get("routine");
    if (inGroup && groupId && messageId) {
      void jumpToMessage({ groupId, messageId }).finally(() => {
        // Keep expandedHistoryThread; only strip the jump URL so refresh does not remount.
        const next = new URLSearchParams(searchParams);
        next.delete("m");
        setSearchParams(next, { replace: true });
      });
      return;
    }
    if (!active) return;
    if (routineId && routinesBotId === active.id) {
      const routine = routines.find((item) => item.id === routineId);
      if (routine) {
        setRoutineDraft(draftFromRoutine(routine));
        setRoutineWebhookSecret(null);
        setEditingRoutine(routine);
        setPanel("routine");
      } else {
        setPanel("settings");
        setSettingsTab("computer");
      }
      const next = new URLSearchParams(searchParams);
      next.delete("routine");
      setSearchParams(next, { replace: true });
    }
    if (messageId) {
      void jumpToMessage({ botId: active.id, messageId }).finally(() => {
        const next = new URLSearchParams(searchParams);
        next.delete("m");
        setSearchParams(next, { replace: true });
      });
    }
  }, [active?.id, groupId, inGroup, routines, routinesBotId, searchParams, setSearchParams]);
  const activeSnapshot = inGroup
    ? snapshot?.groupId === groupId
      ? snapshot
      : null
    : snapshot?.botId === active?.id
      ? snapshot
      : null;
  // Keep the armed reply even when its parent leaves the loaded page: the
  // server resolves a paged-out target and degrades a deleted one to a plain
  // reply instead of failing the send.
  const activeReplyTarget = replyTarget;
  const activeReplyQuote = replyTarget ? replyQuote : null;
  const clearReply = useCallback(() => {
    setReplyTarget(null);
    setReplyQuote(null);
  }, []);
  const currentRuns = activeThreadRuns(activeSnapshot);
  // Run the details panel reports on: the thread's primary run, else its newest active one.
  const panelRun = activeSnapshot?.run ?? currentRuns[0] ?? null;
  // Live status for the active bot's avatar: the sidebar list is a snapshot,
  // so a run starting right now would otherwise stay "idle" until a refetch.
  const activeBotLiveStatus =
    activeSnapshot?.run?.status ?? currentRuns[0]?.status ?? active?.status;
  const { catalog: modelSwitchCatalog } = useConnectedModelOptions();

  async function switchConversationModel(next: { provider: string; modelId: string } | null) {
    if (!active) return;
    await rpc.bots
      .update({
        botId: active.id,
        modelProvider: next?.provider ?? null,
        modelId: next?.modelId ?? null,
      })
      .catch(() => undefined);
    setBots((currentBots) =>
      currentBots.map((item) =>
        item.id === active.id
          ? {
              ...item,
              modelProvider: next?.provider ?? null,
              modelId: next?.modelId ?? null,
            }
          : item,
      ),
    );
  }

  const workingRuns = currentRuns.filter((run) =>
    ["running", "queued", "leased"].includes(run.status),
  );
  const transcriptRunning = workingRuns.length > 0;
  const composerRunning = currentRuns.some((run) => isActive(run.status));
  const runError = threadRunError(activeSnapshot, dismissedRunErrorIds);
  const displayedRunError = !sendError ? runError : null;
  const displayedRunErrorId = displayedRunError ? (activeSnapshot?.run?.id ?? null) : null;
  const handleRunErrorPresented = useCallback((runId: string) => {
    rememberSeenRunErrorId(runId);
  }, []);
  const transcriptMessages = useMemo(
    () => userVisibleMessages(activeSnapshot?.messages ?? [], { includePeerReceipts: true }),
    [activeSnapshot?.messages],
  );
  const transcriptMessagesRef = useRef(transcriptMessages);
  transcriptMessagesRef.current = transcriptMessages;
  const transcriptArtifactTarget = useMemo<ArtifactTarget>(
    () => (inGroup ? { groupId: groupId ?? "" } : { botId: active?.id ?? "" }),
    [active?.id, groupId, inGroup],
  );
  const transcriptMembers = activeSnapshot?.members ?? activeGroup?.members;
  const resolveTranscriptBot = useCallback(
    (botId: string) => {
      const bot = bots.find((candidate) => candidate.id === botId);
      if (bot) return bot;
      return transcriptMembers?.find((member) => member.botId === botId);
    },
    [bots, transcriptMembers],
  );
  // Phase 4 activity projection: live inline rows (tools stay in the steps
  // card, handoffs keep their conversation marker), and background cards that
  // outlive the parent run.
  const liveActivityAll = useMemo(() => liveActivityItems(activeSnapshot), [activeSnapshot]);
  const inlineActivity = useMemo(() => inlineActivityItems(liveActivityAll), [liveActivityAll]);
  const backgroundActivity = useMemo(
    () => backgroundActivityItems(activeSnapshot),
    [activeSnapshot],
  );
  const activityBotColors = useMemo(
    () => Object.fromEntries(bots.map((bot) => [bot.id, bot.color])),
    [bots],
  );
  async function cancelBackgroundTask(taskId: string) {
    const groupId = activeGroupId.current;
    const botId = activeBotId.current;
    if (groupId) {
      await rpc.threads.cancelBackgroundTask({ groupId, taskId });
      await refreshGroupThread(groupId).catch((error) => {
        console.error("refresh after background cancellation failed", error);
      });
    } else if (botId) {
      await rpc.threads.cancelBackgroundTask({ botId, taskId });
      await refreshThread(botId).catch((error) => {
        console.error("refresh after background cancellation failed", error);
      });
    } else {
      throw new Error("No active thread for background task cancellation");
    }
  }
  const resolveTranscriptMemberName = useCallback(
    (botId: string | undefined) => memberName(transcriptMembers, botId),
    [transcriptMembers],
  );
  // UX-02: the plan review card names its Bot in direct threads too, where the
  // member list is empty. This is a SEPARATE resolver: message speaker labels
  // keep their member-only semantics (a direct-thread bot message never grows
  // a name label), only the review card header uses the roster fallback.
  const resolveTranscriptBotDisplayName = useCallback(
    (botId: string) => resolveTranscriptBot(botId)?.name,
    [resolveTranscriptBot],
  );
  const replyTargetName = activeReplyTarget
    ? activeReplyTarget.role === "user"
      ? t`You`
      : (resolveTranscriptMemberName(activeReplyTarget.botId) ?? active?.name ?? t`Bot`)
    : undefined;
  const composerMentionTargets = useMemo(
    () =>
      buildComposerMentionOptions({
        query: "",
        includeEveryone: inGroup,
        currentGroupId: groupId,
        bots: bots.map((bot) => ({ id: bot.id, name: bot.name, color: bot.color })),
        groups: groups.map((group) => ({ id: group.id, name: group.name })),
        routines: mentionRoutines.map((routine) => ({
          id: routine.id,
          name: routine.name,
          crons: routine.crons,
          botId: routine.botId,
          botName: routine.botName,
        })),
        connectors: mentionConnectors,
      }),
    [bots, groupId, groups, inGroup, mentionConnectors, mentionRoutines],
  );
  const shellReady =
    initialBotsLoaded &&
    (inGroup
      ? Boolean(activeGroup && activeSnapshot)
      : bots.length === 0 || Boolean(active && activeSnapshot));
  const refreshThreadRef = useRef(refreshThread);
  refreshThreadRef.current = refreshThread;
  const refreshGroupThreadRef = useRef(refreshGroupThread);
  refreshGroupThreadRef.current = refreshGroupThread;
  const loadOlderMessagesRef = useRef(loadOlderMessages);
  loadOlderMessagesRef.current = loadOlderMessages;
  const jumpToMessageRef = useRef(jumpToMessage);
  jumpToMessageRef.current = jumpToMessage;

  const mentionBotsKey = useMemo(
    () => bots.map((bot) => `${bot.id}:${bot.name}`).join(","),
    [bots],
  );
  const botsForMentionsRef = useRef(bots);
  botsForMentionsRef.current = bots;

  useEffect(() => {
    const bots = botsForMentionsRef.current;
    if (!initialBotsLoaded || bots.length === 0) {
      setMentionRoutines([]);
      setMentionConnectors([]);
      return;
    }
    let cancelled = false;
    const botNameById = new Map(bots.map((bot) => [bot.id, bot.name]));
    void Promise.all(
      bots.map((bot) =>
        rpc.routines
          .list({ botId: bot.id })
          .then((rows) =>
            rows.map((routine) => ({
              ...routine,
              botName: botNameById.get(bot.id) ?? bot.name,
            })),
          )
          .catch(() => [] as Array<Routine & { botName?: string }>),
      ),
    ).then((lists) => {
      if (!cancelled) setMentionRoutines(lists.flat());
    });
    void Promise.all([
      rpc.connections.list().catch(() => [] as Connection[]),
      rpc.connections.catalog({}).catch(() => [] as ConnectionCatalogItem[]),
    ]).then(([connections, catalog]) => {
      if (cancelled) return;
      const connected = connections.filter((row) => row.status === "connected");
      const options: Array<{
        id: string;
        name: string;
        authStatus: "connected" | "needs_auth";
        connectionId?: string;
      }> = connected.map((row) => ({
        id: row.id,
        name: row.displayName,
        authStatus: "connected" as const,
        connectionId: row.id,
      }));
      for (const item of catalog) {
        if (item.connected || item.noAuth) continue;
        if (
          connected.some(
            (row) =>
              row.provider.toLowerCase() === item.slug.toLowerCase() ||
              row.displayName.toLowerCase() === item.name.toLowerCase(),
          )
        ) {
          continue;
        }
        options.push({
          id: `catalog:${item.connectorId}:${item.slug}`,
          name: item.name,
          authStatus: "needs_auth",
        });
      }
      setMentionConnectors(options);
    });
    return () => {
      cancelled = true;
    };
  }, [initialBotsLoaded, mentionBotsKey]);

  useLayoutEffect(() => {
    if (initialBotsLoaded) {
      markOnce("rk:renderer:bots-committed");
      markAfterPaint("rk:renderer:bots-painted");
    }
    if (active && snapshot?.botId === active.id) {
      markOnce("rk:renderer:thread-committed");
      markAfterPaint("rk:renderer:thread-painted");
    }
    if (shellReady) {
      markOnce("rk:renderer:shell-ready");
      markAfterPaint("rk:renderer:shell-painted");
    }
  }, [active, initialBotsLoaded, shellReady, snapshot?.botId]);

  useLayoutEffect(() => {
    const pin = pinnedAroundRef.current;
    if (inGroup) {
      if (!groupId || !snapshot || snapshot.groupId !== groupId) return;
      if (initiallyScrolledThread.current === snapshot.threadId) return;
      if (expandedHistoryThread.current === snapshot.threadId) return;
      if (pin?.groupId === groupId) return;
    } else {
      if (!active || !snapshot || snapshot.botId !== active.id) return;
      if (initiallyScrolledThread.current === snapshot.threadId) return;
      if (expandedHistoryThread.current === snapshot.threadId) return;
      if (pin?.botId === active.id) return;
    }
    const element = messageScroll.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    initiallyScrolledThread.current = snapshot.threadId;
  }, [active, groupId, inGroup, snapshot?.botId, snapshot?.groupId, snapshot?.threadId]);

  const openBot = useCallback((id: string) => navigate(`/app/${id}`), [navigate]);
  const loadOlder = useCallback(() => loadOlderMessagesRef.current(), []);
  const jumpToReplyMessage = useCallback((messageId: string) => {
    const existing = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (existing) {
      // Cancel any in-flight around-fetch so it cannot overwrite this scroll.
      jumpGeneration.current += 1;
      setScrollRequest({ messageId, nonce: jumpGeneration.current });
      return;
    }
    const groupId = activeGroupId.current;
    if (groupId) {
      void jumpToMessageRef.current({ groupId, messageId });
      return;
    }
    const botId = activeBotId.current;
    if (botId) void jumpToMessageRef.current({ botId, messageId });
  }, []);
  const answerMessage = useCallback(
    async (message: ThreadMessage, text: string, username?: string) => {
      const botId = activeBotId.current;
      const groupId = activeGroupId.current;
      if (!botId && !groupId) return;
      const refreshCurrent = async () => {
        if (groupId && activeGroupId.current === groupId) {
          await refreshGroupThreadRef.current(groupId);
        } else if (botId && activeBotId.current === botId) {
          await refreshThreadRef.current(botId);
        }
      };
      try {
        await rpc.threads.answer({
          ...(groupId ? { groupId } : { botId: botId! }),
          runId: message.runId ?? "",
          messageId: message.id,
          answer: text,
          ...(username ? { username } : {}),
        });
      } catch (error) {
        // A conflict may mean another tab already answered. Reconcile the
        // persisted card before leaving the local draft in an error state.
        await refreshCurrent().catch(() => undefined);
        throw error;
      }
      // The answer transaction is committed even if this follow-up refresh
      // fails. SSE/reconnect can still deliver the authoritative card state.
      await refreshCurrent().catch(() => undefined);
    },
    [],
  );
  const reactToMessage = useCallback(
    async (message: ThreadMessage, reaction: MessageReaction) => {
      const botId = activeBotId.current;
      const groupId = activeGroupId.current;
      if (!botId && !groupId) return;
      try {
        await rpc.threads.react({
          ...(groupId ? { groupId } : { botId: botId! }),
          messageId: message.id,
          reaction,
          clientNonce: newClientNonce(),
        });
      } catch (error) {
        const stillHere = groupId
          ? activeGroupId.current === groupId
          : activeBotId.current === botId;
        if (!stillHere) return;
        setSendError(error instanceof Error ? error.message : t`Could not update reaction`);
      }
    },
    [t],
  );
  const onAttachmentPick = useCallback(
    async (files: FileList | null) => {
      const threadKey = activeGroupId.current ?? activeBotId.current;
      if (!threadKey || !files?.length) return;
      const existing = attachmentsForThread(pendingAttachments, threadKey);
      const next: PendingAttachment[] = [];
      const skipped: string[] = [];
      for (const file of Array.from(files)) {
        if (existing.length + next.length >= ATTACHMENT_MAX_COUNT) {
          skipped.push(t`${file.name} (max ${ATTACHMENT_MAX_COUNT} attachments)`);
          continue;
        }
        if (file.size > ATTACHMENT_MAX_BYTES) {
          skipped.push(t`${file.name} (over 10 MiB)`);
          continue;
        }
        const mimeType = inferAttachmentMimeType(file.name, file.type);
        if (!mimeType) {
          skipped.push(file.name);
          continue;
        }
        next.push({
          id: `${file.name}-${file.size}-${file.lastModified}-${next.length}`,
          threadKey,
          file,
          previewUrl: mimeType.startsWith("image/") ? URL.createObjectURL(file) : undefined,
        });
      }
      if (next.length) setPendingAttachments((current) => [...current, ...next]);
      setAttachmentNotice(skipped.length ? t`Skipped ${skipped.join(", ")}` : null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [pendingAttachments, t],
  );
  const removeAttachment = useCallback((attachment: PendingAttachment) => {
    revokePendingAttachmentPreviews([attachment]);
    setPendingAttachments((current) => current.filter((item) => item.id !== attachment.id));
  }, []);
  const sendMessage = useCallback(
    async (text: string, mentions: ComposerMention[] = []) => {
      const initialBotTarget = activeBotId.current;
      const initialGroupTarget = activeGroupId.current;
      if ((!initialBotTarget && !initialGroupTarget) || sending) return;
      const originThreadKey = initialGroupTarget ?? initialBotTarget;
      const attachments = attachmentsForThread(pendingAttachments, originThreadKey);
      const plan = resolveComposerSendPlan({
        text,
        mentions,
        hasAttachments: attachments.length > 0,
      });
      if (plan.isNoOp) return;
      const reroutedToGroup = Boolean(
        plan.rerouteGroupId && plan.rerouteGroupId !== initialGroupTarget,
      );
      const groupTarget = plan.rerouteGroupId ?? initialGroupTarget;
      const botTarget = reroutedToGroup ? undefined : initialBotTarget;
      if (
        plan.shouldSend &&
        (groupTarget || botsRef.current.find((bot) => bot.id === botTarget)?.notifyOnFinish)
      ) {
        const permissionRequest = requestBrowserNotificationPermission();
        if (permissionRequest) void permissionRequest.then(flushPendingBrowserNotifications);
      }
      const trimmed = plan.trimmed;
      sendingRef.current = true;
      setSending(true);
      setSendError(null);
      const dropDelayedSetup = () => {
        // Only after successful engagement so a failed upload/send keeps the setup card.
        if (initialBotTarget && focusPromptBotIdRef.current === initialBotTarget) {
          cancelFocusPrompt();
        }
      };
      const sendErrorMessage = (error: unknown) => {
        const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
        if (code === GROUP_MENTION_CLARIFICATION_CODE) {
          return t`I couldn't split this message into reliable tasks. Clarify which Bot should do what.`;
        }
        return error instanceof Error ? error.message : t`Failed to send message`;
      };
      try {
        if (plan.shouldRunRoutines) {
          const sendNonce = newClientNonce();
          await Promise.all(
            plan.routineIds.map((routineId) =>
              rpc.routines.testRun({
                routineId,
                clientNonce: `routine-mention:${sendNonce}:${routineId}`,
              }),
            ),
          );
        }
        if (!plan.shouldSend) {
          dropDelayedSetup();
          clearReply();
          revokePendingAttachmentPreviews(attachments);
          setPendingAttachments((current) =>
            current.filter((attachment) => attachment.threadKey !== originThreadKey),
          );
          setAttachmentNotice(null);
          if (reroutedToGroup && groupTarget) {
            navigate(`/app/g/${groupTarget}`);
            return;
          }
          if (groupTarget && activeGroupId.current === groupTarget) {
            await refreshGroupThreadRef.current(groupTarget);
          } else if (botTarget && activeBotId.current === botTarget) {
            await refreshThreadRef.current(botTarget);
          }
          return;
        }
        const artifactIds: string[] = [];
        for (const pending of attachments) {
          const mimeType = inferAttachmentMimeType(pending.file.name, pending.file.type);
          if (!mimeType) {
            throw new Error(t`Unsupported file type: ${pending.file.name}`);
          }
          const contentBase64 = await readFileAsBase64(pending.file);
          const artifact = await rpc.artifacts.create(
            groupTarget
              ? { groupId: groupTarget, name: pending.file.name, mimeType, contentBase64 }
              : { botId: botTarget!, name: pending.file.name, mimeType, contentBase64 },
          );
          artifactIds.push(artifact.id);
        }
        const clientNonce = newClientNonce();
        if (groupTarget) {
          await rpc.threads.send({
            groupId: groupTarget,
            clientNonce,
            text: trimmed || undefined,
            mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
            mentionSpans: plan.mentionSpans.length ? plan.mentionSpans : undefined,
            artifactIds: artifactIds.length ? artifactIds : undefined,
            replyToMessageId: reroutedToGroup ? undefined : activeReplyTarget?.id,
            replyQuote: reroutedToGroup ? undefined : (activeReplyQuote ?? undefined),
          });
        } else if (botTarget) {
          const sent = await rpc.threads.send({
            botId: botTarget,
            clientNonce,
            text: trimmed || undefined,
            mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
            mentionSpans: plan.mentionSpans.length ? plan.mentionSpans : undefined,
            artifactIds: artifactIds.length ? artifactIds : undefined,
            replyToMessageId: activeReplyTarget?.id,
            replyQuote: activeReplyQuote ?? undefined,
          });
          if (activeBotId.current === botTarget) {
            updateSnapshot((current) =>
              applyThreadSendReceipt(
                current,
                {
                  botId: botTarget,
                  runId: sent.runId,
                  taskId: sent.taskId,
                },
                terminalRunReceipts.current,
              ),
            );
          }
        }
        dropDelayedSetup();
        clearReply();
        revokePendingAttachmentPreviews(attachments);
        setPendingAttachments((current) =>
          current.filter((attachment) => attachment.threadKey !== originThreadKey),
        );
        // Refresh sidebar status even when a bot→group reroute navigates away below.
        void refreshBots().catch(() => undefined);
        if (reroutedToGroup && groupTarget) {
          navigate(`/app/g/${groupTarget}`);
          return;
        }
        if (groupTarget && activeGroupId.current === groupTarget) setAttachmentNotice(null);
        if (botTarget && activeBotId.current === botTarget) setAttachmentNotice(null);
        if (groupTarget) await refreshGroupThreadRef.current(groupTarget);
        else if (botTarget) await refreshThreadRef.current(botTarget);
      } catch (error) {
        if (reroutedToGroup && groupTarget) {
          setSendError(sendErrorMessage(error));
        } else if (groupTarget && activeGroupId.current === groupTarget) {
          setSendError(sendErrorMessage(error));
        } else if (botTarget && activeBotId.current === botTarget) {
          setSendError(sendErrorMessage(error));
        }
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [
      activeReplyTarget?.id,
      activeReplyQuote,
      clearReply,
      flushPendingBrowserNotifications,
      navigate,
      pendingAttachments,
      sending,
      t,
    ],
  );
  const stopRun = useCallback(async () => {
    if (sending) return;
    sendingRef.current = true;
    setSending(true);
    try {
      const botTarget = activeBotId.current;
      const groupTarget = activeGroupId.current;
      if (groupTarget) {
        setSendError(null);
        try {
          await rpc.threads.stop({ groupId: groupTarget });
        } catch (error) {
          if (activeGroupId.current === groupTarget) {
            setSendError(error instanceof Error ? error.message : t`Failed to stop`);
          }
          return;
        }
        // Clear run UI ahead of the run.cancelled event so refresh races with in-flight gets.
        if (activeGroupId.current === groupTarget) {
          updateSnapshot((prev) =>
            prev && prev.groupId === groupTarget ? clearActiveThreadRuns(prev) : prev,
          );
        }
        await refreshGroupThreadRef.current(groupTarget).catch(() => undefined);
        return;
      }
      if (!botTarget) return;
      setSendError(null);
      try {
        await rpc.threads.stop({ botId: botTarget });
      } catch (error) {
        if (activeBotId.current === botTarget) {
          setSendError(error instanceof Error ? error.message : t`Failed to stop`);
        }
        return;
      }
      // Clear local run/busy immediately rather than waiting for run.cancelled so a
      // superseded in-flight refresh (older cursor) cannot leave Stop enabled / Take control
      // blocked while the API is already idle.
      if (activeBotId.current === botTarget) {
        updateSnapshot((prev) =>
          !prev || (prev.botId !== botTarget && prev.botId) ? prev : clearActiveThreadRuns(prev),
        );
        const currentComputer = computerRef.current;
        if (currentComputer?.busyBotName) {
          commitComputer({ ...currentComputer, busyBotName: null });
        }
      }
      await refreshThreadRef.current(botTarget).catch(() => undefined);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [sending, t]);
  const stopTeaching = useCallback(async () => {
    const id = activeBotId.current;
    if (!id || teachBusy) return;
    const recording = taughtSkills.find(
      (skill) => skill.status === "recording" && taughtSkillsBotId === id,
    );
    if (!recording) return;
    setTeachBusy(true);
    try {
      await rpc.skills.stop({ skillId: recording.id });
      await refreshThreadRef.current(id);
      setComputerOpen(false);
    } finally {
      setTeachBusy(false);
    }
  }, [teachBusy, taughtSkills, taughtSkillsBotId]);
  // Transcript and MessageView are memoized; these must stay referentially stable or every
  // Shell state change re-renders the whole transcript.
  const refreshActiveThread = useCallback(async () => {
    const groupId = activeGroupId.current;
    if (groupId) {
      await refreshGroupThreadRef.current(groupId);
      return;
    }
    const id = activeBotId.current;
    if (!id) return;
    await refreshThreadRef.current(id);
  }, []);
  // Teach chrome needs skills applied before this resolves — refreshThread only
  // kicks skills.list off in the background, so Stop teaching would never mount
  // if that background call failed or lagged behind local recovery.
  const refreshActiveTeaching = useCallback(async () => {
    const id = activeBotId.current;
    if (!id) return;
    await refreshThreadRef.current(id);
    const skills = await rpc.skills.list({ botId: id });
    if (activeBotId.current !== id) return;
    setTaughtSkills(skills);
    setTaughtSkillsBotId(id);
  }, []);
  const addSkillRoutine = useCallback((name: string, prompt: string) => {
    setRoutineDraft({ ...emptyRoutineDraft(), name, prompt });
    setRoutineWebhookSecret(null);
    setEditingRoutine(null);
    setPanel("routine");
  }, []);
  const speakingMessageIdRef = useRef(speakingMessageId);
  speakingMessageIdRef.current = speakingMessageId;
  const speakMessage = useCallback((message: ThreadMessage) => {
    if (speakingMessageIdRef.current === message.id) {
      speaker.stop();
      return;
    }
    const text = speechFromBlocks(message.blocks);
    const id = message.botId ?? activeBotId.current;
    if (text && id) void speaker.speak(text, { botId: id, messageId: message.id });
  }, []);

  async function createGroup(input: { name: string; botIds: string[] }) {
    const group = await rpc.groups.create(input);
    setGroups((current) =>
      current.some((item) => item.id === group.id) ? current : [group, ...current],
    );
    navigate(`/app/g/${group.id}`);
    setPanel(null);
    await refreshBots().catch(() => undefined);
  }

  function cancelFocusPrompt() {
    focusPromptAbortRef.current?.abort();
    focusPromptAbortRef.current = null;
    focusPromptBotIdRef.current = null;
  }

  function setBotsSidebarCollapsedPref(collapsed: boolean) {
    setBotsSidebarCollapsed(collapsed);
    writeBotsSidebarCollapsed(userId, collapsed);
  }

  function openSettings(section: SettingsSection = "general") {
    setSettingsSection(section);
    setSettingsOpen(true);
  }

  async function createBot(input: {
    name: string;
    title: string;
    description: string;
    computerMode: ComputerMode;
    color?: string;
    avatarMode?: "character" | "legacy" | "upload";
    avatarCharacter?: "dot" | "treble" | "wave" | "bounce";
    avatarBodyColor?: import("@rakazo/contracts").AvatarBodyColor;
  }) {
    const isFirstBot = botsRef.current.length === 0;
    const bot = await rpc.bots.create({
      ...normalizeCreateBotProfile(input),
      ...(input.avatarMode === "character"
        ? {
            avatarMode: "character" as const,
            avatarCharacter: input.avatarCharacter!,
            avatarBodyColor: input.avatarBodyColor,
          }
        : input.avatarMode === "upload"
          ? { avatarMode: "upload" as const, color: input.color! }
          : {}),
      notifyOnFinish: true,
      computerMode: input.computerMode,
    });
    setBots((current) =>
      current.some((item) => item.id === bot.id) ? current : [bot, ...current],
    );
    navigate(`/app/${bot.id}`);
    setPanel(null);
    // Register cancellation before awaiting start so leaving the bot during
    // startup cannot miss the abort and still schedule a late focus card.
    cancelFocusPrompt();
    const controller = new AbortController();
    focusPromptAbortRef.current = controller;
    focusPromptBotIdRef.current = bot.id;
    const started = await rpc.onboarding
      .start({ botId: bot.id })
      .then(() => true)
      .catch(() => false);
    if (!started || controller.signal.aborted || focusPromptBotIdRef.current !== bot.id) {
      if (focusPromptAbortRef.current === controller) {
        focusPromptAbortRef.current = null;
        focusPromptBotIdRef.current = null;
      }
      await refreshBots().catch(() => undefined);
      return;
    }
    void scheduleFocusPrompt({
      immediate: isFirstBot,
      signal: controller.signal,
      // A new Bot whose intro run already posted a message does not need the
      // setup focus card on top of it (user report: "two cards at once").
      shouldSkip: () =>
        sendingRef.current ||
        transcriptMessagesRef.current.some((message) => message.role === "bot"),
      prompt: async () => {
        if (focusPromptBotIdRef.current !== bot.id || activeBotId.current !== bot.id) return;
        await rpc.onboarding.promptFocus({ botId: bot.id }).catch(() => undefined);
      },
    }).finally(() => {
      if (focusPromptAbortRef.current === controller) {
        focusPromptAbortRef.current = null;
        focusPromptBotIdRef.current = null;
      }
    });
    await refreshBots().catch(() => undefined);
  }

  async function bootComputer({
    botId: targetBotId,
    takeControl,
    overlay,
    force = false,
  }: {
    botId: string;
    takeControl: boolean;
    overlay: boolean;
    force?: boolean;
  }) {
    const epoch = ++computerBootEpoch.current;
    const stillThisBoot = () => computerBootEpoch.current === epoch;
    const stillThisBot = () =>
      computerBotIdRef.current === targetBotId || activeBotId.current === targetBotId;
    const cached = computerCacheRef.current.get(targetBotId);
    const targetComputer = computer?.botId === targetBotId ? computer : (cached?.computer ?? null);
    const targetScreen = computer?.botId === targetBotId ? screenUrl : (cached?.screenUrl ?? null);
    const needsBoot = force || targetComputer?.state !== "running" || !targetScreen;
    if (overlay && needsBoot) setBooting(true);
    setComputerError(null);
    setComputerErrorFromScreen(false);
    try {
      if (needsBoot) {
        const status = await rpc.computer.boot({ botId: targetBotId });
        if (!stillThisBoot() || !stillThisBot()) return;
        commitComputer(status);
        cacheComputerFor(targetBotId, { computer: status });
      }
      if (takeControl) {
        await rpc.computer.takeover({ botId: targetBotId });
        if (!stillThisBoot() || !stillThisBot()) return;
      }
      await refreshComputerFor(targetBotId);
    } catch (error) {
      if (!stillThisBoot() || !stillThisBot()) return;
      setComputerError(error instanceof Error ? error.message : t`Could not take control`);
      setComputerErrorFromScreen(false);
      throw error;
    } finally {
      if (stillThisBoot()) setBooting(false);
    }
  }

  async function refreshComputerFor(targetBotId: string) {
    if (activeBotId.current === targetBotId) {
      await refreshThread(targetBotId);
      return;
    }
    if (computerBotIdRef.current !== targetBotId) return;
    const status = await rpc.computer.status({ botId: targetBotId });
    if (computerBotIdRef.current !== targetBotId) return;
    commitComputer(status);
    cacheComputerFor(targetBotId, { computer: status });
    await refreshComputerScreen(targetBotId);
  }

  useEffect(() => {
    if (!(panel === "settings" && settingsTab === "computer")) {
      autoBooted.current = null;
      return;
    }
    if (!active) return;
    const botId = active.id;
    let cancelled = false;
    void (async () => {
      // Refresh from the server first. A stale SSE "booting" snapshot used to
      // skip this effect, so an RPC takeover never showed "You have control".
      const snap = await refreshThread(botId).catch(() => null);
      if (cancelled || activeBotId.current !== botId) return;
      const state = snap?.computer?.state;
      const screen = state === "running" ? await refreshComputerScreen(botId) : null;
      if (cancelled || activeBotId.current !== botId) return;
      const action = computerPanelAutoBoot(state, screen);
      if (action === "wait") {
        if (state === "running") autoBooted.current = botId;
        return;
      }
      if (action === "boot" && autoBooted.current === botId) return;
      autoBooted.current = botId;
      if (!computerPanelAutoUsesBoot(action)) return;
      await bootComputer({
        botId,
        takeControl: false,
        overlay: action === "boot",
        force: true,
      }).catch(() => undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, [panel, settingsTab, active?.id]);

  useEffect(() => {
    setComputerOpen(false);
    setComputerError(null);
    setComputerErrorFromScreen(false);
    setComputerBotId(active?.id);
  }, [active?.id]);

  useEffect(() => {
    if (focusPromptBotIdRef.current && focusPromptBotIdRef.current !== active?.id) {
      cancelFocusPrompt();
    }
  }, [active?.id]);

  useEffect(() => () => cancelFocusPrompt(), []);

  useEffect(() => {
    if (!computer?.busyBotName) {
      setComputerError(null);
      setComputerErrorFromScreen(false);
    }
  }, [computer?.busyBotName]);

  useEffect(() => {
    if (panel !== "routine") {
      routineSaveRequest.current += 1;
      setRoutineError(null);
    }
  }, [panel]);

  // The routine panel copies a routine's data into local draft state at click time
  // rather than deriving it from `active`, so it goes stale across a bot switch —
  // without this, Save on bot B could silently update bot A's routine.
  useEffect(() => {
    setEditingRoutine(null);
    setDeleteRoutineTarget(null);
    setPanel((current) => (current === "routine" ? null : current));
  }, [active?.id]);

  useEffect(() => {
    const threadKey = inGroup ? groupId : active?.id;
    setPendingAttachments((current) => {
      const stale = current.filter((attachment) => attachment.threadKey !== threadKey);
      revokePendingAttachmentPreviews(stale);
      return attachmentsForThread(current, threadKey);
    });
    clearReply();
    setAttachmentNotice(null);
    setSendError(null);
  }, [active?.id, clearReply, groupId, inGroup]);

  useEffect(() => {
    if (!computerOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setComputerOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [computerOpen]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!isCommandPaletteHotkey(event)) return;
      event.preventDefault();
      setCommandPaletteOpen((open) => !open);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const heartbeatBotId = computerBot?.id ?? active?.id;
    if (
      (!(panel === "settings" && settingsTab === "computer") && !computerOpen) ||
      !heartbeatBotId ||
      computer?.state !== "running"
    )
      return;
    const ping = () =>
      void rpc.computer.heartbeat({ botId: heartbeatBotId }).catch(() => undefined);
    ping();
    const timer = window.setInterval(ping, 60_000);
    return () => window.clearInterval(timer);
  }, [panel, computerOpen, computerBot?.id, active?.id, computer?.state]);

  /** Open the computer view, taking control when possible. Resolves false if booting failed. */
  async function openComputer(botId?: string) {
    const id = botId ?? active?.id;
    if (!id) return false;
    const bot = botsRef.current.find((candidate) => candidate.id === id);
    if (!bot) return false;
    computerBotIdRef.current = id;
    setComputerBotId(id);
    const cached = computerCacheRef.current.get(id);
    const targetComputer = computer?.botId === id ? computer : (cached?.computer ?? null);
    const targetScreen = computer?.botId === id ? screenUrl : (cached?.screenUrl ?? null);
    if (computer?.botId !== id) {
      commitComputer(targetComputer);
      setScreenUrl(targetScreen);
    }
    setComputerOpen(true);
    computerVisible.current = true;
    const needsTakeover = !userHoldsComputerControl(targetComputer, id);
    const blocked = computerTakeoverBlocked(targetComputer, snapshot?.run?.status);
    try {
      await bootComputer({
        botId: id,
        takeControl: needsTakeover && !blocked,
        overlay: (needsTakeover && !blocked) || targetComputer?.state !== "running",
        force: targetComputer?.state !== "running",
      });
      return true;
    } catch {
      // computerError already set in bootComputer
      return false;
    }
  }
  openComputerRef.current = openComputer;
  const onOpenComputer = useCallback((botId?: string) => {
    void openComputerRef.current(botId);
  }, []);

  const releaseComputer = useCallback(
    async (reason?: ComputerReleaseReason) => {
      const botId = computerBotIdRef.current ?? activeBotId.current;
      if (!botId) return;
      try {
        await rpc.computer.release({ botId, reason });
        if (computerBotIdRef.current !== botId && activeBotId.current !== botId) return;
        setComputerOpen(false);
        const groupId = activeGroupId.current;
        if (groupId) {
          await refreshGroupThreadRef.current(groupId).catch(() => undefined);
        } else {
          await refreshThreadRef.current(botId).catch(() => undefined);
        }
      } catch {
        if (computerBotIdRef.current !== botId && activeBotId.current !== botId) return;
        setComputerError(t`Could not continue`);
        setComputerErrorFromScreen(false);
      }
    },
    [t],
  );

  function dismissComposerError() {
    // The strip shows one message at a time, so only dismiss the run failure when it is the
    // one on screen; otherwise a live run would be silenced before it has even failed.
    const failedRunId = displayedRunErrorId;
    setSendError(null);
    if (failedRunId) {
      rememberSeenRunErrorId(failedRunId);
      setDismissedRunErrorIds((current) => new Set(current).add(failedRunId));
    }
  }

  const embeddedScreenUrl = embeddableScreenUrl(screenUrl);
  const hasControl = userHoldsComputerControl(computer, computerBot?.id);
  const hideScreenLoadError = computerErrorFromScreen && Boolean(embeddedScreenUrl);
  const computerScreenError =
    computerError && !hideScreenLoadError ? (
      <div role="alert" className="flex flex-col items-center gap-3 px-6 text-center text-sm">
        <p className="text-destructive">{computerError}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => computerBot && void refreshComputerScreen(computerBot.id)}
        >
          <Trans>Retry screen</Trans>
        </Button>
      </div>
    ) : null;

  const userName = session.data?.user.name ?? t`You`;
  const initials = userName
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const shell = (
    <div
      data-testid="shell-root"
      data-ready={shellReady}
      className="relative flex h-full min-w-0 overflow-hidden bg-background text-foreground/90"
      onTouchStartCapture={(event) => {
        if (
          mobileSidebarOpen ||
          event.touches.length !== 1 ||
          window.matchMedia("(min-width: 768px)").matches
        ) {
          mobileSidebarSwipeRef.current = null;
          return;
        }
        const touch = event.touches[0];
        if (!touch) return;
        const rtl = document.documentElement.getAttribute("dir") === "rtl";
        const startsAtEdge = rtl
          ? touch.clientX >= window.innerWidth - MOBILE_SIDEBAR_SWIPE_EDGE_PX
          : touch.clientX <= MOBILE_SIDEBAR_SWIPE_EDGE_PX;
        mobileSidebarSwipeRef.current = startsAtEdge
          ? { startX: touch.clientX, startY: touch.clientY }
          : null;
      }}
      onTouchEndCapture={(event) => {
        const swipe = mobileSidebarSwipeRef.current;
        mobileSidebarSwipeRef.current = null;
        const touch = event.changedTouches[0];
        if (
          !swipe ||
          !touch ||
          mobileSidebarOpen ||
          window.matchMedia("(min-width: 768px)").matches
        ) {
          return;
        }
        const rtl = document.documentElement.getAttribute("dir") === "rtl";
        const horizontal = rtl ? swipe.startX - touch.clientX : touch.clientX - swipe.startX;
        const vertical = Math.abs(touch.clientY - swipe.startY);
        if (horizontal >= MOBILE_SIDEBAR_SWIPE_DISTANCE_PX && horizontal > vertical * 1.25) {
          setMobileSidebarOpen(true);
        }
      }}
      onTouchCancelCapture={() => {
        mobileSidebarSwipeRef.current = null;
      }}
    >
      <ComputerUpdateProgress
        onCompleted={() => {
          if (active) void refreshThread(active.id);
        }}
      />
      {bootstrapMe !== undefined ? (
        <HostComputerPrompt initialMe={bootstrapMe ?? undefined} />
      ) : null}
      {mobileSidebarOpen ? (
        <button
          type="button"
          aria-label={t`Close navigation`}
          onClick={() => setMobileSidebarOpen(false)}
          className="absolute inset-y-0 end-0 start-[min(calc(100%-48px),316px)] z-30 bg-overlay md:hidden"
        />
      ) : null}
      {!mobileSidebarOpen ? (
        <div
          data-testid="mobile-sidebar-swipe-edge"
          aria-hidden="true"
          className="absolute bottom-20 start-0 top-16 z-20 w-8 touch-none md:hidden"
        />
      ) : null}
      <aside
        data-testid="bots-sidebar"
        data-collapsed={botsSidebarCollapsed ? "true" : "false"}
        inert={botsSidebarCollapsed && !mobileSidebarOpen ? true : undefined}
        className={`absolute inset-y-0 start-0 z-40 flex w-[calc(100%-48px)] max-w-[316px] shrink-0 flex-col border-e border-sidebar-border bg-sidebar transition-[transform,width,opacity] md:static md:z-auto md:translate-x-0 ${
          mobileSidebarOpen ? "translate-x-0" : "-translate-x-full rtl:translate-x-full"
        } ${
          botsSidebarCollapsed
            ? "md:w-0 md:max-w-0 md:overflow-hidden md:border-e-0 md:opacity-0 md:pointer-events-none"
            : "md:w-[316px]"
        }`}
      >
        <div className="app-drag flex items-center justify-between px-[18px] pb-3 pt-4">
          <WindowChrome />
          <div className="relative flex items-center gap-2.5">
            <button
              type="button"
              aria-label={t`Activity`}
              aria-pressed={activityMode}
              title={t`Activity`}
              data-activity-mode={activityMode ? "on" : "off"}
              onClick={toggleActivityMode}
              className={`app-no-drag flex h-7 w-7 items-center justify-center rounded-full ${
                activityMode
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground/70 hover:text-foreground/75"
              }`}
            >
              <Bell
                size={15}
                strokeWidth={1.8}
                fill={activityMode ? "currentColor" : "none"}
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              className="app-no-drag hidden h-7 w-7 items-center justify-center rounded-full text-muted-foreground/70 hover:text-foreground/75 md:inline-flex"
              aria-label={t`Minimize bots`}
              title={t`Minimize bots`}
              data-testid="minimize-bots-sidebar"
              onClick={() => setBotsSidebarCollapsedPref(true)}
            >
              <PanelLeftClose size={15} strokeWidth={1.8} aria-hidden="true" />
            </button>
            <Popover open={createMenuOpen} onOpenChange={setCreateMenuOpen}>
              <PopoverTrigger
                className="app-no-drag text-[21px] text-muted-foreground/70 hover:text-foreground/75"
                title={t`Create`}
                data-testid="create-menu-trigger"
              >
                +
              </PopoverTrigger>
              {/* Unmount with the state change so the panel it opens never coexists with the menu. */}
              {createMenuOpen ? (
                <PopoverContent
                  align="end"
                  className="app-no-drag w-auto gap-0 overflow-hidden p-0 data-closed:animate-none"
                >
                  <BotCreatePicker
                    bots={bots}
                    onCreateBot={() => {
                      setCreateMenuOpen(false);
                      setMobileSidebarOpen(false);
                      setPanel("create");
                    }}
                    onOpenBot={(id) => {
                      setCreateMenuOpen(false);
                      setMobileSidebarOpen(false);
                      navigate(`/app/${id}`);
                    }}
                    onCreateGroup={() => {
                      setCreateMenuOpen(false);
                      setMobileSidebarOpen(false);
                      setPanel("create-group");
                    }}
                    onCreateSpace={() => {
                      setCreateMenuOpen(false);
                      setMobileSidebarOpen(false);
                      setNewSpaceOpen(true);
                    }}
                    onShowGroupInfo={() => {
                      setCreateMenuOpen(false);
                      setMobileSidebarOpen(false);
                      setPickerInfoTopic("group");
                    }}
                    onShowSpaceInfo={() => {
                      setCreateMenuOpen(false);
                      setMobileSidebarOpen(false);
                      setPickerInfoTopic("space");
                    }}
                  />
                </PopoverContent>
              ) : null}
            </Popover>
          </div>
        </div>
        <InputGroup
          data-testid="sidebar-search"
          className="mx-2.5 mb-3 w-auto rounded-xl bg-card dark:bg-input border border-border text-muted-foreground focus-within:border-ring"
        >
          <InputGroupAddon>
            <Search size={16} strokeWidth={1.8} aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t`Search`}
            autoComplete="off"
            name="sidebar-search"
          />
        </InputGroup>
        <div className="rk-scroll flex flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pb-2.5">
          {showSpaceSearch ? (
            <SpaceSearchResults
              hits={searchHits}
              loading={searchLoading}
              onSelect={(hit) => void jumpToSearchHit(hit)}
            />
          ) : (
            <>
              {activityMode ? (
                <ActivityList
                  onOpenRun={(run) => {
                    setMobileSidebarOpen(false);
                    if (run.groupId) navigate(`/app/g/${run.groupId}`);
                    else navigate(`/app/${run.botId}`);
                  }}
                />
              ) : null}
              {sidebarGroups.map((group) => {
                const collapsed = Boolean(group.title) && collapsedSidebarSections.has(group.key);
                const groupBotIds = group.bots.flatMap((item) =>
                  item.kind === "bot" ? [item.chat.id] : [],
                );
                const nestedRows = nestRosterByParent(group.bots, collapsedRosterParents);
                const treeActive = nestedRows.some((row) => row.depth > 0 || row.hasChildren);
                const rosterParent = new Map(
                  nestedRows.map((row) => [row.item.chat.id, row.parentId] as const),
                );
                // Reorder among visible siblings so keyboard and drag moves match the tree.
                const siblingBotIds = (parentId: string | null) =>
                  nestedRows.flatMap((row) =>
                    row.item.kind === "bot" && row.parentId === parentId ? [row.item.chat.id] : [],
                  );
                return (
                  <div key={group.key} data-sidebar-group={group.key}>
                    {group.title ? (
                      <div className="flex items-center pt-3 pb-0.5">
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg px-2.5 py-1 text-[11px] font-semibold tracking-wider uppercase text-muted-foreground/60 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                          onClick={() => {
                            if (group.emptySpaceId) {
                              openSpaceChat(group.emptySpaceId, "/onboarding");
                              return;
                            }
                            toggleSidebarSection(group.key);
                          }}
                          onContextMenu={
                            group.sectionId
                              ? (event) => {
                                  event.preventDefault();
                                  // Prefer section rename over delete-space when both apply;
                                  // the dedicated space-actions button still opens the space menu.
                                  const sections =
                                    group.spaceId === bootstrapMe?.spaceId
                                      ? botSections
                                      : (spaces.find((space) => space.id === group.spaceId)
                                          ?.botSections ?? []);
                                  const section = sections.find(
                                    (item) => item.id === group.sectionId,
                                  );
                                  if (!section) return;
                                  sectionMenuAnchor.current = event.currentTarget;
                                  setSectionMenu({
                                    section,
                                    spaceId: group.spaceId,
                                    position: { x: event.clientX, y: event.clientY },
                                  });
                                }
                              : group.canDeleteSpace
                                ? (event) => {
                                    event.preventDefault();
                                    spaceMenuAnchor.current = event.currentTarget;
                                    setSpaceMenu({
                                      id: group.spaceId,
                                      position: { x: event.clientX, y: event.clientY },
                                    });
                                  }
                                : undefined
                          }
                          aria-expanded={group.emptySpaceId ? undefined : !collapsed}
                          aria-label={
                            group.emptySpaceId
                              ? t`Open ${group.title}`
                              : collapsed
                                ? t`Expand ${group.title}`
                                : t`Collapse ${group.title}`
                          }
                        >
                          <span className="flex min-w-0 items-center gap-1.5 truncate">
                            {group.showLock ? (
                              <Lock size={11} strokeWidth={2} aria-hidden="true" />
                            ) : null}
                            <span className="truncate">{group.title}</span>
                          </span>
                          {group.emptySpaceId ? null : (
                            <ChevronDown
                              size={14}
                              strokeWidth={1.8}
                              className={
                                collapsed
                                  ? "-rotate-90 transition-transform"
                                  : "transition-transform"
                              }
                              aria-hidden="true"
                            />
                          )}
                        </button>
                        {group.canDeleteSpace ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t`Actions for ${group.spaceName}`}
                            onClick={(event) => {
                              const rect = event.currentTarget.getBoundingClientRect();
                              spaceMenuAnchor.current = event.currentTarget;
                              setSpaceMenu({
                                id: group.spaceId,
                                position: { x: rect.left, y: rect.bottom },
                              });
                            }}
                          >
                            <MoreHorizontal size={14} aria-hidden="true" />
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                    {!collapsed &&
                      nestedRows.map(({ item, depth, hasChildren, parentId }) => {
                        const parentCollapsed =
                          hasChildren && collapsedRosterParents.has(item.chat.id);
                        const selected =
                          (item.kind === "bot" && !inGroup && active?.id === item.chat.id) ||
                          (item.kind === "group" && inGroup && activeGroup?.id === item.chat.id);
                        return (
                          <div
                            key={`${item.kind}:${item.chat.id}`}
                            className="group/row relative"
                            style={{
                              opacity:
                                item.kind === "bot" && draggedBotId === item.chat.id ? 0.55 : 1,
                            }}
                          >
                            {hasChildren ? (
                              <span
                                className="absolute inset-y-0 z-10 flex w-3.5 items-center justify-center"
                                style={{ insetInlineStart: `${10 + depth * 14}px` }}
                              >
                                <button
                                  type="button"
                                  aria-expanded={!parentCollapsed}
                                  aria-label={
                                    parentCollapsed
                                      ? t`Expand ${item.chat.name}`
                                      : t`Collapse ${item.chat.name}`
                                  }
                                  className="inline-flex size-3.5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                                  onClick={() => toggleRosterParent(item.chat.id)}
                                >
                                  <ChevronDown
                                    size={12}
                                    strokeWidth={2}
                                    className={`transition-transform ${
                                      parentCollapsed ? "-rotate-90" : ""
                                    }`}
                                    aria-hidden="true"
                                  />
                                </button>
                              </span>
                            ) : null}
                            <RosterRowCatalog botId={item.kind === "bot" ? item.chat.id : null}>
                              {(avatarState) => (
                                <button
                                  type="button"
                                  draggable={item.kind === "bot"}
                                  data-roster-bot-id={
                                    item.kind === "bot" ? item.chat.id : undefined
                                  }
                                  data-roster-depth={
                                    item.kind === "bot" && treeActive ? depth : undefined
                                  }
                                  aria-keyshortcuts={
                                    item.kind === "bot" ? "Alt+ArrowUp Alt+ArrowDown" : undefined
                                  }
                                  onDragStart={(event) => {
                                    if (item.kind !== "bot") return;
                                    setDraggedBotId(item.chat.id);
                                    event.dataTransfer.effectAllowed = "move";
                                    event.dataTransfer.setData("text/plain", item.chat.id);
                                  }}
                                  onDragOver={(event) => {
                                    if (
                                      item.kind === "bot" &&
                                      draggedBotId &&
                                      groupBotIds.includes(draggedBotId) &&
                                      rosterParent.get(draggedBotId) === parentId
                                    ) {
                                      event.preventDefault();
                                      event.dataTransfer.dropEffect = "move";
                                    }
                                  }}
                                  onDrop={(event) => {
                                    if (
                                      item.kind !== "bot" ||
                                      !draggedBotId ||
                                      rosterParent.get(draggedBotId) !== parentId
                                    )
                                      return;
                                    event.preventDefault();
                                    reorderRosterBot(draggedBotId, item.chat.id, groupBotIds);
                                    setDraggedBotId(null);
                                  }}
                                  onDragEnd={() => setDraggedBotId(null)}
                                  onKeyDown={(event) => {
                                    if (
                                      item.kind !== "bot" ||
                                      !event.altKey ||
                                      (event.key !== "ArrowUp" && event.key !== "ArrowDown")
                                    )
                                      return;
                                    const siblings = siblingBotIds(parentId);
                                    const index = siblings.indexOf(item.chat.id);
                                    const target =
                                      siblings[index + (event.key === "ArrowUp" ? -1 : 1)];
                                    if (!target) return;
                                    event.preventDefault();
                                    reorderRosterBot(item.chat.id, target, groupBotIds);
                                  }}
                                  onClick={() => {
                                    if (item.kind === "bot") {
                                      // Waiting/approval Bots reuse the execution-nav
                                      // return-intent: after the target Thread loads,
                                      // focus lands on the Intervention's first
                                      // operable control. The roster row carries a
                                      // SpaceBot projection without threadId, so the
                                      // full Bot list resolves it; without a trusted
                                      // threadId/runId it only navigates — never guesses.
                                      const botThreadId = bots.find(
                                        (bot) => bot.id === item.chat.id,
                                      )?.threadId;
                                      const intent = botThreadId
                                        ? rosterAttentionIntent({
                                            threadId: botThreadId,
                                            state: avatarState,
                                          })
                                        : null;
                                      if (intent) {
                                        setExecutionNavIntent(intent);
                                        window.dispatchEvent(new Event(EXECUTION_NAV_INTENT_EVENT));
                                      }
                                    }
                                    openSpaceChat(
                                      item.chat.spaceId,
                                      item.kind === "bot"
                                        ? `/app/${item.chat.id}`
                                        : `/app/g/${item.chat.id}`,
                                    );
                                  }}
                                  onContextMenu={(event) => {
                                    if (item.chat.spaceId !== bootstrapMe?.spaceId) return;
                                    event.preventDefault();
                                    botMenuAnchor.current = event.currentTarget;
                                    setBotMenu({
                                      kind: item.kind,
                                      id: item.chat.id,
                                      position: { x: event.clientX, y: event.clientY },
                                    });
                                  }}
                                  className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-start ${
                                    item.kind === "bot" ? "cursor-grab active:cursor-grabbing" : ""
                                  } ${
                                    selected
                                      ? "bg-sidebar-accent"
                                      : "group-hover/row:bg-sidebar-accent"
                                  }`}
                                  style={
                                    treeActive
                                      ? { paddingInlineStart: `${24 + depth * 14}px` }
                                      : undefined
                                  }
                                >
                                  {item.kind === "bot" ? (
                                    /* The avatar state comes from the durable catalog
                                   (BotAvatar reads it itself); the raw chat.status
                                   string is not a trusted state source. */
                                    <BotAvatar
                                      color={item.chat.color}
                                      identity={item.chat.id}
                                      surface="sidebar"
                                      size={35}
                                    />
                                  ) : (
                                    <GroupAvatar
                                      members={
                                        item.chat.id === activeSnapshot?.groupId
                                          ? (activeSnapshot.members ?? item.chat.members)
                                          : item.chat.members
                                      }
                                      size={36}
                                    />
                                  )}
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-baseline justify-between gap-2">
                                      <div className="flex min-w-0 items-baseline gap-1.5 overflow-hidden">
                                        <span
                                          dir="auto"
                                          data-roster-bot-name={
                                            item.kind === "bot" ? "" : undefined
                                          }
                                          className={`min-w-0 truncate text-[14px] text-foreground ${
                                            item.chat.unread ? "font-semibold" : "font-medium"
                                          }`}
                                        >
                                          {item.chat.name}
                                        </span>
                                        {item.kind === "bot" && item.chat.title ? (
                                          <span
                                            dir="auto"
                                            className="shrink-0 text-[11.5px] font-normal text-muted-foreground"
                                          >
                                            {item.chat.title}
                                          </span>
                                        ) : null}
                                        {item.chat.unread ? (
                                          <span className="sr-only">
                                            <Trans> (unread)</Trans>
                                          </span>
                                        ) : null}
                                      </div>
                                      <div className="flex shrink-0 items-center gap-1.5">
                                        <span className="text-[11.5px] text-muted-foreground/60 tabular-nums">
                                          {formatRosterTime(item.chat.updatedAt)}
                                        </span>
                                        {item.chat.unread ? (
                                          <span
                                            aria-hidden="true"
                                            className="inline-block h-2 w-2 rounded-full bg-foreground"
                                          />
                                        ) : null}
                                      </div>
                                    </div>
                                    <div
                                      dir="auto"
                                      className={`mt-0.5 truncate text-[12.5px] ${
                                        item.chat.unread
                                          ? "font-medium text-foreground/75"
                                          : "text-muted-foreground/60"
                                      }`}
                                    >
                                      {/* UX-01B acceptance 12: Bot rows show the real
                                      preview only — never a status-text fallback;
                                      state is expressed by the avatar badge with
                                      its accessible label. */}
                                      {item.kind === "bot"
                                        ? item.chat.preview
                                        : item.chat.preview ||
                                          item.chat.members.map((member) => member.name).join(", ")}
                                    </div>
                                  </div>
                                </button>
                              )}
                            </RosterRowCatalog>
                          </div>
                        );
                      })}
                  </div>
                );
              })}
            </>
          )}
          {archivedBots.length + archivedGroups.length > 0 && !showSpaceSearch ? (
            <div className="mt-2 border-t border-border pt-2">
              <button
                type="button"
                aria-expanded={archivedOpen}
                onClick={() => setArchivedOpen((open) => !open)}
                className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-[13.5px] text-muted-foreground hover:bg-sidebar-accent"
              >
                <span>
                  <Trans>Archived</Trans>
                </span>
                <span>{archivedBots.length + archivedGroups.length}</span>
              </button>
              {archivedOpen ? (
                <>
                  {archivedBots.map((bot) => (
                    <div key={bot.id} className="flex items-center gap-2 rounded-lg px-2.5 py-2">
                      <BotAvatar
                        color={bot.color}
                        identity={bot.id}
                        size={28}
                        status={bot.status}
                      />
                      <span
                        className="min-w-0 flex-1 truncate text-[14px] text-foreground/75"
                        dir="auto"
                      >
                        {bot.name}
                      </span>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() =>
                          void rpc.bots.restore({ botId: bot.id }).then(() => refreshBots(true))
                        }
                      >
                        <Trans>Restore</Trans>
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="text-destructive hover:text-destructive"
                        aria-label={t`Delete ${bot.name}`}
                        onClick={() => setDeleteTarget(bot)}
                      >
                        <Trans>Delete</Trans>
                      </Button>
                    </div>
                  ))}
                  {archivedGroups.map((group) => (
                    <div key={group.id} className="flex items-center gap-2 rounded-lg px-2.5 py-2">
                      <GroupAvatar members={group.members} size={28} />
                      <span
                        className="min-w-0 flex-1 truncate text-[14px] text-foreground/75"
                        dir="auto"
                      >
                        {group.name}
                      </span>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() =>
                          void rpc.groups
                            .restore({ groupId: group.id })
                            .then(() => refreshBots(true))
                        }
                      >
                        <Trans>Restore</Trans>
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="text-destructive hover:text-destructive"
                        aria-label={t`Delete ${group.name}`}
                        onClick={() => setDeleteGroupTarget(group)}
                      >
                        <Trans>Delete</Trans>
                      </Button>
                    </div>
                  ))}
                </>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="mx-3 mb-2 flex items-center gap-2">
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger
              data-testid="user-menu-trigger"
              aria-label={userName}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent text-[12px] text-foreground/75 hover:bg-sidebar-accent"
            >
              {initials}
            </PopoverTrigger>
            {menuOpen ? (
              <PopoverContent
                side="top"
                align="start"
                className="w-[calc(316px-1.5rem)] max-w-[calc(100vw-3rem)] gap-0 p-1 data-closed:animate-none"
              >
                <Button
                  variant="ghost"
                  className="w-full justify-start font-normal"
                  onClick={() => {
                    setMenuOpen(false);
                    setMobileSidebarOpen(false);
                    navigate("/app/artifacts");
                  }}
                >
                  <FolderOpen className="text-muted-foreground" strokeWidth={1.75} />
                  <Trans>Artifacts</Trans>
                </Button>
                <Button
                  variant="ghost"
                  className="w-full justify-start font-normal"
                  aria-label={t`Settings`}
                  onClick={() => {
                    setMenuOpen(false);
                    openSettings("general");
                  }}
                >
                  <Settings className="text-muted-foreground" strokeWidth={1.75} />
                  <Trans>Settings</Trans>
                </Button>
                <Button
                  variant="ghost"
                  className="w-full justify-start font-normal"
                  aria-label={t`Usage`}
                  onClick={() => {
                    setMenuOpen(false);
                    void loadUsage(usageState.range);
                    openSettings("usage");
                  }}
                >
                  <Gauge className="text-muted-foreground" strokeWidth={1.75} />
                  <Trans>Usage</Trans>
                </Button>
                <Button
                  variant="ghost"
                  className="w-full justify-start font-normal"
                  onClick={() =>
                    void authClient.signOut().then(() => {
                      clearSpaceSelection();
                      navigate("/");
                    })
                  }
                >
                  <LogOut className="text-muted-foreground" strokeWidth={1.75} />
                  <Trans>Log out</Trans>
                </Button>
              </PopoverContent>
            ) : null}
          </Popover>
          <button
            type="button"
            onClick={() => setPluginsOpen(true)}
            data-testid="integrations-entry"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-full border border-sidebar-border px-3 py-1.5 text-[12.5px] text-foreground/80 hover:bg-sidebar-accent"
          >
            <LayoutGrid size={13} strokeWidth={1.8} className="shrink-0" />
            <span className="truncate">
              <Trans>Integrations</Trans>
            </span>
          </button>
        </div>
      </aside>

      {/* The full-screen computer covers the sidebar, so its edge must not catch clicks there. */}
      {computerOpen || booting ? null : (
        <button
          type="button"
          data-testid="bots-sidebar-edge"
          aria-label={botsSidebarCollapsed ? t`Show bots` : t`Hide bots`}
          aria-pressed={!botsSidebarCollapsed}
          className={`absolute inset-y-0 z-50 hidden w-2 cursor-ew-resize touch-none border-0 bg-transparent p-0 md:block ${
            botsSidebarCollapsed ? "start-0" : "start-[308px]"
          }`}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            botsSidebarEdgeDragRef.current = {
              startX: event.clientX,
              mode: botsSidebarCollapsed ? "expand" : "collapse",
            };
          }}
          onPointerMove={(event) => {
            const drag = botsSidebarEdgeDragRef.current;
            if (!drag) return;
            const rtl =
              typeof document !== "undefined" &&
              document.documentElement.getAttribute("dir") === "rtl";
            const delta = rtl ? drag.startX - event.clientX : event.clientX - drag.startX;
            if (drag.mode === "expand" && delta >= BOTS_SIDEBAR_EDGE_DRAG_PX) {
              botsSidebarEdgeDragRef.current = null;
              setBotsSidebarCollapsedPref(false);
            } else if (drag.mode === "collapse" && delta <= -BOTS_SIDEBAR_EDGE_DRAG_PX) {
              botsSidebarEdgeDragRef.current = null;
              setBotsSidebarCollapsedPref(true);
            }
          }}
          onPointerUp={(event) => {
            const drag = botsSidebarEdgeDragRef.current;
            botsSidebarEdgeDragRef.current = null;
            if (!drag) return;
            if (Math.abs(event.clientX - drag.startX) < BOTS_SIDEBAR_EDGE_DRAG_PX) {
              setBotsSidebarCollapsedPref(!botsSidebarCollapsed);
            }
          }}
          onPointerCancel={() => {
            botsSidebarEdgeDragRef.current = null;
          }}
        />
      )}

      <main
        aria-hidden={mobileSidebarOpen || undefined}
        inert={mobileSidebarOpen}
        className="relative flex min-w-0 flex-1 flex-col bg-background"
      >
        {/* Window drag region formerly provided by the conversation header. */}
        <div
          className="app-drag pointer-events-none absolute inset-x-0 top-0 h-12"
          aria-hidden="true"
        />
        {(active || activeGroup) && !mobileSidebarOpen ? (
          <div className="pointer-events-none absolute inset-x-0 top-2.5 z-40 flex items-start justify-center px-3">
            <div className="app-no-drag pointer-events-auto absolute left-3 top-0.5 flex items-center gap-1 md:left-[22px]">
              {botsSidebarCollapsed && desktopBridge() ? <WindowChrome /> : null}
              <button
                type="button"
                aria-label={t`Open navigation`}
                onClick={() => setMobileSidebarOpen(true)}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-foreground/75 hover:bg-accent md:hidden"
              >
                <Menu size={19} strokeWidth={1.7} />
              </button>
              {botsSidebarCollapsed ? (
                <button
                  type="button"
                  data-testid="restore-bots-sidebar"
                  aria-label={t`Show bots`}
                  title={t`Show bots`}
                  onClick={() => setBotsSidebarCollapsedPref(false)}
                  className="hidden h-8 w-8 shrink-0 place-items-center rounded-lg text-foreground/75 hover:bg-accent md:grid"
                >
                  <PanelLeftOpen size={19} strokeWidth={1.7} aria-hidden="true" />
                </button>
              ) : null}
            </div>
            {/* One control only: avatar, name and run status share a single
                  click that opens or closes the Bot panel (UX-03 F5). */}
            <button
              type="button"
              data-testid="bot-settings-trigger"
              aria-expanded={inGroup ? panel === "group" : undefined}
              title={inGroup ? t`Open group details` : t`Open bot settings`}
              aria-label={
                inGroup
                  ? (activeGroup?.name ?? activeSnapshot?.groupName ?? t`Group`)
                  : (active?.name ?? t`Select a bot`)
              }
              onClick={() => {
                if (inGroup) {
                  setGroupTab("details");
                  setPanel(panel === "group" ? null : "group");
                  return;
                }
                setPanel(panel === "settings" ? null : "settings");
              }}
              className="app-no-drag pointer-events-auto flex h-[38px] items-center gap-2.5 rounded-full border border-border/70 bg-card/85 pe-3 ps-1.5 shadow-sm backdrop-blur-md hover:border-foreground/25"
            >
              {inGroup ? (
                groupPanel.members ? (
                  <GroupIdentityCluster members={groupPanel.members} variant="capsule" />
                ) : (
                  <GroupAvatar
                    members={activeSnapshot?.members ?? activeGroup?.members ?? []}
                    size={26}
                  />
                )
              ) : active ? (
                <BotAvatar
                  color={active.color}
                  identity={active.id}
                  size={26}
                  status={activeBotLiveStatus}
                />
              ) : null}
              <span
                className="max-w-[150px] truncate text-[13px] font-medium text-foreground"
                dir="auto"
              >
                {inGroup
                  ? (activeGroup?.name ?? activeSnapshot?.groupName ?? t`Group`)
                  : (active?.name ?? t`Select a bot`)}
              </span>
              {!inGroup && active && panelRun ? (
                <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                  <span
                    className={`size-2 shrink-0 rounded-full bg-current ${runStatusTextClass(panelRun.status)}`}
                    style={
                      isRunActive(panelRun.status)
                        ? { animation: "rkPulse 1.2s ease-in-out infinite" }
                        : undefined
                    }
                    aria-hidden="true"
                  />
                  <span className={runStatusTextClass(panelRun.status)}>
                    {runStatusLabel(panelRun.status)}
                  </span>
                </span>
              ) : null}
            </button>
            {inGroup ? (
              <div className="app-no-drag pointer-events-auto absolute top-0.5 right-3">
                <button
                  type="button"
                  data-testid="group-work-entry"
                  aria-label={t`Work`}
                  aria-expanded={panel === "group" && groupTab === "work"}
                  onClick={() => {
                    setGroupTab("work");
                    setPanel("group");
                  }}
                  className={`${panel ? "hidden md:flex" : "flex"} h-8 items-center rounded-[9px] border border-border/70 bg-card/85 px-3 text-[12px] font-medium text-muted-foreground shadow-sm backdrop-blur-md hover:border-foreground/25 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none`}
                >
                  <Trans>Work</Trans>
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        {!active && !activeGroup && initialBotsLoaded ? (
          <div className="grid flex-1 place-items-center">
            <Button onClick={() => setPanel("create")}>
              <Plus size={16} aria-hidden="true" />
              <Trans>Create new Bot</Trans>
            </Button>
          </div>
        ) : (
          <Transcript
            key={activeSnapshot?.threadId}
            scrollRef={messageScroll}
            reservePillBand={Boolean(active || activeGroup)}
            scrollRequest={scrollRequest}
            onScrollRequestHandled={clearScrollRequest}
            artifactTarget={transcriptArtifactTarget}
            messages={transcriptMessages}
            plans={activeSnapshot?.plans}
            steps={activeSnapshot?.steps}
            todos={activeSnapshot?.todos}
            runs={[
              ...(activeSnapshot?.run ? [activeSnapshot.run] : []),
              ...(activeSnapshot?.activeRuns ?? []),
              ...(activeSnapshot?.recentRuns ?? []),
            ]}
            activeRunIds={currentRuns.filter((run) => isRunActive(run.status)).map((run) => run.id)}
            showToolActivity={showToolActivity}
            olderCursor={activeSnapshot?.olderCursor ?? null}
            loadingOlder={loadingOlder}
            interventions={activeSnapshot?.interventions}
            interactions={activeSnapshot?.interactions}
            displayBlocks={activeSnapshot?.displayBlocks}
            cardsUnifiedV2={activeSnapshot?.interactionCapabilities?.cardsUnifiedV2 === true}
            conversationName={
              inGroup ? (activeGroup?.name ?? activeSnapshot?.groupName) : active?.name
            }
            groupNameOf={(groupId) => groups.find((group) => group.id === groupId)?.name}
            threadId={activeSnapshot?.threadId ?? ""}
            executions={activeSnapshot?.executions}
            running={transcriptRunning}
            activity={inlineActivity}
            backgroundTasks={backgroundActivity}
            onCancelBackgroundTask={inGroup ? undefined : cancelBackgroundTask}
            showActivityAvatars={inGroup}
            activityBotColors={activityBotColors}
            onLoadOlder={loadOlder}
            onOpenBot={openBot}
            onAnswer={answerMessage}
            onReply={(message) => {
              setReplyTarget(message);
              setReplyQuote(null);
            }}
            onQuote={(message, quote) => {
              setReplyTarget(message);
              setReplyQuote(quote);
            }}
            onReact={reactToMessage}
            onJumpToMessage={jumpToReplyMessage}
            onOpenPeerMessages={(target) => {
              if (!target.destination) return;
              setPeerConversation({
                peerBotId: target.botId,
                peerBotName:
                  resolveTranscriptBotDisplayName(target.botId) ?? target.botName ?? t`Bot`,
                sourceReceiptMessageId: target.sourceReceiptMessageId,
                pairThreadId: target.destination.pairThreadId,
                messageId: target.destination.messageId,
              });
            }}
            memberName={resolveTranscriptMemberName}
            botNameOf={resolveTranscriptBotDisplayName}
            peerBot={resolveTranscriptBot}
            onRefresh={refreshActiveThread}
            onBotChanged={refreshBots}
            onAddRoutine={addSkillRoutine}
            voiceReady={Boolean(voiceStatus?.ready)}
            speakingMessageId={speakingMessageId}
            onSpeak={speakMessage}
            onOpenComputer={onOpenComputer}
          />
        )}
        {recordingSkill ? (
          <div className="px-6 pb-2 text-center text-[13px] text-destructive">
            <Trans>Teaching in progress. Stop teaching before sending a new message.</Trans>
          </div>
        ) : null}
        {active || activeGroup ? (
          <Composer
            key={inGroup ? `group:${groupId}` : `bot:${active?.id}`}
            activeName={inGroup ? (activeGroup?.name ?? activeSnapshot?.groupName) : active?.name}
            running={composerRunning}
            disabled={Boolean(recordingSkill)}
            pendingAttachments={activePendingAttachments}
            attachmentNotice={attachmentNotice}
            sendError={sendError}
            runError={displayedRunError}
            runErrorId={displayedRunErrorId}
            onRunErrorPresented={handleRunErrorPresented}
            onDismissError={dismissComposerError}
            sending={sending}
            fileInputRef={fileInputRef}
            onAttachmentPick={onAttachmentPick}
            onRemoveAttachment={removeAttachment}
            onSend={sendMessage}
            onStop={stopRun}
            onVoice={
              !inGroup && active
                ? () => {
                    if (!voiceStatus?.ready) {
                      openSettings("voice");
                      return;
                    }
                    startCall({
                      botId: active.id,
                      botName: active.name,
                      botColor: active.color,
                      transcribe: Boolean(voiceStatus?.transcribe),
                    });
                  }
                : undefined
            }
            replyTarget={activeReplyTarget}
            replyQuote={activeReplyQuote}
            replyTargetName={replyTargetName}
            onClearReply={clearReply}
            mentionTargets={composerMentionTargets}
            agentSkills={agentSkills}
            onSlashOpen={refreshAgentSkills}
            onSlashAction={(action) => {
              if (action === "chat-settings") {
                setPanel(inGroup ? "group-settings" : "settings");
                return;
              }
              if (action === "settings-general") {
                openSettings("general");
                return;
              }
              if (action === "settings-usage") {
                void loadUsage(usageState.range);
                openSettings("usage");
              }
            }}
          />
        ) : null}
      </main>

      <CallCard onSettings={() => openSettings("voice")} />

      {/* Create flows are centered dialogs, not side panels: they are one-shot
          forms, and the chat stays readable behind them. */}
      {panel === "create" ? (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) setPanel(null);
          }}
        >
          <DialogContent
            className="w-[calc(100vw-32px)] max-w-[560px] gap-5 rounded-3xl p-6"
            data-testid="create-bot-dialog"
          >
            <DialogHeader className="space-y-0">
              <DialogTitle className="text-[14px] font-semibold tracking-tight">
                <Trans>New bot</Trans>
              </DialogTitle>
            </DialogHeader>
            <CreateBotForm onCreate={(input) => createBot(input)} />
          </DialogContent>
        </Dialog>
      ) : null}
      {panel === "create-group" ? (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) setPanel(null);
          }}
        >
          <DialogContent
            className="w-[calc(100vw-32px)] max-w-[520px] gap-5 rounded-3xl p-6"
            data-testid="create-group-dialog"
          >
            <DialogHeader className="space-y-0">
              <DialogTitle className="text-[14px] font-semibold tracking-tight">
                <Trans>New group</Trans>
              </DialogTitle>
            </DialogHeader>
            <CreateGroupForm bots={bots} onCreate={(input) => createGroup(input)} />
          </DialogContent>
        </Dialog>
      ) : null}

      <aside
        data-testid="side-panel"
        data-panel={panel ?? "closed"}
        className={`absolute inset-y-0 end-0 z-20 flex min-h-0 shrink-0 flex-col overflow-hidden bg-background transition-[width] duration-150 ease-out md:relative ${
          panel && (active || activeGroup)
            ? "w-full max-w-[384px] border-s border-sidebar-border md:w-[384px] md:max-w-none"
            : "pointer-events-none w-0"
        }`}
      >
        {panel && (active || activeGroup) ? (
          <div
            className={
              panel === "group"
                ? "h-full w-full md:w-[384px]"
                : "rk-scroll h-full w-full overflow-y-auto px-5 py-[17px] md:w-[384px]"
            }
          >
            {panel !== "routine" &&
            panel !== "create" &&
            panel !== "create-group" &&
            panel !== "group" &&
            panel !== "group-settings" ? (
              <div className="mb-4 flex items-center justify-between">
                <span className="text-[13.5px] text-muted-foreground">
                  {panel === "settings" ? (
                    <Trans>Settings</Trans>
                  ) : active ? (
                    (computer?.state ?? active.status)
                  ) : (
                    <Trans>Group</Trans>
                  )}
                </span>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t`Close panel`}
                    onClick={() => setPanel(null)}
                  >
                    <X size={16} strokeWidth={1.8} />
                  </Button>
                </div>
              </div>
            ) : null}
            {panel === "group" && activeGroup ? (
              <GroupPanel
                key={activeGroup.id}
                members={groupPanel.members}
                membersError={groupPanel.membersError}
                groupName={activeGroup.name}
                tab={groupTab}
                onTabChange={setGroupTab}
                onClose={() => setPanel(null)}
                onRename={async (next) => {
                  const updated = await rpc.groups.update({
                    groupId: activeGroup.id,
                    name: next,
                  });
                  setGroups((current) =>
                    current.map((group) => (group.id === updated.id ? updated : group)),
                  );
                  setSnapshot((current) =>
                    current && current.groupId === updated.id
                      ? { ...current, groupName: updated.name }
                      : current,
                  );
                  groupPanel.reload();
                  await Promise.all([refreshBots(), refreshGroupThread(activeGroup.id)]).catch(
                    () => undefined,
                  );
                }}
                onManageMembers={() => setPanel("group-settings")}
                routines={groupPanel.routines}
                routinesError={groupPanel.routinesError}
                artifacts={groupPanel.artifacts}
                artifactsError={groupPanel.artifactsError}
                artifactsLoading={groupPanel.artifactsLoading}
                nextCursor={groupPanel.nextCursor}
                onLoadMoreArtifacts={groupPanel.loadMoreArtifacts}
                onOpenArtifact={(item: GroupArtifactItem) => {
                  navigate(`/app/artifacts/${item.id}`);
                }}
                onRetry={groupPanel.reload}
              />
            ) : null}
            {panel === "group-settings" && activeGroup ? (
              <GroupSettings
                key={activeGroup.id}
                group={activeGroup}
                bots={bots}
                onSave={async (input) => {
                  const updated = await rpc.groups.update({ groupId: activeGroup.id, ...input });
                  setGroups((current) =>
                    current.map((group) => (group.id === updated.id ? updated : group)),
                  );
                  setPanel(null);
                  await Promise.all([refreshBots(), refreshGroupThread(activeGroup.id)]).catch(
                    () => undefined,
                  );
                }}
                onRemove={async () => {
                  await rpc.groups.remove({ groupId: activeGroup.id });
                  const remainingGroups = groups.filter((group) => group.id !== activeGroup.id);
                  setGroups(remainingGroups);
                  setPanel(null);
                  navigate(firstThreadRoute(bots, remainingGroups), { replace: true });
                  await refreshBots().catch(() => undefined);
                }}
              />
            ) : null}
            {panel === "settings" && active ? (
              <BotSettings
                key={active.id}
                bot={active}
                settingsTab={settingsTab}
                onSettingsTabChange={setSettingsTab}
                computerScreen={
                  <div>
                    <div
                      data-testid="computer-preview"
                      className="group relative aspect-[16/10] overflow-hidden rounded-[14px] bg-background"
                    >
                      {computerOpen ? (
                        <div className="grid h-full place-items-center text-sm text-muted-foreground/80">
                          <Trans>Open in full window</Trans>
                        </div>
                      ) : computer?.kind === "desktop" ? (
                        <DesktopKindEmptyState className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground/80" />
                      ) : computer?.state === "running" &&
                        embeddedScreenUrl &&
                        !computerScreenError ? (
                        <iframe
                          title={t`Bot screen preview`}
                          src={embeddedScreenUrl}
                          sandbox={screenIframeSandbox(embeddedScreenUrl)}
                          className="h-full w-full border-0 bg-black"
                          allow="clipboard-read; clipboard-write"
                          style={{ pointerEvents: "none" }}
                        />
                      ) : (
                        <div className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground/80">
                          {computerScreenError ??
                            (computersAreUnavailable(bootstrapMe?.sandboxProvider) ? (
                              <ComputersUnavailableHint />
                            ) : (
                              computerPlaceholder(
                                computer?.state,
                                booting,
                                computerLabel(computer?.mode, active.name),
                              )
                            ))}
                        </div>
                      )}
                      {!computerScreenError ? (
                        <button
                          type="button"
                          data-testid="computer-preview-open"
                          className="absolute inset-0 flex cursor-pointer items-center justify-center bg-overlay/40 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                          aria-label={t`Open`}
                          onClick={() => void openComputer()}
                        >
                          <span className="inline-flex items-center gap-2 rounded-full bg-overlay px-3.5 py-2 text-[14px] text-foreground shadow-md">
                            <Maximize2 size={15} strokeWidth={1.9} aria-hidden />
                            <Trans>Open</Trans>
                          </span>
                        </button>
                      ) : null}
                    </div>
                    <p className="mt-2 truncate text-[13.5px] text-muted-foreground" dir="auto">
                      {t`${active.name}'s screen`}
                    </p>
                    {!computerOpen && computerPanelNeedsMaintenance(computer?.state, booting) ? (
                      <ComputerMaintenanceActions
                        botId={active.id}
                        computer={computer}
                        onChanged={async () => {
                          await refreshThread(active.id);
                        }}
                      />
                    ) : null}
                  </div>
                }
                routines={
                  <div>
                    <RoutineListHeader
                      onCreate={() => {
                        setRoutineDraft(emptyRoutineDraft());
                        setRoutineWebhookSecret(null);
                        setEditingRoutine(null);
                        setRoutineError(null);
                        setPanel("routine");
                      }}
                    />
                    {activeRoutines.map((routine) => {
                      const routineRunning =
                        snapshot?.run?.routineId === routine.id && isActive(snapshot.run.status);
                      return (
                        <RoutineListRow
                          key={routine.id}
                          routine={routine}
                          running={routineRunning}
                          onOpen={() => {
                            setRoutineDraft(draftFromRoutine(routine));
                            setRoutineWebhookSecret(null);
                            setEditingRoutine(routine);
                            setRoutineError(null);
                            setPanel("routine");
                          }}
                          onStop={() => void stopRun()}
                        />
                      );
                    })}
                  </div>
                }
                memoryProviderConfigured={memoryProviderConfig != null}
                onSkillsChange={setAgentSkills}
                onSave={async ({ computerMode, ...patch }) => {
                  if (computerMode !== active.computerMode) {
                    await rpc.bots.setComputer({
                      botId: active.id,
                      mode: computerMode,
                    });
                  }
                  await rpc.bots.update({ botId: active.id, ...patch });
                  await refreshBots();
                }}
                onAvatarChanged={refreshBots}
                onExport={async () => {
                  const manifest = await rpc.export.bot({ botId: active.id });
                  const blob = new Blob([JSON.stringify(manifest, null, 2)], {
                    type: "application/json",
                  });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `${active.name.toLowerCase().replace(/\s+/g, "-")}-export.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                onClear={() => setClearTarget({ kind: "bot", chat: active })}
              />
            ) : null}
            {panel === "routine" && active ? (
              <RoutineEditor
                draft={routineDraft}
                onChange={setRoutineDraft}
                editing={editingRoutine}
                timezone={editingRoutine?.timezone ?? localTimezone()}
                webhook={{
                  path:
                    typeof window !== "undefined"
                      ? `${window.location.origin}/api/v1/bots/${active.id}/webhook`
                      : `/api/v1/bots/${active.id}/webhook`,
                  secret: routineWebhookSecret,
                  configured: active.webhookConfigured || Boolean(routineWebhookSecret),
                }}
                githubPath={
                  typeof window !== "undefined"
                    ? `${window.location.origin}/api/v1/bots/${active.id}/github`
                    : `/api/v1/bots/${active.id}/github`
                }
                messageProviders={messagingProviders}
                saving={savingRoutine}
                running={runningRoutine}
                error={routineError}
                onBack={() => {
                  setPanel("settings");
                  setSettingsTab("detail");
                }}
                onClose={() => setPanel(null)}
                onEnsureWebhook={async () => {
                  await ensureWebhookSecret(active.id);
                }}
                onSave={async () => {
                  if (routineSavePending.current) return;
                  const targetBotId = active.id;
                  const targetRoutine = editingRoutine;
                  if (targetRoutine && targetRoutine.botId !== targetBotId) return;
                  if (
                    !routineDraft.schedules.length &&
                    !routineDraft.webhookEnabled &&
                    !routineDraft.githubEnabled &&
                    !routineDraft.messageProvider
                  ) {
                    setRoutineError(t`Add a schedule, webhook, GitHub, or message trigger`);
                    return;
                  }
                  const saveRequest = ++routineSaveRequest.current;
                  routineSavePending.current = true;
                  setSavingRoutine(true);
                  setRoutineError(null);
                  try {
                    if (
                      (routineDraft.webhookEnabled || routineDraft.githubEnabled) &&
                      !active.webhookConfigured &&
                      !routineWebhookSecret
                    ) {
                      await ensureWebhookSecret(targetBotId);
                    }
                    const crons = routineDraft.schedules.map(cronFromPreset);
                    let saved: Routine;
                    if (targetRoutine) {
                      const armOneShot = routineNeedsOneShotArm(targetRoutine, crons);
                      let runAt: string | undefined;
                      if (armOneShot) {
                        if (!routineDraft.runAtLocal) {
                          setRoutineError(t`Add a run time for this one-shot.`);
                          return;
                        }
                        const parsed = new Date(routineDraft.runAtLocal);
                        if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= Date.now()) {
                          setRoutineError(t`Run time must be in the future.`);
                          return;
                        }
                        runAt = parsed.toISOString();
                      }
                      saved = await rpc.routines.update({
                        routineId: targetRoutine.id,
                        name: routineDraft.name || t`Routine`,
                        prompt: routineDraft.prompt || t`Check in.`,
                        crons,
                        active: armOneShot ? true : routineDraft.active,
                        webhookEnabled: routineDraft.webhookEnabled,
                        githubEnabled: routineDraft.githubEnabled,
                        messageProvider: routineDraft.messageProvider,
                        ...(runAt ? { runAt } : {}),
                      });
                    } else {
                      saved = await rpc.routines.create({
                        botId: targetBotId,
                        name: routineDraft.name || t`Routine`,
                        prompt: routineDraft.prompt || t`Check in.`,
                        crons,
                        timezone: localTimezone(),
                        active: routineDraft.active,
                        notify: true,
                        webhookEnabled: routineDraft.webhookEnabled,
                        githubEnabled: routineDraft.githubEnabled,
                        messageProvider: routineDraft.messageProvider,
                      });
                    }
                    if (
                      routineSaveRequest.current === saveRequest &&
                      activeBotId.current === targetBotId
                    ) {
                      setEditingRoutine(saved);
                      setRoutineDraft(draftFromRoutine(saved));
                    }
                  } catch (error) {
                    if (
                      routineSaveRequest.current !== saveRequest ||
                      activeBotId.current !== targetBotId
                    ) {
                      return;
                    }
                    setRoutineError(
                      error instanceof Error ? error.message : t`Could not save routine`,
                    );
                    return;
                  } finally {
                    routineSavePending.current = false;
                    setSavingRoutine(false);
                  }
                  if (
                    routineSaveRequest.current !== saveRequest ||
                    activeBotId.current !== targetBotId
                  ) {
                    return;
                  }
                  await refreshThread(targetBotId).catch(() => undefined);
                }}
                onTestRun={async () => {
                  if (routineRunPending.current) return;
                  const targetBotId = active.id;
                  const targetRoutine = editingRoutine;
                  if (!targetRoutine) return;
                  routineRunPending.current = true;
                  setRunningRoutine(true);
                  setRoutineError(null);
                  try {
                    await rpc.routines.testRun({ routineId: targetRoutine.id });
                    await refreshThread(targetBotId);
                  } catch (error) {
                    if (activeBotId.current === targetBotId) {
                      setRoutineError(
                        error instanceof Error ? error.message : t`Could not run routine`,
                      );
                    }
                  } finally {
                    routineRunPending.current = false;
                    setRunningRoutine(false);
                  }
                }}
                onDelete={() => {
                  if (editingRoutine) {
                    setDeleteRoutineTarget(editingRoutine);
                    return;
                  }
                  setPanel("computer");
                }}
              />
            ) : null}
          </div>
        ) : null}
      </aside>

      <Suspense fallback={null}>
        {contextChat && botMenu ? (
          <BotContextMenu
            bot={contextChat}
            position={botMenu.position}
            onClose={closeBotMenu}
            sections={botSections}
            onTogglePinned={() => {
              setBotMenu(null);
              const request = contextBot
                ? rpc.bots.update({ botId: contextBot.id, pinned: !contextBot.pinned })
                : rpc.groups.update({
                    groupId: contextGroup!.id,
                    pinned: !contextGroup!.pinned,
                  });
              void request.then(() => refreshBots());
            }}
            onToggleUnread={() => {
              const unread = !contextChat.unread;
              setBotMenu(null);
              if (contextBot) {
                const request = unread ? markBotUnread(contextBot.id) : markBotRead(contextBot.id);
                void request.catch(() => undefined);
              } else {
                const request = unread
                  ? rpc.threads.markUnread({ groupId: contextGroup!.id })
                  : rpc.threads.markRead({ groupId: contextGroup!.id });
                void request
                  .then(() =>
                    setGroups((current) =>
                      current.map((group) =>
                        group.id === contextGroup!.id ? { ...group, unread } : group,
                      ),
                    ),
                  )
                  .catch(() => undefined);
              }
            }}
            onMoveToSection={(sectionId) => {
              setBotMenu(null);
              if (sectionId === contextChat.sectionId) return;
              const request = contextBot
                ? rpc.bots.update({ botId: contextBot.id, sectionId })
                : rpc.groups.update({ groupId: contextGroup!.id, sectionId });
              void request.then(() => refreshBots());
            }}
            onCreateSection={() => {
              setNewSectionTarget(
                contextBot
                  ? { kind: "bot", chat: contextBot }
                  : { kind: "group", chat: contextGroup! },
              );
              setBotMenu(null);
            }}
            onRenameSection={(sectionId) => {
              const section = botSections.find((item) => item.id === sectionId);
              const spaceId = bootstrapMe?.spaceId;
              if (section && spaceId) setRenameSectionTarget({ section, spaceId });
              setBotMenu(null);
            }}
            onEdit={() => {
              navigate(contextBot ? `/app/${contextBot.id}` : `/app/g/${contextGroup!.id}`);
              setPanel(contextBot ? "settings" : "group-settings");
              setBotMenu(null);
            }}
            onDuplicate={() => {
              setBotMenu(null);
              const request = contextBot
                ? rpc.bots.duplicate({ botId: contextBot.id })
                : rpc.groups.duplicate({ groupId: contextGroup!.id });
              void request.then(async (chat) => {
                await refreshBots();
                navigate(contextBot ? `/app/${chat.id}` : `/app/g/${chat.id}`);
              });
            }}
            onClear={() => {
              setClearTarget(
                contextBot
                  ? { kind: "bot", chat: contextBot }
                  : { kind: "group", chat: contextGroup! },
              );
              setBotMenu(null);
            }}
            onArchive={() => {
              setBotMenu(null);
              const request = contextBot
                ? rpc.bots.archive({ botId: contextBot.id })
                : rpc.groups.archive({ groupId: contextGroup!.id });
              void request.then(() => refreshBots(true));
            }}
            onDelete={() => {
              if (contextBot) setDeleteTarget(contextBot);
              else setDeleteGroupTarget(contextGroup!);
              setBotMenu(null);
            }}
          />
        ) : null}

        {spaceMenu ? (
          <DropdownMenu
            open
            onOpenChange={(open) => {
              if (!open) closeSpaceMenu();
            }}
          >
            {/* Invisible anchor at the pointer position, mirroring the bot menu. */}
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden
                  className="fixed size-0 p-0 opacity-0"
                  style={{ left: spaceMenu.position.x, top: spaceMenu.position.y }}
                />
              }
            />
            <DropdownMenuContent
              aria-label={t`Actions for space`}
              align="start"
              sideOffset={0}
              className="w-[220px]"
            >
              <DropdownMenuItem
                variant="destructive"
                onClick={() => {
                  const target = spaces.find((space) => space.id === spaceMenu.id);
                  if (target) setDeleteSpaceTarget(target);
                  setSpaceMenu(null);
                }}
              >
                <Trash2 />
                {t`Delete space`}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        {deleteTarget ? (
          <DeleteBotDialog
            bot={deleteTarget}
            onCancel={() => setDeleteTarget(null)}
            onConfirm={async (deleteMemories) => {
              await rpc.bots.remove({ botId: deleteTarget.id, deleteMemories });
              setDeleteTarget(null);
              setPanel(null);
              await refreshBots(true);
            }}
          />
        ) : null}

        {deleteGroupTarget ? (
          <DeleteItemDialog
            item={deleteGroupTarget}
            noun="group"
            onCancel={() => setDeleteGroupTarget(null)}
            onConfirm={async () => {
              await rpc.groups.remove({ groupId: deleteGroupTarget.id });
              setDeleteGroupTarget(null);
              setPanel(null);
              await refreshBots(true);
            }}
          />
        ) : null}

        {deleteSpaceTarget ? (
          <DeleteItemDialog
            item={deleteSpaceTarget}
            noun="space"
            description={
              <Trans>Only empty spaces can be deleted. Delete its bots and groups first.</Trans>
            }
            onCancel={() => setDeleteSpaceTarget(null)}
            onConfirm={async () => {
              const targetId = deleteSpaceTarget.id;
              const result = await rpc.spaces.remove({ spaceId: targetId });
              setDeleteSpaceTarget(null);
              setPanel(null);
              const effectiveSpaceId = selectedSpaceId() ?? bootstrapMe?.spaceId;
              if (effectiveSpaceId === targetId) {
                // The auth boundary changed, so reload like a space switch.
                if (selectSpace(result.activeSpaceId)) {
                  window.location.assign("/app");
                  return;
                }
              }
              await refreshBots(true);
            }}
          />
        ) : null}

        {newSectionTarget ? (
          <NewBotSectionDialog
            bot={newSectionTarget.chat}
            onCancel={() => setNewSectionTarget(null)}
            onConfirm={async (name) => {
              await rpc.botSections.create(
                newSectionTarget.kind === "bot"
                  ? { botId: newSectionTarget.chat.id, name }
                  : { groupId: newSectionTarget.chat.id, name },
              );
              setNewSectionTarget(null);
              await refreshBots();
            }}
          />
        ) : null}

        {renameSectionTarget ? (
          <RenameBotSectionDialog
            section={renameSectionTarget.section}
            onCancel={() => setRenameSectionTarget(null)}
            onConfirm={async (name) => {
              await rpc.botSections.update(
                {
                  sectionId: renameSectionTarget.section.id,
                  name,
                },
                { context: { spaceId: renameSectionTarget.spaceId } },
              );
              setRenameSectionTarget(null);
              await refreshBots();
            }}
          />
        ) : null}

        {sectionMenu ? (
          <DropdownMenu
            open
            onOpenChange={(open) => {
              if (!open) closeSectionMenu();
            }}
          >
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden
                  className="fixed size-0 p-0 opacity-0"
                  style={{ left: sectionMenu.position.x, top: sectionMenu.position.y }}
                />
              }
            />
            <DropdownMenuContent
              aria-label={t`Actions for ${sectionMenu.section.name}`}
              align="start"
              sideOffset={0}
              className="w-[220px]"
            >
              <DropdownMenuItem
                onClick={() => {
                  setRenameSectionTarget({
                    section: sectionMenu.section,
                    spaceId: sectionMenu.spaceId,
                  });
                  setSectionMenu(null);
                }}
              >
                <Pencil />
                {t`Rename section`}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        <CommandPalette
          open={commandPaletteOpen}
          onOpenChange={setCommandPaletteOpen}
          bots={bots}
          onSelectBot={(id) => {
            setMobileSidebarOpen(false);
            navigate(`/app/${id}`);
          }}
        />

        {newSpaceOpen ? (
          <NewSpaceDialog
            onCancel={() => setNewSpaceOpen(false)}
            onConfirm={async (name) => {
              const space = await rpc.spaces.create({ name });
              if (!selectSpace(space.id)) {
                setNewSpaceOpen(false);
                await refreshBots();
                return;
              }
              window.location.assign("/onboarding");
            }}
          />
        ) : null}

        {pickerInfoTopic ? (
          <PickerInfoDialog topic={pickerInfoTopic} onClose={() => setPickerInfoTopic(null)} />
        ) : null}

        {clearTarget ? (
          <ClearConversationDialog
            bot={clearTarget.chat}
            onCancel={() => setClearTarget(null)}
            onConfirm={async () => {
              await rpc.threads.clear(
                clearTarget.kind === "bot"
                  ? { botId: clearTarget.chat.id }
                  : { groupId: clearTarget.chat.id },
              );
              if (
                (clearTarget.kind === "bot" && active?.id === clearTarget.chat.id) ||
                (clearTarget.kind === "group" && activeGroup?.id === clearTarget.chat.id)
              ) {
                expandedHistoryThread.current = null;
                pinnedAroundRef.current = null;
                historyEpoch.current += 1;
                updateSnapshot((current) =>
                  current
                    ? {
                        ...current,
                        messages: [],
                        olderCursor: null,
                        run: null,
                        activeRuns: [],
                        plans: [],
                        steps: [],
                        todos: [],
                        interventions: [],
                        interactions: [],
                        displayBlocks: [],
                      }
                    : current,
                );
              }
              setClearTarget(null);
              await refreshBots();
            }}
          />
        ) : null}

        {deleteRoutineTarget ? (
          <DeleteItemDialog
            item={deleteRoutineTarget}
            noun="routine"
            onCancel={() => setDeleteRoutineTarget(null)}
            onConfirm={async () => {
              const target = deleteRoutineTarget;
              await rpc.routines.remove({ routineId: target.id });
              setDeleteRoutineTarget(null);
              setEditingRoutine((current) => (current?.id === target.id ? null : current));
              if (activeBotId.current !== target.botId) return;
              await refreshThread(target.botId);
              if (activeBotId.current === target.botId) setPanel("computer");
            }}
          />
        ) : null}

        {pluginsOpen ? (
          <PluginsOverlay
            activeBotId={activeBotId.current}
            onClose={() => setPluginsOpen(false)}
            onOpenMcp={() => {
              setPluginsOpen(false);
              setMcpOpen(true);
            }}
          />
        ) : null}
        {mcpOpen ? <McpServersOverlay onClose={() => setMcpOpen(false)} /> : null}
        {messagingSettingsOpen ? (
          <MessagingSettingsOverlay onClose={() => setMessagingSettingsOpen(false)} />
        ) : null}
      </Suspense>

      <Suspense fallback={null}>
        {settingsOpen ? (
          <SettingsOverlay
            name={userName}
            email={session.data?.user.email}
            usage={usageState.summary}
            usageRange={usageState.range}
            usageLoading={usageState.loading}
            usageError={usageState.error}
            onUsageRangeChange={loadUsage}
            initialSection={settingsSection}
            isDeploymentOwner={bootstrapMe?.isDeploymentOwner === true}
            sandboxProvider={bootstrapMe?.sandboxProvider}
            messagingEnabled={messagingSurfaceEnabled}
            onOpenMessaging={() => {
              setSettingsOpen(false);
              setMessagingSettingsOpen(true);
            }}
            memoryConfig={memoryProviderConfig}
            onMemoryConfigChange={(config) => {
              memoryProviderConfigRevision.current += 1;
              setMemoryProviderConfig(config);
            }}
            onVoiceStatusMaybeChanged={async () => {
              try {
                setVoiceStatus(
                  await Promise.race([rpc.voice.status(), voiceStatusRefreshTimeout()]),
                );
              } catch {
                // Prefer reopening Voice settings over starting a call with stale readiness.
                setVoiceStatus(null);
              }
            }}
            onClose={() => {
              setSettingsOpen(false);
              setSettingsSection("general");
            }}
          />
        ) : null}
        {peerConversation && active ? (
          <PeerMessagesOverlay
            botId={active.id}
            botName={active.name}
            botColor={active.color}
            peerBotId={peerConversation.peerBotId}
            peerBotName={peerConversation.peerBotName}
            peerBotColor={
              resolveTranscriptBot(peerConversation.peerBotId)?.color ?? FALLBACK_BOT_COLOR
            }
            sourceReceiptMessageId={peerConversation.sourceReceiptMessageId}
            locator={{
              kind: "pair_message",
              pairThreadId: peerConversation.pairThreadId,
              messageId: peerConversation.messageId,
            }}
            onClose={() => setPeerConversation(null)}
          />
        ) : null}
      </Suspense>

      {booting ? (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-[22px] bg-background/95">
          <div className="text-[19px] font-medium text-foreground">
            <Trans>Booting up {computerBot?.name ?? active?.name}’s computer</Trans>
          </div>
          <div className="h-[5px] w-[min(420px,70%)] overflow-hidden rounded-full bg-accent">
            <div className="h-full w-2/3 rounded-full bg-primary" />
          </div>
        </div>
      ) : computerOpen && computerBot ? (
        <div className="fixed inset-0 z-30 bg-background">
          <div
            data-testid="computer-viewport"
            className="fixed inset-x-0 top-0 flex flex-col bg-background"
            style={{
              height: computerViewport ? `${computerViewport.height}px` : "100dvh",
              top: computerViewport ? `${computerViewport.offsetTop}px` : undefined,
            }}
          >
            <div
              data-testid="computer-chrome"
              className="flex items-center justify-between gap-4 border-b border-sidebar-border px-[18px] py-3.5"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <BotAvatar
                  color={computerBot.color}
                  identity={computerBot.id}
                  size={28}
                  status={computerBot.status}
                />
                {recordingSkill ? (
                  <TeachRecordingChrome
                    recording={recordingSkill}
                    botId={computerBot.id}
                    busy={teachBusy}
                    onStop={stopTeaching}
                    variant="overlay"
                  />
                ) : (
                  <span className="truncate text-[15.5px] font-medium text-foreground" dir="auto">
                    {computerLabel(computer?.mode, computerBot.name)}
                  </span>
                )}
                {!recordingSkill && hasControl ? (
                  computer?.takeoverRequested ? (
                    <span className="rounded-full bg-warning/15 px-[11px] py-1 text-[13px] text-warning">
                      <Trans>Needs you</Trans>
                    </span>
                  ) : (
                    <span className="rounded-full bg-success/15 px-[11px] py-1 text-[13px] text-success">
                      <Trans>You have control</Trans>
                    </span>
                  )
                ) : null}
              </div>
              <div className="flex items-center gap-3">
                {composerRunning ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t`Stop`}
                    data-testid="computer-overlay-stop"
                    onClick={() => void stopRun()}
                    disabled={sending}
                  >
                    <Trans>Stop</Trans>
                  </Button>
                ) : null}
                {recordingSkill ? (
                  <TeachStopButton busy={teachBusy} onStop={stopTeaching} />
                ) : hasControl ? (
                  <ComputerReleaseActions
                    takeoverRequested={Boolean(computer?.takeoverRequested)}
                    onRelease={releaseComputer}
                  />
                ) : null}
                {computerBot && !recordingSkill ? (
                  <TeachComputerOverlayControl
                    key={computerBot.id}
                    botId={computerBot.id}
                    computer={computer}
                    busy={teachBusy}
                    onRefresh={refreshActiveTeaching}
                  />
                ) : null}
                {computerBot && !recordingSkill ? (
                  <ComputerMaintenanceActions
                    botId={computerBot.id}
                    computer={computer}
                    onChanged={async () => {
                      await refreshComputerFor(computerBot.id);
                    }}
                  />
                ) : null}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  aria-label={t`Close computer`}
                  onClick={() => setComputerOpen(false)}
                >
                  <X size={16} strokeWidth={1.8} />
                </Button>
              </div>
            </div>
            {sendError ? (
              <div
                role="alert"
                className="border-b border-destructive/40 bg-destructive/10 px-[18px] py-2 text-[13px] text-destructive"
              >
                {sendError}
              </div>
            ) : null}
            <div className="relative min-h-0 flex-1 bg-background">
              <ComputerWorkspace
                botId={computerBot.id}
                computer={computer}
                hasControl={hasControl}
                dock={!recordingSkill}
                onTakeControl={
                  computer?.state === "running" &&
                  !hasControl &&
                  !computerTakeoverBlocked(computer, snapshot?.run?.status)
                    ? () => openComputer(computerBot.id)
                    : undefined
                }
              >
                {computer?.kind === "desktop" ? (
                  <DesktopKindEmptyState className="grid h-full place-items-center px-8 text-center text-sm text-muted-foreground/80" />
                ) : computer?.state === "running" && embeddedScreenUrl && !computerScreenError ? (
                  <>
                    <iframe
                      title={t`Bot screen`}
                      src={embeddedScreenUrl}
                      sandbox={screenIframeSandbox(embeddedScreenUrl)}
                      className="h-full w-full border-0 bg-black"
                      allow="clipboard-read; clipboard-write; fullscreen"
                      style={{
                        pointerEvents: recordingSkill || !hasControl ? "none" : "auto",
                      }}
                    />
                    {computerBot ? (
                      <TeachCaptureOverlay
                        botId={computerBot.id}
                        skill={recordingSkill}
                        enabled={Boolean(recordingSkill)}
                        screenWidth={computer?.screenWidth}
                        screenHeight={computer?.screenHeight}
                      />
                    ) : null}
                  </>
                ) : (
                  <div className="grid h-full place-items-center text-sm text-muted-foreground/80">
                    {computerScreenError ??
                      (computer?.state === "suspended"
                        ? t`Computer is asleep`
                        : computerLabel(computer?.mode, computerBot.name))}
                  </div>
                )}
              </ComputerWorkspace>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );

  return shell;
}

// Exported as a test seam for the UX-01A execution-region smoke baseline
// (shell-execution-transcript.test.tsx); rendering behavior is unchanged.
export const Transcript = memo(function Transcript({
  scrollRef,
  reservePillBand,
  scrollRequest,
  onScrollRequestHandled,
  artifactTarget,
  messages,
  plans,
  steps,
  todos,
  runs,
  activeRunIds,
  showToolActivity,
  olderCursor,
  loadingOlder,
  interventions,
  interactions,
  displayBlocks,
  cardsUnifiedV2,
  conversationName,
  groupNameOf,
  threadId,
  executions,
  running,
  activity,
  backgroundTasks,
  onCancelBackgroundTask,
  showActivityAvatars,
  activityBotColors,
  botNameOf,
  onLoadOlder,
  onOpenBot,
  onAnswer,
  onReply,
  onQuote,
  onReact,
  onJumpToMessage,
  onOpenPeerMessages,
  memberName,
  peerBot,
  onRefresh,
  onBotChanged,
  onAddRoutine,
  voiceReady,
  speakingMessageId,
  onSpeak,
  onOpenComputer,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  /**
   * UX-03 §5: a floating identity pill is anchored over the top of the
   * conversation column — reserve its band as scroll-top padding so
   * transcript controls are never clicked through the pill.
   */
  reservePillBand?: boolean;
  scrollRequest: { messageId: string; nonce: number } | null;
  onScrollRequestHandled: () => void;
  artifactTarget: ArtifactTarget;
  messages: ThreadMessage[];
  plans?: ThreadSnapshot["plans"];
  steps?: ThreadSnapshot["steps"];
  todos?: ThreadSnapshot["todos"];
  runs: Run[];
  activeRunIds: string[];
  showToolActivity: boolean;
  olderCursor: number | null;
  loadingOlder: boolean;
  interventions?: ThreadSnapshot["interventions"];
  /** CARD-01A strict projection; present only when the server gate is on. */
  interactions?: ThreadSnapshot["interactions"];
  /** CARD-01C display projection; present only when the server gate is on. */
  displayBlocks?: ThreadSnapshot["displayBlocks"];
  cardsUnifiedV2?: boolean;
  conversationName?: string;
  groupNameOf?: (groupId: string) => string | undefined;
  threadId: string;
  /** Server per-Run summaries (HISTORY-001); absent on older servers. */
  executions?: ThreadSnapshot["executions"];
  running: boolean;
  activity?: ActivityItem[];
  backgroundTasks?: ActivityItem[];
  onCancelBackgroundTask?: (taskId: string) => Promise<void>;
  showActivityAvatars?: boolean;
  activityBotColors?: Record<string, string>;
  /** UX-02: Bot display-name resolver for the plan review card header. */
  botNameOf?: (botId: string) => string | undefined;
  onLoadOlder: () => void | Promise<void>;
  onOpenBot: (botId: string) => void;
  onAnswer: (message: ThreadMessage, text: string, username?: string) => Promise<void>;
  onReply: (message: ThreadMessage) => void;
  onQuote: (message: ThreadMessage, quote: string) => void;
  onReact: (message: ThreadMessage, reaction: MessageReaction) => Promise<void>;
  onJumpToMessage: (messageId: string) => void;
  onOpenPeerMessages: (target: PeerReceiptTarget) => void;
  memberName?: (botId: string | undefined) => string | undefined;
  peerBot: (botId: string) => { color: string; status?: string } | undefined;
  onRefresh: () => Promise<void>;
  onBotChanged: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
  voiceReady: boolean;
  speakingMessageId: string | null;
  onSpeak: (message: ThreadMessage) => void;
  onOpenComputer: (botId?: string) => void;
}) {
  const { t } = useLingui();
  const [atEnd, setAtEnd] = useState(true);
  const following = useRef(true);
  const autoScrolling = useRef(false);
  const lastScrollTop = useRef<number | null>(null);
  const autoScrollTimer = useRef<number | undefined>(undefined);
  const jumpButtonRef = useRef<HTMLButtonElement>(null);
  const messageById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  const displayBlocksByMessage = useMemo(
    () => groupDisplayBlocksByMessage(displayBlocks ?? []),
    [displayBlocks],
  );
  const markdownByMessage = useMemo(() => {
    const map = new Map<string, ThreadSnapshot["displayBlocks"]>();
    if (cardsUnifiedV2) {
      for (const block of displayBlocks ?? []) {
        if (block.kind !== "markdown") continue;
        const messageId = block.blockId.slice(0, block.blockId.indexOf(":"));
        const list = map.get(messageId) ?? [];
        list.push(block);
        map.set(messageId, list);
      }
    }
    return map;
  }, [displayBlocks, cardsUnifiedV2]);
  const [markdownHeights, setMarkdownHeights] = useState<Map<string, number>>(new Map());
  const onMarkdownMeasure = useCallback((blockId: string, height: number) => {
    const rounded = Math.round(height);
    setMarkdownHeights((prev) => {
      if (prev.get(blockId) === rounded) return prev;
      const next = new Map(prev);
      next.set(blockId, rounded);
      return next;
    });
  }, []);
  // UX-01A: the execution region (anchor merge, server summaries, expansion,
  // detail cache, Interventions, execution-nav return focus and the per-anchor
  // ExecutionShell rendering) is owned by useExecutionTranscript; messageById
  // is shared read-only input, not an execution-region responsibility.
  const { coveredAsks, renderExecutions, standaloneRegion } = useExecutionTranscript({
    threadId,
    artifactTarget,
    messages,
    messageById,
    plans,
    steps,
    todos,
    runs,
    activeRunIds,
    interventions,
    interactions,
    cardsUnifiedV2,
    conversationName,
    groupNameOf,
    executions,
    activity,
    showActivityAvatars,
    activityBotColors,
    botNameOf,
    onOpenComputer,
    onRefresh,
  });
  const reactionView = useMemo(() => projectMessageReactions(messages), [messages]);
  const peerReceipts = useMemo(() => {
    // Group transcripts use PublicDelegationMessage; a private pair receipt
    // (and the wake row behind it) must never surface there.
    if ("groupId" in artifactTarget) {
      return {
        groups: [],
        groupByMessageId: new Map<string, PeerReceiptGroup>(),
      };
    }
    return groupPeerReceipts(reactionView.visibleMessages);
  }, [artifactTarget, reactionView.visibleMessages]);
  // Public `message_bot` deliveries only exist as public collaboration in a
  // group Thread. Direct threads keep the private receipt chip and pair view.
  const inGroupTranscript = "groupId" in artifactTarget;
  const publicDelegations = useMemo(
    () => (inGroupTranscript ? projectPublicDelegations(messages) : null),
    [inGroupTranscript, messages],
  );
  // Rows merged under a PublicDelegationMessage render their execution anchors
  // there; an orphan hidden row (a wake with no rendered group) keeps its
  // anchors at its own transcript position instead.
  const { mergedAnchorMemberIds, memberToGroupFirst } = useMemo(() => {
    const ids = new Set<string>();
    const firstOfMember = new Map<string, string>();
    if (publicDelegations) {
      for (const group of publicDelegations.groupsByFirstMessageId.values()) {
        for (const messageId of group.messageIds) {
          ids.add(messageId);
          firstOfMember.set(messageId, group.firstMessageId);
        }
      }
    }
    return { mergedAnchorMemberIds: ids, memberToGroupFirst: firstOfMember };
  }, [publicDelegations]);
  const [quoteDraft, setQuoteDraft] = useState<{
    message: ThreadMessage;
    text: string;
    range: Range;
  } | null>(null);
  const selectingWithMouse = useRef(false);

  const evaluateSelection = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setQuoteDraft(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const contentOf = (node: Node) =>
      (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
        "[data-quote-message-id]",
      ) ?? null;
    const startContent = contentOf(range.startContainer);
    const endContent = contentOf(range.endContainer);
    // selection.toString() serializes the whole range (a Ctrl+A transcript is
    // unbounded), so it only runs once both endpoints sit in one message.
    const draft = quoteDraftForSelection(
      {
        startContent,
        endContent,
        text: startContent && startContent === endContent ? selection.toString() : "",
      },
      messageById,
    );
    setQuoteDraft((prev) => {
      if (!draft) return null;
      // Repeat firings for an unchanged selection reuse the draft so the
      // transcript isn't re-rendered by every unrelated selection event. A
      // moved selection (e.g. keyboard-selecting a second occurrence of the
      // same text) must carry its new Range — the pill anchors to it.
      if (
        prev &&
        prev.message === draft.message &&
        prev.text === draft.text &&
        prev.range.compareBoundaryPoints(Range.START_TO_START, range) === 0 &&
        prev.range.compareBoundaryPoints(Range.END_TO_END, range) === 0
      ) {
        return prev;
      }
      return { ...draft, range };
    });
  }, [messageById]);

  // Keyboard and assistive-tech selections never reach a mouseup, so the pill
  // lifecycle listens on selectionchange; the mouse flag keeps it hidden while
  // a drag is still in flight.
  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      selectingWithMouse.current = true;
      if ((event.target as Element | null)?.closest?.("[data-quote-selection]")) return;
      setQuoteDraft(null);
    };
    const onMouseUp = () => {
      selectingWithMouse.current = false;
      evaluateSelection();
    };
    const onSelectionChange = () => {
      if (!selectingWithMouse.current) evaluateSelection();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQuoteDraft(null);
    };
    // A drag that ends outside the window never fires document mouseup; reset
    // the flag on blur so keyboard selections keep working afterwards.
    const onWindowBlur = () => {
      selectingWithMouse.current = false;
    };
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("mouseup", onMouseUp, true);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("mouseup", onMouseUp, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [evaluateSelection]);
  const snapToEnd = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    following.current = true;
    autoScrolling.current = false;
    setAtEnd(true);
    element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
  }, [scrollRef]);

  const jumpToLatest = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    following.current = true;
    autoScrolling.current = !reducedMotion;
    setAtEnd(true);
    element.scrollTo({
      top: element.scrollHeight,
      behavior: reducedMotion ? "auto" : "smooth",
    });
    window.clearTimeout(autoScrollTimer.current);
    // Fallback only: onScroll clears autoScrolling once near-end is reached.
    autoScrollTimer.current = window.setTimeout(
      () => {
        autoScrolling.current = false;
      },
      reducedMotion ? 0 : 2_000,
    );
  }, [scrollRef]);

  const scrolledJump = useRef<number | null>(null);
  const jumpScrolling = useRef(false);
  const jumpScrollTimer = useRef<number | undefined>(undefined);
  const endJumpScroll = useCallback(() => {
    jumpScrolling.current = false;
    window.clearTimeout(jumpScrollTimer.current);
    scrollRef.current?.removeEventListener("scrollend", endJumpScroll);
  }, [scrollRef]);
  // A jump scroll must win over follow-the-tail: unfollow inside the commit
  // that mounts the row so a live commit cannot cancel the animation, keep
  // retrying while the pinned window is still rendering, and suppress the
  // near-end follow re-arm only for the jump's own scroll events — scrollend
  // (or user input interrupting it, which also fires scrollend) ends the
  // suppression, with the timeout as fallback when no scroll happens.
  useLayoutEffect(() => {
    if (!scrollRequest || scrolledJump.current === scrollRequest.nonce) return;
    const element = scrollRef.current;
    // A merged delegation member (paired wake or later outbound) has no row
    // of its own; scroll to its visible group bubble instead so search hits
    // on those ids land on the rendered delegation.
    const groupFirstId = publicDelegations?.hiddenMessageIds.has(scrollRequest.messageId)
      ? memberToGroupFirst.get(scrollRequest.messageId)
      : undefined;
    const row = element?.querySelector(
      `[data-message-id="${CSS.escape(
        groupFirstId ?? scrollRequest.messageId,
      )}"]`,
    );
    if (!element || !row) return;
    scrolledJump.current = scrollRequest.nonce;
    following.current = false;
    autoScrolling.current = false;
    jumpScrolling.current = true;
    element.addEventListener("scrollend", endJumpScroll, { once: true });
    window.clearTimeout(jumpScrollTimer.current);
    jumpScrollTimer.current = window.setTimeout(endJumpScroll, 2_000);
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    onScrollRequestHandled();
  }, [
    messages,
    scrollRequest,
    scrollRef,
    endJumpScroll,
    onScrollRequestHandled,
    publicDelegations,
    memberToGroupFirst,
  ]);

  useLayoutEffect(() => {
    if (following.current) snapToEnd();
  }, [messages, plans, steps, todos, running, snapToEnd]);

  useLayoutEffect(() => {
    const button = jumpButtonRef.current;
    if (atEnd && button && document.activeElement === button) {
      button.blur();
    }
  }, [atEnd]);

  const loadOlder = useCallback(() => {
    const wasFollowing = following.current;
    // Prepend must not race the messages-driven snap-to-end follow path.
    following.current = false;
    autoScrolling.current = false;
    const pending = onLoadOlder();
    if (!pending) return;
    return Promise.resolve(pending).catch((error) => {
      const element = scrollRef.current;
      if (wasFollowing && element && transcriptIsNearEnd(element)) {
        following.current = true;
        setAtEnd(true);
      }
      throw error;
    });
  }, [onLoadOlder, scrollRef]);

  useEffect(
    () => () => {
      window.clearTimeout(autoScrollTimer.current);
      window.clearTimeout(jumpScrollTimer.current);
    },
    [],
  );

  return (
    <div className="relative flex min-h-0 flex-1">
      <div
        ref={scrollRef}
        data-testid="transcript"
        onPointerDown={(event) => {
          lastScrollTop.current = event.currentTarget.scrollTop;
          autoScrolling.current = false;
          following.current = false;
        }}
        onTouchStart={(event) => {
          lastScrollTop.current = event.currentTarget.scrollTop;
          autoScrolling.current = false;
          following.current = false;
        }}
        onWheel={(event) => {
          if (event.deltaY < 0) {
            lastScrollTop.current = event.currentTarget.scrollTop;
            autoScrolling.current = false;
            following.current = false;
          }
        }}
        onScroll={(event) => {
          const scrolledDown = transcriptMovedDown(
            lastScrollTop.current,
            event.currentTarget.scrollTop,
          );
          lastScrollTop.current = event.currentTarget.scrollTop;
          const nearEnd = transcriptIsNearEnd(event.currentTarget);
          setAtEnd(nearEnd);
          // A jump scroll owns the viewport until its animation settles; its
          // own near-end crossings must not re-arm tail-following.
          if (jumpScrolling.current) return;
          if (nearEnd) {
            if (scrolledDown) following.current = true;
            if (autoScrolling.current) {
              autoScrolling.current = false;
              window.clearTimeout(autoScrollTimer.current);
            }
          } else if (!autoScrolling.current) {
            following.current = false;
          }
        }}
        className={`rk-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 pb-5 md:px-7 md:pb-6 ${
          // UX-03 §5 collision avoidance: while the floating identity pill is
          // up it occupies the top ~48px of this column (top-2.5 + h-[38px]);
          // reserve its band as scroll-top padding so "Load earlier messages"
          // and the first transcript rows are never clicked through the pill.
          reservePillBand ? "pt-16" : "pt-5 md:pt-6"
        }`}
      >
        {olderCursor != null ? (
          <button
            type="button"
            disabled={loadingOlder}
            onClick={() => void loadOlder()}
            className="self-center rounded-lg px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground/75 disabled:opacity-50"
          >
            {loadingOlder ? t`Loading…` : t`Load earlier messages`}
          </button>
        ) : null}
        {groupVoiceChats(reactionView.visibleMessages).map((item) => {
          if (item.kind === "voiceChat") {
            if (cardsUnifiedV2) {
              // Recompute from the merged group: per-page projections only
              // cover their own window, so trusting one would drop the turns
              // loaded from older pages. The artifactId, when audio exists,
              // is the only part taken from the projection.
              const projectedArtifactId = item.messages
                .flatMap((message) => displayBlocksByMessage.get(message.id) ?? [])
                .find((block) => block.kind === "voice");
              const voiceBlock = voiceDisplayBlockFromGroup(
                item,
                projectedArtifactId?.kind === "voice" ? projectedArtifactId.artifactId : null,
              );
              if (voiceBlock) {
                return (
                  <VoiceDisplay key={item.key} block={voiceBlock} target={artifactTarget} group={item} />
                );
              }
              // The transcript exceeds the display schema's cap; keep the
              // complete legacy card instead of a clipped projection.
              return (
                <VoiceChatCard
                  key={item.key}
                  group={item}
                  revealMessageId={scrollRequest?.messageId}
                />
              );
            }
            return (
              <VoiceChatCard
                key={item.key}
                group={item}
                revealMessageId={scrollRequest?.messageId}
              />
            );
          }
          const message = item.message;
          const receiptGroup = peerReceipts.groupByMessageId.get(message.id);
          if (receiptGroup) {
            if (receiptGroup.anchorMessageId !== message.id) {
              return (
                <Fragment key={message.id}>
                  {renderExecutions(`before:${message.id}`)}
                  {renderExecutions(message.id)}
                </Fragment>
              );
            }
            return (
              <Fragment key={message.id}>
                {renderExecutions(`before:${message.id}`)}
                <div data-message-id={message.id} className="relative py-0.5">
                  <PeerReceiptRow
                    targets={receiptGroup.targets}
                    botName={(botId) => botNameOf?.(botId)}
                    botColor={(botId) => peerBot(botId)?.color}
                    onOpen={onOpenPeerMessages}
                  />
                </div>
                {renderExecutions(message.id)}
              </Fragment>
            );
          }
          const publicDelegation = publicDelegations?.groupsByFirstMessageId.get(message.id);
          if (publicDelegation) {
            // One natural group message per adjacent same-source delegation.
            // Merged transport rows keep their execution anchors below so no
            // Run shell is detached from the transcript.
            const mergedMessageIds = publicDelegation.messageIds.slice(1);
            return (
              <Fragment key={message.id}>
                {renderExecutions(`before:${message.id}`)}
                <div data-message-id={message.id} className="group/message relative hover:z-20">
                  <div className="relative flex justify-start">
                    <div className="relative w-fit min-w-0 max-w-[min(88%,calc(100%_-_6rem))] [@media(hover:none)]:max-w-[88%]">
                      <PublicDelegationMessage
                        group={publicDelegation}
                        onOpenMention={onOpenBot}
                        resolveBot={(botId) => {
                          const name = botNameOf?.(botId);
                          if (!name) return undefined;
                          return {
                            name,
                            color: peerBot(botId)?.color ?? FALLBACK_BOT_COLOR,
                            available: true,
                          };
                        }}
                      />
                    </div>
                  </div>
                </div>
                {renderExecutions(message.id)}
                {mergedMessageIds.map((messageId) => (
                  <Fragment key={messageId}>
                    {renderExecutions(`before:${messageId}`)}
                    {renderExecutions(messageId)}
                  </Fragment>
                ))}
              </Fragment>
            );
          }
          if (publicDelegations?.hiddenMessageIds.has(message.id)) {
            // Merged members render no row of their own; the scroll effect
            // maps their ids onto the group bubble below.
            if (mergedAnchorMemberIds.has(message.id)) return null;
            return (
              <Fragment key={message.id}>
                {renderExecutions(`before:${message.id}`)}
                {renderExecutions(message.id)}
              </Fragment>
            );
          }
          const suppressAsk = coveredAsks.has(message.id);
          // Only a bot text whose rendered bubble is taller than the card
          // fold threshold becomes the markdown display card; ordinary
          // replies stay in the bubble. Measuring the real render also covers
          // single-paragraph text that wraps tall on narrow viewports. Every
          // other projected kind replaces the legacy block it derived from.
          const messageDisplayBlocks = cardsUnifiedV2
            ? (displayBlocksByMessage.get(message.id) ?? [])
            : [];
          const longMarkdown =
            message.role === "bot"
              ? messageDisplayBlocks.find(
                  (block) =>
                    block.kind === "markdown" &&
                    (markdownHeights.get(block.blockId) ?? 0) > LONG_MARKDOWN_HEIGHT_PX,
                )
              : undefined;
          const selectedDisplayBlocks = messageDisplayBlocks.filter(
            (block) => block.kind !== "markdown" || block === longMarkdown,
          );
          // Both suppression predicates key off the original message.blocks
          // indexes: filtering covered interactions first would shift the
          // indexes the display blocks point at and remove the wrong block.
          const hiddenIndexes = new Set<number>();
          if (suppressAsk) {
            message.blocks.forEach((block, index) => {
              if (
                block.kind === "ask" ||
                (cardsUnifiedV2 &&
                  (block.kind === "app_connect" ||
                    block.kind === "mcp_approval" ||
                    block.kind === "skill_draft"))
              ) {
                hiddenIndexes.add(index);
              }
            });
          }
          for (const block of selectedDisplayBlocks) {
            const index = displayBlockMessageIndex(block.blockId, message.id);
            if (index !== null) hiddenIndexes.add(index);
          }
          const visibleBlocks = message.blocks.filter((_, index) => !hiddenIndexes.has(index));
          const showMessage =
            messageHasVisibleBlocks(visibleBlocks, showToolActivity) ||
            selectedDisplayBlocks.length > 0;
          if (!showMessage) {
            // The bubble is invisible (an activity-only live progress
            // placeholder, or a steps-only message with tool activity off),
            // but a Run anchored to this message id still owns its shell —
            // rendering only the `before:` anchor here would orphan it.
            return (
              <Fragment key={message.id}>
                {renderExecutions(`before:${message.id}`)}
                {renderExecutions(message.id)}
              </Fragment>
            );
          }
          const peerReceipt = isPeerReceiptBlocks(message.blocks);
          const messageReactions = reactionView.reactions.get(message.id);
          return (
            <Fragment key={message.id}>
              {renderExecutions(`before:${message.id}`)}
              <div
                key={message.id}
                data-message-id={message.id}
                className={peerReceipt ? "relative py-0.5" : "group/message relative hover:z-20"}
              >
                {!peerReceipt && !message.id.startsWith("progress:") ? (
                  <time
                    dateTime={message.createdAt}
                    data-testid="message-hover-time"
                    className={cn(
                      "pointer-events-none absolute top-1 z-10 text-xs tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100 group-has-[[aria-expanded=true]]/message:opacity-100",
                      message.role === "user" ? "start-0" : "end-0",
                    )}
                  >
                    {new Date(message.createdAt).toLocaleTimeString(i18n.locale || "en", {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </time>
                ) : null}
                <div
                  className={
                    peerReceipt
                      ? undefined
                      : `relative flex ${message.role === "user" ? "justify-end" : "justify-start"}`
                  }
                >
                  <div
                    data-testid={peerReceipt ? undefined : "message-bubble-frame"}
                    className={
                      peerReceipt
                        ? undefined
                        : `relative w-fit min-w-0 ${
                            message.role === "user"
                              ? "max-w-[min(84%,calc(100%_-_6rem))] [@media(hover:none)]:max-w-[84%]"
                              : "max-w-[min(88%,calc(100%_-_6rem))] [@media(hover:none)]:max-w-[88%]"
                          }`
                    }
                  >
                    <MessageView
                      artifactTarget={artifactTarget}
                      message={message}
                      blocks={visibleBlocks}
                      displayBlocks={selectedDisplayBlocks}
                      markdownCandidates={markdownByMessage.get(message.id)}
                      onMarkdownMeasure={onMarkdownMeasure}
                      canAnswer
                      suppressAsk={suppressAsk}
                      onOpenBot={onOpenBot}
                      onAnswer={onAnswer}
                      speakerName={
                        peerReceipt
                          ? undefined
                          : message.role === "bot"
                            ? memberName?.(message.botId)
                            : undefined
                      }
                      memberName={memberName}
                      peerBot={peerBot}
                      botNameOf={botNameOf}
                      replyPreview={
                        message.replyToMessageId
                          ? messageById.get(message.replyToMessageId)
                          : undefined
                      }
                      replyToMessageId={message.replyToMessageId}
                      onJumpToMessage={onJumpToMessage}
                      onRefresh={onRefresh}
                      onBotChanged={onBotChanged}
                      onAddRoutine={onAddRoutine}
                      voiceReady={voiceReady}
                      speaking={speakingMessageId === message.id}
                      onSpeak={() => onSpeak(message)}
                      onOpenComputer={onOpenComputer}
                      showToolActivity={showToolActivity}
                    />
                    {peerReceipt ? null : (
                      <MessageHoverActions
                        message={message}
                        side={message.role === "user" ? "start" : "end"}
                        onReply={onReply}
                        onReact={onReact}
                      />
                    )}
                  </div>
                </div>
                {!peerReceipt && messageReactions ? (
                  <div
                    data-testid="message-reactions"
                    className={cn(
                      "mt-1 flex flex-wrap gap-1",
                      message.role === "user" && "justify-end",
                    )}
                  >
                    {[...messageReactions].map(([emoji, count]) => (
                      <span
                        key={emoji}
                        className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs"
                      >
                        {emoji}
                        {count > 1 ? ` ${count}` : ""}
                      </span>
                    ))}
                  </div>
                ) : null}
                {renderExecutions(message.id)}
              </div>
            </Fragment>
          );
        })}
        {renderExecutions("__tail")}
        {standaloneRegion}
        {backgroundTasks && backgroundTasks.length > 0 ? (
          <BackgroundTaskActivity items={backgroundTasks} onCancel={onCancelBackgroundTask} />
        ) : null}
      </div>
      {quoteDraft ? (
        <QuoteSelectionButton
          range={quoteDraft.range}
          onQuote={() => {
            onQuote(quoteDraft.message, quoteDraft.text);
            window.getSelection()?.removeAllRanges();
            setQuoteDraft(null);
          }}
        />
      ) : null}
      <button
        ref={jumpButtonRef}
        type="button"
        aria-label={t`Jump to latest`}
        aria-hidden={atEnd}
        tabIndex={atEnd ? -1 : 0}
        onClick={jumpToLatest}
        className={`absolute bottom-4 left-1/2 z-20 grid h-9 w-9 -translate-x-1/2 place-items-center rounded-full border border-border bg-muted/95 text-foreground/75 shadow-md backdrop-blur transition-[opacity,transform,background-color] duration-200 ease-[cubic-bezier(.22,1,.36,1)] hover:bg-border motion-reduce:transition-none ${
          atEnd ? "pointer-events-none translate-y-2 opacity-0" : "translate-y-0 opacity-100"
        }`}
      >
        <ArrowDown size={17} strokeWidth={1.8} />
      </button>
    </div>
  );
});

/**
 * Floating Quote action anchored to the selection's bounding rect. Measures
 * itself after mount so it can flip below the selection when there is no room
 * above and stay clamped inside the viewport; re-anchors on scroll/resize.
 */
const QuoteSelectionButton = memo(function QuoteSelectionButton({
  range,
  onQuote,
}: {
  range: Range;
  onQuote: () => void;
}) {
  const { t } = useLingui();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [placement, setPlacement] = useState<{
    top: number;
    left: number;
    above: boolean;
  } | null>(null);

  useLayoutEffect(() => {
    const update = () => {
      if (range.collapsed || !document.contains(range.commonAncestorContainer)) {
        setPlacement(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      const width = buttonRef.current?.offsetWidth ?? 0;
      const height = buttonRef.current?.offsetHeight ?? 0;
      const above = rect.top >= height + 8;
      setPlacement({
        top: above ? rect.top - 8 : rect.bottom + 8,
        left: Math.min(
          Math.max(rect.left + rect.width / 2, width / 2 + 8),
          window.innerWidth - width / 2 - 8,
        ),
        above,
      });
    };
    update();
    window.addEventListener("resize", update);
    // Scroll doesn't bubble — listen on the capture phase to catch any scroller.
    window.addEventListener("scroll", update, { capture: true, passive: true });
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [range]);

  return createPortal(
    <button
      ref={buttonRef}
      type="button"
      data-quote-selection
      data-testid="quote-selection"
      onMouseDown={(event) => {
        // Keep the highlight alive until the click commits the quote.
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={onQuote}
      style={placement ? { top: placement.top, left: placement.left } : { visibility: "hidden" }}
      className={cn(
        "fixed z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-[13px] font-medium text-foreground shadow-md hover:bg-muted",
        placement?.above === false ? "translate-y-0" : "-translate-y-full",
      )}
    >
      <TextQuote size={13} strokeWidth={2} />
      {t`Quote`}
    </button>,
    document.body,
  );
});

const Composer = memo(function Composer({
  activeName,
  running,
  disabled,
  pendingAttachments,
  attachmentNotice,
  sendError,
  runError,
  runErrorId,
  onRunErrorPresented,
  onDismissError,
  sending,
  fileInputRef,
  onAttachmentPick,
  onRemoveAttachment,
  onSend,
  onStop,
  onVoice,
  replyTarget,
  replyQuote,
  replyTargetName,
  onClearReply,
  mentionTargets,
  agentSkills,
  onSlashOpen,
  onSlashAction,
}: {
  activeName?: string;
  running: boolean;
  disabled?: boolean;
  pendingAttachments: PendingAttachment[];
  attachmentNotice: string | null;
  sendError: string | null;
  runError: string | null;
  runErrorId: string | null;
  onRunErrorPresented: (runId: string) => void;
  onDismissError: () => void;
  sending: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onAttachmentPick: (files: FileList | null) => void | Promise<void>;
  onRemoveAttachment: (attachment: PendingAttachment) => void;
  onSend: (text: string, mentions?: ComposerMention[]) => Promise<void>;
  onStop: () => Promise<void>;
  onVoice?: () => void;
  replyTarget?: ThreadMessage | null;
  replyQuote?: string | null;
  replyTargetName?: string;
  onClearReply?: () => void;
  mentionTargets?: ComposerMention[];
  agentSkills?: AgentSkillCatalogEntry[];
  onSlashOpen?: () => void;
  onSlashAction?: (action: SlashActionId) => void;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionHighlightIndex, setMentionHighlightIndex] = useState(0);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<AgentSkillCatalogEntry | null>(null);
  const [selectedMentions, setSelectedMentions] = useState<ComposerMention[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [replyAnnouncement, setReplyAnnouncement] = useState("");
  // What the live region currently holds — a send disarming the reply clears
  // "reply" text, while an explicit cancel must keep "Reply cancelled".
  const replyAnnouncementKind = useRef<"reply" | "cancelled" | null>(null);
  const prevReplyTarget = useRef<ThreadMessage | null>(null);
  const runErrorRef = useRef<HTMLDivElement>(null);
  const presentedRunErrorIdRef = useRef<string | null>(null);
  const mentionListboxId = useId();
  const dragDepth = useRef(0);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const canSend =
    draft.trim().length > 0 ||
    selectedSkill !== null ||
    selectedMentions.length > 0 ||
    pendingAttachments.length > 0;

  useEffect(() => {
    if (!runError || !runErrorId) return;
    const currentRunErrorId = runErrorId;
    let frame = 0;
    function recordIfPresented() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const element = runErrorRef.current;
        if (!element || document.visibilityState !== "visible") return;
        const rect = element.getBoundingClientRect();
        const topElement = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        if (topElement && (topElement === element || element.contains(topElement))) {
          if (presentedRunErrorIdRef.current === currentRunErrorId) return;
          presentedRunErrorIdRef.current = currentRunErrorId;
          onRunErrorPresented(currentRunErrorId);
        }
      });
    }
    recordIfPresented();
    const observer = new MutationObserver(recordIfPresented);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("transitionend", recordIfPresented);
    document.addEventListener("visibilitychange", recordIfPresented);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("transitionend", recordIfPresented);
      document.removeEventListener("visibilitychange", recordIfPresented);
    };
  }, [onRunErrorPresented, runError, runErrorId]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    function syncHeight() {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.style.height = "0px";
      textarea.style.height = `${textarea.scrollHeight}px`;
    }

    syncHeight();
    let lastWidth = el.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const width = textarea.getBoundingClientRect().width;
      if (width === lastWidth) return;
      lastWidth = width;
      syncHeight();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [draft]);

  function updateDraft(value: string) {
    setDraft(value);
    setSelectedMentions((current) =>
      current.filter((mention) => mentionStillInPrompt(value, mention)),
    );
    const mentionMatch = /(?:^|\s)@([\w-]*)$/.exec(value);
    setMentionQuery(mentionMatch ? (mentionMatch[1] ?? "") : null);
    // `/` only at the start of the draft so forced skills expand (`Use skill:` / `/Name` prefix).
    const slashMatch = selectedSkill === null ? /^\/([^\n]*)$/.exec(value) : null;
    const nextSlash = slashMatch ? (slashMatch[1] ?? "") : null;
    if (nextSlash !== null && slashQuery === null) onSlashOpen?.();
    setSlashQuery(nextSlash);
  }

  function focusComposer() {
    textareaRef.current?.focus();
  }

  function insertMention(mention: ComposerMention) {
    setDraft((current) => current.replace(/@([\w-]*)$/, `@${mention.name} `));
    setMentionQuery(null);
    setMentionHighlightIndex(0);
    setSelectedMentions((current) =>
      current.some((selected) => mentionChipKey(selected) === mentionChipKey(mention))
        ? current
        : [...current, mention],
    );
    focusComposer();
  }

  function insertSkill(skill: AgentSkillCatalogEntry) {
    setSelectedSkill(skill);
    setDraft("");
    setSlashQuery(null);
  }

  function runSlashAction(action: SlashActionId) {
    setDraft("");
    setSlashQuery(null);
    onSlashAction?.(action);
  }

  function removeLastChip() {
    if (selectedMentions.length > 0) {
      const last = selectedMentions[selectedMentions.length - 1];
      setSelectedMentions((current) => current.slice(0, -1));
      if (last) setDraft((current) => stripMentionToken(current, last.name));
      return;
    }
    if (selectedSkill) setSelectedSkill(null);
  }

  const mentionOptions = useMemo(() => {
    if (mentionQuery === null || !mentionTargets?.length) return [];
    const query = mentionQuery.trim().toLowerCase();
    return mentionTargets
      .filter((target) => !query || target.name.toLowerCase().startsWith(query))
      .slice(0, 10);
  }, [mentionQuery, mentionTargets]);

  useEffect(() => {
    setMentionHighlightIndex(0);
  }, [mentionQuery, mentionOptions]);

  const activeMentionIndex = clampMentionHighlightIndex(
    mentionHighlightIndex,
    mentionOptions.length,
  );
  const mentionPickerOpen = mentionOptions.length > 0;
  const activeMentionOptionId = mentionPickerOpen
    ? `${mentionListboxId}-option-${activeMentionIndex}`
    : undefined;

  const slashSkillOptions = useMemo(() => {
    if (slashQuery === null) return [];
    const query = slashQuery.trim().toLowerCase();
    const skills = agentSkills ?? [];
    return skills
      .filter((skill) => {
        if (!query) return true;
        return (
          skill.name.toLowerCase().includes(query) ||
          skill.description.toLowerCase().includes(query)
        );
      })
      .slice(0, 8);
  }, [agentSkills, slashQuery]);

  const slashActionOptions = useMemo(() => {
    if (slashQuery === null) return [];
    const query = slashQuery.trim().toLowerCase();
    return SLASH_ACTIONS.filter((action) => !query || action.label.toLowerCase().includes(query));
  }, [slashQuery]);

  const showSlashPicker =
    slashQuery !== null &&
    mentionQuery === null &&
    (slashSkillOptions.length > 0 || slashActionOptions.length > 0);

  function send() {
    if (!canSend || sending || disabled) return;
    const text = serializeComposerPrompt(draft, selectedSkill, selectedMentions);
    setDraft("");
    setMentionQuery(null);
    setMentionHighlightIndex(0);
    setSlashQuery(null);
    setSelectedSkill(null);
    const mentions = selectedMentions;
    setSelectedMentions([]);
    void onSend(text, mentions);
  }

  function handleDragEnter(event: DragEvent<HTMLFieldSetElement>) {
    const dataTransfer = event.dataTransfer;
    if (!isFileDrag(dataTransfer)) return;
    event.preventDefault();
    if (disabled) {
      dragDepth.current = 0;
      setDraggingFiles(false);
      return;
    }
    dragDepth.current += 1;
    setDraggingFiles(true);
  }

  function handleDragOver(event: DragEvent<HTMLFieldSetElement>) {
    const dataTransfer = event.dataTransfer;
    if (!isFileDrag(dataTransfer)) return;
    event.preventDefault();
    dataTransfer.dropEffect = disabled ? "none" : "copy";
    if (disabled) {
      dragDepth.current = 0;
      setDraggingFiles(false);
      return;
    }
    setDraggingFiles(true);
  }

  function handleDragLeave(event: DragEvent<HTMLFieldSetElement>) {
    if (!isFileDrag(event.dataTransfer)) return;
    if (disabled) {
      dragDepth.current = 0;
      setDraggingFiles(false);
      return;
    }
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDraggingFiles(false);
  }

  function handleDrop(event: DragEvent<HTMLFieldSetElement>) {
    const dataTransfer = event.dataTransfer;
    if (!isFileDrag(dataTransfer)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDraggingFiles(false);
    if (!disabled) void onAttachmentPick(dataTransfer.files);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const clipboardData = event.clipboardData;
    // Only intercept real FileList pastes; leave text-only / empty-files native.
    if (disabled || !clipboardData || !isFilePaste(clipboardData)) return;
    event.preventDefault();
    void onAttachmentPick(clipboardData.files);
    const text = clipboardData.getData("text/plain");
    if (!text) return;
    const textarea = event.currentTarget;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    updateDraft(`${draft.slice(0, start)}${text}${draft.slice(end)}`);
    const caret = start + text.length;
    window.requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(caret, caret);
    });
  }

  const showComposerPlaceholder =
    draft.length === 0 && selectedSkill === null && selectedMentions.length === 0;
  const replyName = replyTarget ? (replyTargetName ?? previewMessageText(replyTarget)) : "";
  const replyNameRef = useRef(replyName);
  replyNameRef.current = replyName;
  const announceTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(announceTimer.current), []);

  // Arming or retargeting a reply unmounts the control that started it, so
  // focus would drop to <body>; announce on start and when the target changes.
  // The timer lives in a ref: a same-id rerender (e.g. the display name
  // resolving after arming) must not cancel the pending announcement.
  useEffect(() => {
    const prev = prevReplyTarget.current;
    prevReplyTarget.current = replyTarget ?? null;
    if (!replyTarget) {
      // Cancel (or send) within the delay must not let a stale "Replying to"
      // overwrite the cancel announcement — kill the pending timer.
      window.clearTimeout(announceTimer.current);
      // A send disarms the reply without touching the region — drop the stale
      // "Replying to" so it cannot linger or re-announce. An explicit cancel
      // sets "Reply cancelled" in the same event, so only clear "reply" text.
      if (replyAnnouncementKind.current === "reply") {
        replyAnnouncementKind.current = null;
        setReplyAnnouncement("");
      }
      return;
    }
    if (!prev || prev.id !== replyTarget.id) {
      textareaRef.current?.focus();
      // Clear-then-set so a switch between same-author targets re-announces —
      // identical live-region text would otherwise be a no-op.
      setReplyAnnouncement("");
      replyAnnouncementKind.current = null;
      window.clearTimeout(announceTimer.current);
      announceTimer.current = window.setTimeout(() => {
        replyAnnouncementKind.current = "reply";
        setReplyAnnouncement(t`Replying to ${replyNameRef.current}`);
      }, 50);
    }
  }, [replyTarget, replyName, t]);

  return (
    <fieldset
      aria-label={t`Message composer`}
      data-dragging={draggingFiles ? "files" : undefined}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`relative z-30 m-0 min-w-0 border-0 px-3 pb-4 pt-3 md:px-6 md:pb-6 ${
        draggingFiles ? "rounded-[14px] ring-2 ring-inset ring-ring" : ""
      }`}
    >
      <div role="status" data-testid="composer-announcement" className="sr-only">
        {replyAnnouncement}
      </div>
      {sendError || runError ? (
        <div
          ref={runErrorRef}
          role="alert"
          data-testid="composer-error"
          className="mb-3 flex items-center gap-2 rounded-[14px] border border-destructive/40 bg-destructive/10 px-4 py-2 text-[13px] text-destructive"
        >
          <span className="min-w-0 flex-1">{sendError ?? runError}</span>
          <button
            type="button"
            aria-label={t`Dismiss error`}
            data-testid="composer-error-dismiss"
            onClick={() => {
              onDismissError();
              window.requestAnimationFrame(() => textareaRef.current?.focus());
            }}
            className="shrink-0 text-destructive hover:text-foreground"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      ) : null}
      {replyTarget ? (
        <div
          data-testid="reply-chip"
          className="mb-2 flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1.5 text-[13px] text-foreground/75"
        >
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {replyQuote
              ? t`Replying to ${replyName}: “${replyQuote}”`
              : t`Replying to ${replyName}`}
          </span>
          <button
            type="button"
            aria-label={t`Cancel reply`}
            onClick={() => {
              replyAnnouncementKind.current = "cancelled";
              // Kill a pending arm announce in this event — the effect's
              // cleanup can lag the timer, and a late "Replying to" would
              // then be cleared as stale, dropping the cancel announcement.
              window.clearTimeout(announceTimer.current);
              onClearReply?.();
              setReplyAnnouncement(t`Reply cancelled`);
              // The chip unmounts with this button — keep focus in the composer.
              textareaRef.current?.focus();
            }}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      ) : null}
      {attachmentNotice ? (
        <div className="mb-3 rounded-[14px] border border-warning/40 bg-warning/10 px-4 py-2 text-[13px] text-warning">
          {attachmentNotice}
        </div>
      ) : null}
      {pendingAttachments.length ? (
        <div className="mb-3 flex flex-wrap gap-2">
          {pendingAttachments.map((attachment) => (
            <div
              key={attachment.id}
              className="flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1.5 text-[13px] text-foreground/75"
            >
              {attachment.previewUrl ? (
                <img
                  src={attachment.previewUrl}
                  alt={attachment.file.name}
                  className="h-8 w-8 rounded object-cover"
                />
              ) : (
                <Paperclip size={14} strokeWidth={1.8} />
              )}
              <span className="max-w-[180px] truncate" dir="auto">
                {attachment.file.name}
              </span>
              <button
                type="button"
                aria-label={t`Remove ${attachment.file.name}`}
                onClick={() => onRemoveAttachment(attachment)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X size={13} strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {mentionPickerOpen ? (
        <div
          id={mentionListboxId}
          role="listbox"
          aria-label={t`Mentions`}
          data-testid="mention-picker"
          className="mb-2 overflow-hidden rounded-[14px] border border-border bg-muted"
        >
          {mentionOptions.map((mention, index) => {
            const optionId = `${mentionListboxId}-option-${index}`;
            const highlighted = index === activeMentionIndex;
            return (
              <button
                id={optionId}
                key={mentionChipKey(mention)}
                type="button"
                role="option"
                aria-selected={highlighted}
                aria-label={t`@${mention.name}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertMention(mention)}
                onMouseEnter={() => setMentionHighlightIndex(index)}
                className={`flex w-full items-start gap-3 px-4 py-2.5 text-start hover:bg-accent ${
                  highlighted ? "bg-accent" : ""
                }`}
              >
                <MentionOptionIcon mention={mention} />
                <span className="min-w-0">
                  <span dir="auto" className="block text-[14px] text-foreground">
                    @{mention.name}
                  </span>
                  {mention.subtitle ? (
                    <span dir="auto" className="block truncate text-[12.5px] text-muted-foreground">
                      {mention.subtitle}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      {showSlashPicker ? (
        <div
          data-testid="slash-picker"
          className="mb-2 overflow-hidden rounded-[14px] border border-border bg-muted"
        >
          {slashSkillOptions.map((skill) => (
            <button
              key={skill.id}
              type="button"
              aria-label={t`Skill ${skill.name}`}
              onClick={() => insertSkill(skill)}
              className="flex w-full items-start gap-3 px-4 py-2.5 text-start hover:bg-accent"
            >
              <Box size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span dir="auto" className="block text-[14px] text-foreground">
                  {skill.name}
                </span>
                <span dir="auto" className="block truncate text-[12.5px] text-muted-foreground">
                  {truncateSlashDescription(skill.description)}
                </span>
              </span>
            </button>
          ))}
          {slashActionOptions.map((action) => {
            const label = slashActionLabel(action.id);
            return (
              <button
                key={action.id}
                type="button"
                aria-label={label}
                onClick={() => runSlashAction(action.id)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-start hover:bg-accent"
              >
                <Settings size={16} strokeWidth={1.7} className="shrink-0 text-muted-foreground" />
                <span className="text-[14px] text-foreground">{label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      <div
        data-testid="composer-bar"
        className="flex items-center gap-3.5 rounded-full border border-border bg-background py-[9px] pe-2.5 ps-3 transition-colors focus-within:border-ring"
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          className="hidden"
          onChange={(event) => void onAttachmentPick(event.target.files)}
        />
        <Button
          variant="ghost"
          size="icon"
          aria-label={t`Attach file`}
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
          className="size-8 shrink-0 rounded-full border border-border bg-muted text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Plus size={16} strokeWidth={2} />
        </Button>
        <div className="flex min-w-0 flex-1 flex-wrap items-end gap-1.5">
          {selectedSkill ? (
            <span
              data-testid="skill-chip"
              className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-[13px] text-foreground"
            >
              <Box size={13} strokeWidth={1.7} className="shrink-0 text-muted-foreground/70" />
              <span dir="auto" className="truncate">
                {selectedSkill.name}
              </span>
              <button
                type="button"
                aria-label={t`Remove skill ${selectedSkill.name}`}
                onClick={() => setSelectedSkill(null)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X size={12} strokeWidth={2} />
              </button>
            </span>
          ) : null}
          {selectedMentions.map((mention) => (
            <span
              key={mentionChipKey(mention)}
              data-testid="mention-chip"
              data-mention-kind={mention.kind}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-[13px] text-foreground"
            >
              <MentionChipIcon mention={mention} />
              <span dir="auto" className="truncate">
                {mention.name}
              </span>
              <button
                type="button"
                aria-label={t`Remove mention ${mention.name}`}
                onClick={() => {
                  setSelectedMentions((current) =>
                    current.filter(
                      (selected) => mentionChipKey(selected) !== mentionChipKey(mention),
                    ),
                  );
                  setDraft((current) => stripMentionToken(current, mention.name));
                }}
                className="text-muted-foreground hover:text-foreground"
              >
                <X size={12} strokeWidth={2} />
              </button>
            </span>
          ))}
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => updateDraft(event.target.value)}
            onPaste={handlePaste}
            onKeyDown={(event) => {
              if (
                event.key === "Backspace" &&
                draft.length === 0 &&
                (selectedSkill !== null || selectedMentions.length > 0)
              ) {
                event.preventDefault();
                removeLastChip();
                return;
              }
              const action = resolveMentionPickerKey({
                key: event.key,
                shiftKey: event.shiftKey,
                isComposing: event.nativeEvent.isComposing || event.keyCode === 229,
                optionCount: mentionOptions.length,
                highlightedIndex: activeMentionIndex,
              });
              if (action.type === "complete") {
                const mention = mentionOptions[action.index];
                if (!mention) return;
                event.preventDefault();
                insertMention(mention);
                return;
              }
              if (action.type === "move") {
                event.preventDefault();
                setMentionHighlightIndex(action.index);
                return;
              }
              if (action.type === "dismiss") {
                event.preventDefault();
                setMentionQuery(null);
                setMentionHighlightIndex(0);
                return;
              }
              if (action.type === "send") {
                event.preventDefault();
                send();
              }
            }}
            disabled={disabled}
            placeholder={
              showComposerPlaceholder
                ? activeName
                  ? t`Message ${activeName}`
                  : t`Message…`
                : undefined
            }
            aria-label={activeName ? t`Message ${activeName}` : t`Message`}
            role="combobox"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-expanded={mentionPickerOpen}
            aria-controls={mentionPickerOpen ? mentionListboxId : undefined}
            aria-activedescendant={activeMentionOptionId}
            name="chat-message"
            autoComplete="off"
            dir="auto"
            rows={1}
            className="max-h-32 min-h-[24px] min-w-[8rem] flex-1 resize-none overflow-y-auto bg-transparent py-0.5 text-[15.5px] leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-40"
          />
        </div>
        {onVoice && draft.trim().length === 0 ? (
          <Button
            variant="outline"
            size="icon"
            aria-label={t`Voice`}
            title={t`Voice`}
            disabled={disabled}
            onClick={onVoice}
            className="size-8 shrink-0 rounded-full text-foreground/75"
          >
            <Mic size={16} strokeWidth={1.8} />
          </Button>
        ) : null}
        {running ? (
          <div className="flex items-center gap-1.5 shrink-0">
            <Button
              size="icon"
              aria-label={t`Send`}
              disabled={sending || !canSend || disabled}
              onClick={send}
              className="size-8 rounded-full bg-white text-black hover:bg-white/90 shadow-sm transition-transform active:scale-95"
            >
              <ArrowUp size={16} strokeWidth={2.2} />
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label={t`Stop`}
              disabled={sending}
              onClick={() => void onStop()}
              className="size-8 rounded-full border border-border bg-muted text-foreground/80 shadow-sm transition-colors hover:bg-accent hover:text-foreground"
            >
              <Square size={11} strokeWidth={0} fill="currentColor" />
            </Button>
          </div>
        ) : (
          <Button
            size="icon"
            aria-label={t`Send`}
            disabled={sending || !canSend || disabled}
            onClick={send}
            className="size-8 shrink-0 rounded-full bg-white text-black hover:bg-white/90 shadow-sm transition-transform active:scale-95 disabled:bg-white/10 disabled:text-muted-foreground/30 disabled:shadow-none"
          >
            <ArrowUp size={16} strokeWidth={2.2} />
          </Button>
        )}
      </div>
    </fieldset>
  );
});

function slashActionLabel(id: SlashActionId) {
  switch (id) {
    case "chat-settings":
      return t`Chat Settings`;
    case "settings-general":
      return t`Settings: General`;
    case "settings-usage":
      return t`Settings: Usage`;
  }
}

function MentionOptionIcon({ mention }: { mention: ComposerMention }) {
  if (mention.kind === "routine") {
    return <Clock size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-muted-foreground" />;
  }
  if (mention.kind === "connector") {
    return <Puzzle size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-muted-foreground" />;
  }
  if (mention.kind === "group") {
    return (
      <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-accent text-[9px] text-foreground/75">
        G
      </span>
    );
  }
  if (mention.kind === "everyone") {
    return (
      <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-accent text-[9px] text-foreground/75">
        @
      </span>
    );
  }
  return <BotAvatar color={mention.color ?? FALLBACK_BOT_COLOR} identity={mention.id} size={16} />;
}

function MentionChipIcon({ mention }: { mention: ComposerMention }) {
  if (mention.kind === "routine") {
    return <Clock size={13} strokeWidth={1.7} className="shrink-0 text-muted-foreground/70" />;
  }
  if (mention.kind === "connector") {
    return <Puzzle size={13} strokeWidth={1.7} className="shrink-0 text-muted-foreground/70" />;
  }
  if (mention.kind === "group" || mention.kind === "everyone") {
    return (
      <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-accent text-[9px] text-foreground/75">
        {mention.kind === "group" ? "G" : "@"}
      </span>
    );
  }
  return <BotAvatar color={mention.color ?? FALLBACK_BOT_COLOR} identity={mention.id} size={16} />;
}

function previewMessageText(message: ThreadMessage): string {
  const text = message.blocks
    .map((block) => {
      if (block.kind === "channel_message") return block.text;
      if (block.kind === "text") {
        // Bot text is Markdown; user text is already plain.
        return message.role === "bot" ? plainTextFromMarkdown(block.text) : block.text;
      }
      return "";
    })
    .filter(Boolean)
    .join(" ")
    .trim();
  if (text) return text;
  if (message.blocks.some((block) => block.kind === "image" || block.kind === "file")) {
    return t`Attachment`;
  }
  return t`Message`;
}

/** Bound reply excerpts used in accessible names (visible UI truncates via CSS). */
function accessibleReplyExcerpt(text: string, max = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  // Reserve a slot for the ellipsis; never split a surrogate pair at the cut.
  const end = (normalized.charCodeAt(max - 2) & 0xfc00) === 0xd800 ? max - 2 : max - 1;
  return `${normalized.slice(0, end).trimEnd()}…`;
}

function formatRosterTime(isoDate?: string | null): string {
  if (!isoDate) return "";
  try {
    const d = new Date(isoDate);
    if (Number.isNaN(d.getTime())) return "";
    const locale = i18n.locale || "en";
    const now = new Date();
    const isToday =
      d.getDate() === now.getDate() &&
      d.getMonth() === now.getMonth() &&
      d.getFullYear() === now.getFullYear();
    if (isToday) {
      return d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
    }
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday =
      d.getDate() === yesterday.getDate() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getFullYear() === yesterday.getFullYear();
    if (isYesterday) return t`Yesterday`;
    const diffDays = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays < 7) {
      return d.toLocaleDateString(locale, { weekday: "short" });
    }
    return d.toLocaleDateString(locale, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function MessageHoverActions({
  message,
  side,
  onReply,
  onReact,
}: {
  message: ThreadMessage;
  side: "start" | "end";
  onReply: (message: ThreadMessage) => void;
  onReact: (message: ThreadMessage, reaction: MessageReaction) => Promise<void>;
}) {
  const { t } = useLingui();
  const [moreOpen, setMoreOpen] = useState(false);
  const [reactionsOpen, setReactionsOpen] = useState(false);

  // Streaming progress bubbles keep hover free for selection / stop clicks.
  if (message.id.startsWith("progress:")) return null;

  function copyMessage() {
    const text = copyableMessageText(message);
    if (!text || !navigator.clipboard) return;
    void navigator.clipboard.writeText(text).catch(() => undefined);
  }

  const iconButtonClass =
    "grid h-7 w-7 place-items-center text-muted-foreground transition-colors hover:text-foreground";

  return (
    <MessageHoverMetadata pinned={moreOpen || reactionsOpen} side={side}>
      <div data-testid="message-hover-actions" className="flex items-center gap-0.5">
        {canReactToThreadMessage(message) ? (
          <Popover open={reactionsOpen} onOpenChange={setReactionsOpen}>
            <PopoverTrigger
              aria-label={t`React`}
              className={cn(
                iconButtonClass,
                "h-11 w-11 [@media(hover:hover)_and_(pointer:fine)]:h-7 [@media(hover:hover)_and_(pointer:fine)]:w-7",
              )}
            >
              <Smile size={15} strokeWidth={1.7} />
            </PopoverTrigger>
            <PopoverContent
              align={side === "end" ? "start" : "end"}
              className="w-auto flex-row gap-0 rounded-2xl p-1.5"
              aria-label={t`Reactions`}
            >
              {MESSAGE_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={emoji}
                  className="grid h-11 w-11 place-items-center rounded-xl text-2xl hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => {
                    setReactionsOpen(false);
                    void onReact(message, emoji);
                  }}
                >
                  {emoji}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        ) : null}
        <button
          type="button"
          aria-label={t`Reply`}
          onClick={() => onReply(message)}
          className={cn(
            iconButtonClass,
            "h-11 w-11 [@media(hover:hover)_and_(pointer:fine)]:h-7 [@media(hover:hover)_and_(pointer:fine)]:w-7",
          )}
        >
          <Reply size={15} strokeWidth={1.7} />
        </button>
        <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
          <DropdownMenuTrigger
            aria-label={t`More`}
            className={cn(
              iconButtonClass,
              "h-11 w-11 [@media(hover:hover)_and_(pointer:fine)]:h-7 [@media(hover:hover)_and_(pointer:fine)]:w-7",
            )}
          >
            <MoreHorizontal size={15} strokeWidth={1.7} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align={side === "end" ? "start" : "end"}>
            <DropdownMenuItem onClick={copyMessage}>
              <Copy size={14} strokeWidth={1.7} />
              <Trans>Copy</Trans>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </MessageHoverMetadata>
  );
}

function firstThreadRoute(
  bots: readonly Pick<Bot, "id">[],
  groups: readonly Pick<Group, "id">[],
): string {
  if (bots[0]) return `/app/${bots[0].id}`;
  if (groups[0]) return `/app/g/${groups[0].id}`;
  return "/app";
}

function applyThreadEvent(
  event: ProductEvent,
  commitSnapshot: (next: ThreadSnapshot | null) => void,
  commitComputer: (next: ComputerStatus | null) => void,
  snapshotRef: MutableRefObject<ThreadSnapshot | null>,
  computerRef: MutableRefObject<ComputerStatus | null>,
  botsRef?: MutableRefObject<Array<{ id: string; name: string }>>,
) {
  publishComputerCommand(event);
  if (isThreadSnapshotEvent(event)) {
    // Activity labels name real bots; resolve ids from the group members and
    // the roster so live reduction matches the server-side replay.
    const botNames: Record<string, string> = {};
    for (const member of snapshotRef.current?.members ?? []) {
      if (member.botId && member.name) botNames[member.botId] = member.name;
    }
    for (const bot of botsRef?.current ?? []) botNames[bot.id] = bot.name;
    const next = reduceThreadSnapshot(snapshotRef.current, event, { botNames });
    commitSnapshot(next);
  }
  if (isComputerStatusEvent(event)) {
    const next = reduceComputerStatus(computerRef.current, event);
    commitComputer(next);
  }
}

function ComputerReleaseActions({
  takeoverRequested,
  onRelease,
}: {
  takeoverRequested: boolean;
  onRelease: (reason?: ComputerReleaseReason) => Promise<void>;
}) {
  if (!takeoverRequested) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => void onRelease()}>
        <Trans>Release</Trans>
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" size="sm" onClick={() => void onRelease("skipped")}>
        <Trans>Skip</Trans>
      </Button>
      <Button type="button" size="sm" onClick={() => void onRelease("done")}>
        <Trans>I’m done</Trans>
      </Button>
    </div>
  );
}

function AvatarChangeCard({
  botId,
  changeId,
  before,
  after,
  onChanged,
}: {
  botId: string | null;
  changeId: string;
  before: string;
  after: string;
  onChanged: () => Promise<void>;
}) {
  const [canUndo, setCanUndo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!botId) return;
    let active = true;
    let request = 0;
    const refresh = () => {
      const current = ++request;
      void rpc.bots
        .avatarChanges({ botId })
        .then((changes) => {
          if (active && current === request)
            setCanUndo(changes[0]?.id === changeId && changes[0]?.undoneAt == null);
        })
        .catch(() => undefined);
    };
    refresh();
    window.addEventListener("workpal:avatar-refresh", refresh);
    return () => {
      active = false;
      window.removeEventListener("workpal:avatar-refresh", refresh);
    };
  }, [botId, changeId]);
  return (
    <div
      className="w-[min(380px,90%)] rounded-[18px] border border-border bg-muted px-[18px] py-3 text-[14px]"
      role="status"
    >
      <div className="font-medium">
        <Trans>Avatar updated</Trans>
      </div>
      <div className="mt-1 text-muted-foreground">
        {before} → {after}
      </div>
      {canUndo ? (
        <button
          type="button"
          disabled={busy}
          className="mt-2 font-medium text-primary disabled:opacity-50"
          onClick={() => {
            setBusy(true);
            void rpc.bots
              .undoAvatarChange({ changeId })
              .then(async () => {
                setCanUndo(false);
                window.dispatchEvent(new Event("workpal:avatar-refresh"));
                await onChanged();
              })
              .catch((cause) =>
                setError(cause instanceof Error ? cause.message : "Could not undo avatar change"),
              )
              .finally(() => setBusy(false));
          }}
        >
          <Trans>Undo</Trans>
        </button>
      ) : null}
      {error ? (
        <div role="alert" className="mt-2 text-destructive">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function GroupReceiptNavigation({
  block,
  botName,
}: {
  block: CollaborationReceiptBlock;
  botName: string;
}) {
  const navigate = useNavigate();
  return (
    <GroupDestinationReceipt
      block={block}
      botName={botName}
      onOpen={({ groupId, messageId }) =>
        navigate({
          pathname: `/app/g/${groupId}`,
          search: `?m=${encodeURIComponent(messageId)}`,
        })
      }
    />
  );
}

/** A bot bubble text taller than this (the card fold cap, max-h-40) is long. */
const LONG_MARKDOWN_HEIGHT_PX = 160;

/**
 * Reports the natural rendered height of an in-bubble bot text so the parent
 * can decide whether the text becomes a folded markdown display card. A
 * ResizeObserver re-reports on reflow, so narrow viewports that wrap a
 * single paragraph into a tall column are covered.
 */
function MeasuredBotText({
  text,
  blockId,
  onMeasure,
}: {
  text: string;
  blockId: string;
  onMeasure: (blockId: string, height: number) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => onMeasure(blockId, el.scrollHeight);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [blockId, onMeasure]);
  return (
    <div ref={ref}>
      <ChatMarkdown>{text}</ChatMarkdown>
    </div>
  );
}

const MessageView = memo(function MessageView({
  artifactTarget,
  canAnswer,
  suppressAsk = false,
  message,
  blocks,
  displayBlocks,
  markdownCandidates,
  onMarkdownMeasure,
  onAnswer,
  onOpenBot,
  speakerName,
  memberName,
  peerBot,
  botNameOf,
  replyPreview,
  replyToMessageId,
  onJumpToMessage,
  onRefresh,
  onBotChanged,
  onAddRoutine,
  voiceReady,
  speaking,
  onSpeak,
  onOpenComputer,
  showToolActivity,
}: {
  artifactTarget: ArtifactTarget;
  canAnswer: boolean;
  suppressAsk?: boolean;
  message: ThreadMessage;
  /** Parent-filtered blocks; defaults to the message's own blocks. */
  blocks?: ThreadMessage["blocks"];
  /** CARD-01C display projection for this message, after legacy suppression. */
  displayBlocks?: ThreadSnapshot["displayBlocks"];
  /** CARD-01C markdown candidates whose source text still renders in-bubble. */
  markdownCandidates?: ThreadSnapshot["displayBlocks"];
  onMarkdownMeasure?: (blockId: string, height: number) => void;
  onAnswer: (message: ThreadMessage, text: string, username?: string) => Promise<void>;
  onOpenBot: (botId: string) => void;
  speakerName?: string;
  memberName?: (botId: string | undefined) => string | undefined;
  peerBot: (botId: string) => { color: string; status?: string } | undefined;
  botNameOf?: (botId: string) => string | undefined;
  replyPreview?: ThreadMessage;
  replyToMessageId?: string;
  onJumpToMessage?: (messageId: string) => void;
  onRefresh: () => Promise<void>;
  onBotChanged: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
  voiceReady: boolean;
  speaking: boolean;
  onSpeak: () => void;
  onOpenComputer: (botId?: string) => void;
  showToolActivity: boolean;
}) {
  const { t } = useLingui();
  const messageBlocks = blocks ?? message.blocks;
  const isNarration =
    message.role === "bot" &&
    messageBlocks.length > 0 &&
    messageBlocks.every(
      (block) => block.kind === "text" || block.kind === "progress" || block.kind === "steps",
    );
  const isLive = message.id.startsWith("progress:");
  const quoteMessageId = message.id.includes(":") ? undefined : message.id;
  const visibleNarrationBlocks = renderableMessageBlocks(messageBlocks, showToolActivity);
  const parentJumpId = replyPreview?.id ?? replyToMessageId;
  const speakerBot = message.botId ? peerBot?.(message.botId) : undefined;
  const speakerColorDef = useMemo(
    () => resolvePersonaColorDef(message.botId ?? "bot", speakerBot?.color),
    [message.botId, speakerBot?.color],
  );
  const messageContext = (
    <>
      {speakerName ? (
        <div
          className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold tracking-tight"
          dir="auto"
          style={{ color: speakerColorDef.light }}
        >
          <BotAvatar
            color={speakerBot?.color ?? FALLBACK_BOT_COLOR}
            identity={message.botId}
            size={22}
          />
          {speakerName}
        </div>
      ) : null}
      {parentJumpId ? (
        <button
          type="button"
          data-testid="reply-parent-preview"
          // Name the action and a short excerpt; a bare action label would
          // hide the quote, and an unbounded quote can be thousands of chars.
          aria-label={
            message.replyQuote
              ? t`Jump to replied message: “${accessibleReplyExcerpt(message.replyQuote)}”`
              : replyPreview
                ? t`Jump to replied message: ${accessibleReplyExcerpt(previewMessageText(replyPreview))}`
                : t`Jump to replied message`
          }
          onClick={() => onJumpToMessage?.(parentJumpId)}
          className="mb-2 block max-w-[74%] truncate rounded-[14px] border border-border bg-background px-3 py-2 text-start text-[12.5px] text-muted-foreground hover:border-border hover:text-foreground/75"
          dir="auto"
        >
          {message.replyQuote
            ? `“${message.replyQuote}”`
            : replyPreview
              ? previewMessageText(replyPreview)
              : t`Earlier message`}
        </button>
      ) : null}
    </>
  );
  if (isNarration) {
    if (visibleNarrationBlocks.length === 0) {
      // Every narration block was suppressed (tool activity hidden and the
      // remaining text became its markdown card). Keep the projected cards
      // instead of dropping the message entirely.
      if (!displayBlocks?.length) return null;
      return (
        <>
          {messageContext}
          <div className="mt-2">
            <DisplayBlockList blocks={displayBlocks} target={artifactTarget} />
          </div>
        </>
      );
    }
    if (isToolOnlyNarration(messageBlocks, showToolActivity)) {
      return (
        <>
          {messageContext}
          <ToolOnlyNarration blocks={visibleNarrationBlocks} live={isLive} />
          {displayBlocks?.length ? (
            <div className="mt-2">
              <DisplayBlockList blocks={displayBlocks} target={artifactTarget} />
            </div>
          ) : null}
        </>
      );
    }
    return (
      <>
        {messageContext}
        <div className="flex w-fit max-w-full items-start justify-start gap-2 [@media(hover:none)]:w-full">
          {!speakerName && message.botId ? (
            <BotAvatar
              color={speakerBot?.color ?? FALLBACK_BOT_COLOR}
              identity={message.botId}
              size={32}
            />
          ) : null}
          <div
            data-testid="message-bot-bubble"
            className="max-w-full space-y-2.5 rounded-[20px] bg-muted px-[18px] py-3 text-[15.5px] leading-[1.5] text-foreground/90"
            dir="auto"
          >
            {visibleNarrationBlocks.map((block, i) => {
              if (block.kind === "steps") {
                return (
                  <ToolActivityDisclosure
                    key={i}
                    live={isLive}
                    stepCount={toolStepCount(block.steps)}
                    durationMs={block.durationMs}
                  >
                    <ToolSteps
                      steps={block.steps}
                      currentIndex={isLive ? block.steps.length - 1 : undefined}
                      limit={isLive ? LIVE_TOOL_STEP_WINDOW : undefined}
                    />
                  </ToolActivityDisclosure>
                );
              }
              if (block.kind === "text" || block.kind === "progress") {
                const markdownCandidate =
                  block.kind === "text"
                    ? (markdownCandidates ?? []).find(
                        (candidate) =>
                          candidate.kind === "markdown" && candidate.text === block.text,
                      )
                    : undefined;
                return (
                  <div
                    key={i}
                    data-quote-message-id={block.kind === "text" ? quoteMessageId : undefined}
                  >
                    {markdownCandidate && onMarkdownMeasure ? (
                      <MeasuredBotText
                        text={block.text}
                        blockId={markdownCandidate.blockId}
                        onMeasure={onMarkdownMeasure}
                      />
                    ) : (
                      <ChatMarkdown streaming={block.kind === "progress"}>
                        {block.text}
                      </ChatMarkdown>
                    )}
                  </div>
                );
              }
              return null;
            })}
            {!isLive && voiceReady && messageBlocks.some((block) => block.kind === "text") ? (
              <button
                type="button"
                aria-label={speaking ? t`Stop speaking` : t`Speak this reply`}
                onClick={onSpeak}
                className="text-[12px] text-muted-foreground hover:text-foreground"
              >
                {speaking ? <Trans>Stop</Trans> : <Trans>Speak</Trans>}
              </button>
            ) : null}
          </div>
        </div>
        {displayBlocks?.length ? (
          <div className="mt-2">
            <DisplayBlockList blocks={displayBlocks} target={artifactTarget} />
          </div>
        ) : null}
      </>
    );
  }
  return (
    <>
      {messageContext}
      {messageBlocks.map((block, i) => {
        if (block.kind === "steps" && shouldRenderToolCard(block, showToolActivity)) {
          return (
            <StandaloneToolActivity
              key={i}
              live={isLive}
              steps={block.steps}
              stepCount={toolStepCount(block.steps)}
              durationMs={block.durationMs}
            />
          );
        }
        if (isToolActivityBlock(block)) return null;
        if (block.kind === "handoff") {
          const from = memberName?.(block.fromBotId) ?? t`bot`;
          const to = memberName?.(block.toBotId) ?? t`bot`;
          return (
            <div
              key={i}
              className="flex items-center justify-center gap-2 py-1 text-[13.5px] text-muted-foreground"
            >
              <span>
                ↪ {to} ← {from}
              </span>
              <span>{block.text}</span>
            </div>
          );
        }
        if (block.kind === "collaboration_receipt") {
          // Bot-target receipts render through PeerReceiptRow before this
          // message view; group receipts keep the destination card below.
          if (block.target.kind === "bot") return null;
          if ("groupId" in artifactTarget) return null;
          return (
            <GroupReceiptNavigation
              key={i}
              block={block}
              botName={message.botId ? (botNameOf?.(message.botId) ?? t`Bot`) : t`Bot`}
            />
          );
        }
        if (block.kind === "bot_message_sent" || block.kind === "bot_message_received") {
          // Legacy source receipts are grouped into the lightweight row before
          // this view. Pair-side bodies never reach a human transcript here.
          return null;
        }
        if (block.kind === "channel_message") {
          return (
            <div
              key={i}
              className="flex items-center justify-center gap-2 py-1 text-[13.5px] text-muted-foreground"
            >
              <span>
                {messageProviderLabel(block.provider, block.transport)} · {block.fromLabel}:{" "}
                {block.text}
              </span>
            </div>
          );
        }
        if (block.kind === "meta") {
          return (
            <div
              key={i}
              className="flex items-center justify-center gap-2 py-1 text-[13.5px] text-muted-foreground"
            >
              <span className="text-warning">◷</span>
              <span>{block.text}</span>
            </div>
          );
        }
        if (block.kind === "progress") {
          return (
            <div
              key={i}
              className="flex w-fit max-w-full justify-start [@media(hover:none)]:w-full"
            >
              <div
                data-testid="message-bot-bubble"
                className="max-w-full rounded-[20px] bg-muted px-[18px] py-3 text-[15.5px] leading-[1.5] text-foreground/90"
                dir="auto"
              >
                <ChatMarkdown streaming>{block.text}</ChatMarkdown>
              </div>
            </div>
          );
        }
        if (block.kind === "subagent") {
          const running = block.status === "running";
          const failed = block.status === "failed";
          const statusLabel = running
            ? t`Working`
            : block.status === "completed"
              ? t`Done`
              : failed
                ? t`Could not finish`
                : t`Cancelled`;
          return (
            <div
              key={i}
              data-subagent-status={block.status}
              className="w-[min(420px,90%)] rounded-[18px] border border-border bg-muted px-[18px] py-4"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-[15px] font-medium text-foreground" dir="auto">
                  {block.name}
                </span>
                <span
                  className={`rounded-full px-[11px] py-1 text-[13px] ${
                    failed
                      ? "bg-warning/15 text-warning"
                      : running
                        ? "bg-foreground/5 text-foreground"
                        : block.status === "completed"
                          ? "bg-success/15 text-success"
                          : "bg-muted text-muted-foreground"
                  }`}
                >
                  {statusLabel}
                </span>
              </div>
              <div className="mt-2 text-[13.5px] text-muted-foreground">{block.task}</div>
              {block.progress || block.result ? (
                <div className="mt-2.5 text-[14.5px] leading-[1.5] text-foreground/75">
                  <ChatMarkdown streaming={running}>
                    {block.result || block.progress || ""}
                  </ChatMarkdown>
                </div>
              ) : null}
            </div>
          );
        }
        if (block.kind === "child_bot") {
          const removed = block.status === "deleted" || block.status === "archived";
          return (
            <button
              key={i}
              type="button"
              disabled={removed}
              onClick={() => onOpenBot(block.botId)}
              className="w-[min(340px,90%)] rounded-[18px] border border-border bg-muted px-[18px] py-4 text-start disabled:opacity-60"
            >
              <div className="flex items-center justify-between">
                <span className="text-[15px] font-medium text-foreground" dir="auto">
                  {block.name}
                </span>
                <span
                  className={`rounded-full px-[11px] py-1 text-[13px] ${
                    removed ? "bg-destructive/15 text-destructive" : "bg-success/15 text-success"
                  }`}
                >
                  {block.status === "archived" ? (
                    <Trans>archived</Trans>
                  ) : block.status === "deleted" ? (
                    <Trans>deleted</Trans>
                  ) : (
                    <Trans>bot</Trans>
                  )}
                </span>
              </div>
              <div className="mt-2 text-[14.5px] leading-[1.5] text-foreground/75" dir="auto">
                {removed
                  ? block.status === "archived"
                    ? t`Archived. Chat, memory, and files kept.`
                    : t`Removed with chat, computer, and memory.`
                  : block.title || t`Opened its thread.`}
              </div>
            </button>
          );
        }
        if (block.kind === "avatar_change") {
          return (
            <AvatarChangeCard
              key={i}
              botId={message.botId ?? null}
              changeId={block.changeId}
              before={
                (block.beforeCharacter
                  ? `${block.beforeCharacter} · ${block.beforeBodyColor ?? "ink"}`
                  : null) ??
                (block.beforeMode === "upload" ? t`Uploaded image` : t`Previous avatar`)
              }
              after={
                block.afterCharacter
                  ? `${block.afterCharacter} · ${block.afterBodyColor ?? "ink"}`
                  : t`Uploaded image`
              }
              onChanged={onBotChanged}
            />
          );
        }
        if (block.kind === "group_membership_failure") {
          return (
            <div key={i} className="flex justify-start py-1">
              <GroupMembershipFailureCard
                botName={message.botId ? (botNameOf?.(message.botId) ?? t`Bot`) : t`Bot`}
                groupName={block.groupName}
              />
            </div>
          );
        }
        if (block.kind === "choice") {
          const botId = "botId" in artifactTarget ? artifactTarget.botId : message.botId;
          if (!botId) return null;
          return <ChoiceCard key={i} botId={botId} block={block} onBotChanged={onBotChanged} />;
        }
        if (block.kind === "app_connect") {
          const botId = "botId" in artifactTarget ? artifactTarget.botId : message.botId;
          if (!botId) return null;
          return (
            <div key={i} className="flex justify-start py-1">
              <AppConnectCard botId={botId} block={block} />
            </div>
          );
        }
        if (block.kind === "chart") {
          return (
            <div key={i} className="flex justify-start">
              <ChartBlockView name={block.name} spec={block.spec} data={block.data} />
            </div>
          );
        }
        if (block.kind === "mcp_approval") {
          const botId = "botId" in artifactTarget ? artifactTarget.botId : message.botId;
          if (!botId) return null;
          return (
            <div key={i} className="flex justify-start">
              <McpApprovalCard botId={botId} threadId={message.threadId} block={block} />
            </div>
          );
        }
        if (block.kind === "image") {
          return (
            <div
              key={i}
              className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <ArtifactImage
                target={artifactTarget}
                artifactId={block.artifactId}
                name={block.name}
              />
            </div>
          );
        }
        if (block.kind === "file") {
          return (
            <div
              key={i}
              className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <ArtifactFileCard
                target={artifactTarget}
                artifactId={block.artifactId}
                name={block.name}
                mimeType={block.mimeType}
                size={block.size}
              />
            </div>
          );
        }
        if (block.kind === "text" && message.role === "user") {
          // User bubbles stay literal text on web and mobile. Only structured
          // mention inlines and explicit URLs are links; a bare `@name` is
          // never promoted to identity.
          return (
            <div key={i} className="flex w-fit max-w-full justify-end [@media(hover:none)]:w-full">
              <div
                data-testid="message-user-bubble"
                data-quote-message-id={quoteMessageId}
                className="max-w-full whitespace-pre-wrap wrap-anywhere rounded-[20px] bg-chat-user px-[18px] py-3 text-[15.5px] leading-[1.45] text-chat-user-foreground"
                dir="auto"
              >
                <MessageText
                  text={block.text}
                  inlines={block.inlines}
                  resolveMention={(mentionedBotId) => {
                    const name = botNameOf?.(mentionedBotId);
                    if (!name) return undefined;
                    return {
                      name,
                      color: peerBot(mentionedBotId)?.color ?? FALLBACK_BOT_COLOR,
                      available: true,
                    };
                  }}
                  onOpenMention={onOpenBot}
                />
              </div>
            </div>
          );
        }
        if (block.kind === "text") {
          const markdownCandidate = (markdownCandidates ?? []).find(
            (candidate) => candidate.kind === "markdown" && candidate.text === block.text,
          );
          const markdownNode = markdownCandidate && onMarkdownMeasure ? (
            <MeasuredBotText
              key={markdownCandidate.blockId}
              text={block.text}
              blockId={markdownCandidate.blockId}
              onMeasure={onMarkdownMeasure}
            />
          ) : (
            <ChatMarkdown key={`md-${i}`}>{block.text}</ChatMarkdown>
          );
          return (
            <div
              key={i}
              className="flex w-fit max-w-full justify-start [@media(hover:none)]:w-full"
            >
              <div
                data-testid="message-bot-bubble"
                className="max-w-full rounded-[20px] bg-muted px-[18px] py-3 text-[15.5px] leading-[1.5] text-foreground/90"
                dir="auto"
              >
                <div data-quote-message-id={quoteMessageId}>{markdownNode}</div>
                {voiceReady ? (
                  <button
                    type="button"
                    aria-label={speaking ? t`Stop speaking` : t`Speak this reply`}
                    onClick={onSpeak}
                    className="mt-2 text-[12px] text-muted-foreground hover:text-foreground"
                  >
                    {speaking ? <Trans>Stop</Trans> : <Trans>Speak</Trans>}
                  </button>
                ) : null}
              </div>
            </div>
          );
        }
        if (block.kind === "card") {
          return (
            <div key={i} className="flex justify-start">
              <div className="flex flex-col gap-2 rounded-[20px] bg-muted px-5 py-4">
                {block.lines.map((line) => (
                  <div key={line.k} className="flex items-baseline gap-2.5 text-[15px]">
                    <span className="text-success">✓</span>
                    <span className="font-semibold text-white">{line.k}</span>
                    <span className="text-muted-foreground">→</span>
                    <span>{line.v}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        }
        if (block.kind === "ask") {
          if (suppressAsk) return null;
          return (
            <AskCard
              key={i}
              block={block}
              canAnswer={canAnswer}
              draftKey={
                block.input === "secret"
                  ? undefined
                  : message.runId
                    ? askDraftKey(message.runId, message.id)
                    : undefined
              }
              onAnswer={(text, username) => onAnswer(message, text, username)}
            />
          );
        }
        if (block.kind === "cloud_agent") return <CloudAgentCard key={i} block={block} />;
        if (block.kind === "skill_draft") {
          return (
            <div key={i} className="flex justify-start">
              <SkillDraftCard block={block} onRefresh={onRefresh} onAddRoutine={onAddRoutine} />
            </div>
          );
        }
        if (block.kind === "computer") {
          return (
            <div
              key={i}
              data-testid="computer-card"
              className="w-[340px] rounded-[18px] border border-border bg-muted px-[18px] py-4"
            >
              <div className="flex items-center justify-between">
                <span className="text-[15px] font-medium text-foreground">
                  <Trans>Computer</Trans>
                </span>
                <span
                  className={
                    block.state === "Needs you"
                      ? "rounded-full bg-warning/15 px-[11px] py-1 text-[13px] text-warning"
                      : "rounded-full bg-success/15 px-[11px] py-1 text-[13px] text-success"
                  }
                >
                  {block.state}
                </span>
              </div>
              <div className="my-2.5 text-[14.5px] leading-[1.5] text-foreground/75">
                <ChatMarkdown>{block.text}</ChatMarkdown>
              </div>
              <Button
                type="button"
                size="sm"
                data-testid="computer-card-open"
                onClick={() => onOpenComputer(message.botId)}
              >
                <Trans>Open</Trans>
              </Button>
            </div>
          );
        }
        return null;
      })}
      {displayBlocks?.length ? (
        <div className="mt-2">
          <DisplayBlockList blocks={displayBlocks} target={artifactTarget} />
        </div>
      ) : null}
    </>
  );
});

function DesktopKindEmptyState({ className }: { className?: string }) {
  return (
    <div className={className}>
      <Trans>
        This bot runs on this computer, not a Linux desktop. Shell and files use your home folder.
      </Trans>
    </div>
  );
}

function computerPlaceholder(
  state: ComputerStatus["state"] | undefined,
  booting: boolean,
  label: string,
) {
  if (state === "booting" || booting) return t`Booting live desktop…`;
  if (state === "running") return label;
  if (state === "suspended") return t`Computer is asleep. Open it to wake.`;
  if (state === "error") return t`Computer failed to boot`;
  return t`Computer is stopped`;
}

function computerLabel(mode: ComputerStatus["mode"] | undefined, botName: string) {
  return mode === "dedicated" ? t`${botName}’s computer` : t`Team Computer`;
}

function newClientNonce(): string {
  return newClientId();
}
