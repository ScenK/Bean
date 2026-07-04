export type OrbState = "idle" | "listening" | "working" | "done";

export interface OrbHandle {
  setState(state: OrbState): void;
  setLit(lit: boolean): void;
}

// Coffee-bean mark from the redesign mockup (~/Develop/Desktop Quick Action App). Colors come
// from CSS classes (see orb.css) so it follows the theme's accent instead of hard-coded browns.
const BEAN_SVG = `
<svg class="bean-orb-mark" viewBox="0 0 36 36" fill="none" aria-hidden="true">
  <path class="bean-orb-body" d="M18 3C11 3 5.5 8 5 15C4.5 22 9 29 16 31.5C23 34 30 29.5 32 22.5C34 15.5 30 7 24 4.5C22.3 3.5 20.2 3 18 3Z"/>
  <path class="bean-orb-crease-line" d="M12 9C10 12 10 17 12 20" stroke-width="2.5" stroke-linecap="round"/>
  <path class="bean-orb-crease" d="M18 7C18 7 15 14 18 22C21 14 18 7 18 7Z"/>
  <ellipse class="bean-orb-gloss" cx="14" cy="10" rx="3" ry="2" transform="rotate(-20 14 10)"/>
</svg>`;

export function createOrb(container: HTMLElement, opts?: { size?: number }): OrbHandle {
  const size = opts?.size ?? 96;
  container.style.width = `${size}px`;
  container.style.height = `${size}px`;

  const root = document.createElement("div");
  root.className = "bean-orb";
  root.dataset.state = "idle";

  const glow = document.createElement("div");
  glow.className = "bean-orb-glow";

  // Two expanding halo rings, staggered, for the idle "pulse outward" from the mockup.
  const ring0 = document.createElement("div");
  ring0.className = "bean-orb-ring";
  const ring1 = document.createElement("div");
  ring1.className = "bean-orb-ring bean-orb-ring--delay";

  const mark = document.createElement("div");
  mark.className = "bean-orb-mark-wrap";
  mark.innerHTML = BEAN_SVG;

  root.append(glow, ring0, ring1, mark);
  container.replaceChildren(root);

  return {
    setState(state: OrbState) {
      root.dataset.state = state;
    },
    setLit(lit: boolean) {
      root.classList.toggle("bean-orb--lit", lit);
    },
  };
}
