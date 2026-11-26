import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, foldGutter, foldKeymap, StreamLanguage, type Language, type LanguageSupport } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { python } from "@codemirror/legacy-modes/mode/python";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { oneDark } from "@codemirror/theme-one-dark";
import type { ItemKind } from "./api";
import type { ResolvedTheme } from "./theme";
import { syntaxHighlightingFor } from "./syntax-highlight";

const langCompartment = new Compartment();
const themeCompartment = new Compartment();

/**
 * Every accepted spelling of a language, mapped to the single canonical key in
 * `languages`. Keeping the aliases in one table is what lets the editor, the
 * Markdown fenced-code highlighter and `LANG_EXT` on the worker agree.
 */
const LANG_ALIASES: Record<string, string> = {
  markdown: "markdown",
  md: "markdown",
  typescript: "typescript",
  ts: "typescript",
  javascript: "javascript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  shell: "shell",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  python: "python",
  py: "python",
  powershell: "powershell",
  ps1: "powershell",
  pwsh: "powershell",
};

/**
 * Languages are built once at module scope. `StreamLanguage.define` bakes a
 * parser per call, and the Markdown fence highlighter asks for a language on
 * every block parse — recreating them there would be both slow and cache-hostile.
 */
const languages: Record<string, Language> = {
  // Plain GFM without fence support, so Markdown-in-Markdown cannot recurse.
  markdown: markdownLanguage,
  typescript: javascript({ typescript: true }).language,
  javascript: javascript().language,
  json: json().language,
  // Lezer parser, not the legacy stream mode: only this distinguishes a quoted
  // key (`"name"`) from a quoted value (`"HK-OM"`), which the stream mode cannot.
  yaml: yaml().language,
  shell: StreamLanguage.define(shell),
  python: StreamLanguage.define(python),
  powershell: StreamLanguage.define(powerShell),
};

function languageFor(lang: string): Language | null {
  const canonical = LANG_ALIASES[lang.trim().toLowerCase()];
  return canonical ? languages[canonical] ?? null : null;
}

let markdownSupportCache: LanguageSupport | null = null;

function markdownSupport(): LanguageSupport {
  return (markdownSupportCache ??= markdown({
    base: markdownLanguage,
    codeLanguages: (info) => languageFor(info),
  }));
}

function languageExtension(kind: ItemKind, lang: string): Extension {
  // Editing a Markdown entry uses the fence-aware support; `languages.markdown`
  // stays the plain grammar and is only ever handed to nested code blocks.
  if (LANG_ALIASES[lang.trim().toLowerCase()] === "markdown") return markdownSupport();
  return languageFor(lang) ?? (kind === "doc" ? markdownSupport() : []);
}

export function editorThemeExtension(theme: ResolvedTheme): Extension {
  if (theme === "dark") {
    return [
      oneDark,
      EditorView.theme({
        "&": { backgroundColor: "transparent" },
        ".cm-content": { caretColor: "#7fa8ff" },
        ".cm-tooltip": { border: "1px solid #2f3746", backgroundColor: "#171b24" },
        ".cm-panels": { backgroundColor: "#171b24", color: "#e7eaf0" },
        ".cm-searchMatch": { backgroundColor: "rgba(77, 141, 255, 0.28)" },
        ".cm-selectionMatch": { backgroundColor: "rgba(77, 141, 255, 0.18)" },
      }),
      syntaxHighlightingFor("dark"),
    ];
  }
  return [
    EditorView.theme({
      "&": { backgroundColor: "transparent", color: "#1a2230" },
      ".cm-content": { caretColor: "#3b7aef" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#3b7aef" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: "rgba(59, 122, 239, 0.22)",
      },
      ".cm-activeLine": { backgroundColor: "rgba(26, 34, 48, 0.05)" },
      ".cm-activeLineGutter": { backgroundColor: "rgba(26, 34, 48, 0.05)" },
      ".cm-gutters": { backgroundColor: "transparent", color: "#647084", border: "none" },
      ".cm-tooltip": { border: "1px solid #c8d0dc", backgroundColor: "#ffffff", color: "#1a2230" },
      ".cm-panels": { backgroundColor: "#e9edf4", color: "#1a2230" },
      ".cm-searchMatch": { backgroundColor: "rgba(59, 122, 239, 0.2)" },
      ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(59, 122, 239, 0.35)" },
      ".cm-selectionMatch": { backgroundColor: "rgba(59, 122, 239, 0.14)" },
    }),
    syntaxHighlightingFor("light"),
  ];
}

export type EditorHandle = {
  view: EditorView;
  getValue: () => string;
  setValue: (value: string) => void;
  setMode: (kind: ItemKind, lang: string) => void;
  setTheme: (theme: ResolvedTheme) => void;
  focus: () => void;
  destroy: () => void;
};

export function createEditor(
  parent: HTMLElement,
  initial: { content: string; kind: ItemKind; lang: string; theme?: ResolvedTheme },
  onChange: () => void,
): EditorHandle {
  const theme = initial.theme ?? "dark";
  const state = EditorState.create({
    doc: initial.content,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      placeholder("在这里写 Markdown 文档或脚本……"),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      themeCompartment.of(editorThemeExtension(theme)),
      EditorView.lineWrapping,
      langCompartment.of(languageExtension(initial.kind, initial.lang)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChange();
      }),
    ],
  });

  const view = new EditorView({ state, parent });

  return {
    view,
    getValue: () => view.state.doc.toString(),
    setValue: (value: string) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
    },
    setMode: (kind, lang) => {
      view.dispatch({
        effects: langCompartment.reconfigure(languageExtension(kind, lang)),
      });
    },
    setTheme: (next) => {
      view.dispatch({
        effects: themeCompartment.reconfigure(editorThemeExtension(next)),
      });
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}

/** Read-only extensions for one pane of the revision diff; keeps app theming. */
export function readOnlyExtensions(
  kind: ItemKind,
  lang: string,
  theme: ResolvedTheme,
): readonly Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.lineWrapping,
    editorThemeExtension(theme),
    languageExtension(kind, lang),
  ];
}
