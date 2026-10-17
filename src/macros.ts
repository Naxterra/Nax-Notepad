// Keyboard macros: recording key presses and typed text, and replaying them through the
// editor's own key handling, so undo, read-only mode and auto-closing brackets apply as if
// the keys were typed.
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { isAltGr } from "./keymap";

export type MacroStep =
  | { type: "text"; text: string }
  | { type: "key"; key: string; code: string; ctrl?: boolean; shift?: boolean; alt?: boolean }
  | { type: "cmd"; id: string };

export interface Macro {
  name: string;
  steps: MacroStep[];
}

interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  getModifierState?: (k: string) => boolean;
}

const IGNORED = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock", "Dead", "Process", "Unidentified", "NumLock", "ScrollLock", "ContextMenu", "OS"]);

/** Clipboard and undo keys are handled natively; macros store them as commands. */
const NATIVE_CMDS: Record<string, string> = { c: "edit.copy", x: "edit.cut", v: "edit.paste", a: "edit.selectAll", z: "edit.undo", y: "edit.redo" };

/** The macro step for a key press in the editor, or null if the key is not recorded. */
export function stepForKey(e: KeyLike): MacroStep | null {
  if (e.isComposing || IGNORED.has(e.key)) return null;
  const altGr = isAltGr(e);
  const ctrl = (e.ctrlKey || !!e.metaKey) && !altGr;
  const alt = e.altKey && !altGr;
  if (!ctrl && !alt && e.key.length === 1) return { type: "text", text: e.key };
  if (ctrl && !alt) {
    const k = e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
    if (!e.shiftKey && NATIVE_CMDS[k]) return { type: "cmd", id: NATIVE_CMDS[k] };
    if (e.shiftKey && k === "z") return { type: "cmd", id: "edit.redo" };
  }
  const step: MacroStep = { type: "key", key: e.key, code: e.code };
  if (ctrl) step.ctrl = true;
  if (e.shiftKey) step.shift = true;
  if (alt) step.alt = true;
  return step;
}

/** Append a step, merging consecutive typed text. */
export function addStep(steps: MacroStep[], step: MacroStep): void {
  const last = steps[steps.length - 1];
  if (step.type === "text" && last?.type === "text") last.text += step.text;
  else steps.push(step.type === "text" ? { ...step } : step);
}

/** Type text as if from the keyboard (input handlers such as auto-close brackets run). */
export function typeText(view: EditorView, text: string): void {
  for (const ch of text) {
    const { from, to } = view.state.selection.main;
    const insert = () => view.state.update(view.state.replaceSelection(ch), { userEvent: "input.type", scrollIntoView: true });
    const handled = view.state.facet(EditorView.inputHandler).some((h) => h(view, from, to, ch, insert));
    if (!handled) view.dispatch(insert());
  }
}

/** Run a recorded key through the editor's keymaps. */
export function pressKey(view: EditorView, s: Extract<MacroStep, { type: "key" }>): boolean {
  const ev = new KeyboardEvent("keydown", { key: s.key, code: s.code, ctrlKey: !!s.ctrl, shiftKey: !!s.shift, altKey: !!s.alt, bubbles: true, cancelable: true });
  return runScopeHandlers(view, ev, "editor");
}

export interface PlayContext {
  view(): EditorView;
  runCommand(id: string): unknown;
}

/** Replay the steps once. */
export async function playSteps(steps: MacroStep[], ctx: PlayContext): Promise<void> {
  for (const s of steps) {
    if (s.type === "text") typeText(ctx.view(), s.text);
    else if (s.type === "key") pressKey(ctx.view(), s);
    else await ctx.runCommand(s.id);
  }
}

/** Short readable description of a macro (for lists). */
export function describeSteps(steps: MacroStep[], max = 60): string {
  const parts = steps.map((s) => {
    if (s.type === "text") return JSON.stringify(s.text);
    if (s.type === "cmd") return s.id;
    return (s.ctrl ? "Ctrl+" : "") + (s.alt ? "Alt+" : "") + (s.shift ? "Shift+" : "") + s.key;
  });
  const text = parts.join(" ");
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}
