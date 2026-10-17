import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { backend, errorText } from "../backend";
import { DATA_KEYS, DEFAULTS, EXPORT_DATA_KEYS, Settings, settings, updateSettings, validSettings } from "../settings";
import { THEMES } from "../theme";
import { closeModal, h, message, showModal, toast } from "./dialogs";
import { t } from "../i18n";

type Field =
  | { key: keyof Settings; label: string; type: "bool" }
  | { key: keyof Settings; label: string; type: "number"; min: number; max: number }
  | { key: keyof Settings; label: string; type: "text" }
  | { key: keyof Settings; label: string; type: "select"; options: { value: string; label: string }[] };

const sections: { title: string; fields: Field[] }[] = [
  {
    title: "Appearance",
    fields: [
      { key: "theme", label: "Theme", type: "select", options: [{ value: "system", label: "Follow Windows (dark/light)" }, ...THEMES.map((t) => ({ value: t.id, label: t.name }))] },
      { key: "fontFamily", label: "Editor font", type: "text" },
      { key: "fontSize", label: "Font size", type: "number", min: 6, max: 72 },
      { key: "previewFontFamily", label: "Live Preview font", type: "text" },
      { key: "showMenuBar", label: "Show menu bar (Alt toggles)", type: "bool" },
      { key: "language", label: "Language (restarts the window)", type: "select", options: [{ value: "system", label: "System language" }, { value: "en", label: "English" }, { value: "de", label: "German" }] },
    ],
  },
  {
    title: "Editing",
    fields: [
      { key: "tabSize", label: "Tab size", type: "number", min: 1, max: 16 },
      { key: "insertSpaces", label: "Insert spaces instead of tabs", type: "bool" },
      { key: "detectIndent", label: "Detect indentation from file content", type: "bool" },
      { key: "wordWrap", label: "Word wrap", type: "bool" },
      { key: "lineNumbers", label: "Line numbers", type: "bool" },
      { key: "highlightActiveLine", label: "Highlight current line", type: "bool" },
      { key: "indentationMarkers", label: "Indentation guides", type: "bool" },
      { key: "showWhitespace", label: "Show whitespace", type: "bool" },
      { key: "showEol", label: "Show line endings", type: "bool" },
      { key: "bracketMatching", label: "Highlight matching brackets", type: "bool" },
      { key: "autoCloseBrackets", label: "Auto-close brackets and quotes", type: "bool" },
      { key: "keymapPreset", label: "Keyboard preset", type: "select", options: [{ value: "nax", label: "Nax-Notepad" }, { value: "npp", label: "Notepad++" }] },
    ],
  },
  {
    title: "Files",
    fields: [
      { key: "defaultEol", label: "Line endings for new files", type: "select", options: [{ value: "CRLF", label: "Windows (CRLF)" }, { value: "LF", label: "Unix (LF)" }, { value: "CR", label: "Classic Mac (CR)" }] },
      { key: "defaultEncoding", label: "Encoding for new files", type: "select", options: ["UTF-8", "UTF-8-BOM", "UTF-16LE", "windows-1252"].map((v) => ({ value: v, label: v })) },
      { key: "trimTrailingOnSave", label: "Trim trailing whitespace on save", type: "bool" },
      { key: "ensureFinalNewline", label: "Ensure final newline on save", type: "bool" },
      { key: "autoReloadExternal", label: "Reload unmodified files changed on disk", type: "bool" },
      { key: "restoreSession", label: "Restore tabs and unsaved text on start", type: "bool" },
      { key: "pagedWindowLines", label: "Lines per page for huge files", type: "number", min: 500, max: 50000 },
    ],
  },
  {
    title: "Markdown",
    fields: [
      { key: "livePreviewDefault", label: "Open Markdown files in Live Preview", type: "bool" },
      { key: "previewMaxWidth", label: "Readable line width in px (0 = full width)", type: "number", min: 0, max: 5000 },
    ],
  },
  {
    title: "Updates",
    fields: [{ key: "checkUpdates", label: "Check for updates on start (once a day)", type: "bool" }],
  },
];

export interface SettingsDialogActions {
  openShortcuts?: () => void;
  nppImport?: () => void;
  exportSettings?: () => void;
  importSettings?: () => void;
  /** Called after the keyboard preset changed. */
  keymapChanged?: () => void;
}

