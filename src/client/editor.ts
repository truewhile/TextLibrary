import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle, foldGutter, foldKeymap, StreamLanguage } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { python } from "@codemirror/legacy-modes/mode/python";
import { oneDark } from "@codemirror/theme-one-dark";
import type { ItemKind } from "./api";
import type { ResolvedTheme } from "./theme";

const langCompartment = new Compartment();
const themeCompartment = new Compartment();

function languageExtension(kind: ItemKind, lang: string) {
  switch (lang) {
    case "markdown":
    case "md":
      return markdown({ base: markdownLanguage, codeLanguages: [] });
    case "typescript":
    case "ts":
      return javascript({ typescript: true });
    case "javascript":
    case "js":
      return javascript();
    case "json":
      return json();
    case "shell":
    case "sh":
    case "bash":
      return StreamLanguage.define(shell);
    case "python":
    case "py":
      return StreamLanguage.define(python);
    default:
      return kind === "doc" ? markdown({ base: markdownLanguage, codeLanguages: [] }) : [];
  }
}

function editorThemeExtension(theme: ResolvedTheme): Extension {
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
    ];
  }
  return EditorView.theme({
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
  });
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
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
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
