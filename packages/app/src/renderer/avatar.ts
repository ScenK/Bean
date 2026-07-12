import { createOrb } from "./orb.js";
import type { AvatarMode, ComponentKind } from "../channels.js";
import { createDragPreparationGate } from "../drag-preparation.js";
import { createDragWatchdog } from "../drag-watchdog.js";
import { AVATAR_SIZE, avatarSizeForMode } from "../avatar-menu.js";
import { computeStackPositions, nearestPetalIndex, pointInRect, resolvePetalDropIndex, type Point } from "../petal-geometry.js";
import type { Project, Skill } from "@bean/core";

// Quick-actions and the drag-skill bloom render as the same vertical tile stack (see the
// redesign mockup at ~/Develop/Desktop Quick Action App and .bean-petal in drag-bloom.css):
// tiles right-aligned under the bean, growing downward, sliding in from the side.
const TILE_DX = 84;        // column sits left of the bean anchor so tiles are right-aligned under it
const TILE_FIRST_DY = 92;  // first tile's center, just below the bean box
const TILE_STEP = 60;      // vertical spacing between tile centers
const tilePositions = (count: number, cx: number, cy: number): Point[] =>
  computeStackPositions(count, cx - TILE_DX, cy + TILE_FIRST_DY, TILE_STEP);

// Peaceful, muted per-tile icon colors — the only splash of color; tile surfaces stay amber.
const TILE_COLORS = ["#7FA88B", "#7C9CC4", "#C9976B", "#B58BB0", "#C7A24E", "#6FA8A0"];
const DOT = '<span class="bean-petal-dot"></span>';
const ICONS: Record<string, string> = {
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  skills: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7z"/></svg>',
  projects: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/></svg>',
  notes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  routines: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v5h-5"/><path d="M12 7v5l3 3"/></svg>',
};
const QUICK_ACTIONS: { kind: ComponentKind; name: string; desc: string }[] = [
  { kind: "chat", name: "Chat", desc: "Ask Bean anything" },
  { kind: "skills", name: "Skills", desc: "Manage skills" },
  { kind: "projects", name: "Projects", desc: "Your projects" },
  { kind: "notes", name: "Notes", desc: "Saved talks & ideas" },
  { kind: "routines", name: "Routines", desc: "Scheduled automations" },
];
const color = (i: number): string => TILE_COLORS[i % TILE_COLORS.length]!;

// Shared tile markup: icon chip (left) + name/desc (right), plus an optional badge.
const tileInner = (icon: string, name: string, desc: string, tileColor: string, badge = ""): string => `
  <span class="bean-petal-icon" style="color:${tileColor}">${icon}</span>
  <span class="bean-petal-body">
    <span class="bean-petal-head"><span class="bean-petal-name">${name}</span>${badge}</span>
    <span class="bean-petal-desc">${desc}</span>
  </span>`;

let menuCx = 0, menuCy = 0;

// The window is reused for the avatar's whole lifetime now — it never navigates
// to another page — so this fixed size only needs to be set once.
window.resizeTo(120, 120);

// The window body is the drag region (so you can move the avatar around).
// The #bean element is explicitly NO-drag: a `-webkit-app-region: drag` element
// is treated by macOS as an OS window-move handle and swallows mouse events, so
// the dblclick/drop listeners must live on a no-drag element to fire at all.
(document.body.style as unknown as { webkitAppRegion: string }).webkitAppRegion = "drag";

const el = document.getElementById("bean");
const orbSlot = document.getElementById("bean-orb");
const hint = document.querySelector<HTMLElement>(".bean-box-hint");
const menu = document.getElementById("bean-menu");
const bloom = document.getElementById("bean-drag-bloom");
const reading = document.getElementById("bean-reading");

