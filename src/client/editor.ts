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
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import type { ItemKind } from "./api";
import type { ResolvedTheme } from "./theme";
import { syntaxHighlightingFor } from "./syntax-highlight";

const langCompartment = new Compartment();
const themeCompartment = new Compartment();
const wrapCompartment = new Compartment();

/**
 * Wrapping is a reader preference, not a document property, so it lives in its
 * own compartment: switching it must not disturb the language or theme state.
 * Turning it off leaves every line at its natural width, which is what makes the
 * editor overflow horizontally and become pannable with the bottom scrollbar.
 */
function wrapExtension(wrap: boolean): Extension {
  return wrap ? EditorView.lineWrapping : [];
}

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

/**
 * The canonical language key for any accepted spelling, or `null` when the
 * string is not a language this app knows. Exported so features that dispatch
 * on language (formatting) honour the same aliases as the editor.
 */
export function canonicalLang(lang: string | null | undefined): string | null {
  if (!lang) return null;
  return LANG_ALIASES[lang.trim().toLowerCase()] ?? null;
}

function languageFor(lang: string): Language | null {
  const canonical = canonicalLang(lang);
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
  if (canonicalLang(lang) === "markdown") return markdownSupport();
  return languageFor(lang) ?? (kind === "doc" ? markdownSupport() : []);
}

/**
 * Indentation guides, one column per indent unit, shared by every editor view.
 *
 * `indentationMarkers` emits a style module per call, and CodeMirror never
 * removes those modules. Calling it once per theme therefore left two modules
 * fighting over the same light/dark selector, and whichever was inserted last
 * won in both themes — which silently reverted the light palette to the
 * library's near-white default. Registering a single instance with both
 * palettes lets the editor's own light/dark class pick the right one.
 *
 * Colours are tuned per theme: on the dark surface `--line-strong`-level greys
 * read as guides without competing with tokens, while the light surface needs a
 * deeper tone than `--line` or the 1px line vanishes against white. The active
 * column is only slightly brighter so the current block reads as a highlight
 * rather than a second accent colour.
 *
 * The plugin paints its gradient on a `z-index: -1` pseudo-element, so on the
 * cursor's line the active-line tint covers it. Lifting that layer to `z-index:
 * 0` re-draws the guides on top of the tint; they only occupy whitespace, so the
 * 1px lines never cross a glyph.
 */
const indentGuides: Extension = [
  indentationMarkers({
    thickness: 1,
    colors: {
      light: "#c6d0df",
      dark: "#3b4557",
      activeLight: "#93a5bf",
      activeDark: "#6d80a1",
    },
  }),
  EditorView.theme({
    ".cm-line.cm-activeLine.cm-indent-markers::before": { zIndex: "0" },
  }),
];

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
      indentGuides,
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
    indentGuides,
  ];
}

export type EditorHandle = {
  view: EditorView;
  getValue: () => string;
  setValue: (value: string) => void;
  setMode: (kind: ItemKind, lang: string) => void;
  setTheme: (theme: ResolvedTheme) => void;
  setWrap: (wrap: boolean) => void;
  focus: () => void;
  destroy: () => void;
};

export function createEditor(
  parent: HTMLElement,
  initial: {
    content: string;
    kind: ItemKind;
    lang: string;
    theme?: ResolvedTheme;
    wrap?: boolean;
  },
  onChange: () => void,
): EditorHandle {
  const theme = initial.theme ?? "dark";
  const wrap = initial.wrap ?? true;
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
      wrapCompartment.of(wrapExtension(wrap)),
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
    setWrap: (next) => {
      view.dispatch({
        effects: wrapCompartment.reconfigure(wrapExtension(next)),
      });
      // Re-measuring keeps the scrollbar extent honest the moment the mode
      // flips; without it the gutter and horizontal scrollbar can lag a frame.
      view.requestMeasure();
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
  wrap = true,
): readonly Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    wrapExtension(wrap),
    editorThemeExtension(theme),
    languageExtension(kind, lang),
  ];
}
