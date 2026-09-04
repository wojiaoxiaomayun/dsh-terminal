/**
 * dsh-plugin-terminal - client half (xterm.js, multi-tab, Codex-style bottom
 * panel). Each tab owns an independent PTY session + xterm instance + WebSocket;
 * switching tabs only swaps the visible pane - processes and scrollback stay.
 * Refresh restores every live session as its own tab.
 *
 * Layout: a full-width panel pinned to the viewport bottom (like the terminal
 * zone of Codex/VS Code bottom panels). Collapsed it is a single 34px bar;
 * expanded it grows upward with a drag-to-resize grip. A configurable
 * shortcut (default Ctrl+`) toggles it - see /terminal-panel/config.
 * Visual language follows DSH design tokens, with the xterm surface always
 * dark (Campbell palette) so shell colors read in both themes.
 */
import React from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { parseShortcut, matchesShortcut } from "./shortcut.js";

const PREFIX = "/terminal-panel";
const HEIGHT_KEY = "dsh-plugin-terminal.height";
/* user-chosen panel position, persisted so switching sessions restores the
 * manual expand/collapse state instead of force-expanding the panel */
const OPEN_KEY = "dsh-plugin-terminal.open";
/* per-workspace AUTO-OPEN preference, keyed by normalized workspace path.
 * Defaults to OFF: switching to a workspace does not spawn a new terminal
 * (saves resources) until the user switches the toggle on in the settings
 * panel. */
const AUTOFLLOW_PREFIX = "dsh-plugin-terminal.autofollow.";
const MIN_HEIGHT = 120;

/* per-workspace auto-open preference (default: off). Keyed by normalized path
 * so the same dir (workspace or session cwd) maps to one flag. */
function autofollowKey(norm) { return AUTOFLLOW_PREFIX + norm; }
function getAutofollow(norm) {
  try { return localStorage.getItem(autofollowKey(norm)) === "1"; } catch { return false; }
}
function setAutofollow(norm, on) {
  try { localStorage.setItem(autofollowKey(norm), on ? "1" : "0"); } catch { /* storage unavailable */ }
}

/* xterm stylesheet served by the host plugin */
const XTERM_CSS_TAG = "dsh-plugin-terminal-xterm-css";
if (typeof document !== "undefined" && document.getElementById(XTERM_CSS_TAG) === null) {
  const link = document.createElement("link");
  link.id = XTERM_CSS_TAG;
  link.rel = "stylesheet";
  link.href = PREFIX + "/xterm.css";
  document.head.appendChild(link);
}

/* Codex-style bottom panel skin (DSH design tokens; terminal surface dark). */
const STYLE_TAG = "dsh-plugin-terminal-styles";
const PANEL_CSS = ".dshTermRoot{position:fixed;bottom:0;z-index:50;font-family:Inter,var(--dsw-font-family)}\n.dshTermBar{box-sizing:border-box;width:100%;height:34px;display:flex;align-items:center;gap:10px;padding:0 14px;background:var(--dsw-specific-tip);border-top:1px solid var(--dsw-alias-border-l1);cursor:pointer;color:var(--dsw-alias-label-primary);text-align:left;user-select:none;-webkit-user-select:none}\n.dshTermBar:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}\n.dshTermBarLead{color:var(--dsw-alias-label-tertiary);flex:none;place-items:center;display:grid}\n.dshTermBarTitle{min-width:0;flex:none;font-size:13px;font-weight:500;line-height:24px}\n.dshTermBarState{min-width:0;flex:auto;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:24px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.dshTermBarActions{flex:none;align-items:center;gap:2px;display:flex}\n.dshTermBarAction{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;flex:none;place-items:center;padding:0;display:grid}\n.dshTermBarAction:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}\n.dshTermBarAction:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}\n.dshTermBarAction:disabled{cursor:default;opacity:.45}\n.dshTermBarChevron{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:999px;flex:none;place-items:center;padding:0;display:grid}\n.dshTermBarChevron:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}\n.dshTermPanel{box-sizing:border-box;width:100%;display:flex;flex-direction:column;background:var(--dsw-specific-tip);border-top:1px solid var(--dsw-alias-border-l1);overflow:hidden;animation:dshTermIn .16s ease-out}\n@keyframes dshTermIn{from{transform:translateY(14px);opacity:.4}to{transform:none;opacity:1}}\n.dshTermResize{flex:none;height:6px;cursor:ns-resize;touch-action:none;position:relative}\n.dshTermResize:after{content:'';position:absolute;left:0;right:0;top:2px;height:2px;border-radius:2px;background:transparent;transition:background .15s}\n.dshTermResize:hover:after{background:var(--dsw-alias-interactive-bg-hover)}\n.dshTermTabs{flex:none;box-sizing:border-box;height:36px;display:flex;align-items:center;gap:2px;padding:0 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-tip)}\n.dshTermTabsScroll{flex:1;min-width:0;display:flex;align-items:center;gap:2px;height:100%;overflow-x:auto;scrollbar-width:none}\n.dshTermTabsScroll::-webkit-scrollbar{display:none}\n.dshTermTabsLead{color:var(--dsw-alias-label-tertiary);flex:none;display:grid;place-items:center;margin-right:2px}\n.dshTermTabsState{flex:none;max-width:180px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:24px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0 6px}\n.dshTermTab{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 6px 0 9px;border-radius:7px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font-family:Inter,var(--dsw-font-family);font-size:12px;font-weight:500;cursor:pointer;flex:none;max-width:200px}\n.dshTermTab:hover{background:var(--dsw-alias-interactive-bg-hover)}\n.dshTermTab.isActive{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}\n.dshTermTab:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}\n.dshTermTab.isExited{opacity:.5}\n.dshTermTab.isExited .dshTermTabLabel{text-decoration:line-through;text-decoration-thickness:1px}\n.dshTermTabLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.dshTermTabLead{display:grid;place-items:center;flex:none;opacity:.7}\n.dshTermTabClose{width:20px;height:20px;border:none;background:transparent;color:inherit;border-radius:6px;display:grid;place-items:center;cursor:pointer;padding:0;opacity:0;flex:none}\n.dshTermTab:hover .dshTermTabClose,.dshTermTab.isActive .dshTermTabClose{opacity:.65}\n.dshTermTabClose:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover)}\n.dshTermNew{width:26px;height:26px;flex:none;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:7px;display:grid;place-items:center;cursor:pointer;padding:0}\n.dshTermNew:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}\n.dshTermNew:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}\n.dshTermNew:disabled{cursor:default;opacity:.45}\n.dshTermCollapse{flex:none;display:grid;place-items:center;width:26px;height:26px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:7px;cursor:pointer;padding:0}\n.dshTermCollapse:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}\n.dshTermBody{flex:auto;min-height:0;position:relative;background:#1e2128;box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1)}\n.dshTermPane{position:absolute;inset:0;display:none;padding:4px 10px 8px;background:#1e2128}\n.dshTermPane.isActive{display:block}\n.dshTermEmpty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:#8b90a0;font-family:Inter,var(--dsw-font-family);font-size:12px}\n.dshTermEmptyBtn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:#2a2e38;color:#e6e8ee;font-family:Inter,var(--dsw-font-family);font-size:12px;font-weight:500;cursor:pointer}\n.dshTermEmptyBtn:hover{background:#343946}\nbody.dshTermResizing{cursor:ns-resize!important;user-select:none!important;-webkit-user-select:none!important}\n.dshTermSettings{position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;background:rgba(8,10,14,.45);backdrop-filter:blur(2px);padding:24px;box-sizing:border-box}\n.dshTermSettingsCard{width:min(460px,92vw);max-height:70vh;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-surface-secondary,#1c1f27);color:var(--dsw-alias-label-primary);box-shadow:0 18px 60px rgba(0,0,0,.45);font-family:Inter,var(--dsw-font-family);display:flex;flex-direction:column}\n.dshTermSettingsHead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:14px 14px 6px;flex:none;font-size:13px;font-weight:600}\n.dshTermSettingsTitle{min-width:0}\n.dshTermSettingsHint{padding:0 14px 10px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}\n.dshTermSettingsList{display:flex;flex-direction:column;padding:0 10px 12px;gap:2px}\n.dshTermSettingsRow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 10px;border-radius:8px;cursor:pointer;font-size:12.5px}\n.dshTermSettingsRow:hover{background:var(--dsw-alias-interactive-bg-hover)}\n.dshTermSettingsRow.dshTermSettingsMuted{color:var(--dsw-alias-label-tertiary);justify-content:center;cursor:default}\n.dshTermSettingsName{min-width:0;display:flex;flex-direction:column;gap:1px}\n.dshTermSettingsDir{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.dshTermSettingsPath{color:var(--dsw-alias-label-tertiary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.dshTermSettingsToggle{flex:none;width:34px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-interactive-bg-hover);cursor:pointer;padding:0;position:relative;transition:background .15s}\n.dshTermSettingsToggle.isOn{background:#3b82f6;border-color:#3b82f6}\n.dshTermSettingsToggleKnob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .15s}\n.dshTermSettingsToggle.isOn .dshTermSettingsToggleKnob{transform:translateX(14px)}";
if (typeof document !== "undefined" && document.getElementById(STYLE_TAG) === null) {
  const tag = document.createElement("style");
  tag.id = STYLE_TAG;
  tag.textContent = PANEL_CSS;
  document.head.appendChild(tag);
}

