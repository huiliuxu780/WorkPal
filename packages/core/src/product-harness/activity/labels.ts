/**
 * Product Harness Phase 4 — canonical activity labels (§29/§30).
 *
 * One vocabulary for every surface: thread inline activity, tool disclosure,
 * background cards and the sidebar. Runtime internals (plan_enter,
 * agent_spawn, task_output, raw event names) must never reach users; the
 * projector is the only place that translates them, using these labels.
 */

/** Tool names → action language (§10). Unknown tools get a plain-human fallback. */
const TOOL_ACTION_LABELS: Readonly<Record<string, string>> = {
  read_file: "Reading file",
  list_files: "Checking files",
  write_file: "Updating file",
  attach_file: "Attaching file",
  shell: "Running command",
  open_path: "Opening file",
  launch_app: "Launching app",
  web_search: "Searching the web",
  web_fetch: "Fetching page",
  browser_navigate: "Opening page",
  browser_snapshot: "Inspecting page",
  browser_act: "Using the browser",
  computer_observe: "Checking the screen",
  computer_act: "Using the computer",
  render_plot: "Drawing chart",
  remember: "Saving note",
  send_email: "Sending email",
  message_user: "Posting update",
  ask_user: "Asking you",
  request_takeover: "Handing you the screen",
  request_secret: "Requesting a secret",
  add_mcp_server: "Connecting a service",
  runtime_current_time: "Checking the time",
  run_subagent: "Delegating to a helper",
};

export function toolActionLabel(toolName: string): string {
  const mapped = TOOL_ACTION_LABELS[toolName];
  if (mapped) return mapped;
  // Never leak raw identifiers verbatim when we can avoid it: unknown tools
  // still render as plain words, not snake_case internals.
  const words = toolName.replace(/[_-]+/g, " ").trim();
  if (!words) return "Working";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const activityLabels = {
  working: "Working",
  starting: "Starting",
  finishing: "Finishing up",
  planning: "Planning",
  readyToExecute: "Ready to execute",
  waitingApproval: "Waiting for approval",
  waitingInput: "Waiting for your answer",
  needsInput: "Needs your input",
  needsTakeover: "Needs you to take over",
  researching: "Researching",
  workingInBackground: "Working in background",
  backgroundCompleted: "Background task completed",
  backgroundFailed: "Background research failed",
  backgroundCancelled: "Background task cancelled",
  completed: "Completed",
  failed: "Stopped with an error",
  cancelled: "Cancelled",
  doneSummary: "Done",
  actionsSuffix: "actions",
  actionSuffix: "action",
  earlier: "earlier",
} as const;

export function askedForHelpLabel(botName: string): string {
  return `Asked ${botName} for help`;
}

export function askedQuestionLabel(botName: string): string {
  return `Asked ${botName} a question`;
}

export function isWorkingLabel(botName: string): string {
  return `${botName} is working`;
}

export function returnedResultLabel(botName: string): string {
  return `${botName} returned a result`;
}

export function couldNotCompleteLabel(botName: string): string {
  return `${botName} couldn't complete the request`;
}

export function handedToLabel(botName: string): string {
  return `Handed this to ${botName}`;
}

/**
 * Translate a runtime `thread.progress` activity text into product language,
 * or null when the text must not surface (thinking hints, raw tool state).
 */
export function planProgressLabel(progressText: string): string | null {
  const text = progressText.trim();
  if (text === "plan_enter" || text === "plan_write") return activityLabels.planning;
  if (text === "plan_exit") return activityLabels.readyToExecute;
  if (/waiting for approval$/i.test(text)) return activityLabels.waitingApproval;
  return null;
}