export function openSettingsDialog(actions: SettingsDialogActions = {}): void {
  const body = h("div", { class: "settings-body" });
  for (const sec of sections) {
    body.append(h("h3", {}, t(sec.title)));
    for (const f of sec.fields) {
      let control: HTMLElement;
      const cur = settings[f.key];
      if (f.type === "bool") {
        const cb = h("input", { type: "checkbox" }) as HTMLInputElement;
        cb.checked = Boolean(cur);
        cb.addEventListener("change", () => updateSettings({ [f.key]: cb.checked } as Partial<Settings>));
        control = cb;
      } else if (f.type === "number") {
        const inp = h("input", { class: "input", type: "number", min: String(f.min), max: String(f.max) }) as HTMLInputElement;
        inp.value = String(cur);
        inp.addEventListener("change", () => {
          const v = Math.max(f.min, Math.min(f.max, Number(inp.value) || Number(DEFAULTS[f.key])));
          inp.value = String(v);
          updateSettings({ [f.key]: v } as Partial<Settings>);
        });
        control = inp;
      } else if (f.type === "text") {
        const inp = h("input", { class: "input wide", type: "text" }) as HTMLInputElement;
        inp.value = String(cur);
        inp.addEventListener("change", () => updateSettings({ [f.key]: inp.value || DEFAULTS[f.key] } as Partial<Settings>));
        control = inp;
      } else {
        const sel = h("select", { class: "input" }) as HTMLSelectElement;
        for (const o of f.options) sel.append(h("option", { value: o.value }, t(o.label)));
        sel.value = String(cur);
        sel.addEventListener("change", () => {
          updateSettings({ [f.key]: sel.value } as Partial<Settings>);
          if (f.key === "language") window.dispatchEvent(new CustomEvent("nax:reload"));
          if (f.key === "keymapPreset") actions.keymapChanged?.();
        });
        control = sel;
      }
      body.append(h("label", { class: "settings-row" }, h("span", { class: "settings-label" }, t(f.label)), control));
    }
  }
  const linkBtn = (label: string, fn?: () => void) =>
    fn
      ? h(
          "button",
          {
            class: "btn small",
            click: () => {
              closeModal();
              fn();
            },
          },
          label
        )
      : null;
  body.append(
    h("h3", {}, t("More")),
    h(
      "div",
      { class: "settings-actions" },
      linkBtn(t("Keyboard Shortcuts…"), actions.openShortcuts),
      linkBtn(t("Import from Notepad++…"), actions.nppImport),
      linkBtn(t("Export Settings…"), actions.exportSettings),
      linkBtn(t("Import Settings…"), actions.importSettings)
    )
  );
  const box = h(
    "div",
    { class: "modal settings" },
    h("div", { class: "modal-title" }, t("Settings")),
    body,
    h(
      "div",
      { class: "modal-buttons" },
      h(
        "button",
        {
          class: "btn",
          title: t("Shortcuts, macros, recent files and search history are kept."),
          click: () => {
            const defaults: Partial<Settings> = { ...DEFAULTS };
            for (const k of DATA_KEYS) delete defaults[k];
            updateSettings(defaults);
            closeModal();
            openSettingsDialog(actions);
          },
        },
        t("Reset to defaults")
      ),
      h("button", { class: "btn primary", click: () => closeModal() }, t("Close"))
    )
  );
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeModal();
    }
  });
  showModal(box);
  (box.querySelector("input,select") as HTMLElement | null)?.focus();
}

/** Write the preferences, shortcuts and macros to a JSON file. */
export async function exportSettings(): Promise<void> {
  const target = await saveDialog({ defaultPath: "nax-notepad-settings.json", title: t("Export Settings"), filters: [{ name: "JSON", extensions: ["json"] }] });
  if (!target) return;
  const out: Record<string, unknown> = { app: "Nax-Notepad", kind: "settings", version: 1 };
  for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    if (DATA_KEYS.includes(k) && !EXPORT_DATA_KEYS.includes(k)) continue;
    out[k] = settings[k];
  }
  try {
    await backend.writeTextFile(target, JSON.stringify(out, null, 2));
    toast(t("Settings exported."));
  } catch (e) {
    await message(t("Export Settings"), errorText(e));
  }
}

/** Read settings from a JSON file written by Export Settings. Returns true if anything changed. */
export async function importSettings(onApplied: () => void): Promise<void> {
  const sel = await openDialog({ title: t("Import Settings"), filters: [{ name: "JSON", extensions: ["json"] }] });
  if (typeof sel !== "string") return;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await backend.readTextFile(sel, 4 << 20));
  } catch (e) {
    await message(t("Import Settings"), t("The file is not a valid settings file: {error}", { error: errorText(e) }));
    return;
  }
  const valid = validSettings(raw);
  for (const k of DATA_KEYS) if (!EXPORT_DATA_KEYS.includes(k)) delete valid[k];
  const n = Object.keys(valid).length;
  if (!n) {
    await message(t("Import Settings"), t("The file contains no settings for Nax-Notepad."));
    return;
  }
  const langChanged = valid.language !== undefined && valid.language !== settings.language;
  updateSettings(valid);
  onApplied();
  toast(t("{n} settings imported.", { n }));
  if (langChanged) window.dispatchEvent(new CustomEvent("nax:reload"));
}