/* The terminal surface is ALWAYS dark with the Windows Terminal "Campbell"
 * palette. Shell output colors (ConPTY indices, ls/git/PSReadLine) are
 * designed for dark backgrounds - e.g. ConPTY emits fg-7 (#e5e5e5) for the
 * prompt, which is invisible on a light card. A dark inset surface (like a
 * code block in chat) keeps every ANSI color readable in both DSH themes. */
const TERM_THEME = {
  foreground: "#d7dae0",
  background: "#1e2128",
  cursor: "#d7dae0",
  cursorAccent: "#1e2128",
  selectionBackground: "#3b4252aa",
  /* Campbell hues, brightened so every slot clears ~4:1 on #1e2128
   * (stock Campbell blue/red/magenta measure 2.0-2.7:1 - unreadable). */
  black: "#0c0c0c",
  red: "#e74856",
  green: "#16c60c",
  yellow: "#c19c00",
  blue: "#3b78ff",
  magenta: "#d64fa8",
  cyan: "#3a96dd",
  white: "#cccccc",
  brightBlack: "#8a8a8a",
  brightRed: "#ff6b6b",
  brightGreen: "#2ee62e",
  brightYellow: "#f9f1a5",
  brightBlue: "#7aa2ff",
  brightMagenta: "#f27fd8",
  brightCyan: "#61d6d6",
  brightWhite: "#f2f2f2",
};

/* host API */
async function api(path, opts) {
  const res = await fetch(PREFIX + path, opts);
  if (!res.ok) throw new Error("terminal-panel " + res.status);
  return res.json();
}
const post = (path, body) =>
  api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
const del = (path) => api(path, { method: "DELETE" }).catch(() => {});
const prettyShell = (s) => (s ?? "shell").replace(/\.exe$/i, "");
/* label names the *workspace* (the terminal's cwd dir) first, e.g.
 * "dsh-terminal", and falls back to the shell when no cwd was resolved (so
 * fresh tabs don't all read "powershell"). A "#N" suffix disambiguates when
 * a workspace ends up with more than one tab. */
function tabLabel(tab) {
  if (typeof tab.cwd === "string" && tab.cwd.length > 0) {
    const dir = tab.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop();
    if (dir) {
      const m = /#(\d+)$/.exec(tab.title ?? "");
      return m === null ? dir : dir + " " + m[1];
    }
  }
  const base = prettyShell(tab.shell);
  return base;
}
/* Normalize a filesystem path for the per-workspace dedup: lowercase,
 * `\` -> `/`, collapse doubled slashes, drop the trailing slash. Windows is
 * the primary target (case-insensitive), so lowercasing makes the "is this
 * terminal already open in the current workspace" match reliable. */
