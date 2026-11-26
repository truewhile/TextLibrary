import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import type { ItemKind } from "./api";
import type { DiffLayout } from "./diff-layout";
import { readOnlyExtensions } from "./editor";
import type { ResolvedTheme } from "./theme";

export type DiffSpec = {
  /** Snapshot text on the left / above (the "old" side). */
  original: string;
  /** Current text on the right / below (the "new" side). */
  current: string;
  kind: ItemKind;
  lang: string;
  theme: ResolvedTheme;
  layout: DiffLayout;
  /** Mirror the editor's long-line mode so the comparison reads the same way. */
  wrap?: boolean;
};

/**
 * Renders an old/new comparison into `parent` and returns a disposer.
 *
 * The caller loads this module with a dynamic `import()`, so `@codemirror/merge`
 * stays out of the initial chunk and the common edit path pays nothing for it.
 */
export function mountDiff(parent: HTMLElement, spec: DiffSpec): () => void {
  const extensions = readOnlyExtensions(spec.kind, spec.lang, spec.theme, spec.wrap ?? true);

  if (spec.layout === "split") {
    const view = new MergeView({
      parent,
      a: { doc: spec.original, extensions },
      b: { doc: spec.current, extensions },
      orientation: "a-b",
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 6 },
    });
    return () => view.destroy();
  }

  // Unified mode puts the snapshot's removed lines inline above the current
  // text, which stays legible on a phone where two columns would not.
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: spec.current,
      extensions: [
        ...extensions,
        unifiedMergeView({
          original: spec.original,
          mergeControls: false,
          gutter: true,
          highlightChanges: true,
        }),
      ],
    }),
  });
  return () => view.destroy();
}
