export type ItemKind = "doc" | "script";

export type ItemMeta = {
  slug: string;
  title: string;
  kind: ItemKind;
  lang: string;
  group: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  size: number;
  etag: string;
};

export type Item = ItemMeta & { content: string };

export type ShareSummary = {
  path: string;
  slug: string;
  filename: string;
  protected: boolean;
  createdAt: string;
  url: string;
};

export type Revision = {
  key: string;
  savedAt: string;
  title: string;
  size: number;
};

export class ApiError extends Error {
  status: number;
  etag?: string;

  constructor(message: string, status: number, etag?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.etag = etag;
  }
}

const TOKEN_KEY = "textlibrary.token";

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(token: string): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${getToken()}`);
  if (init.body) headers.set("content-type", "application/json");

  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const body = payload as { error?: string; etag?: string } | null;
    throw new ApiError(body?.error ?? `请求失败 (${res.status})`, res.status, body?.etag);
  }
  return payload as T;
}

export const api = {
  ping: () => request<{ ok: boolean }>("/api/ping"),
  list: () => request<{ items: ItemMeta[]; truncated: boolean; limit: number }>("/api/items"),
  get: (slug: string) => request<Item>(`/api/items/${encodeURIComponent(slug)}`),
  save: (
    slug: string,
    body: {
      content: string;
      title: string;
      kind: ItemKind;
      lang: string;
      group?: string;
      tags?: string[];
      etag?: string;
    },
  ) =>
    request<ItemMeta>(`/api/items/${encodeURIComponent(slug)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  remove: (slug: string) =>
    request<{ ok: boolean }>(`/api/items/${encodeURIComponent(slug)}`, { method: "DELETE" }),
  revisions: (slug: string) =>
    request<{ revisions: Revision[] }>(`/api/items/${encodeURIComponent(slug)}/revisions`),
  revision: (slug: string, key: string) =>
    request<{ key: string; content: string }>(
      `/api/items/${encodeURIComponent(slug)}/revisions/${encodeURIComponent(key)}`,
    ),
  restore: (slug: string, key: string) =>
    request<{ ok: boolean }>(
      `/api/items/${encodeURIComponent(slug)}/revisions/${encodeURIComponent(key)}/restore`,
      { method: "POST" },
    ),
  renameGroup: (from: string, to: string) =>
    request<{ ok: boolean; moved: number }>("/api/groups/rename", {
      method: "POST",
      body: JSON.stringify({ from, to }),
    }),
  shares: (slug?: string) =>
    request<{ shares: ShareSummary[] }>(
      slug ? `/api/shares?slug=${encodeURIComponent(slug)}` : "/api/shares",
    ),
  createShare: (body: { slug: string; path: string; filename: string; password: string }) =>
    request<ShareSummary & { password: string }>("/api/shares", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  removeShare: (path: string) =>
    request<{ ok: boolean; deleted: string }>(`/api/shares/${encodeURIComponent(path)}`, {
      method: "DELETE",
    }),
};
