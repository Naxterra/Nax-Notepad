import { DEFAULTS, Settings, settings, updateSettings } from "../settings";
import { THEMES } from "../theme";
import { closeModal, h, showModal } from "./dialogs";

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
    ],
  },
  {
    title: "Editing",
    fields: [
      { key: "tabSize", label: "Tab size", type: "number", min: 1, max: 16 },
      { key: "insertSpaces", label: "Insert spaces instead of tabs", type: "bool" },
      { key: "wordWrap", label: "Word wrap", type: "bool" },
      { key: "lineNumbers", label: "Line numbers", type: "bool" },
      { key: "highlightActiveLine", label: "Highlight current line", type: "bool" },
      { key: "indentationMarkers", label: "Indentation guides", type: "bool" },
      { key: "bracketMatching", label: "Highlight matching brackets", type: "bool" },
      { key: "autoCloseBrackets", label: "Auto-close brackets and quotes", type: "bool" },
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
];

export function openSettingsDialog(): void {
  const body = h("div", { class: "settings-body" });
  for (const sec of sections) {
    body.append(h("h3", {}, sec.title));
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
        for (const o of f.options) sel.append(h("option", { value: o.value }, o.label));
        sel.value = String(cur);
        sel.addEventListener("change", () => updateSettings({ [f.key]: sel.value } as Partial<Settings>));
        control = sel;
      }
      body.append(h("label", { class: "settings-row" }, h("span", { class: "settings-label" }, f.label), control));
    }
  }
  const box = h(
    "div",
    { class: "modal settings" },
    h("div", { class: "modal-title" }, "Settings"),
    body,
    h(
      "div",
      { class: "modal-buttons" },
      h(
        "button",
        {
          class: "btn",
          click: () => {
            updateSettings({ ...DEFAULTS });
            closeModal();
            openSettingsDialog();
          },
        },
        "Reset to defaults"
      ),
      h("button", { class: "btn primary", click: () => closeModal() }, "Close")
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