function normPath(p) {
  if (typeof p !== "string") return "";
  return p.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/$/g, "").toLowerCase();
}

/* icons on the official 14/16px grids */
function TerminalGlyph14() {
  return React.createElement(
    "svg",
    { width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
    React.createElement("rect", { x: 1.35, y: 1.35, width: 11.3, height: 11.3, rx: 2.4, stroke: "currentColor", strokeWidth: 1.05 }),
    React.createElement("path", { d: "M4.75 4.9L7.05 7L4.75 9.1", stroke: "currentColor", strokeWidth: 1.05, strokeLinecap: "round", strokeLinejoin: "round" }),
    React.createElement("path", { d: "M7.75 9.1H10.05", stroke: "currentColor", strokeWidth: 1.05, strokeLinecap: "round" }),
  );
}
function TerminalGlyph12() {
  return React.createElement(
    "svg",
    { width: 12, height: 12, viewBox: "0 0 14 14", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
    React.createElement("rect", { x: 1.35, y: 1.35, width: 11.3, height: 11.3, rx: 2.4, stroke: "currentColor", strokeWidth: 1.1 }),
    React.createElement("path", { d: "M4.75 4.9L7.05 7L4.75 9.1", stroke: "currentColor", strokeWidth: 1.1, strokeLinecap: "round", strokeLinejoin: "round" }),
    React.createElement("path", { d: "M7.75 9.1H10.05", stroke: "currentColor", strokeWidth: 1.1, strokeLinecap: "round" }),
  );
}
function ChevronUp14() {
  return React.createElement(
    "svg",
    { width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
    React.createElement("path", { d: "M11.8486 8.5L11.4238 8.07617L8.69727 5.34863C8.44157 5.09294 8.21562 4.86618 8.01172 4.70215C7.79912 4.53117 7.55595 4.38244 7.25 4.33398C7.08435 4.30778 6.91565 4.30778 6.75 4.33398C6.44405 4.38244 6.20088 4.53117 5.98828 4.70215C5.78438 4.86618 5.55843 5.09294 5.30273 5.34863L2.57617 8.07617L2.15137 8.5L3 9.34863L3.42383 8.92383L6.15137 6.19727C6.42595 5.92268 6.59876 5.75151 6.74023 5.6377C6.87291 5.53096 6.92272 5.52187 6.9375 5.51953C6.97895 5.51297 7.02105 5.51297 7.0625 5.51953C7.07728 5.52187 7.12709 5.53096 7.25977 5.6377C7.40124 5.75151 7.57405 5.92268 7.84863 6.19727L10.5762 8.92383L11 9.34863L11.8486 8.5Z", fill: "currentColor" }),
  );
}
function ChevronDown14() {
  return React.createElement(
    "svg",
    { width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
    React.createElement("path", { d: "M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z", fill: "currentColor" }),
  );
}
function ChevronRight14() {
  return React.createElement(
    "svg",
    { width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
    React.createElement("path", { d: "M5.5 2.15137L5.92383 2.57617L8.65137 5.30273C8.90706 5.55843 9.13382 5.78438 9.29785 5.98828C9.46883 6.20088 9.61756 6.44405 9.66602 6.75C9.69222 6.91565 9.69222 7.08435 9.66602 7.25C9.61756 7.55595 9.46883 7.79912 9.29785 8.01172C9.13382 8.21561 8.90706 8.44157 8.65137 8.69727L5.92383 11.4238L5.5 11.8486L4.65137 11L5.07617 10.5762L7.80273 7.84863C8.07732 7.57405 8.24849 7.40124 8.3623 7.25977C8.46904 7.12709 8.47813 7.07728 8.48047 7.0625C8.48703 7.02105 8.48703 6.97895 8.48047 6.9375C8.47813 6.92272 8.46904 6.87291 8.3623 6.74023C8.24849 6.59876 8.07732 6.42595 7.80273 6.15137L5.07617 3.42383L4.65137 3L5.5 2.15137Z", fill: "currentColor" }),
  );
}
function Refresh14() {
  return React.createElement(
    "svg",
    { width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
    React.createElement("path", { d: "M1.272 6.21348C1.70645 3.08888 4.59169 0.908064 7.71634 1.34239C8.95495 1.51469 10.0438 2.07331 10.8814 2.87755L11.9458 1.81407C12.1347 1.6255 12.4572 1.75911 12.4575 2.02598V5.08751C12.4574 5.25303 12.3233 5.38731 12.1577 5.38731H9.0972C8.82993 5.38731 8.69629 5.06361 8.88528 4.87462L10.0327 3.72618C9.3732 3.09994 8.52006 2.66569 7.5513 2.53087C5.08313 2.18779 2.80376 3.91044 2.46048 6.37852C2.11747 8.84665 3.84009 11.1261 6.30814 11.4693C8.77612 11.8121 11.0557 10.0896 11.399 7.62148L12.728 7.80531C12.2935 10.9299 9.4083 13.1107 6.28366 12.6764C3.159 12.2421 0.977243 9.35731 1.272 6.21348Z", fill: "currentColor" }),
  );
}
function Settings14() {
  return React.createElement(
    "svg",
    { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
    React.createElement("path", {
      d: "M8 5.6A2.4 2.4 0 108 10.4 2.4 2.4 0 108 5.6z",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.1,
      strokeLinecap: "round",
      strokeLinejoin: "round",
    }),
    React.createElement("path", {
      d: "M13.6 8c0-.34-.03-.68-.08-1l1.08-.88a.6.6 0 00.14-.75L13.5 3.7a.6.6 0 00-.72-.26l-1.32.44A4.9 4.9 0 0010 3.05L9.78 1.7A.6.6 0 009.18 1.3L8 1.3a.6.6 0 00-.6.53l-.22 1.72A5.5 5.5 0 005.6 4l-1.32-.44a.6.6 0 00-.72.26L2.15 5.61a.6.6 0 00.14.75l1.08.9c-.08.24-.16.48-.22.74H3.4a.6.6 0 00-.6.6v3.4c0 .33.27.6.6.6h1.76c.26.3.54.58.84.83l.22 1.84a.6.6 0 00.6.52h3.36a.6.6 0 00.6-.52l.22-1.84c.33-.25.62-.53.87-.83h1.73a.6.6 0 00.6-.6V8a.6.6 0 00-.6-.6z",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.1,
      strokeLinecap: "round",
      strokeLinejoin: "round",
    }),
  );
}
function Close14() {
  return React.createElement(
    "svg",
    { width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
    React.createElement("path", { d: "M10.6074 4.40278L8.00975 6.99973L10.6074 9.59739L9.59736 10.6074L6.9997 8.00978L4.40274 10.6074L3.3927 9.59739L5.98966 6.99973L3.3927 4.40278L4.40274 3.39273L6.9997 5.98969L9.59736 3.39273L10.6074 4.40278Z", fill: "currentColor" }),
  );
}
function Plus12() {
  return React.createElement(
    "svg",
    { width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
    React.createElement("path", { d: "M8.64453 1.5V7.34961H14.5V8.65039H8.64453V14.5H7.34473V8.65039H1.5V7.34961H7.34473V1.5H8.64453Z", fill: "currentColor" }),
  );
}

/* one terminal pane: its own xterm + WS to one PTY session */
function TermPane({ tab, active, onExit }) {
  const { useEffect, useRef } = React;
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const wsRef = useRef(null);

  /* mount: create terminal, connect WS */
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    /* TUI-agent tuned options (codex / claude code):
     * - unicodeVersion "11": modern CJK/emoji width tables - mixed CN/EN agent
     *   output lays out correctly instead of overlapping/shifting
     * - drawBoldTextInBrightColors false: keep real ANSI colors on bold text
     *   (true swaps e.g. bold red to bright red - Claude Code headers drift)
     * - scrollback 10000: agent sessions stream lots of tool output
     * - CJK font fallbacks so Chinese never falls out of the mono stack */
    const term = new Terminal({
      cursorBlink: true,
      fontFamily:
        "ui-monospace, SFMono-Regular, 'Cascadia Mono', Consolas, Menlo, 'PingFang SC', 'Noto Sans Mono CJK SC', 'Microsoft YaHei', monospace",
      fontSize: 12.5,
      lineHeight: 1.25,
      scrollback: 10000,
      unicodeVersion: "11",
      drawBoldTextInBrightColors: false,
      theme: TERM_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    /* Ctrl+click (Cmd+click on macOS) opens http(s) links in the browser.
     * Plain clicks still select text, so this never steals selection. */
    term.loadAddon(new WebLinksAddon((_event, uri) => {
      window.open(uri, "_blank", "noopener,noreferrer");
    }));
    term.open(host);
    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch { /* zero-size guard */ }
    });
    termRef.current = term;
    fitRef.current = fit;

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(proto + "//" + location.host + PREFIX + "/ws/" + tab.id);
    ws.onopen = () => {
      /* The mount effect's fit() runs in a rAF that can fire BEFORE the socket
       * opens, so its onResize would be dropped (readyState !== OPEN) and the
       * PTY would stay at the spawn default (80x24). Replay the current
       * dimensions on connect so the shell repaints at the pane's real size -
       * otherwise PSReadLine's "clear rows below the prompt" sequence overflows
       * a short panel and leaves the cursor stranded on the bottom row. */
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };
    ws.onmessage = (ev) => term.write(ev.data);
    /* Whether this pane attached to a LIVE process at mount. Restored history
     * tabs (tab.exited === true) replay their buffer and then receive the same
     * "session exited" close, but must NOT auto-close - they are the
     * restartable survivors of a dsh web restart. */
    const wasLive = !tab.exited;
    ws.onclose = (ev) => {
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      /* Only a server-initiated "session exited" close means the PTY died.
       * A client-initiated close (unmount cleanup, network error) leaves the
       * process alive on the host, so the tab must stay open. */
      if (ev.reason !== "session exited") return;
      onExit(tab.id, wasLive);
    };
    ws.onerror = () => ws.close();
    wsRef.current = ws;
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });

    /* Xshell/PuTTY-style mouse shortcuts: releasing the mouse after selecting
     * text copies it; right-click pastes the clipboard into the shell.
     *
     * Clipboard access is two-tier:
     * - navigator.clipboard (Async Clipboard API) is fast but ONLY exists in
     *   secure contexts (https, or http://localhost/127.0.0.1). When the GUI
     *   is opened from another machine over plain http - the "remote" case -
     *   it is undefined and any call throws. Copy therefore falls back to the
     *   legacy document.execCommand("copy") via a temp textarea, which works
     *   in insecure contexts too.
     * - Reading the clipboard has no insecure-context fallback API, so when
     *   navigator.clipboard is missing we do NOT swallow the native context
     *   menu: its "Paste" item feeds the focused xterm textarea and xterm's
     *   own paste event forwards the text into the shell. Ctrl+V inside the
     *   terminal already works that way in every context. */
    const legacyCopy = (text) => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      document.body.removeChild(ta);
      return ok;
    };
    const writeClipboard = (text) => {
      if (typeof navigator.clipboard?.writeText === "function") {
        navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
      } else {
        legacyCopy(text);
      }
    };
    const copySelection = (ev) => {
      /* left-button release only: right-click is paste, don't re-copy */
      if (ev.button !== 0) return;
      if (!term.hasSelection()) return;
      const text = term.getSelection();
      if (!text) return;
      writeClipboard(text);
    };
    const pasteClipboard = (ev) => {
      if (typeof navigator.clipboard?.readText !== "function") {
        /* insecure context (remote http / iframe permissions policy): let the
         * browser's native context menu show - its Paste item reaches the
         * focused xterm textarea and pastes into the shell */
        return;
      }
      ev.preventDefault();
      navigator.clipboard
        .readText()
        .then((text) => {
          if (text) term.paste(text);
        })
        .catch(() => {
          /* permission denied; Ctrl+V still pastes natively */
        });
    };
    /* VS Code-style Ctrl+Shift+C / Ctrl+Shift+V - attempted when the Async
     * Clipboard API exists (secure context); the keys NEVER reach the shell,
     * so Ctrl+C stays SIGINT and Ctrl+V keeps pasting natively. */
    const onCustomKey = (ev) => {
      if (ev.type !== "keydown") return true;
      if (!(ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey)) return true;
      const k = ev.key.toLowerCase();
      if (k === "c") {
        if (typeof navigator.clipboard?.writeText === "function" && term.hasSelection()) {
          writeClipboard(term.getSelection());
        }
        return false;
      }
      if (k === "v") {
        if (typeof navigator.clipboard?.readText === "function") {
          navigator.clipboard
            .readText()
            .then((text) => {
              if (text) term.paste(text);
            })
            .catch(() => {});
        }
        return false;
      }
      return true;
    };
    term.attachCustomKeyEventHandler(onCustomKey);
    term.element.addEventListener("mouseup", copySelection);
    term.element.addEventListener("contextmenu", pasteClipboard);

    return () => {
      term.element.removeEventListener("mouseup", copySelection);
      term.element.removeEventListener("contextmenu", pasteClipboard);
      ws.onclose = null;
      ws.close();
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
    };
  }, [tab.id]);


  /* activate: fit (dimensions may have settled) + focus */
  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch { /* not mounted */ }
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active]);

  /* resize with the panel (only the visible pane can fit) */
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (!active) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
        } catch { /* not mounted */ }
      });
    });
    ro.observe(host);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [active]);

  return React.createElement("div", {
    className: "dshTermPane" + (active ? " isActive" : ""),
    ref: hostRef,
    onMouseDown: () => {
      if (active) termRef.current?.focus();
    },
  });
}

