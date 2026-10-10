// EditorState construction and the compartments that let settings change at runtime.
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, LanguageDescription, LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { highlightSelectionMatches } from "@codemirror/search";
import { Compartment, EditorState, Extension } from "@codemirror/state";
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
import { searchHighlight } from "./searchhl";

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
};

export interface StateOptions {
  text: string;
  settings: Settings;
  readOnly: boolean;
  livePreview: boolean;
  lpConfig: LivePreviewConfig;
  language: Extension;
  firstLineOffset?: number;
  extra?: Extension[];
}

export function lineNumbersExt(enabled: boolean, offset = 0): Extension {
  if (!enabled) return [];
  return lineNumbers({ formatNumber: (n) => String(n + offset) });
}

export function indentExt(s: Settings): Extension {
  return [EditorState.tabSize.of(s.tabSize), indentUnit.of(s.insertSpaces ? " ".repeat(s.tabSize) : "\t")];
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
      rectangularSelection(),
      crosshairCursor(),
      compartments.activeLine.of(s.highlightActiveLine ? highlightActiveLine() : []),
      highlightSelectionMatches(),
      searchHighlight,
      compartments.indent.of(indentExt(s)),
      compartments.wrap.of(s.wordWrap ? EditorView.lineWrapping : []),
      compartments.readOnly.of(EditorState.readOnly.of(o.readOnly)),
      compartments.indentMarkers.of(s.indentationMarkers ? indentationMarkers({ hideFirstIndent: true }) : []),
      compartments.language.of(o.language),
      compartments.livePreview.of(o.livePreview ? livePreview(o.lpConfig) : []),
      compartments.appKeymap.of([]),
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
    p = desc.name === "Markdown" ? Promise.resolve(markdown({ base: markdownLanguage, codeLanguages: languages })) : desc.load();
    cache.set(desc.name, p);
  }
  return p;
}
