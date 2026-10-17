// Keyboard shortcut editor: preset choice, per-command keys and conflict detection.
import { Command, setKeyCapture } from "../commands";
import { lang, t } from "../i18n";
import { chordFromEvent, displayChord, effectiveKey, findConflicts, normalizeChord, PRESETS } from "../keymap";
import { settings, updateSettings } from "../settings";
import { h, showModal } from "./dialogs";

export function openShortcutDialog(cmds: Command[], apply: () => void): void {
  let preset = settings.keymapPreset;
  const overrides: Record<string, string> = { ...settings.keyOverrides };
  const keyOf = (c: Command) => effectiveKey(c, preset, overrides);

  const presetSel = h("select", { class: "input" }) as HTMLSelectElement;
  for (const p of PRESETS) presetSel.append(h("option", { value: p.id }, p.label));
  presetSel.value = preset;
  const filter = h("input", { class: "input wide", type: "text", placeholder: t("Filter by command or key") }) as HTMLInputElement;
  const summary = h("div", { class: "keys-summary" });
  const list = h("div", { class: "keys-list" });

  let capturing: { c: Command; cell: HTMLElement } | null = null;

  const stopCapture = () => {
    capturing = null;
    setKeyCapture(null);
  };

  const render = () => {
    const bindings = cmds.map((c) => ({ id: c.id, key: keyOf(c) }));
    const conflicts = findConflicts(bindings);
    const conflictOf = new Map<string, string[]>();
    for (const ids of conflicts.values()) for (const id of ids) conflictOf.set(id, ids.filter((x) => x !== id));
    summary.textContent = conflicts.size ? t("{n} key conflicts (marked red). Only the first command of a conflict runs.", { n: conflicts.size }) : t("No conflicts.");
    summary.classList.toggle("bad", conflicts.size > 0);
    const q = filter.value.trim().toLowerCase();
    list.replaceChildren();
    for (const c of cmds) {
      const key = keyOf(c);
      const text = `${c.category} ${c.title} ${key ?? ""} ${key ? displayChord(key, lang) : ""}`.toLowerCase();
      if (q && !text.includes(q)) continue;
      const others = conflictOf.get(c.id);
      const keyCell = h("span", { class: "keys-key" + (others ? " conflict" : "") }, key ? displayChord(key, lang) : "—");
      if (others) keyCell.title = t("Also used by: {names}", { names: others.map((id) => cmds.find((x) => x.id === id)?.title ?? id).join(", ") });
      const changed = Object.prototype.hasOwnProperty.call(overrides, c.id);
      const row = h(
        "div",
        { class: "keys-row" + (changed ? " changed" : "") },
        h("span", { class: "keys-cat" }, c.category),
        h("span", { class: "keys-title" }, c.title),
        keyCell,
        c.native
          ? h("span", { class: "keys-note" }, t("fixed"))
          : h(
              "span",
              { class: "keys-actions" },
              h("button", { class: "btn small", click: () => startCapture(c, keyCell) }, t("Change")),
              h(
                "button",
                {
                  class: "btn small",
                  title: t("Remove the key"),
                  click: () => {
                    overrides[c.id] = "";
                    render();
                  },
                },
                "✕"
              ),
              h(
                "button",
                {
                  class: "btn small",
                  title: t("Back to the preset key"),
                  disabled: !changed,
                  click: () => {
                    delete overrides[c.id];
                    render();
                  },
                },
                "↺"
              )
            )
      );
      list.append(row);
    }
  };

  const startCapture = (c: Command, cell: HTMLElement) => {
    stopCapture();
    capturing = { c, cell };
    cell.textContent = t("Press a key combination… (Esc cancels)");
    cell.classList.add("capturing");
    setKeyCapture((e) => {
      if (!capturing) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        stopCapture();
        render();
        return;
      }
      const chord = chordFromEvent(e);
      if (!chord) return; // modifier only, wait for the key
      const target = capturing.c;
      stopCapture();
      // Store only differences from the preset.
      const presetKey = effectiveKey(target, preset, {});
      if (presetKey && normalizeChord(presetKey) === normalizeChord(chord)) delete overrides[target.id];
      else overrides[target.id] = chord;
      render();
    });
  };

  presetSel.addEventListener("change", () => {
    preset = presetSel.value;
    render();
  });
  filter.addEventListener("input", render);

  const box = h(
    "div",
    { class: "modal keys" },
    h("div", { class: "modal-title" }, t("Keyboard Shortcuts")),
    h("label", { class: "settings-row" }, h("span", { class: "settings-label" }, t("Preset")), presetSel),
    filter,
    summary,
    list,
    h(
      "div",
      { class: "modal-buttons" },
      h(
        "button",
        {
          class: "btn",
          click: () => {
            for (const k of Object.keys(overrides)) delete overrides[k];
            render();
          },
        },
        t("Reset all to preset")
      ),
      h(
        "button",
        {
          class: "btn primary",
          click: () => {
            updateSettings({ keymapPreset: preset, keyOverrides: { ...overrides } }, { silent: true });
            apply();
            close();
          },
        },
        t("Save")
      ),
      h("button", { class: "btn", click: () => close() }, t("Cancel"))
    )
  );
  box.addEventListener("keydown", (e) => {
    if (capturing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
  const close = showModal(box, () => stopCapture());
  render();
  filter.focus();
}
