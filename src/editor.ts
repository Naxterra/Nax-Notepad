// EditorState construction and the compartments that let settings change at runtime.
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, LanguageDescription, LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { highlightSelectionMatches } from "@codemirror/search";
import { Compartment, EditorState, Extension } from "@codemirror/state";
import { readOnlyGuard } from "./readonly";
export { systemChange } from "./readonly";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { livePreview, LivePreviewConfig } from "./livepreview";
import { Settings } from "./settings";
import { cmHighlight, cmTheme } from "./theme";
import { MARKDOWN_EXTENSIONS } from "./markdown";
import { searchHighlight } from "./searchhl";
import { codeLanguageFor, fenceLanguageCompletion } from "./codefence";
import { bookmarks } from "./bookmarks";
import { columnBlock } from "./columnselect";
import { compareField } from "./compare";
import { IndentInfo } from "./indentdetect";
import { whitespaceExt } from "./whitespace";

export const compartments = {
  language: new Compartment(),
  wrap: new Compartment(),
  livePreview: new Compartment(),
  readOnly: new Compartment(),
  lineNumbers: new Compartment(),
  indent: new Compartment(),
  activeLine: new Compartment(),
  indentMarkers: new Compartment(),
  closeBrackets: new Compartment(),
  bracketMatching: new Compartment(),
  appKeymap: new Compartment(),
  whitespace: new Compartment(),
};

export interface StateOptions {
  text: string;
  settings: Settings;
  readOnly: boolean;
  livePreview: boolean;
  lpConfig: LivePreviewConfig;
  language: Extension;
  firstLineOffset?: number;
  /** Indentation of this document (detected or chosen); defaults to the settings. */
  indent?: IndentInfo;
  /** Line ending label for "show line endings". */
  eol?: () => string;
  extra?: Extension[];
}

export function lineNumbersExt(enabled: boolean, offset = 0): Extension {
  if (!enabled) return [];
  return lineNumbers({ formatNumber: (n) => String(n + offset) });
}

export function indentExt(s: Settings, info?: IndentInfo | null): Extension {
  const spaces = info ? info.spaces : s.insertSpaces;
  const size = info && info.size > 0 ? info.size : s.tabSize;
  return [EditorState.tabSize.of(size), indentUnit.of(spaces ? " ".repeat(size) : "\t")];
}

export function createState(o: StateOptions): EditorState {
  const s = o.settings;
  return EditorState.create({
    doc: o.text,
    extensions: [
      compartments.lineNumbers.of(lineNumbersExt(s.lineNumbers, o.firstLineOffset ?? 0)),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter({ openText: "▾", closedText: "▸" }),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      cmTheme,
      cmHighlight,
      compartments.bracketMatching.of(s.bracketMatching ? bracketMatching() : []),
      compartments.closeBrackets.of(s.autoCloseBrackets ? closeBrackets() : []),
      fenceLanguageCompletion,
      rectangularSelection(),
      crosshairCursor(),
      compartments.activeLine.of(s.highlightActiveLine ? highlightActiveLine() : []),
      highlightSelectionMatches(),
      searchHighlight,
      compartments.indent.of(indentExt(s, o.indent)),
      compartments.wrap.of(s.wordWrap ? EditorView.lineWrapping : []),
      compartments.readOnly.of(EditorState.readOnly.of(o.readOnly)),
      readOnlyGuard,
      compartments.indentMarkers.of(s.indentationMarkers ? indentationMarkers({ hideFirstIndent: true }) : []),
      compartments.language.of(o.language),
      compartments.livePreview.of(o.livePreview ? livePreview(o.lpConfig) : []),
      compartments.appKeymap.of([]),
      compartments.whitespace.of(whitespaceExt(s.showWhitespace, s.showEol, o.eol ?? (() => "LF"))),
      bookmarks,
      columnBlock,
      compareField,
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
      ...(o.extra ?? []),
    ],
  });
}

export interface LanguageInfo {
  name: string;
  desc: LanguageDescription;
}

export const allLanguages: LanguageInfo[] = languages
  .map((d) => ({ name: d.name, desc: d }))
  .sort((a, b) => a.name.localeCompare(b.name));

export function languageForFile(name: string): LanguageDescription | null {
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  if (MARKDOWN_EXTENSIONS.includes(ext)) return LanguageDescription.matchLanguageName(languages, "markdown", true);
  if (/\.(txt|log|ini|cfg|conf)$/.test(lower) || !/\./.test(lower)) {
    if (/\.(ini|cfg|conf)$/.test(lower)) return LanguageDescription.matchFilename(languages, "x.ini") ?? LanguageDescription.matchLanguageName(languages, "ini", true);
    return null;
  }
  return LanguageDescription.matchFilename(languages, name);
}

export function languageByName(name: string): LanguageDescription | null {
  return LanguageDescription.matchLanguageName(languages, name, true);
}

const cache = new Map<string, Promise<LanguageSupport>>();
export function loadLanguage(desc: LanguageDescription): Promise<LanguageSupport> {
  let p = cache.get(desc.name);
  if (!p) {
    // Markdown: use the GFM dialect (tables, task lists, strikethrough, autolinks) and
    // highlight fenced code blocks with the matching language.
    p = desc.name === "Markdown" ? Promise.resolve(markdown({ base: markdownLanguage, codeLanguages: codeLanguageFor })) : desc.load();
    cache.set(desc.name, p);
  }
  return p;
}