if (el && orbSlot && hint && bloom && reading) {
  (el.style as unknown as { webkitAppRegion: string }).webkitAppRegion = "no-drag";

  const orb = createOrb(orbSlot, { size: 48 });
  orb.setState("listening");

  window.bean.getTheme().then((t) => { document.documentElement.dataset.theme = t; });
  window.bean.onThemeChanged((t) => { document.documentElement.dataset.theme = t; });

  // Avatar mode: "normal" (collapsed bean) | "hover" (proximity box, no tiles) | "menu"
  // (quick-action tiles) | "drag" (skill/quick-action tiles).
  // Drives the window's grown size via the main process (see avatar-menu.ts).
  let mode: AvatarMode = "normal";
  const dragPreparation = createDragPreparationGate();
  const setMode = (next: AvatarMode): void => {
    mode = next;
    window.bean.setAvatarMode(next);
  };

  // ── The expanding box ────────────────────────────────────────────────────
  // The bean box is right-anchored so it grows leftward/downward while the bean itself stays put.
  // padding-right is 0 (see avatar-box.css), so the bean's distance from the box's right edge is
  // a constant `RIGHT_INSET` (1px border + 24px half-orb) — position by that and it never drifts.
  // The window width is known from the mode (dragBloomLayout never clamps width), so we don't race
  // the async resize by reading window.innerWidth.
  const RIGHT_INSET = 25;
  const positionBox = (x: number, y: number): void => {
    el.style.position = "absolute";
    el.style.left = "auto";
    el.style.right = `${avatarSizeForMode(mode).width - (x + RIGHT_INSET)}px`;
    el.style.top = `${y}px`;
    el.style.transform = "translateY(-50%)";
  };
  // The box is always absolutely pinned by its right edge (a constant inset from the bean), so the
  // bean holds one screen position regardless of window size — no absolute↔flow jump on collapse.
  // Start it pinned at the idle window's center.
  const pinIdle = (): void => positionBox(AVATAR_SIZE.width / 2, AVATAR_SIZE.height / 2);
  pinIdle();
  const setHint = (text: string): void => { hint.textContent = text; };
  const expandBox = (hintText: string): void => {
    el.classList.add("bean-box--expanded");
    setHint(hintText);
  };
  const collapseBox = (): void => {
    el.classList.remove("bean-box--expanded", "bean-box--hovering");
  };
  const setBoxHovering = (on: boolean): void => {
    el.classList.toggle("bean-box--hovering", on);
    orb.setLit(on);
  };

  // Smooth return to the collapsed bean: shrink the box in place first (the window is still grown,
  // so there's room), then shrink the window only once the box is small. Main replies with the
  // idle bean position (onAvatarDragLayout "normal") to re-pin — the bean never moves or flashes.
  let collapseTimer: number | undefined;
  const cancelCollapse = (): void => {
    if (collapseTimer !== undefined) { clearTimeout(collapseTimer); collapseTimer = undefined; }
  };
  const collapse = (): void => {
    cancelCollapse();
    dragWatchdog.disarm();
    menu?.classList.remove("bean-menu--open");
    bloom.classList.remove("bean-drag-bloom--open");
    setHover(undefined);
    collapseBox();
    collapseTimer = window.setTimeout(() => { collapseTimer = undefined; setMode("normal"); }, 300);
  };

  // Backstop for a drag that ends without the bloom seeing drop/dragleave (this window is known
  // to drop terminal events — see drag-watchdog.ts): drag events stop arriving, the watchdog
  // goes silent, and we collapse instead of wedging in "drag" mode forever.
  const dragWatchdog = createDragWatchdog(() => {
    if (mode === "drag") collapse();
  });

  // ── Proximity: cursor enters/leaves the (transparent) avatar window ───────
  // The window itself is the proximity zone; growing to the box on enter and back on leave gives
  // natural hysteresis (enter at the small 120px window, leave at the wider box window) so it
  // doesn't flicker at the boundary. A short guard after enter ignores any resize-induced leave.
  // ponytail: window-sized proximity, not the mockup's 230px radius — a true radius would need
  // main-process cursor polling. Swap in polling if the zone feels too tight.
  let hoverEnterAt = 0;
  document.documentElement.addEventListener("mouseenter", () => {
    if (mode === "hover") { cancelCollapse(); expandBox("drop anything here"); return; } // re-grab mid-collapse
    if (mode !== "normal") return;
    hoverEnterAt = Date.now();
    setMode("hover");
  });
  document.documentElement.addEventListener("mouseleave", () => {
    if (mode !== "hover") return;
    if (Date.now() - hoverEnterAt < 150) return;
    collapse();
  });

  // Bubble menu: picking a tile opens that component and closes the menu; clicking outside it or
  // pressing Escape also closes it. Tiles are rendered collapsed then flipped open next frame (in
  // onAvatarDragLayout) so the slide-in actually plays.
  const setMenuOpen = (open: boolean): void => {
    if (open) {
      cancelCollapse();
      setMode("menu");
      return;
    }
    collapse();
  };

  window.bean.onAvatarFoldMenu(() => {
    if (mode === "menu") setMenuOpen(false);
    // Backstop for a dropped mouseleave (main polls the cursor while hovering). Guard on the timer
    // so a repeat poll can't restart — and thus never finish — an already-running collapse.
    else if (mode === "hover" && collapseTimer === undefined) collapse();
  });

  const renderMenu = (): void => {
    if (!menu) return;
    const positions = tilePositions(QUICK_ACTIONS.length, menuCx, menuCy);
    menu.innerHTML = QUICK_ACTIONS.map((a, i) => {
      const p = positions[i]!;
      return `
      <button type="button" class="bean-petal bean-petal--menu" data-kind="${a.kind}" style="left:${p.x}px;top:${p.y}px;--i:${i}">
        ${tileInner(ICONS[a.kind] ?? "", a.name, a.desc, color(i))}
      </button>`;
    }).join("");
    // Notes tile badge: total saved note count. Patched in async after the menu paints.
    void window.bean.listNotes().then((notes) => {
      const tile = menu.querySelector('.bean-petal--menu[data-kind="notes"]');
      if (notes.length > 0 && tile) tile.insertAdjacentHTML("beforeend", `<span class="bean-petal-badge bean-petal-badge--end">${notes.length}</span>`);
    });
  };

  menu?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".bean-petal--menu");
    if (!btn) return;
    void window.bean.openComponent(btn.dataset.kind as ComponentKind);
    setMenuOpen(false);
  });

  window.addEventListener("click", (e) => {
    // Escape hatch: real clicks can't happen mid-drag (the mouse is held by the drag session),
    // so a click while still in "drag" mode means the mode is wedged — collapse it.
    if (mode === "drag") { collapse(); return; }
    if (mode !== "menu") return;
    const target = e.target as HTMLElement;
    // el.contains, not ===: the box holds nested orb/text nodes, so a click on the bean body
    // never targets `el` itself, only a descendant of it.
    if (el.contains(target) || target.closest(".bean-petal--menu")) return;
    setMenuOpen(false);
  });

  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (mode === "menu") setMenuOpen(false);
    else if (mode === "drag") collapse();
  });

  // Drag a URL onto Bean: dragenter opens a downward stack of tiles below the (temporarily grown)
  // window; dragover tracks the cursor and highlights the nearest tile; drop commits to whichever
  // was last highlighted. With skills configured the tiles are skills (drop routes the URL through
  // that skill); with none, they fall back to the quick actions so a drag ALWAYS does something.
  // The bloom container itself — not the individual tiles — is the real, window-sized, no-drag drop
  // target (tiles are pointer-events:none and hit-tested by math): the avatar body is a
  // -webkit-app-region:drag OS window-move region that swallows mouse-driven events on anything
  // that isn't a real, properly-sized no-drag element (see .memory/safety-window-behavior.md).
  // The orb's center within the grown window is provided by the main process per drag (see
  // dragBloomLayout); it anchors on the bean's fixed screen position so the bean never jumps.
  let beanCx = 220, beanCy = 44; // sane default for the first paint before the layout reply lands
  let skills: Skill[] = [];
  let projects: Project[] = [];
  let petalPositions: Point[] = [];
  let hoverIndex: number | undefined;
  let boxHovered = false;

  // The tiles shown while dragging, with the action each performs on drop of a URL.
  interface DragTile { icon: string; name: string; desc: string; badge: string; run: (url: string) => void; }
  let dragTiles: DragTile[] = [];

  // A dropped file/folder (Finder) populates dataTransfer.files, not text/uri-list — check it
  // first. A dropped URL (browser) populates text/uri-list/text/plain instead and has no files.
  const dataUrl = (e: DragEvent): string | undefined => {
    const file = e.dataTransfer?.files?.[0];
    if (file) return window.bean.getPathForFile(file);
    return e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain") || undefined;
  };

  const buildDragTiles = (): void => {
    // Disabled skills are hidden from the quick-launch (still editable in the Skills panel).
    const active = skills.filter((s) => s.enabled !== false);
    if (active.length > 0) {
      // Same priority order as bestProjectForSkill (explicit Project.skills before the legacy
      // defaultSkill badge), just picking a skill — keeps the "best guess" hint consistent with
      // what dropping on that tile will actually resolve to.
      const suggested = active.find((s) => projects.some((p) => p.skills?.includes(s.name)))?.name
        ?? active.find((s) => projects.some((p) => p.defaultSkill === s.name))?.name
        ?? active[0]?.name;
      dragTiles = active.map((s) => ({
        icon: DOT,
        name: s.name,
        desc: s.description,
        badge: s.name === suggested ? '<span class="bean-petal-badge">best</span>' : "",
        run: (url: string) => {
          reading.classList.add("bean-reading--open");
          window.bean.planFromDrop(s.name, url);
          // ponytail: fixed cosmetic delay standing in for a real "reading the page" step;
          // swap for a real fetch/summarize call if that ever gets built.
          setTimeout(() => reading.classList.remove("bean-reading--open"), 700);
        },
      }));
    } else {
      // No skills configured — fall back to the quick actions so dragging still lands somewhere.
      dragTiles = QUICK_ACTIONS.map((a) => ({
        icon: ICONS[a.kind] ?? "",
        name: a.name,
        desc: a.desc,
        badge: "",
        run: (url: string) => void window.bean.openComponent(a.kind, url),
      }));
    }
  };

  const renderPetals = (): void => {
    petalPositions = tilePositions(dragTiles.length, beanCx, beanCy);
    bloom.innerHTML = dragTiles.map((t, i) => {
      const p = petalPositions[i]!;
      return `
      <div class="bean-petal${t.badge ? " bean-petal--suggested" : ""}" data-index="${i}" style="left:${p.x}px;top:${p.y}px;--i:${i}">
        ${tileInner(t.icon, t.name, t.desc, color(i), t.badge)}
      </div>`;
    }).join("");
  };

  // Pin the box + place the tiles once the main process reports where the bean landed in the grown
  // window. Tiles are created collapsed, then flipped open next frame so the slide-in plays.
  window.bean.onAvatarDragLayout((p) => {
    if (mode === "normal") { positionBox(p.x, p.y); return; } // re-pin the collapsed box after a resize
    if (mode === "hover") {
      positionBox(p.x, p.y);
      expandBox("drop anything here");
      return;
    }
    if (mode === "menu") {
      menuCx = p.x;
      menuCy = p.y;
      positionBox(p.x, p.y);
      expandBox("quick actions");
      renderMenu();
      requestAnimationFrame(() => menu?.classList.add("bean-menu--open"));
      return;
    }
    if (mode !== "drag") return;
    beanCx = p.x;
    beanCy = p.y;
    positionBox(p.x, p.y);
    expandBox("drop anything here");
    renderPetals();
    requestAnimationFrame(() => bloom.classList.add("bean-drag-bloom--open"));
  });

  const setHover = (index: number | undefined, overBox = false): void => {
    if (hoverIndex === index && boxHovered === overBox) return;
    hoverIndex = index;
    boxHovered = overBox;
    const on = index !== undefined || overBox;
    setBoxHovering(on); // bean brightens + box glows while a tile OR the box itself is targeted
    setHint(overBox ? "drop to chat" : on ? "release to drop" : "drop anything here");
    bloom.querySelectorAll<HTMLElement>(".bean-petal").forEach((node) =>
      node.classList.toggle("bean-petal--active", Number(node.dataset.index) === index));
  };

  const closeBloom = (): void => {
    if (mode === "drag") collapse();
  };

  el.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragWatchdog.arm();
    if (mode === "drag") {
      // Re-entry while a dragleave-triggered collapse is pending (mode flips back to "normal"
      // only after collapse()'s 300ms timer): cancel it and restore the bloom. Without this the
      // window shrinks out from under the still-held drag, and the eventual drop can land
      // outside the resized window — leaving the avatar wedged in drag mode (the freeze bug).
      cancelCollapse();
      expandBox("drop anything here");
      bloom.classList.add("bean-drag-bloom--open");
      return;
    }
    if (mode !== "normal" && mode !== "hover") return;
    if (!dragPreparation.begin()) return;
    cancelCollapse();
    void (async () => {
      try {
        [skills, projects] = await Promise.all([window.bean.listSkills(), window.bean.listProjects()]);
        buildDragTiles();
        // Grow into drag mode; the main process replies with the bean's anchored position
        // (onAvatarDragLayout above), which is when we actually place the box and open the bloom.
        setMode("drag");
      } finally {
        dragPreparation.end();
      }
    })();
  });

  bloom.addEventListener("dragover", (e) => {
    e.preventDefault();
    dragWatchdog.arm();
    // The box itself always wins over petal-proximity snapping: without this, a drop meant for
    // the box (not any specific skill) could still land within nearestPetalIndex's maxDist of
    // the first petal — implicitly running a skill nobody chose. See el.getBoundingClientRect(),
    // not bloom's, since the box is the thing the user is actually dropping onto.
    if (pointInRect(e.clientX, e.clientY, el.getBoundingClientRect())) { setHover(undefined, true); return; }
    const rect = bloom.getBoundingClientRect();
    // Wider gate than a radial fan: tiles are broad, so hovering anywhere over the column snaps
    // to the nearest tile center.
    setHover(nearestPetalIndex(e.clientX - rect.left, e.clientY - rect.top, petalPositions, 130));
  });

  bloom.addEventListener("dragleave", (e) => {
    // Close only when the cursor genuinely leaves the bloom's rect. `e.target === bloom` alone is
    // too eager for the tall vertical stack — spurious dragleaves fire while moving between the box
    // and the tiles, which would collapse the bloom mid-drag. A point-in-rect test is robust to that.
    const r = bloom.getBoundingClientRect();
    if (e.clientX <= r.left || e.clientX >= r.right || e.clientY <= r.top || e.clientY >= r.bottom) closeBloom();
  });

  bloom.addEventListener("drop", (e) => {
    e.preventDefault();
    const url = dataUrl(e);
    const index = resolvePetalDropIndex(e.clientX, e.clientY, bloom.getBoundingClientRect(), el.getBoundingClientRect(), petalPositions, 130);
    const chosen = index !== undefined ? dragTiles[index] : undefined;
    closeBloom();
    if (url && chosen) chosen.run(url);
    else if (url) void window.bean.openComponent("chat", url); // no tile chosen — plain fallback
  });

  // Fallback path: a drop that lands on the bean before the bloom's own handler catches it.
  // While a collapse is pending the bloom is pointer-events:none, so dragovers land here —
  // keep feeding the watchdog so it only fires on genuine drag-event silence.
  el.addEventListener("dragover", (e) => { e.preventDefault(); dragWatchdog.arm(); });
  el.addEventListener("drop", (e) => {
    if (mode === "drag") return; // the document-level backstop below handles a mid-collapse drop
    e.preventDefault();
    const url = dataUrl(e);
    if (url) void window.bean.openComponent("chat", url);
  });

  // Guard 4 (see .memory/safety-drag-mode-needs-watchdog.md): while a collapse is pending the
  // bloom is pointer-events:none, so over the tile column — away from the box — drag events
  // retarget to the window body, where nothing cancels the collapse, re-arms the watchdog, or
  // preventDefaults the dragover. The drag dies silently and the eventual drop is refused (or
  // lands outside the shrunk window), which is exactly the "dropped a URL on a skill tile and
  // nothing happened" bug. Catch drag events at the document: any dragover anywhere in the
  // window keeps drag mode alive, and a drop that still slips through is resolved with the
  // same box-wins-then-nearest-tile hit test the bloom uses.
  document.addEventListener("dragover", (e) => {
    if (mode !== "drag") return;
    e.preventDefault();
    dragWatchdog.arm();
    if (collapseTimer === undefined) return; // bloom is alive — its own handlers manage hover state
    cancelCollapse();
    expandBox("drop anything here");
    bloom.classList.add("bean-drag-bloom--open");
  });
  document.addEventListener("drop", (e) => {
    if (e.defaultPrevented || mode !== "drag") return; // bloom/el already handled it
    e.preventDefault();
    const url = dataUrl(e);
    const index = resolvePetalDropIndex(e.clientX, e.clientY, bloom.getBoundingClientRect(), el.getBoundingClientRect(), petalPositions, 130);
    const chosen = index !== undefined ? dragTiles[index] : undefined;
    closeBloom();
    if (url && chosen) chosen.run(url);
    else if (url) void window.bean.openComponent("chat", url);
  });

  // #bean is no-drag (see comment above), so dragging the visible body itself is done manually:
  // track mouse deltas and move the OS window via IPC instead of CSS drag. A plain left click
  // (mousedown+mouseup with no real movement) toggles the quick-actions menu — CLICK_THRESHOLD
  // tells the two apart. Both work whether the bean is collapsed (normal) or the hover box is up.
  const CLICK_THRESHOLD = 4;
  let dragging = false;
  let moved = false;
  let downX = 0, downY = 0;
  let lastX = 0, lastY = 0;
  el.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    downX = lastX = e.screenX;
    downY = lastY = e.screenY;
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    if (!moved && (Math.abs(e.screenX - downX) > CLICK_THRESHOLD || Math.abs(e.screenY - downY) > CLICK_THRESHOLD)) {
      moved = true;
      // Real move started (not just a click) — show the grabbing hand only now.
      if (mode === "normal" || mode === "hover") document.documentElement.classList.add("bean-moving");
    }
    if (mode === "normal" || mode === "hover") window.bean.moveWindowBy(e.screenX - lastX, e.screenY - lastY);
    lastX = e.screenX;
    lastY = e.screenY;
  });
  window.addEventListener("mouseup", () => {
    document.documentElement.classList.remove("bean-moving");
    if (dragging && !moved) {
      if (mode === "normal" || mode === "hover") setMenuOpen(true);
      else if (mode === "menu") setMenuOpen(false);
    }
    dragging = false;
  });
}
