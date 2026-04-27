// Floating toolbar for the active table. Implemented as a CM6 ViewPlugin so
// it lives inside Obsidian's markdown editor and follows scroll / selection /
// focus changes naturally. Three placement modes are supported (see
// `FloatingToolbarPosition`): `on-click` (default), `follow-mouse`, `top-left`.

import { EditorView, ViewPlugin, ViewUpdate, PluginValue } from "@codemirror/view";
import { App, MarkdownView } from "obsidian";
import type TableMasterPlugin from "../main";
import { Icons } from "./icons";
import { t } from "../i18n";
import * as actions from "../editor/actions";
import { getActionContext } from "../editor/contextHelper";

/** Resolve the CM6 EditorView that is currently the *active* markdown editor.
 *  Returns null when the active workspace leaf isn't a markdown view (file
 *  explorer, settings, etc.). Used to gate every toolbar instance on whether
 *  it belongs to that view — without this, multiple open / split / hover
 *  markdown panes each show their own toolbar simultaneously. */
function activeMarkdownEditorView(app: App): EditorView | null {
  const md = app.workspace.getActiveViewOfType(MarkdownView);
  // `editor.cm` is the CM6 EditorView in Obsidian's Live Preview build. It's
  // not part of the public types but is the de facto way community plugins
  // bridge from `Editor` to CodeMirror; safe-cast through `unknown`.
  const cm = (md?.editor as unknown as { cm?: EditorView } | undefined)?.cm;
  return cm ?? null;
}

interface ToolbarHost {
  getApp(): App;
  getPlugin(): TableMasterPlugin;
}

