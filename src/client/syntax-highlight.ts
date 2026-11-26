import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { Extension, Range, Text } from "@codemirror/state";
import { NodeProp, type SyntaxNode, type Tree } from "@lezer/common";
import type { ResolvedTheme } from "./theme";

/**
 * Token colours, one shared vocabulary across both themes.
 *
 * A tone keeps the same meaning in light and dark — a key stays red, a string
 * stays green — so switching theme changes the lightness, not the semantics.
 * Every colour was contrast-checked against its own editor background (>= 4.5:1)
 * rather than picked by eye.
 */
type Palette = {
  key: string;
  string: string;
  escape: string;
  number: string;
  bool: string;
  variable: string;
  func: string;
  type: string;
  keyword: string;
  operator: string;
  punctuation: string;
  comment: string;
  heading: string;
  link: string;
  invalid: string;
};

const DARK: Palette = {
  key: "#e06c75",
  string: "#98c379",
  escape: "#56b6c2",
  number: "#d19a66",
  bool: "#56b6c2",
  variable: "#d19a66",
  func: "#61afef",
  type: "#e5c07b",
  keyword: "#c678dd",
  operator: "#56b6c2",
  punctuation: "#7d8799",
  comment: "#7d8799",
  heading: "#e06c75",
  link: "#61afef",
  invalid: "#ff7b72",
};

const LIGHT: Palette = {
  key: "#b31d28",
  string: "#0a6640",
  escape: "#0b6a6a",
  number: "#8a4b00",
  bool: "#0b6a6a",
  variable: "#8a4b00",
  func: "#6639ba",
  type: "#0550ae",
  keyword: "#8250df",
  operator: "#0b6a6a",
  punctuation: "#57606a",
  comment: "#5f6875",
  heading: "#0550ae",
  link: "#0550ae",
  invalid: "#cf222e",
};

function highlightStyle(c: Palette): HighlightStyle {
  // Later specs win when a node carries several tags, so broad rules come
  // first and the specific ones follow.
  return HighlightStyle.define([
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: c.comment, fontStyle: "italic" },
    { tag: [t.meta, t.documentMeta, t.annotation, t.processingInstruction], color: c.punctuation },
    {
      tag: [t.punctuation, t.separator, t.bracket, t.squareBracket, t.brace, t.paren, t.angleBracket, t.contentSeparator],
      color: c.punctuation,
    },
    {
      tag: [t.operator, t.operatorKeyword, t.compareOperator, t.arithmeticOperator, t.logicOperator, t.bitwiseOperator],
      color: c.operator,
    },
    { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.self, t.unit, t.modifier], color: c.keyword },
    { tag: [t.propertyName, t.definition(t.propertyName), t.attributeName], color: c.key },
    { tag: [t.string, t.special(t.string), t.attributeValue, t.character, t.docString], color: c.string },
    { tag: [t.escape, t.regexp], color: c.escape },
    { tag: [t.number, t.integer, t.float], color: c.number },
    { tag: [t.bool, t.atom, t.null], color: c.bool },
    {
      tag: [t.variableName, t.special(t.variableName), t.standard(t.variableName), t.macroName, t.labelName],
      color: c.variable,
    },
    { tag: [t.function(t.variableName), t.definition(t.function(t.variableName))], color: c.func },
    { tag: [t.typeName, t.className, t.namespace, t.tagName], color: c.type },
    {
      tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6],
      color: c.heading,
      fontWeight: "600",
    },
    { tag: [t.link, t.url], color: c.link, textDecoration: "underline" },
    { tag: t.strong, fontWeight: "600" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: t.quote, color: c.comment, fontStyle: "italic" },
    { tag: t.invalid, color: c.invalid },
  ]);
}

const NUMBER_RE = /^[-+]?(?:\d[\d_]*)*(?:\.\d[\d_]*)?(?:[eE][-+]?\d+)?$/;
const BOOL_RE = /^(?:true|false|yes|no|on|off|y|n)$/i;
const NULL_RE = /^(?:null|~)$/i;

export type ScalarRange = { from: number; to: number; cls: "cm-tok-number" | "cm-tok-bool" | "cm-tok-null" };

/**
 * Offset from a fenced-code node to the first line of its content.
 *
 * The mounted tree's positions start at the first content line, so callers must
 * add this rather than the node start (fence marks) or `overlay[0].from` (which
 * also points at the opening fence, not the code).
 */
function fenceContentOffset(node: SyntaxNode): number {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeText") return child.from - node.from;
  }
  return 0;
}

/**
 * The Lezer YAML grammar tags every plain scalar as generic `content`, so
 * numbers, booleans and nulls would render as ordinary text. This finds them so
 * they can be tinted without forking the grammar.
 *
 * Three details are easy to get wrong and all are load-bearing:
 * - `Key/Literal` is a key, already coloured as a property name; only values count.
 * - A fenced YAML block inside Markdown is a *mounted* tree. `SyntaxNode.iterate`
 *   never descends into one, and the mount descriptor lives on `TreeCursor.tree`,
 *   not on the node type — checking `node.type.prop()` silently finds nothing.
 * - Positions inside a mounted tree are relative to `overlay[0].from` (the first
 *   content line), not to the `FencedCode` node itself.
 */
export function collectYamlScalars(top: Tree, doc: Text): ScalarRange[] {
  const out: ScalarRange[] = [];

  const consider = (name: string, from: number, to: number, parentName: string | null) => {
    if (name !== "Literal" || parentName === "Key") return;
    const text = doc.sliceString(from, to).trim();
    if (!text) return;
    const cls = BOOL_RE.test(text)
      ? "cm-tok-bool"
      : NULL_RE.test(text)
        ? "cm-tok-null"
        : /\d/.test(text) && NUMBER_RE.test(text)
          ? "cm-tok-number"
          : null;
    if (cls) out.push({ from, to, cls });
  };

  const visitTree = (tree: Tree, base: number): void => {
    const cursor = tree.cursor();
    do {
      // A fenced block carries its own tree. Its offsets are relative to the
      // *first content line*, which is the `CodeText` child of the enclosing
      // `FencedCode` — not `overlay[0].from`, which points at the fence marks.
      const mounted = cursor.tree?.prop(NodeProp.mounted);
      if (mounted) {
        visitTree(mounted.tree, base + cursor.from + fenceContentOffset(cursor.node));
      }
      consider(cursor.name, base + cursor.from, base + cursor.to, cursor.node.parent?.name ?? null);
    } while (cursor.next());
  };

  visitTree(top, 0);
  return out;
}

function literalClasses(c: Palette): Extension {
  // `baseTheme` selectors are always active; `theme` rules need the theme
  // class on the editor and would go inert under the app's own theming.
  return EditorView.baseTheme({
    ".cm-tok-number": { color: c.number },
    ".cm-tok-bool": { color: c.bool },
    ".cm-tok-null": { color: c.bool, fontStyle: "italic" },
  });
}

const yamlScalars = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    build(view: EditorView): DecorationSet {
      const ranges: Range<Decoration>[] = collectYamlScalars(syntaxTree(view.state), view.state.doc).map(
        (s) => Decoration.mark({ class: s.cls }).range(s.from, s.to),
      );
      return ranges.length ? Decoration.set(ranges, true) : Decoration.none;
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.build(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** Syntax highlighting for the given theme, plus YAML scalar fix-ups. */
export function syntaxHighlightingFor(theme: ResolvedTheme): Extension {
  const palette = theme === "dark" ? DARK : LIGHT;
  return [syntaxHighlighting(highlightStyle(palette)), literalClasses(palette), yamlScalars];
}
