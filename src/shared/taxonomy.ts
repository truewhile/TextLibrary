/**
 * Group paths and tags are validated on both sides of the wire. Keeping the rules
 * in one module prevents the editor from offering a value the Worker will reject.
 */

export const MAX_GROUP_LENGTH = 96;
export const MAX_GROUP_DEPTH = 4;
export const MAX_GROUP_SEGMENT = 32;
export const MAX_TAGS = 8;
export const MAX_TAG_LENGTH = 24;

const SEGMENT_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;
const TAG_FORBIDDEN_RE = /[,\u0000-\u001f\u007f]/;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Collapse repeated or leading/trailing separators so `ops//deploy/` equals `ops/deploy`. */
export function normalizeGroup(input: unknown): ParseResult<string> {
  if (input === undefined || input === null) return { ok: true, value: "" };
  if (typeof input !== "string") return { ok: false, error: "分组必须是字符串" };

  const raw = input.trim().replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
  if (!raw) return { ok: true, value: "" };
  if (raw.length > MAX_GROUP_LENGTH) {
    return { ok: false, error: `分组路径不能超过 ${MAX_GROUP_LENGTH} 个字符` };
  }

  const segments = raw.split("/");
  if (segments.length > MAX_GROUP_DEPTH) {
    return { ok: false, error: `分组最多 ${MAX_GROUP_DEPTH} 级` };
  }
  for (const segment of segments) {
    if (segment.length > MAX_GROUP_SEGMENT) {
      return { ok: false, error: `每级分组名不能超过 ${MAX_GROUP_SEGMENT} 个字符` };
    }
    if (!SEGMENT_RE.test(segment)) {
      return { ok: false, error: `分组名「${segment}」不合法：需以文字或数字开头，只含文字、数字和 ._-` };
    }
  }
  return { ok: true, value: raw };
}

export function normalizeTags(input: unknown): ParseResult<string[]> {
  if (input === undefined || input === null) return { ok: true, value: [] };

  let list: unknown[];
  if (Array.isArray(input)) list = input;
  else if (typeof input === "string") list = input.split(",");
  else return { ok: false, error: "标签必须是字符串或字符串数组" };

  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (typeof entry !== "string") return { ok: false, error: "标签必须是字符串" };
    const tag = entry.trim().replace(/\s+/g, " ");
    if (!tag) continue;
    if (tag.length > MAX_TAG_LENGTH) {
      return { ok: false, error: `标签「${tag.slice(0, 10)}…」超过 ${MAX_TAG_LENGTH} 个字符` };
    }
    if (TAG_FORBIDDEN_RE.test(tag) || tag.includes("/")) {
      return { ok: false, error: "标签不能包含逗号、斜杠或控制字符" };
    }
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  if (out.length > MAX_TAGS) {
    return { ok: false, error: `每个条目最多 ${MAX_TAGS} 个标签` };
  }
  return { ok: true, value: out };
}

/** R2 custom metadata stores tags as a JSON string; tolerate anything older writes left behind. */
export function parseStoredTags(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  } catch {
    return [];
  }
}

export function groupSegments(path: string): string[] {
  return path ? path.split("/") : [];
}

export function groupLabel(path: string): string {
  if (!path) return "未分组";
  const segments = groupSegments(path);
  return segments[segments.length - 1];
}

export function groupDepth(path: string): number {
  return groupSegments(path).length - 1;
}

/** True when `path` sits under `ancestor` (`ops/deploy` is under `ops`). */
export function isDescendantGroup(path: string, ancestor: string): boolean {
  if (!ancestor) return false;
  return path !== ancestor && path.startsWith(ancestor + "/");
}

/**
 * Every ancestor of a path, shortest first, so a collapsed branch can hide its
 * whole subtree without walking the tree recursively at render time.
 */
export function groupAncestors(path: string): string[] {
  const segments = groupSegments(path);
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"));
}