export function buildFloatingToolbarExt(host: ToolbarHost) {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      view: EditorView;
      dom: HTMLElement;
      visible = false;
      lastFrom = -1;

      constructor(view: EditorView) {
        this.view = view;
        this.dom = document.createElement("div");
        this.dom.className = "tm-floating-toolbar";
        // Tagged so `TableMasterPlugin.onunload` can sweep up any toolbars
        // whose CM6 destroy() hook didn't fire (Obsidian doesn't always
        // reconfigure already-open editor views on plugin unload).
        this.dom.dataset.tmFloatingToolbar = "1";
        // Hidden until refresh() decides to show it. Toggled via the
        // `is-hidden` CSS class (defined in styles.css) rather than an inline
        // `display` style — obsidianmd lint forbids static style.display
        // assignments because they bypass theme overrides.
        this.dom.classList.add("is-hidden");
        // Stop bubbling to avoid Obsidian re-focusing editor and dropping cursor
        this.dom.addEventListener("mousedown", (e) => e.preventDefault());
        // IMPORTANT: mount on <body>, not view.dom.parentElement. Some
        // Obsidian themes / wrappers put a `transform` (or `filter` /
        // `perspective`) on an ancestor of the editor pane to trigger GPU
        // compositing. Any of those properties anchor `position: fixed` to
        // that ancestor instead of the viewport, which is why the user saw
        // the toolbar systematically offset to the bottom-right. <body> is
        // never inside such a transform, so fixed positioning is reliable.
        document.body.appendChild(this.dom);
        this.render();
        // Subscribe to settings broadcasts so the toolbar reacts to a position
        // change without requiring the user to also click in the editor.
        this.settingsListener = () => this.refresh(this.view);
        document.addEventListener("table-master:settings-changed", this.settingsListener);
        // Track scroll on the editor's scroll container so the toolbar can
        // re-anchor itself if a future placement mode wants viewport-tied
        // coordinates. CM6's `viewportChanged` only fires when the rendered
        // range changes, not on every scroll tick.
        // (Currently a no-op for the active modes, but kept so adding a new
        // mode that needs scroll updates is friction-free.)
        this.scrollListener = () => {
          if (this.raf != null) return;
          this.raf = requestAnimationFrame(() => {
            this.raf = null;
            this.refresh(this.view);
          });
        };
        view.scrollDOM.addEventListener("scroll", this.scrollListener, { passive: true });
        window.addEventListener("scroll", this.scrollListener, { passive: true, capture: true });
        // Install the on-click mousedown handler eagerly. It MUST exist before
        // the user's first click on a table — otherwise that click happens
        // while no listener is attached and the toolbar misses it. The handler
        // self-gates on the current mode, so it's a no-op while the user is
        // in `follow-mouse` / `top-left` mode.
        this.ensureMouseDownListener();
        this.update({ view, docChanged: true, selectionSet: true } as unknown as ViewUpdate);
      }

      // Most recent mouse coords *in viewport-relative pixels* — fed by a
      // `mousemove` listener and consumed by both the "follow-mouse" and
      // "on-click" position modes. We use `clientX/Y` so the placement code
      // can rely on `position: fixed`, which sidesteps any quirks in the
      // editor's parent chain (custom themes / unusual leaf wrappers etc.
      // — that was the root cause of "top-left mode also doesn't show").
      clientX = 0;
      clientY = 0;
      mouseInTable = false;
      mouseListener: ((e: MouseEvent) => void) | null = null;
      mouseDownListener: ((e: MouseEvent) => void) | null = null;
      settingsListener: (() => void) | null = null;
      scrollListener: (() => void) | null = null;
      raf: number | null = null;

      update(u: ViewUpdate) {
        const settings = host.getPlugin().settings;
        if (!settings.showFloatingToolbar) {
          this.hide();
          return;
        }
        // `focusChanged` is essential: when the user clicks into another
        // markdown leaf (split / hover / second tab) every ViewPlugin
        // instance receives a focusChanged update. Each refresh() then
        // re-checks whether *its* view is still the active one, so only the
        // currently-active toolbar stays visible — fixing the "two toolbars
        // showing at once" symptom in split / hover-editor layouts.
        if (
          u.docChanged ||
          u.selectionSet ||
          u.viewportChanged ||
          u.geometryChanged ||
          u.focusChanged
        ) {
          this.refresh(u.view);
        }
      }

      destroy() {
        this.dom.remove();
        if (this.mouseListener) {
          this.view.dom.removeEventListener("mousemove", this.mouseListener);
          this.mouseListener = null;
        }
        if (this.mouseDownListener) {
          document.removeEventListener("mousedown", this.mouseDownListener, true);
          this.mouseDownListener = null;
        }
        if (this.settingsListener) {
          document.removeEventListener("table-master:settings-changed", this.settingsListener);
          this.settingsListener = null;
        }
        if (this.scrollListener) {
          this.view.scrollDOM.removeEventListener("scroll", this.scrollListener);
          window.removeEventListener("scroll", this.scrollListener, true);
          this.scrollListener = null;
        }
        if (this.raf != null) {
          cancelAnimationFrame(this.raf);
          this.raf = null;
        }
      }

      /** Shared entry point used by both `update()` and the mouse handler. */
      refresh(view: EditorView) {
        const settings = host.getPlugin().settings;
        if (!settings.showFloatingToolbar) {
          this.removeMouseListener();
          // Note: we do NOT remove the mousedown listener here; it self-gates
          // on `showFloatingToolbar` and must stay attached so re-enabling
          // the toolbar doesn't require re-loading the plugin.
          this.hide();
          return;
        }
        // Only the *active* markdown editor's toolbar should be drawn.
        // Obsidian routinely keeps multiple EditorView instances alive at
        // once — split panes, hover editors, the second pane of a linked
        // pane, the embedded editor inside a popover, etc. Every one of
        // those instances runs this ViewPlugin and mounts its own toolbar
        // DOM on <body>; without this gate they all show up simultaneously
        // (which is exactly the "two toolbars" screenshot the user reported
        // for top-left mode). We deliberately do NOT use `view.hasFocus`:
        // it only flips on keyboard focus, so common cases like "the user
        // just opened the file" or "clicked the toolbar button (which
        // preventDefaults focus shift)" would incorrectly hide us.
        const activeCM = activeMarkdownEditorView(host.getApp());
        if (!activeCM || activeCM !== view) {
          this.hide();
          return;
        }
        // Belt-and-braces: if the active view's DOM somehow has zero size
        // (e.g. mid-layout transition), bail out rather than land the
        // toolbar at (0,0).
        const rect = view.dom.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          this.hide();
          return;
        }
        // Normalize the (now-removed) `above-table` value left over in old
        // configs to the new default so the rest of this function only has
        // to worry about the three live modes.
        const rawMode = settings.floatingToolbarPosition as string;
        const mode: "on-click" | "follow-mouse" | "top-left" =
          rawMode === "follow-mouse" || rawMode === "top-left" ? rawMode : "on-click";
        const parent = view.dom.parentElement;
        if (!parent) {
          this.hide();
          return;
        }

        // Manage the mousemove listener, but NOT the mousedown listener.
        // The mousedown listener is installed once at construction time and
        // self-gates on the current mode — removing it would make on-click
        // mode miss the first click after a mode switch.
        if (mode !== "follow-mouse" && mode !== "top-left") this.removeMouseListener();

        // Mode `on-click` — visibility driven entirely by mousedown events.
        // refresh() should NOT toggle visibility here; the listener already
        // exists from construction time and decides on its own when to
        // show / hide / reposition the toolbar.
        if (mode === "on-click") {
          return;
        }

        // Modes `follow-mouse` and `top-left` are *always-visible* anchors
        // so the user can hit table commands even if our table-detection
        // logic gets confused by the active theme. They use `position:
        // fixed` to bypass any parent-positioning quirks.
        this.ensureVisible();
        this.ensureMouseListener();
        if (mode === "top-left") {
          this.placeTopLeft(view);
          return;
        }
        // `follow-mouse`: placement is driven *entirely* by the mousemove
        // handler. refresh() must NOT call placeAtMouse here — otherwise
        // every click / keystroke (which produces a selectionSet update)
        // would re-snap the toolbar to the current pointer, which the user
        // perceives as "a popup at the click position" identical to the
        // on-click mode. We only seed an initial top-left position so the
        // toolbar isn't stranded at (0,0) before the first mousemove.
        if (!this.dom.style.top) this.placeTopLeft(view);
      }

      /** Make the toolbar measurable & visible without leaving it at a stale position. */
      private ensureVisible() {
        if (this.dom.classList.contains("is-hidden")) {
          this.dom.classList.remove("is-hidden");
          this.visible = true;
        }
      }

      private ensureMouseListener() {
        if (this.mouseListener) return;
        const fn = (e: MouseEvent) => {
          // Cache pointer coords + table-hover flag immediately so the next
          // animation frame sees the latest values; defer the actual
          // measurement / DOM write to rAF so we don't read layout on every
          // mousemove tick.
          this.clientX = e.clientX;
          this.clientY = e.clientY;
          const target = e.target as HTMLElement | null;
          this.mouseInTable = !!target?.closest?.("table");
          const settings = host.getPlugin().settings;
          if (!settings.showFloatingToolbar) return;
          if (settings.floatingToolbarPosition !== "follow-mouse") return;
          if (this.raf != null) return;
          this.raf = requestAnimationFrame(() => {
            this.raf = null;
            // Place directly here instead of going through refresh(). refresh
            // intentionally never calls placeAtMouse so non-mouse updates
            // (clicks, typing, focus changes) can't snap the toolbar to the
            // pointer; mousemove is the only thing that's allowed to.
            const rect = this.view.dom.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            this.ensureVisible();
            if (this.mouseInTable) {
              this.placeAtMouse();
            } else {
              this.placeTopLeft(this.view);
            }
          });
        };
        this.view.dom.addEventListener("mousemove", fn);
        this.mouseListener = fn;
      }

      private removeMouseListener() {
        if (!this.mouseListener) return;
        this.view.dom.removeEventListener("mousemove", this.mouseListener);
        this.mouseListener = null;
        this.mouseInTable = false;
      }

      /**
       * Document-level mousedown handler that drives the `on-click` mode.
       * Captured (useCapture=true) so we see the click before CM6 / Obsidian
       * potentially stop propagation. Clicks inside a `<table>` show the
       * toolbar at that point; clicks outside any table (and not on the
       * toolbar itself) hide it.
       */
      private ensureMouseDownListener() {
        if (this.mouseDownListener) return;
        const fn = (e: MouseEvent) => {
          const settings = host.getPlugin().settings;
          if (!settings.showFloatingToolbar) return;
          if (settings.floatingToolbarPosition !== "on-click") return;
          const target = e.target as HTMLElement | null;
          if (!target) return;
          // Click on the toolbar itself: don't hide, don't reposition; let
          // the button's own click handler run.
          if (this.dom.contains(target)) return;
          // Only act on clicks within our editor view; otherwise stale state
          // from another pane could move our toolbar.
          if (!this.view.dom.contains(target)) return;
          // Don't pop up unless we're the active markdown editor — prevents a
          // background split-pane / hover-editor view from snapping its own
          // toolbar to a click that was intended for the foreground pane.
          const activeCM = activeMarkdownEditorView(host.getApp());
          if (activeCM !== this.view) return;
          if (target.closest("table")) {
            this.clientX = e.clientX;
            this.clientY = e.clientY;
            this.ensureVisible();
            this.placeAtMouse();
          } else {
            this.hide();
          }
        };
        document.addEventListener("mousedown", fn, true);
        this.mouseDownListener = fn;
      }

      private removeMouseDownListener() {
        if (!this.mouseDownListener) return;
        document.removeEventListener("mousedown", this.mouseDownListener, true);
        this.mouseDownListener = null;
      }

      hide() {
        if (!this.visible) return;
        this.dom.classList.add("is-hidden");
        this.visible = false;
      }

      /**
       * Pin the toolbar to the top-left corner of the editor pane using
       * `position: fixed`. Uses the editor's own bounding rect (in viewport
       * coords) and — because we're mounted on <body> — those coords land
       * exactly where the user expects, with no transformed-ancestor offset.
       */
      private placeTopLeft(view: EditorView) {
        const rect = view.dom.getBoundingClientRect();
        // `position: fixed` is declared in styles.css; we only set the dynamic
        // top / left here. Inline display/position assignments would trip
        // obsidianmd's no-static-styles-assignment rule.
        this.ensureVisible();
        this.dom.style.top = `${Math.max(rect.top, 0)}px`;
        this.dom.style.left = `${Math.max(rect.left, 0)}px`;
      }

      /**
       * Place the toolbar so its top-left corner sits at the latest pointer
       * position. The user explicitly asked for no offset — the toolbar
       * shows up exactly at the click point. Clamp to the viewport so the
       * toolbar is never partially off-screen.
       */
      private placeAtMouse() {
        // `position: fixed` lives in styles.css; only the dynamic top/left
        // are set inline (see comment in placeTopLeft).
        this.ensureVisible();
        const myWidth = this.dom.offsetWidth || 200;
        const myHeight = this.dom.offsetHeight || 80;
        const maxLeft = window.innerWidth - myWidth - 4;
        const maxTop = window.innerHeight - myHeight - 4;
        const left = Math.min(Math.max(this.clientX, 4), Math.max(maxLeft, 4));
        const top = Math.min(Math.max(this.clientY, 4), Math.max(maxTop, 4));
        this.dom.style.top = `${top}px`;
        this.dom.style.left = `${left}px`;
      }

      render() {
        this.dom.empty();
        const groups: Array<{
          icon: string;
          tip: string;
          run: () => void;
        }[]> = [
          [
            { icon: Icons.rowAbove, tip: t("tip.insertRowAbove"), run: () => this.act(actions.insertRowAbove) },
            { icon: Icons.rowBelow, tip: t("tip.insertRowBelow"), run: () => this.act(actions.insertRowBelow) },
            { icon: Icons.colLeft, tip: t("tip.insertColLeft"), run: () => this.act(actions.insertColLeft) },
            { icon: Icons.colRight, tip: t("tip.insertColRight"), run: () => this.act(actions.insertColRight) },
            { icon: Icons.delRow, tip: t("tip.deleteRow"), run: () => this.act(actions.deleteRow) },
            { icon: Icons.delCol, tip: t("tip.deleteCol"), run: () => this.act(actions.deleteCol) },
          ],
          [
            { icon: Icons.moveUp, tip: t("tip.moveRowUp"), run: () => this.act(actions.moveRowUp) },
            { icon: Icons.moveDown, tip: t("tip.moveRowDown"), run: () => this.act(actions.moveRowDown) },
            { icon: Icons.moveLeft, tip: t("tip.moveColLeft"), run: () => this.act(actions.moveColLeft) },
            { icon: Icons.moveRight, tip: t("tip.moveColRight"), run: () => this.act(actions.moveColRight) },
          ],
          [
            { icon: Icons.alignLeft, tip: t("tip.alignLeft"), run: () => this.act((c) => actions.alignColumn(c, "left")) },
            { icon: Icons.alignCenter, tip: t("tip.alignCenter"), run: () => this.act((c) => actions.alignColumn(c, "center")) },
            { icon: Icons.alignRight, tip: t("tip.alignRight"), run: () => this.act((c) => actions.alignColumn(c, "right")) },
          ],
          [
            { icon: Icons.mergeUp, tip: t("tip.mergeUp"), run: () => this.act(actions.mergeUp) },
            { icon: Icons.mergeDown, tip: t("tip.mergeDown"), run: () => this.act(actions.mergeDown) },
            { icon: Icons.mergeLeft, tip: t("tip.mergeLeft"), run: () => this.act(actions.mergeLeft) },
            { icon: Icons.split, tip: t("tip.split"), run: () => this.act(actions.splitCell) },
          ],
          [
            { icon: Icons.grid, tip: t("tip.gridEditor"), run: () => host.getPlugin().openGridEditor() },
            { icon: Icons.format, tip: t("tip.format"), run: () => this.act(actions.formatTable) },
            {
              icon: Icons.importTable,
              tip: t("tip.importTable"),
              run: () => void host.getPlugin().importTableFromClipboard(),
            },
          ],
        ];

        for (const group of groups) {
          const g = this.dom.createDiv({ cls: "tm-group" });
          for (const item of group) {
            const btn = g.createEl("button", { cls: "tm-btn" });
            btn.setAttribute("aria-label", item.tip);
            btn.title = item.tip;
            // Parse the bundled SVG via DOMParser instead of `innerHTML =` so
            // the obsidianmd lint rule banning innerHTML/outerHTML writes is
            // satisfied. The strings live in `Icons` and are entirely
            // controlled by us, so the parser sees only trusted markup.
            const parsedIcon = new DOMParser().parseFromString(item.icon, "image/svg+xml");
            const iconEl = parsedIcon.documentElement;
            if (iconEl && iconEl.nodeName.toLowerCase() === "svg") {
              btn.appendChild(iconEl);
            }
            btn.addEventListener("click", (e) => {
              e.preventDefault();
              e.stopPropagation();
              item.run();
            });
          }
        }
      }

      act(fn: (ctx: actions.ActionContext) => void) {
        const ctx = getActionContext(host.getApp(), host.getPlugin());
        if (!ctx) return;
        fn(ctx);
      }
    },
  );
}
