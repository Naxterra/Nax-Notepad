// "Import from Notepad++": reads the Notepad++ settings folder, shows what can be taken over,
// and applies only what the user ticks. Items that cannot be mapped are listed as skipped.
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { App } from "../app";
import { backend, errorText } from "../backend";
import { Command } from "../commands";
import { t } from "../i18n";
import { Macro } from "../macros";
import { ImportedMacro, ImportedShortcut, parseConfig, parseSession, parseShortcuts, SessionFile, SettingChange } from "../nppimport";
import { settings, Settings, updateSettings } from "../settings";
import { h, message, showModal, toast } from "./dialogs";


interface Loaded {
  dir: string;
  settings: SettingChange[];
  shortcuts: ImportedShortcut[];
  macros: ImportedMacro[];
  files: SessionFile[];
  /** Files from the session that no longer exist. */
  missing: SessionFile[];
  errors: string[];
}

function join(dir: string, name: string): string {
  return dir.replace(/[\\/]+$/, "") + "\\" + name;
}

async function load(dir: string): Promise<Loaded> {
  const out: Loaded = { dir, settings: [], shortcuts: [], macros: [], files: [], missing: [], errors: [] };
  const read = async (name: string) => {
    const p = join(dir, name);
    if (!(await backend.pathExists(p))) return null;
    try {
      return await backend.readTextFile(p);
    } catch (e) {
      out.errors.push(`${name}: ${errorText(e)}`);
      return null;
    }
  };
  const config = await read("config.xml");
  if (config) out.settings = parseConfig(config);
  const shortcuts = await read("shortcuts.xml");
  if (shortcuts) {
    const s = parseShortcuts(shortcuts);
    out.shortcuts = s.shortcuts;
    out.macros = s.macros;
  }
  const session = await read("session.xml");
  if (session) {
    for (const f of parseSession(session)) {
      const exists = f.untitled ? !!f.backup && (await backend.pathExists(f.backup)) : await backend.pathExists(f.path);
      (exists ? out.files : out.missing).push(f);
    }
  }
  return out;
}

