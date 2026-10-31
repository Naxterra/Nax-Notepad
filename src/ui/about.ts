import { openUrl } from "@tauri-apps/plugin-opener";
import { backend } from "../backend";
import { t } from "../i18n";
import { APP_VERSION, checkForUpdates, ISSUES_URL, REPO_URL } from "../update";
import { h, showModal } from "./dialogs";

export function openAboutDialog(): void {
  const dataDir = h("code", {}, "%APPDATA%\\Nax-Notepad");
  void backend
    .appDataDir()
    .then((d) => (dataDir.textContent = d))
    .catch(() => undefined);
  const link = (href: string, label: string) =>
    h(
      "a",
      {
        href: "#",
        class: "link",
        click: (e) => {
          e.preventDefault();
          void openUrl(href);
        },
      },
      label
    );
  const box = h(
    "div",
    { class: "modal about" },
    h("div", { class: "about-head" }, h("img", { src: "/icon.png", class: "about-icon", alt: "" }), h("div", {}, h("div", { class: "modal-title" }, "Nax-Notepad"), h("div", { class: "about-version" }, `${t("Version")} ${APP_VERSION}`))),
    h(
      "div",
      { class: "modal-text" },
      t("A fast tabbed editor with Markdown Live Preview and support for multi-gigabyte files."),
      h("br"),
      t("Built with Tauri 2 and CodeMirror 6. Nax Source-Available License 1.0."),
      h("br"),
      h("br"),
      t("Settings, session and unsaved text are stored in"),
      " ",
      dataDir,
      h("br"),
      h("br"),
      link(REPO_URL, t("GitHub Repository")),
      " · ",
      link(ISSUES_URL, t("Report an Issue"))
    ),
    h(
      "div",
      { class: "modal-buttons" },
      h("button", { class: "btn", click: () => void checkForUpdates(false) }, t("Check for updates")),
      h("button", { class: "btn primary", click: () => close() }, t("Close"))
    )
  );
  box.tabIndex = -1;
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || e.key === "Enter") {
      e.preventDefault();
      close();
    }
  });
  const close = showModal(box);
  box.focus();
}
