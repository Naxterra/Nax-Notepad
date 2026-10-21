// Small line icons (24x24 viewBox, drawn with the current text color).

const svg = (body: string, extra = "") =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${body}</svg>`;

const FILE = '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>';

export const ICONS = {
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  minimize: svg('<path d="M5 12h14"/>'),
  maximize: svg('<rect x="5" y="5" width="14" height="14" rx="1.5"/>'),
  restore: svg('<rect x="5" y="8" width="11" height="11" rx="1.5"/><path d="M8 8V6.5A1.5 1.5 0 0 1 9.5 5h8A1.5 1.5 0 0 1 19 6.5v8a1.5 1.5 0 0 1-1.5 1.5H16"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  file: svg(FILE),
  fileText: svg(FILE + '<path d="M8.5 13h7M8.5 16.5h5"/>'),
  fileCode: svg(FILE + '<path d="m10 12.5-2 2 2 2M14 12.5l2 2-2 2"/>'),
  fileJson: svg(FILE + '<path d="M10 11.5c-1 0-1.3.6-1.3 1.4v.6c0 .5-.3.9-.8.9.5 0 .8.4.8.9v.6c0 .8.3 1.4 1.3 1.4M14 11.5c1 0 1.3.6 1.3 1.4v.6c0 .5.3.9.8.9-.5 0-.8.4-.8.9v.6c0 .8-.3 1.4-1.3 1.4"/>'),
  fileMarkdown: svg(FILE + '<path d="M8 17v-4.5l2 2.2 2-2.2V17M15 12.5V17M13.5 15.5 15 17l1.5-1.5"/>'),
  fileBinary: svg(FILE + '<rect x="8" y="11.5" width="3" height="5" rx="1.5"/><path d="M14.5 11.5v5"/>'),
  fileImage: svg(FILE + '<circle cx="10" cy="12.5" r="1.3"/><path d="m8 18 3-3 2 2 2-2.5L17 17"/>'),
  fileLog: svg(FILE + '<path d="M8.5 12h7M8.5 14.5h7M8.5 17h4"/>'),
  fileSettings: svg(FILE + '<circle cx="12" cy="14.5" r="2"/><path d="M12 11v1.5M12 16.5V18M8.8 13l1.3.7M13.9 15.8l1.3.7M8.8 16l1.3-.7M13.9 13.2l1.3-.7"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="9.5" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  unlock: svg('<rect x="5" y="11" width="14" height="9.5" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.6-1.7"/>'),
  copy: svg('<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>'),
  arrowRight: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  chevronDown: svg('<path d="m6 9 6 6 6-6"/>'),
  chevronUp: svg('<path d="m6 15 6-6 6 6"/>'),
  chevronRight: svg('<path d="m9 6 6 6-6 6"/>'),
  folder: svg('<path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>'),
  drive: svg('<rect x="3.5" y="13" width="17" height="6" rx="1.5"/><path d="M5.5 13 8 5.5h8L18.5 13M16.5 16h.01"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  panelRight: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M15 4.5v15"/>'),
  binary: svg('<rect x="5" y="4" width="4" height="7" rx="2"/><path d="M15 4v7M5 13.5v6.5M15 13.5h4v6.5h-4z"/>'),
  eye: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>'),
  menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  info: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>'),
};

export type IconName = keyof typeof ICONS;

/** An element holding the icon. */
export function icon(name: IconName, cls = ""): HTMLElement {
  const el = document.createElement("span");
  el.className = "ic" + (cls ? " " + cls : "");
  el.innerHTML = ICONS[name];
  return el;
}

/** Icon for a file name, by extension. */
export function fileIcon(name: string): IconName {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (/^(md|markdown|mdown|mkd|mdx|rmd)$/.test(ext)) return "fileMarkdown";
  if (/^(json|jsonc|json5|yaml|yml|toml)$/.test(ext)) return "fileJson";
  if (/^(ini|cfg|conf|config|reg|properties|env|xml|plist)$/.test(ext)) return "fileSettings";
  if (/^(log|out|err)$/.test(ext)) return "fileLog";
  if (/^(png|jpe?g|gif|bmp|ico|webp|svg|tiff?)$/.test(ext)) return "fileImage";
  if (/^(exe|dll|bin|dat|so|dylib|o|obj|lib|class|pdf|zip|7z|rar|gz|iso|img|db|sqlite|pak)$/.test(ext)) return "fileBinary";
  if (/^(js|mjs|cjs|ts|tsx|jsx|rs|py|c|h|cpp|hpp|cc|cs|java|go|rb|php|sh|bash|ps1|psm1|bat|cmd|lua|sql|kt|swift|scala|r|pl|vue|svelte|html?|css|scss|less)$/.test(ext)) return "fileCode";
  if (/^(txt|text|csv|tsv|nfo|readme)$/.test(ext) || !name.includes(".")) return "fileText";
  return "file";
}
