// Drag events (drop / out-of-rect dragleave) are the ONLY exits from the avatar's "drag" mode,
// and this transparent always-on-top window is known to drop terminal events (see
// .memory/safety-window-behavior.md and the hover-mode cursor-poll backstop in ipc.ts). A drag
// that ends without either event wedges the avatar: window stuck grown, the window-sized bloom
// overlay swallowing every click — indistinguishable from a frozen app. Chromium re-fires
// dragover on a stationary target every ~350ms, so silence well past that reliably means the
// drag is gone. Arm on every dragenter/dragover; disarm when the bloom collapses.
export function createDragWatchdog(
  onSilent: () => void,
  silenceMs = 800,
): { arm: () => void; disarm: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disarm = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return {
    arm: () => {
      disarm();
      timer = setTimeout(() => {
        timer = undefined;
        onSilent();
      }, silenceMs);
    },
    disarm,
  };
}