/* Codex-style bottom terminal panel: collapsed 34px bar, expanded full-width
 * draggable panel. Ctrl+` toggles. Height persists across reloads. */
function TerminalPanel(props) {
  const { useEffect, useRef, useState, useCallback } = React;
  const { sessionId, useSessions, useWorkspaces } = props ?? {};
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) === "1";
    } catch { /* storage unavailable */ }
    return false;
  });
  /* persist the panel position so a session switch restores the user's last
   * manual expand/collapse choice instead of force-opening the panel */
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    } catch { /* storage unavailable */ }
  }, [open]);
  /** cwd of the DSH session this panel is mounted in. Prefer the workspace
   *  membership (what the user sees on screen - the workspace the session
   *  lives in), then the session summary cwd, then the parent session's cwd
   *  (subagent rows carry no cwd of their own). New tabs are spawned there
   *  instead of the server's process.cwd(), so a server restart no longer
   *  strands new terminals in the launch directory. The owning sessionId is
   *  also sent with every create request so the host can fall back to the
   *  workspace registry when all client-side lookups come up empty. */
  const workspacePath = useWorkspaces((s) =>
    Array.isArray(s?.items)
      ? s.items.find((w) => Array.isArray(w?.sessionIds) && w.sessionIds.includes(sessionId))?.path
      : undefined,
  );
  const sessionCwd = useSessions((s) => {
    const row = s?.byId?.[sessionId];
    if (typeof row?.cwd === 'string' && row.cwd.length > 0) return row.cwd;
    if (typeof row?.parentId === 'string') {
      const parent = s.byId[row.parentId];
      if (typeof parent?.cwd === 'string' && parent.cwd.length > 0) return parent.cwd;
    }
    return undefined;
  });
  const workspaceCwd = typeof workspacePath === 'string' && workspacePath.length > 0 ? workspacePath : sessionCwd;
  /** tabs: [{id, title, shell, exited}] in strip order */
  const [tabs, setTabs] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [busy, setBusy] = useState(false);
  /** panel toggle shortcut, parsed from the host /config response */
  const DEFAULT_SHORTCUT = parseShortcut("ctrl+`");
  const [shortcut, setShortcut] = useState(DEFAULT_SHORTCUT);
  const shortcutLabel = shortcut?.label ?? "Ctrl+`";

  const [height, setHeight] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(HEIGHT_KEY));
      if (Number.isFinite(saved) && saved >= MIN_HEIGHT) return saved;
    } catch { /* storage unavailable */ }
    return Math.round(window.innerHeight * 0.36);
  });
  const heightRef = useRef(height);
  heightRef.current = height;
  const bootOnce = useRef(false);
  const [bootReady, setBootReady] = useState(false);
  const openHandled = useRef(false);
  /** normalized workspace path this mount has already followed (activate-or-create);
   *  guards the follow effect so a settling mount never re-fires it */
  const followHandledRef = useRef(null);
  /** settings modal: lists every workspace with a per-workspace auto-open toggle */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState([]);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  /* normalized-path -> autoOpen boolean, mirroring localStorage for the open
   * settings modal (a toggle flips both in one go) */
  const [autofollowMap, setAutofollowMap] = useState({});
  const readAutofollowMap = useCallback((wsList) => {
    const map = {};
    for (const w of wsList) {
      if (typeof w?.path === "string") map[normPath(w.path)] = getAutofollow(normPath(w.path));
    }
    setAutofollowMap(map);
  }, []);
  const refreshWorkspaces = useCallback(async () => {
    try {
      const data = await api("/workspaces");
      const list = Array.isArray(data?.workspaces) ? data.workspaces : [];
      setWorkspaces(list);
      readAutofollowMap(list);
    } catch (err) {
      console.error("[dsh-plugin-terminal] list workspaces failed:", err);
      setWorkspaces([]);
    } finally {
      setWorkspacesLoaded(true);
    }
  }, [readAutofollowMap]);
  const toggleAutofollow = useCallback((norm) => {
    setAutofollowMap((prev) => {
      const next = !(prev[norm] ?? false);
      setAutofollow(norm, next);
      return { ...prev, [norm]: next };
    });
  }, []);
  /* load the workspace list each time the settings panel is opened, so new
   * workspaces show up without needing a plugin/app restart */
  useEffect(() => {
    if (settingsOpen) {
      setWorkspacesLoaded(false);
      refreshWorkspaces();
    }
  }, [settingsOpen, refreshWorkspaces]);
  const rootRef = useRef(null);
  /** conversation-column geometry: the panel never covers the side rails */
  const [geo, setGeo] = useState({ left: 0, width: window.innerWidth });

  /* The terminal bar/panel is pinned to the viewport bottom; the composer card
   * (the nearest ancestor holding the textarea) gets margin-bottom equal to the
   * panel's rendered height, so the input dialog ALWAYS sits above the terminal
   * - collapsed bar (34px) and expanded panel alike. */
  const { useLayoutEffect } = React;
  useLayoutEffect(() => {
    const rootEl = rootRef.current;
    if (rootEl === null) return;
    const host = () => rootEl.closest("[data-conversation-scroll]") ?? rootEl.parentElement;
    const findComposer = () => {
      let el = rootEl.parentElement;
      while (el !== null && el !== document.body) {
        if (el.querySelector("textarea") !== null) return el;
        el = el.parentElement;
      }
      return null;
    };
    let card = null;
    const measure = () => {
      const el = host();
      if (el !== null) {
        const r = el.getBoundingClientRect();
        setGeo({ left: r.left, width: r.width });
      }
      const h = Math.round(rootEl.getBoundingClientRect().height);
      if (card !== null) card.style.marginBottom = h > 0 ? h + "px" : "";
    };
    card = findComposer();
    const el = host();
    const ro = new ResizeObserver(measure);
    if (el !== null) ro.observe(el);
    ro.observe(rootEl);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      if (card !== null) card.style.marginBottom = "";
    };
  }, []);

  const active = tabs.find((t) => t.id === activeId) ?? null;

  /* Restore live sessions on EVERY mount (page load, workspace switch):
   * the panel is injected per-conversation, so switching workspaces remounts
   * this component and tabs/open were lost - the bar showed "no session" even
   * though the host still owns the PTYs. Restore here (attach only, NEVER
   * create - no orphan PTYs from a mount nobody opened); creation happens in
   * the open effect below. */
  useEffect(() => {
    if (bootOnce.current) return;
    bootOnce.current = true;
    (async () => {
      setBusy(true);
      try {
        const list = await api("/sessions");
        /* Restore only LIVE sessions as real tabs. The host keeps exited
         * sessions as persistent (cross-restart) history, but surfacing them
         * all as tabs on every boot just leaves a pile of dead "已退出" tabs
         * that the per-workspace model should instead rebuild on demand. */
        const all = list.sessions ?? [];
        const live = all.filter((x) => !x.exited);
        if (live.length > 0) {
          setTabs(live.map((x) => ({
            id: x.id,
            title: x.title,
            shell: x.shell,
            cwd: typeof x.cwd === 'string' ? x.cwd : null,
            exited: !!x.exited,
          })));
          setActiveId(live[live.length - 1].id);
        }
      } catch (err) {
        console.error("[dsh-plugin-terminal] restore failed:", err);
      } finally {
        setBusy(false);
        setBootReady(true);
      }
    })();
  }, []);

  /* first open with no restored tabs: create one session. openHandled guards
   * so closing the last tab does NOT auto-create - only a fresh open does.
   * Honors the workspace auto-open toggle: with it OFF (default) opening the
   * panel never spawns a terminal - the user creates one via +. */
  useEffect(() => {
    if (!open) {
      openHandled.current = false;
      return;
    }
    if (!bootReady || tabs.length > 0 || openHandled.current) return;
    if (typeof workspaceCwd !== "string" || workspaceCwd.length === 0 || !getAutofollow(normPath(workspaceCwd))) return;
    openHandled.current = true;
    newTab();
  }, [open, bootReady, tabs.length, workspaceCwd]);

  /* fetch the host-side plugin config: the toggle shortcut (and, for future
   * use, the configured shell command). Falls back to the defaults when the
   * route is absent (older host). */
  useEffect(() => {
    (async () => {
      try {
        const cfg = await api("/config");
        if (typeof cfg.toggleShortcut === "string" && cfg.toggleShortcut.trim().length > 0) {
          const parsed = parseShortcut(cfg.toggleShortcut);
          if (parsed !== null) setShortcut(parsed);
          else console.warn("[dsh-plugin-terminal] ignoring invalid toggleShortcut:", cfg.toggleShortcut);
        }
      } catch {
        /* older host without /config - keep defaults */
      }
    })();
  }, []);

  /* configurable toggle shortcut (default Ctrl+`, e.g. ctrl+j). When the
   * shortcut is a control character the terminal also consumes (Ctrl+J is
   * the shell's line feed), a press with focus inside a terminal pane is
   * left to the shell instead of toggling the panel. */
  useEffect(() => {
    const onKey = (e) => {
      if (!matchesShortcut(shortcut, e)) return;
      if (e.target instanceof HTMLElement && e.target.closest(".dshTermPane") !== null) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcut]);

  /* x on a tab: delete session, drop tab, activate a neighbor. Also marks the
   * panel as user-managed so an emptied strip does NOT auto-create a fresh
   * terminal (only a fresh open does). */
  const closeTab = useCallback(async (id) => {
    openHandled.current = true;
    setTabs((cur) => {
      const idx = cur.findIndex((t) => t.id === id);
      if (idx === -1) return cur;
      const next = cur.filter((t) => t.id !== id);
      setActiveId((act) => {
        if (act !== id) return act;
        if (next.length === 0) return null;
        return (next[Math.min(idx, next.length - 1)] ?? next[0]).id;
      });
      return next;
    });
    await del("/sessions/" + id);
  }, []);

  /* A live tab whose process died on its own is auto-closed: the dead pane is
   * useless and only blocks the body below. Restored history tabs carry
   * wasLive=false and stay open so they can still be restarted. */
  const onExit = useCallback((id, wasLive) => {
    if (wasLive) closeTab(id);
    else setTabs((cur) => cur.map((t) => (t.id === id ? { ...t, exited: true } : t)));
  }, [closeTab]);

  /* + button: new session in a new tab, spawned in the current workspace.
   *  sessionId rides along so the host can resolve the workspace path through
   *  the DSH workspace registry when the client-side cwd lookup failed. */
  const newTab = useCallback(async () => {
    setBusy(true);
    try {
      const cwd = workspaceCwd ?? active?.cwd;
      const s = await post("/sessions", { cwd, sessionId });
      setTabs((cur) => [...cur, { id: s.id, title: s.title, shell: s.shell, cwd: s.cwd ?? cwd, exited: false }]);
      setActiveId(s.id);
    } catch (err) {
      console.error("[dsh-plugin-terminal] new tab failed:", err);
    } finally {
      setBusy(false);
    }
  }, [workspaceCwd, active?.cwd, sessionId]);

  /* Follow the CURRENT workspace: once boot restore is done and this mount's
   * workspace path is known, activate the live terminal already rooted there,
   * or create one when none is alive. This ONLY runs when auto-open is enabled
   * for that workspace (settings panel toggle) - defaults to OFF so switching
   * workspaces does not spawn terminals from nowhere. Runs once per mount per
   * workspace (guarded by followHandledRef); the open effect's auto-create is
   * pre-empted via openHandled so a fresh workspace never spawns two PTYs. */
  useEffect(() => {
    if (!bootReady) return;
    if (typeof workspaceCwd !== "string" || workspaceCwd.length === 0) return;
    const key = normPath(workspaceCwd);
    if (followHandledRef.current === key) return;
    followHandledRef.current = key;
    /* user turned auto-open OFF for this workspace: never spawn/activate on
     * switch - terminals are created manually via +. */
    if (!getAutofollow(key)) return;
    /* One live terminal per workspace: a tab whose process died while its pane
     * was unmounted (panel collapsed, or a different workspace on screen) comes
     * back from the host as restored history (exited) on the next mount. Drop
     * those dead tabs here so they never linger beside a fresh replacement as a
     * "已退出" duplicate - the live tab below is the only one that should stay. */
    for (const dead of tabs.filter((t) => t.exited && normPath(t.cwd) === key)) {
      closeTab(dead.id);
    }
    const live = tabs.find((t) => !t.exited && normPath(t.cwd) === key);
    if (live) {
      setActiveId(live.id);
    } else {
      newTab();
    }
    /* Leave the panel's expand/collapse state to the user: switching sessions
     * restores the last manual position (via the persisted `open` pref) instead
     * of force-opening. We only activate-or-create the workspace terminal. */
    openHandled.current = true;
  }, [bootReady, workspaceCwd, tabs, newTab, closeTab]);

  /* header refresh: restart the active tab IN PLACE via the host restart
   * route, which respawns the shell and INHERITS the old scrollback - the
   * terminal keeps its history AND its tab name (server-side session counter
   * increments on every spawn, so using the fresh title would look like
   * "zsh 1 -> zsh 2 -> zsh 3", i.e. as if a new terminal was created
   * instead of restarted). Only the + button appends a genuinely new tab. */
  const restartActive = useCallback(async () => {
    if (active === null) return;
    setBusy(true);
    try {
      /* prefer the tab's own persisted cwd (a tab may belong to a different
       * workspace than the one currently on screen); legacy tabs without a
       * persisted cwd fall back to the current workspace. */
      const s = await post("/sessions/" + active.id + "/restart", { cwd: active.cwd ?? workspaceCwd });
      setTabs((cur) => cur.map((t) => (t.id === active.id ? { id: s.id, title: active.title, shell: s.shell, cwd: s.cwd ?? active.cwd ?? workspaceCwd, exited: false } : t)));
      setActiveId(s.id);
    } catch (err) {
      console.error("[dsh-plugin-terminal] restart failed:", err);
    } finally {
      setBusy(false);
    }
  }, [active, workspaceCwd]);

  /* drag the resize grip: grow the panel upward */
  const startResize = useCallback((e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = heightRef.current;
    const maxH = Math.round(window.innerHeight * 0.78);
    const move = (ev) => {
      const h = Math.min(maxH, Math.max(MIN_HEIGHT, startH + (startY - ev.clientY)));
      setHeight(Math.round(h));
    };
    const up = () => {
      document.body.classList.remove("dshTermResizing");
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      try {
        localStorage.setItem(HEIGHT_KEY, String(heightRef.current));
      } catch { /* storage unavailable */ }
    };
    document.body.classList.add("dshTermResizing");
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }, []);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  const stateLabel = busy
    ? "启动中…"
    : active === null
      ? tabs.length === 0 ? "无会话" : "空闲"
      : active.exited ? tabLabel(active) + " 已退出，点 ⟳ 重启" : tabLabel(active);

  const settingsModal = React.createElement(
    "div",
    { className: "dshTermSettings", onClick: (e) => { if (e.target === e.currentTarget) setSettingsOpen(false); } },
    React.createElement(
      "div",
      { className: "dshTermSettingsCard", role: "dialog", "aria-modal": "true" },
      React.createElement(
        "div",
        { className: "dshTermSettingsHead" },
        React.createElement("span", { className: "dshTermSettingsTitle" }, "终端设置 — 各工作区自动打开"),
        React.createElement(
          "button",
          { className: "dshTermBarAction", title: "关闭", "aria-label": "关闭", onClick: () => setSettingsOpen(false) },
          Close14(),
        ),
      ),
      React.createElement(
        "div",
        { className: "dshTermSettingsHint" },
        "开启后，切换到该工作区会自动打开（或激活）它的终端；关闭（默认）则仅手动创建，不自动打开，以节省资源。",
      ),
      React.createElement(
        "div",
        { className: "dshTermSettingsList" },
        !workspacesLoaded
          ? React.createElement("div", { className: "dshTermSettingsRow dshTermSettingsMuted" }, "加载中…")
          : workspaces.length === 0
            ? React.createElement("div", { className: "dshTermSettingsRow dshTermSettingsMuted" }, "还没有工作区。")
            : workspaces.map((w) => {
                const norm = normPath(w.path);
                const on = autofollowMap[norm] ?? false;
                return React.createElement(
                  "label",
                  { key: w.id ?? w.path, className: "dshTermSettingsRow" },
                  React.createElement(
                    "span",
                    { className: "dshTermSettingsName" },
                    React.createElement("span", { className: "dshTermSettingsDir" }, w.title || ""),
                    React.createElement("span", { className: "dshTermSettingsPath" }, w.path || ""),
                  ),
                  React.createElement(
                    "button",
                    {
                      className: "dshTermSettingsToggle" + (on ? " isOn" : ""),
                      role: "switch",
                      "aria-checked": on,
                      title: on ? "已开启自动打开" : "已关闭自动打开",
                      onClick: () => toggleAutofollow(norm),
                    },
                    React.createElement("span", { className: "dshTermSettingsToggleKnob", "aria-hidden": true }),
                  ),
                );
              }),
      ),
    ),
  );

  return React.createElement(
    "div",
    { className: "dshTermRoot", ref: rootRef, style: { left: geo.left + "px", width: geo.width + "px" } },
    open
      ? React.createElement(
          "div",
          { className: "dshTermPanel", id: "dshTermPanel", style: { height: height + "px" } },
          React.createElement("div", {
            className: "dshTermResize",
            title: "拖动调整高度",
            onPointerDown: startResize,
          }),
          /* single merged header row: lead + scrollable tabs + new + state + restart + collapse */
          React.createElement(
            "div",
            { className: "dshTermTabs" },
            React.createElement("span", { className: "dshTermTabsLead", "aria-hidden": true }, TerminalGlyph14()),
            React.createElement(
              "div",
              { className: "dshTermTabsScroll", role: "tablist" },
              ...tabs.map((t) =>
                React.createElement(
                  "button",
                  {
                    key: t.id,
                    role: "tab",
                    "aria-selected": t.id === activeId,
                    className: "dshTermTab" + (t.id === activeId ? " isActive" : "") + (t.exited ? " isExited" : ""),
                    title: t.exited ? tabLabel(t) + " (已退出)" : tabLabel(t),
                    onClick: () => setActiveId(t.id),
                  },
                  React.createElement("span", { className: "dshTermTabLead", "aria-hidden": true }, TerminalGlyph12()),
                  React.createElement("span", { className: "dshTermTabLabel" }, tabLabel(t)),
                  React.createElement(
                    "span",
                    {
                      className: "dshTermTabClose",
                      role: "button",
                      title: "关闭 " + tabLabel(t),
                      onClick: (e) => {
                        e.stopPropagation();
                        closeTab(t.id);
                      },
                    },
                    Close14(),
                  ),
                ),
              ),
            ),
            React.createElement(
              "button",
              {
                className: "dshTermNew",
                title: "新建终端",
                "aria-label": "新建终端",
                disabled: busy,
                onClick: newTab,
              },
              Plus12(),
            ),
            React.createElement("span", { className: "dshTermTabsState", title: stateLabel }, stateLabel),
            /* restart must be reachable for exited history tabs too */
            active !== null
              ? React.createElement(
                  "button",
                  { className: "dshTermBarAction", title: active.exited ? "重启进程（保留标签位）" : "重启当前会话", "aria-label": "重启当前会话", disabled: busy, onClick: restartActive },
                  Refresh14(),
                )
              : null,
            React.createElement(
              "button",
              { className: "dshTermBarAction", title: "终端设置（各工作区自动打开）", "aria-label": "终端设置", onClick: () => setSettingsOpen(true) },
              Settings14(),
            ),
            React.createElement(
              "button",
              {
                className: "dshTermCollapse",
                title: "收起面板（" + shortcutLabel + "）",
                "aria-label": "收起面板",
                onClick: toggle,
              },
              ChevronDown14(),
            ),
          ),
          React.createElement(
            "div",
            { className: "dshTermBody" },
            ...tabs.map((t) =>
              React.createElement(TermPane, {
                key: t.id,
                tab: t,
                active: t.id === activeId,
                onExit,
              }),
            ),
            tabs.length === 0
              ? React.createElement(
                  "div",
                  { className: "dshTermEmpty" },
                  React.createElement("span", null, "没有终端会话"),
                  React.createElement(
                    "button",
                    { className: "dshTermEmptyBtn", onClick: newTab },
                    Plus12(),
                    "新建终端",
                  ),
                )
              : null,
          ),
        )
      : React.createElement(
          "div",
          {
            className: "dshTermBar",
            role: "button",
            tabIndex: 0,
            "aria-expanded": open,
            "aria-controls": "dshTermPanel",
            title: "终端面板（" + shortcutLabel + " 切换）",
            onClick: toggle,
            onKeyDown: (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggle();
              }
            },
          },
          React.createElement("span", { className: "dshTermBarLead", "aria-hidden": true }, TerminalGlyph14()),
          React.createElement("span", { className: "dshTermBarTitle" }, "终端" + (tabs.length > 1 ? " · " + tabs.length : "")),
          React.createElement("span", { className: "dshTermBarState" }, stateLabel),
          React.createElement(
            "span",
            { className: "dshTermBarActions", onClick: (e) => e.stopPropagation() },
            active !== null
              ? React.createElement(
                  "button",
                  { className: "dshTermBarAction", title: active.exited ? "重启进程（保留标签位）" : "重启当前会话", "aria-label": "重启当前会话", disabled: busy, onClick: restartActive },
                  Refresh14(),
                )
              : null,
            React.createElement(
              "button",
              { className: "dshTermBarAction", title: "终端设置（各工作区自动打开）", "aria-label": "终端设置", onClick: () => setSettingsOpen(true) },
              Settings14(),
            ),
          ),
          React.createElement("span", { className: "dshTermBarChevron", "aria-hidden": true }, ChevronUp14()),
        ),
    settingsOpen ? settingsModal : null,
  );
}
export { TerminalPanel };
