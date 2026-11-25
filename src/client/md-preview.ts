import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({
  gfm: true,
  breaks: false,
});

/** Render Markdown to sanitized HTML for the in-app preview pane. */
export function renderMarkdown(source: string): string {
  const raw = marked.parse(source || "", { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
  });
}

export type MdViewMode = "edit" | "preview" | "split";

export const MD_VIEW_MODES: { id: MdViewMode; label: string; title: string }[] = [
  { id: "edit", label: "编辑", title: "仅编辑" },
  { id: "split", label: "分栏", title: "左编辑右预览" },
  { id: "preview", label: "预览", title: "仅预览" },
];

export function isMarkdownLang(lang: string | null | undefined): boolean {
  const value = (lang ?? "").toLowerCase();
  return value === "markdown" || value === "md";
}
