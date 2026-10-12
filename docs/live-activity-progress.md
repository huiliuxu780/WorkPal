# Task 05 current and recent Activity

The Shell consumes the existing Phase 4 `ActivityItem` projection and does not build a second event reducer.

## Implemented

- A same-Run selector chooses a current line only from `status=running` or an explicit waiting item. Multiple active projected items produce a neutral aggregate; a running Run with no new item gets a quiet-running note. A terminal Run never promotes stale running/waiting items to current or recent work and explicitly notes incomplete activity synchronization.
- The Activity slot displays one current line and folds recent rows behind a persistent button. The row window comes from `foldAdjacentTools` and `windowActivity`; its hidden count describes only rows in the loaded projection. No server-history count is invented.
- Plan, Step and Todo sections are React-memoized with stable snapshot props, so activity-only updates do not remount their disclosure DOM or reset local expansion/focus state.
- Chinese labels use the existing catalog. Other locales currently use the English source for the new strings.

## Verified and remaining

- Focused tests cover Run matching, current selection, terminal stale activity, waits and projected-window counts. The rendered component test checks one primary line and a folded recent list.
- The producer still lacks an explicit server truncation marker, disconnected/stale presentation source and same-Bot helper identity. Tool rows continue in the existing tool card to avoid duplicate presentation, so Task 05's full tool-as-current mapping is not yet integrated.
- `windowActivity` keeps all active/waiting rows even if more than six exist; the design's strict six-row recent cap needs a separate priority rule before changing that shared behavior.
- Browser visual, keyboard and live Java→Web flow acceptance remain.
