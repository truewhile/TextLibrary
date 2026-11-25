/**
 * Share links are extra public aliases for an item. Their path is a single
 * segment so routing stays trivial, and the rules live here so the editor can
 * reject a bad alias before a request is made.
 */

export const MAX_SHARE_PATH = 64;
export const MIN_PASSWORD_LENGTH = 4;
export const MAX_PASSWORD_LENGTH = 64;
export const MAX_FILENAME = 120;

export type ShareParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const SHARE_PATH_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;

/** Characters that would let a filename escape its header or the response. */
const FILENAME_FORBIDDEN_RE = /[\\/:*?"<>|\u0000-\u001f\u007f]/;

export function normalizeSharePath(input: unknown): ShareParseResult<string> {
  if (typeof input !== "string") return { ok: false, error: "分享路径必须是字符串" };
  const value = input.trim().replace(/^\/+|\/+$/g, "");
  if (!value) return { ok: false, error: "请填写分享路径" };
  if (value.includes("/")) return { ok: false, error: "分享路径只能是单段，不含 /" };
  if (value.length > MAX_SHARE_PATH) {
    return { ok: false, error: `分享路径不能超过 ${MAX_SHARE_PATH} 个字符` };
  }
  if (!SHARE_PATH_RE.test(value)) {
    return {
      ok: false,
      error: "分享路径需以文字或数字开头，只能包含文字、数字和 ._-",
    };
  }
  return { ok: true, value };
}

export function normalizeFilename(input: unknown): ShareParseResult<string> {
  if (input === undefined || input === null) return { ok: true, value: "" };
  if (typeof input !== "string") return { ok: false, error: "文件名必须是字符串" };
  const value = input.trim();
  if (!value) return { ok: true, value: "" };
  if (value.length > MAX_FILENAME) {
    return { ok: false, error: `文件名不能超过 ${MAX_FILENAME} 个字符` };
  }
  if (FILENAME_FORBIDDEN_RE.test(value)) {
    return { ok: false, error: "文件名不能包含 \\ / : * ? \" < > | 或控制字符" };
  }
  if (value === "." || value === "..") return { ok: false, error: "文件名不合法" };
  return { ok: true, value };
}

export function normalizePassword(input: unknown): ShareParseResult<string> {
  if (input === undefined || input === null) return { ok: true, value: "" };
  if (typeof input !== "string") return { ok: false, error: "密码必须是字符串" };
  const value = input.trim();
  if (!value) return { ok: true, value: "" };
  if (value.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `密码至少 ${MIN_PASSWORD_LENGTH} 个字符` };
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: `密码不能超过 ${MAX_PASSWORD_LENGTH} 个字符` };
  }
  return { ok: true, value };
}

/** Share links are stored as JSON records; tolerate whatever older writes left behind. */
export type ShareRecord = {
  path: string;
  slug: string;
  filename: string;
  passwordHash: string;
  passwordSalt: string;
  createdAt: string;
};

export function parseShareRecord(raw: string | undefined): ShareRecord | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.slug !== "string" || !record.slug) return null;
    return {
      path: typeof record.path === "string" ? record.path : "",
      slug: record.slug,
      filename: typeof record.filename === "string" ? record.filename : "",
      passwordHash: typeof record.passwordHash === "string" ? record.passwordHash : "",
      passwordSalt: typeof record.passwordSalt === "string" ? record.passwordSalt : "",
      createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
    };
  } catch {
    return null;
  }
}

export type ShareSummary = {
  path: string;
  slug: string;
  filename: string;
  protected: boolean;
  createdAt: string;
  /** Ready-to-share URL relative to the worker origin. */
  url: string;
};

/** The public path for a share, including the password when there is one. */
export function shareUrl(path: string, password = ""): string {
  const base = `/s/${encodeURIComponent(path)}`;
  return password ? `${base}?p=${encodeURIComponent(password)}` : base;
}
