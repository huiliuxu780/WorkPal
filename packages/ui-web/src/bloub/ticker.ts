/**
 * Local adaptation (ours, not upstream): one shared rAF loop for every live
 * bloub avatar, so a sidebar full of bots costs a single frame callback.
 * Time is seconds since navigationStart, matching BotEngine.sample(now).
 *
 * Embedded webviews (ZCode's in-app browser) freeze rAF entirely while
 * occluded, even though the page reports itself visible — a watchdog timer
 * keeps a slow heartbeat in that case, so the avatar never looks dead and
 * catches up the moment the pane is shown again.
 */
type Tick = (nowSec: number) => void;

const listeners = new Set<Tick>();
const STALL_SECONDS = 0.25;
const WATCHDOG_MS = 250;

let raf = 0;
let watchdog = 0;
let lastTick = 0;

function loop(tMs: number): void {
  lastTick = tMs / 1000;
  for (const listener of [...listeners]) {
    try {
      listener(lastTick);
    } catch (error) {
      // One broken avatar must not stop the shared loop; surface it instead.
      console.error("[bloub ticker] frame failed", error);
    }
  }
  if (listeners.size > 0) raf = requestAnimationFrame(loop);
  else raf = 0;
}

export function addTicker(listener: Tick): () => void {
  listeners.add(listener);
  if (!raf) raf = requestAnimationFrame(loop);
  if (!watchdog) {
    watchdog = window.setInterval(() => {
      if (listeners.size === 0) return;
      if (performance.now() / 1000 - lastTick > STALL_SECONDS) loop(performance.now());
    }, WATCHDOG_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (watchdog) window.clearInterval(watchdog);
      watchdog = 0;
    }
  };
}