export async function openNppImport(app: App, cmds: Command[], applyKeys: () => void, macrosChanged: () => void): Promise<void> {
  let dir = await backend.nppConfigDir();
  if (!dir) {
    const d = await openDialog({ directory: true, title: t("Choose the Notepad++ settings folder (contains config.xml)") });
    if (typeof d !== "string") return;
    dir = d;
  }
  let data: Loaded;
  try {
    data = await load(dir);
  } catch (e) {
    await message(t("Import from Notepad++"), errorText(e));
    return;
  }
  if (!data.settings.length && !data.shortcuts.length && !data.macros.length && !data.files.length) {
    await message(t("Import from Notepad++"), t("No Notepad++ settings were found in {dir}.", { dir }) + (data.errors.length ? "\n\n" + data.errors.join("\n") : ""));
    return;
  }

  const titleOf = (id: string) => cmds.find((c) => c.id === id)?.title ?? id;
  const mappedKeys = data.shortcuts.filter((s) => s.commandId && s.key !== null);
  const unmappedKeys = data.shortcuts.filter((s) => !s.commandId || s.key === null);
  const goodMacros = data.macros.filter((m) => m.steps);
  const badMacros = data.macros.filter((m) => !m.steps);

  const body = h("div", { class: "settings-body" });
  const checks: { box: HTMLInputElement; apply: () => void | Promise<void> }[] = [];
  const section = (title: string) => body.append(h("h3", {}, title));
  const item = (label: string, detail: string, apply: () => void | Promise<void>, on = true) => {
    const box = h("input", { type: "checkbox" }) as HTMLInputElement;
    box.checked = on;
    checks.push({ box, apply });
    body.append(h("label", { class: "import-row" }, box, h("span", {}, label), detail ? h("span", { class: "import-detail" }, detail) : null));
  };
  const note = (text: string) => body.append(h("div", { class: "import-note" }, text));

  body.append(h("div", { class: "import-note" }, t("Source: {dir}", { dir })));

  if (data.settings.length) {
    section(t("Editor settings"));
    for (const s of data.settings) {
      const value = typeof s.value === "boolean" ? (s.value ? t("on") : t("off")) : String(s.value);
      item(`${t(s.label.split(":")[0])}: ${value}`, "", () => updateSettings({ [s.key]: s.value } as Partial<Settings>));
    }
  }
  if (data.files.length || data.missing.length) {
    section(t("Session"));
    const named = data.files.filter((f) => !f.untitled);
    const untitled = data.files.filter((f) => f.untitled);
    if (named.length)
      item(t("Open {n} files from the Notepad++ session", { n: named.length }), named.slice(0, 3).map((f) => f.path).join(", ") + (named.length > 3 ? " …" : ""), async () => {
        for (const f of named) {
          await app.openFiles([f.path], false);
          const tab = app.findByPath(f.path);
          if (tab && f.view === 1 && app.paneIndex(tab) === 0) app.moveToOtherView(tab);
        }
      });
    if (untitled.length)
      item(t('Import {n} unsaved "new" documents as new tabs', { n: untitled.length }), untitled.map((f) => f.path).join(", "), async () => {
        for (const f of untitled) {
          try {
            app.newTab(await backend.readTextFile(f.backup!), false);
          } catch (e) {
            data.errors.push(`${f.path}: ${errorText(e)}`);
          }
        }
      });
    if (data.missing.length) note(t("Skipped {n} session entries whose files no longer exist.", { n: data.missing.length }));
  }
  if (mappedKeys.length) {
    section(t("Keyboard shortcuts"));
    item(t("Use the Notepad++ keyboard preset"), t("Ctrl+L cut line, Ctrl+Shift+L delete line, Ctrl+Q comment, Ctrl+B matching brace, …"), () => updateSettings({ keymapPreset: "npp" }, { silent: true }), settings.keymapPreset !== "npp");
    item(
      t("Take over {n} changed Notepad++ shortcuts", { n: mappedKeys.length }),
      mappedKeys
        .slice(0, 4)
        .map((s) => `${titleOf(s.commandId!)} = ${s.key || t("none")}`)
        .join(", ") + (mappedKeys.length > 4 ? " …" : ""),
      () => {
        const o = { ...settings.keyOverrides };
        for (const s of mappedKeys) o[s.commandId!] = s.key ?? "";
        updateSettings({ keyOverrides: o }, { silent: true });
      }
    );
  }
  if (unmappedKeys.length) note(t("Skipped {n} shortcuts for Notepad++ commands that Nax-Notepad does not have.", { n: unmappedKeys.length }));
  if (goodMacros.length) {
    section(t("Macros"));
    for (const m of goodMacros)
      item(m.name, m.key ? m.key : "", () => {
        const macros: Macro[] = [...settings.macros.filter((x) => x.name !== m.name), { name: m.name, steps: m.steps! }];
        const patch: Partial<Settings> = { macros };
        if (m.key) patch.keyOverrides = { ...settings.keyOverrides, [`macro.user.${m.name}`]: m.key };
        updateSettings(patch, { silent: true });
      });
  }
  if (badMacros.length) note(t("Skipped macros: {list}", { list: badMacros.map((m) => `${m.name} (${t("unsupported")}: ${m.problem})`).join("; ") }));
  if (data.errors.length) note(data.errors.join("\n"));

  const box = h(
    "div",
    { class: "modal settings import" },
    h("div", { class: "modal-title" }, t("Import from Notepad++")),
    body,
    h(
      "div",
      { class: "modal-buttons" },
      h(
        "button",
        {
          class: "btn primary",
          click: async () => {
            close();
            let n = 0;
            for (const c of checks) {
              if (!c.box.checked) continue;
              try {
                await c.apply();
                n++;
              } catch (e) {
                data.errors.push(errorText(e));
              }
            }
            applyKeys();
            macrosChanged();
            toast(t("Imported {n} items from Notepad++.", { n }), 4000);
            if (data.errors.length) await message(t("Import from Notepad++"), data.errors.join("\n"));
          },
        },
        t("Import")
      ),
      h("button", { class: "btn", click: () => close() }, t("Cancel"))
    )
  );
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
  const close = showModal(box);
  (box.querySelector("button.primary") as HTMLElement | null)?.focus();
}
