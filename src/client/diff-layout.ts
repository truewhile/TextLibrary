/**
 * Layout choice for the revision diff.
 *
 * This lives apart from `revision-diff.ts` on purpose: `main.ts` needs the
 * breakpoint at render time but must not statically import the merge package,
 * which is why the diff module itself is loaded with a dynamic `import()`.
 */

/** Below this width a side-by-side diff is unreadable, so we fall back to unified. */
export const SPLIT_DIFF_MIN_WIDTH = 821;

export type DiffLayout = "split" | "unified";

/** Which presentation to use right now. Resolve once, then pass it back in. */
export function diffLayout(): DiffLayout {
  return window.innerWidth >= SPLIT_DIFF_MIN_WIDTH ? "split" : "unified";
}
