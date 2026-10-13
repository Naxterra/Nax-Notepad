// Update check against the GitHub releases of the project repository.
import { openUrl } from "@tauri-apps/plugin-opener";
import { t } from "./i18n";
import { settings, updateSettings } from "./settings";
import { confirmDialog, toast } from "./ui/dialogs";

class GitHubHttpError extends Error {
  constructor(readonly status: number) {
    super(`GitHub ${status}`);
  }
}

export const REPO = "Naxterra/Nax-Notepad";
export const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases/latest`;
export const ISSUES_URL = `${REPO_URL}/issues`;
export const APP_VERSION: string = __APP_VERSION__;

interface Release {
  tag_name: string;
  html_url: string;
  name?: string;
  body?: string;
}

function parseVersion(v: string): number[] {
  return v
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .slice(0, 3)
    .map((x) => parseInt(x, 10) || 0);
}

export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return false;
}

export async function fetchLatestRelease(): Promise<Release> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new GitHubHttpError(res.status);
    return (await res.json()) as Release;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check for a newer release. With `silent`, only a newer version produces UI (a toast);
 * errors and "up to date" stay quiet.
 */
export async function checkForUpdates(silent: boolean): Promise<void> {
  if (!silent) toast(t("Checking for updates…"), 1500);
  let rel: Release;
  try {
    rel = await fetchLatestRelease();
  } catch (e) {
    if (!silent) {
      // A private repository (or one without releases) answers anonymous API calls with 404.
      // The releases page still works in the browser, where the user is signed in.
      const reason =
        e instanceof GitHubHttpError && e.status === 404
          ? t("GitHub shows no public release. The repository is private or has no releases yet, so Nax-Notepad cannot read it without signing in.")
          : t("GitHub could not be reached ({error}).", { error: String(e instanceof Error ? e.message : e) });
      const text = reason + "\n\n" + t("Installed version: {version}. You can compare it on the releases page in your browser.", { version: APP_VERSION });
      const go = await confirmDialog(t("Update check failed"), text, t("Open releases page"), t("Close"));
      if (go) void openUrl(RELEASES_URL);
    }
    return;
  } finally {
    updateSettings({ lastUpdateCheck: Date.now() });
  }
  const latest = rel.tag_name.replace(/^v/i, "");
  if (!isNewer(latest, APP_VERSION)) {
    if (!silent) toast(t("You are up to date ({version}).", { version: APP_VERSION }));
    return;
  }
  const text = t("Version {latest} is available (you have {current}).", { latest, current: APP_VERSION }) + (rel.body ? `\n\n${rel.body.slice(0, 600)}` : "");
  const go = await confirmDialog(t("Update available"), text, t("Open download page"), t("Later"));
  if (go) void openUrl(rel.html_url || RELEASES_URL);
}

/** Startup hook: at most one silent check per day when enabled. */
export function scheduleStartupCheck(): void {
  if (!settings.checkUpdates) return;
  const day = 24 * 60 * 60 * 1000;
  if (Date.now() - (settings.lastUpdateCheck || 0) < day) return;
  window.setTimeout(() => void checkForUpdates(true), 6000);
}
