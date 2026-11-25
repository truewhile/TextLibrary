import { Hono } from "hono";
import {
  normalizeGroup,
  normalizeTags,
  parseStoredTags,
} from "./shared/taxonomy";
import {
  MAX_FILENAME,
  normalizeFilename,
  normalizePassword,
  normalizeSharePath,
  parseShareRecord,
  type ShareRecord,
} from "./shared/share";

type Env = {
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_TOKEN: string;
};

type ItemKind = "doc" | "script";

type ItemMeta = {
  slug: string;
  title: string;
  kind: ItemKind;
  lang: string;
  group: string;
  tags: string[];
  updatedAt: string;
  createdAt: string;
  size: number;
  etag: string;
};

const REV_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_REVISIONS = 20;

// Slugs may contain Unicode letters/digits (Chinese titles are common), but must
// never be able to escape the `docs/` prefix or smuggle a path separator.
function isValidSlug(slug: string): boolean {
  if (!slug || slug.length > 64) return false;
  if (slug === "." || slug === "..") return false;
  if (slug.startsWith(".") || slug.endsWith(".")) return false;
  if (/[\/\\:*?"<>|%\u0000-\u001f\u007f]/.test(slug)) return false;
  return /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(slug);
}

const CONTENT_TYPES: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  ts: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
  sh: "text/x-shellscript; charset=utf-8",
  bash: "text/x-shellscript; charset=utf-8",
  py: "text/x-python; charset=utf-8",
  ps1: "text/plain; charset=utf-8",
  yml: "text/yaml; charset=utf-8",
  yaml: "text/yaml; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

const LANG_EXT: Record<string, string> = {
  markdown: "md",
  md: "md",
  javascript: "js",
  js: "js",
  typescript: "ts",
  ts: "ts",
  shell: "sh",
  sh: "sh",
  python: "py",
  py: "py",
  json: "json",
  powershell: "ps1",
  yaml: "yml",
  yml: "yml",
  text: "txt",
  txt: "txt",
};

const bodyKey = (slug: string) => `docs/${slug}`;
const revPrefix = (slug: string) => `revs/${slug}/`;
const shareKey = (path: string) => `shares/${path}`;
const SHARE_PREFIX = "shares/";

/**
 * Share paths live in their own key space so an alias can never shadow a
 * document, a revision, or an API route.
 */
async function readShare(bucket: R2Bucket, path: string): Promise<ShareRecord | null> {
  const obj = await bucket.get(shareKey(path));
  if (!obj) return null;
  return parseShareRecord(await obj.text());
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function listShares(bucket: R2Bucket, slug?: string): Promise<ShareRecord[]> {
  const out: ShareRecord[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix: SHARE_PREFIX, cursor });
    for (const obj of listed.objects) {
      const record = parseShareRecord(await (await bucket.get(obj.key))?.text());
      if (!record) continue;
      if (slug && record.slug !== slug) continue;
      out.push({ ...record, path: obj.key.slice(SHARE_PREFIX.length) });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return out;
}

function extOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : "";
}

function downloadName(slug: string, lang: string): string {
  if (extOf(slug)) return slug;
  const ext = LANG_EXT[lang] ?? LANG_EXT.markdown;
  return `${slug}.${ext}`;
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const left = enc.encode(a);
  const right = enc.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

function jsonError(message: string, status: number, extra?: Record<string, unknown>) {
  return new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function metaFromObject(obj: R2Object, slug: string): ItemMeta {
  const custom = obj.customMetadata ?? {};
  return {
    slug,
    title: custom.title || slug,
    kind: custom.kind === "script" ? "script" : "doc",
    lang: custom.lang || "markdown",
    group: custom.group || "",
    tags: parseStoredTags(custom.tags),
    updatedAt: custom.updatedAt || obj.uploaded.toISOString(),
    createdAt: custom.createdAt || obj.uploaded.toISOString(),
    size: obj.size,
    etag: obj.etag,
  };
}

async function readRaw(
  bucket: R2Bucket,
  key: string,
): Promise<{ text: string; obj: R2ObjectBody } | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  return { text: await obj.text(), obj };
}

async function pruneRevisions(bucket: R2Bucket, slug: string) {
  const listed = await bucket.list({ prefix: revPrefix(slug) });
  const keys = listed.objects.map((o) => o.key).sort();
  const excess = keys.length - MAX_REVISIONS;
  if (excess <= 0) return;
  await Promise.all(keys.slice(0, excess).map((key) => bucket.delete(key)));
}

async function snapshotCurrent(bucket: R2Bucket, slug: string, obj: R2ObjectBody, text: string) {
  const prevMeta = obj.customMetadata ?? {};
  const now = new Date().toISOString();
  const revKey = `${revPrefix(slug)}${now.replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
  await bucket.put(revKey, text, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
    customMetadata: {
      title: prevMeta.title || slug,
      lang: prevMeta.lang || "markdown",
      savedAt: now,
      etag: obj.etag,
      size: String(text.length),
    },
  });
  await pruneRevisions(bucket, slug);
  return revKey;
}

const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", async (c, next) => {
  const expected = c.env.ADMIN_TOKEN;
  if (!expected) {
    return jsonError("服务端未配置 ADMIN_TOKEN", 500);
  }
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || !timingSafeEqual(token, expected)) {
    return jsonError("未授权", 401);
  }
  await next();
});

app.get("/api/ping", (c) => c.json({ ok: true }));

const LIST_PAGE_LIMIT = 5000;

app.get("/api/items", async (c) => {
  const items: ItemMeta[] = [];
  let cursor: string | undefined;
  let truncated = false;

  do {
    const listed = await c.env.BUCKET.list({
      prefix: "docs/",
      include: ["customMetadata"],
      cursor,
    });
    for (const obj of listed.objects) {
      items.push(metaFromObject(obj, obj.key.slice("docs/".length)));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
    if (cursor && items.length >= LIST_PAGE_LIMIT) {
      truncated = true;
      break;
    }
  } while (cursor);

  items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return c.json({ items, truncated });
});

const GROUP_MOVE_LIMIT = 500;

async function collectGroupItems(bucket: R2Bucket, group: string) {
  const matches: { slug: string; obj: R2Object }[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix: "docs/", include: ["customMetadata"], cursor });
    for (const obj of listed.objects) {
      const current = normalizeGroup(obj.customMetadata?.group);
      const value = current.ok ? current.value : "";
      if (group && (value === group || value.startsWith(group + "/"))) {
        matches.push({ slug: obj.key.slice("docs/".length), obj });
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor && matches.length <= GROUP_MOVE_LIMIT);
  return matches;
}

/**
 * Groups are metadata on each object, so renaming a branch rewrites every member.
 * Only `group` changes; bodies and etags are preserved so open editors can keep saving.
 */
app.post("/api/groups/rename", async (c) => {
  let body: { from?: unknown; to?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return jsonError("请求体必须是 JSON", 400);
  }

  const from = normalizeGroup(body.from);
  const to = normalizeGroup(body.to);
  if (!from.ok) return jsonError(from.error, 400);
  if (!to.ok) return jsonError(to.error, 400);
  if (!from.value) return jsonError("缺少要重命名的分组", 400);
  if (from.value === to.value) return c.json({ ok: true, moved: 0 });
  if (to.value && to.value.startsWith(from.value + "/")) {
    return jsonError("新分组不能位于被重命名的分组内部", 400);
  }

  const matches = await collectGroupItems(c.env.BUCKET, from.value);
  if (matches.length > GROUP_MOVE_LIMIT) {
    return jsonError(`该分组下条目超过 ${GROUP_MOVE_LIMIT} 条，请分开重命名`, 413);
  }

  let moved = 0;
  for (const { slug, obj } of matches) {
    const custom = obj.customMetadata ?? {};
    const rest = custom.group!.slice(from.value.length);
    const nextGroup = to.value ? to.value + rest : "";
    const current = await c.env.BUCKET.get(bodyKey(slug));
    if (!current) continue;
    const text = await current.text();
    const res = await c.env.BUCKET.put(bodyKey(slug), text, {
      httpMetadata: {
        contentType:
          CONTENT_TYPES[extOf(slug)] ?? CONTENT_TYPES[LANG_EXT[custom.lang ?? "md"] ?? "md"] ?? "text/plain; charset=utf-8",
      },
      // Grouping is placement, not an edit: keep updatedAt so the list order
      // still reflects when the content actually changed.
      customMetadata: { ...custom, group: nextGroup },
      onlyIf: { etagMatches: current.etag },
    });
    if (res) moved++;
  }
  return c.json({ ok: true, moved });
});

app.get("/api/items/:slug", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return jsonError("非法名称", 400);
  const found = await readRaw(c.env.BUCKET, bodyKey(slug));
  if (!found) return jsonError("未找到", 404);
  return c.json({ ...metaFromObject(found.obj, slug), content: found.text });
});

app.put("/api/items/:slug", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return jsonError("非法名称", 400);

  let body: {
    content?: unknown;
    title?: unknown;
    kind?: unknown;
    lang?: unknown;
    group?: unknown;
    tags?: unknown;
    etag?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return jsonError("请求体必须是 JSON", 400);
  }

  if (typeof body.content !== "string") return jsonError("content 必须是字符串", 400);
  const content = body.content;
  if (content.length > MAX_BODY) return jsonError("内容超过 2 MiB 限制", 413);

  // Omitted fields keep their previous value; an explicit empty value clears them.
  const groupInput =
    body.group === undefined ? undefined : normalizeGroup(body.group);
  if (groupInput && !groupInput.ok) return jsonError(groupInput.error, 400);
  const tagsInput = body.tags === undefined ? undefined : normalizeTags(body.tags);
  if (tagsInput && !tagsInput.ok) return jsonError(tagsInput.error, 400);

  const key = bodyKey(slug);
  const existing = await c.env.BUCKET.get(key);
  const now = new Date().toISOString();

  const requestedEtag = typeof body.etag === "string" && body.etag ? body.etag : null;
  if (existing && !requestedEtag) {
    return jsonError("条目已存在，需要携带 etag 才能覆盖", 409, { etag: existing.etag });
  }
  if (!existing && requestedEtag) {
    return jsonError("条目不存在或已被删除，请刷新列表", 409);
  }
  if (existing && requestedEtag && existing.etag !== requestedEtag) {
    return jsonError("内容已被其他会话修改，请先刷新", 409, { etag: existing.etag });
  }

  const prevMeta = existing ? existing.customMetadata ?? {} : {};
  const prevText = existing ? await existing.text() : "";
  const kind: ItemKind =
    body.kind === "script" || body.kind === "doc"
      ? body.kind
      : prevMeta.kind === "script"
        ? "script"
        : "doc";
  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim().slice(0, 200)
      : prevMeta.title || slug;
  const lang =
    typeof body.lang === "string" && body.lang.trim()
      ? body.lang.trim().slice(0, 40)
      : prevMeta.lang || (kind === "doc" ? "markdown" : extOf(slug) || "text");

  const prevGroup = normalizeGroup(prevMeta.group);
  const group = groupInput ? groupInput.value : prevGroup.ok ? prevGroup.value : "";
  const tags = tagsInput ? tagsInput.value : parseStoredTags(prevMeta.tags);

  const putOptions: R2PutOptions = {
    httpMetadata: {
      contentType: CONTENT_TYPES[extOf(slug)] ?? CONTENT_TYPES[LANG_EXT[lang] ?? "md"] ?? "text/plain; charset=utf-8",
    },
    customMetadata: {
      title,
      kind,
      lang,
      group,
      tags: JSON.stringify(tags),
      updatedAt: now,
      createdAt: prevMeta.createdAt || now,
      revisedFrom: existing?.etag ?? "",
    },
  };
  if (existing) putOptions.onlyIf = { etagMatches: existing.etag };

  let written: R2Object | null = null;
  try {
    written = await c.env.BUCKET.put(key, content, putOptions);
  } catch {
    return jsonError("写入被并发修改打断，请刷新后重试", 409);
  }
  if (!written) return jsonError("写入被并发修改打断，请刷新后重试", 409);

  // Snapshot the replaced text only after the write is committed, so a rejected
  // save (etag conflict) can never leave behind a duplicate revision entry.
  if (existing && prevText !== content) {
    try {
      await snapshotCurrent(c.env.BUCKET, slug, existing, prevText);
    } catch {
      // Losing a snapshot must not fail a save that already landed.
    }
  }

  const meta: ItemMeta = {
    slug,
    title,
    kind,
    lang,
    group,
    tags,
    createdAt: putOptions.customMetadata!.createdAt,
    updatedAt: now,
    size: written.size,
    etag: written.etag,
  };
  return c.json(meta, existing ? 200 : 201);
});

app.delete("/api/items/:slug", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return jsonError("非法名称", 400);
  const existing = await c.env.BUCKET.head(bodyKey(slug));
  if (!existing) return jsonError("未找到", 404);
  await c.env.BUCKET.delete(bodyKey(slug));
  const revs = await c.env.BUCKET.list({ prefix: revPrefix(slug) });
  await Promise.all(revs.objects.map((o) => c.env.BUCKET.delete(o.key)));
  // Share links without their document would 404 anyway; clean them up so the
  // path becomes reusable instead of silently blocked.
  const shares = await listShares(c.env.BUCKET, slug);
  await Promise.all(shares.map((share) => c.env.BUCKET.delete(shareKey(share.path))));
  return c.json({ ok: true, deleted: slug, shares: shares.length });
});

/* ------------------------------- share links ------------------------------ */

function shareSummary(record: ShareRecord): Record<string, unknown> {
  return {
    path: record.path,
    slug: record.slug,
    filename: record.filename,
    protected: Boolean(record.passwordHash),
    createdAt: record.createdAt,
    url: `/s/${encodeURIComponent(record.path)}`,
  };
}

app.get("/api/shares", async (c) => {
  const slug = c.req.query("slug") ?? "";
  if (slug && !isValidSlug(slug)) return jsonError("非法名称", 400);
  const records = await listShares(c.env.BUCKET, slug || undefined);
  const shares = records
    .map(shareSummary)
    .sort((a, b) => String(a.createdAt) < String(b.createdAt) ? 1 : -1);
  return c.json({ shares });
});

app.post("/api/shares", async (c) => {
  let body: { slug?: unknown; path?: unknown; filename?: unknown; password?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return jsonError("请求体必须是 JSON", 400);
  }

  const slug = typeof body.slug === "string" ? body.slug : "";
  if (!isValidSlug(slug)) return jsonError("非法名称", 400);
  const pathInput = normalizeSharePath(body.path);
  if (!pathInput.ok) return jsonError(pathInput.error, 400);
  const filenameInput = normalizeFilename(body.filename);
  if (!filenameInput.ok) return jsonError(filenameInput.error, 400);
  const passwordInput = normalizePassword(body.password);
  if (!passwordInput.ok) return jsonError(passwordInput.error, 400);

  // Reserved words would collide with the app's own routes and static files.
  const reserved = new Set(["api", "d", "v", "s", "assets", "index", "favicon"]);
  if (reserved.has(pathInput.value.toLowerCase())) {
    return jsonError(`分享路径「${pathInput.value}」是保留字，请换一个`, 409);
  }

  const doc = await c.env.BUCKET.head(bodyKey(slug));
  if (!doc) return jsonError("条目不存在，请先保存", 404);

  const existing = await c.env.BUCKET.get(shareKey(pathInput.value));
  if (existing) return jsonError(`分享路径「${pathInput.value}」已被占用`, 409);

  const now = new Date().toISOString();
  const salt = crypto.randomUUID();
  const passwordHash = passwordInput.value ? await hashPassword(passwordInput.value, salt) : "";
  const record: ShareRecord = {
    path: pathInput.value,
    slug,
    filename: filenameInput.value.slice(0, MAX_FILENAME),
    passwordHash,
    passwordSalt: passwordHash ? salt : "",
    createdAt: now,
  };

  const written = await c.env.BUCKET.put(shareKey(record.path), JSON.stringify(record), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    // Reserve the path atomically so two sessions cannot claim it at once.
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (!written) return jsonError(`分享路径「${record.path}」已被占用`, 409);

  return c.json({ ...shareSummary(record), password: passwordInput.value }, 201);
});

app.delete("/api/shares/:path", async (c) => {
  const pathInput = normalizeSharePath(c.req.param("path"));
  if (!pathInput.ok) return jsonError(pathInput.error, 400);
  const existing = await c.env.BUCKET.head(shareKey(pathInput.value));
  if (!existing) return jsonError("分享链接不存在", 404);
  await c.env.BUCKET.delete(shareKey(pathInput.value));
  return c.json({ ok: true, deleted: pathInput.value });
});

app.get("/api/items/:slug/revisions", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return jsonError("非法名称", 400);
  const listed = await c.env.BUCKET.list({
    prefix: revPrefix(slug),
    include: ["customMetadata"],
  });
  const revisions = listed.objects
    .map((obj) => ({
      key: obj.key.slice(revPrefix(slug).length),
      savedAt: obj.customMetadata?.savedAt || obj.uploaded.toISOString(),
      title: obj.customMetadata?.title || slug,
      size: obj.size,
    }))
    .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  return c.json({ revisions });
});

app.get("/api/items/:slug/revisions/:key", async (c) => {
  const slug = c.req.param("slug");
  const revKey = c.req.param("key");
  if (!isValidSlug(slug) || !REV_KEY_RE.test(revKey)) return jsonError("非法名称", 400);
  const found = await readRaw(c.env.BUCKET, revPrefix(slug) + revKey);
  if (!found) return jsonError("未找到", 404);
  return c.json({ key: revKey, content: found.text });
});

app.post("/api/items/:slug/revisions/:key/restore", async (c) => {
  const slug = c.req.param("slug");
  const revKey = c.req.param("key");
  if (!isValidSlug(slug) || !REV_KEY_RE.test(revKey)) return jsonError("非法名称", 400);
  const rev = await c.env.BUCKET.get(revPrefix(slug) + revKey);
  if (!rev) return jsonError("版本不存在", 404);
  const current = await c.env.BUCKET.get(bodyKey(slug));
  if (!current) return jsonError("条目已被删除", 404);

  const currentText = await current.text();
  const text = await rev.text();
  const custom = current.customMetadata ?? {};
  const now = new Date().toISOString();

  const written = await c.env.BUCKET.put(bodyKey(slug), text, {
    httpMetadata: {
      contentType:
        CONTENT_TYPES[extOf(slug)] ?? CONTENT_TYPES[LANG_EXT[custom.lang ?? "md"] ?? "md"] ?? "text/plain; charset=utf-8",
    },
    customMetadata: { ...custom, updatedAt: now },
    onlyIf: { etagMatches: current.etag },
  });
  if (!written) return jsonError("条目刚被修改，请刷新后再恢复", 409);

  // Snapshot only after the restore lands, so a failed restore leaves no stray revision.
  if (currentText !== text) await snapshotCurrent(c.env.BUCKET, slug, current, currentText);

  return c.json({ ok: true, restored: revKey });
});

function downloadResponse(
  text: string,
  opts: {
    filename: string;
    contentType: string;
    inline: boolean;
    etag?: string;
    updatedAt?: string;
    group?: string;
    tags?: string[];
  },
) {
  const ascii = opts.filename.replace(/[^\x20-\x7e]/g, "_");
  return new Response(text, {
    headers: {
      "content-type": opts.contentType,
      "content-disposition": `${opts.inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(opts.filename)}`,
      "cache-control": "public, max-age=60",
      // Consumers such as deploy scripts can branch on taxonomy without a second API call.
      "x-cfnode-group": encodeURIComponent(opts.group ?? ""),
      "x-cfnode-tags": encodeURIComponent((opts.tags ?? []).join(",")),
      ...(opts.etag ? { etag: opts.etag } : {}),
      ...(opts.updatedAt ? { "last-modified": new Date(opts.updatedAt).toUTCString() } : {}),
    },
  });
}

app.get("/d/:slug", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return jsonError("非法名称", 400);
  const found = await readRaw(c.env.BUCKET, bodyKey(slug));
  if (!found) return c.text("Not found", 404);
  const custom = found.obj.customMetadata ?? {};
  const ext = extOf(slug) || LANG_EXT[custom.lang ?? ""] || "txt";
  return downloadResponse(found.text, {
    filename: downloadName(slug, custom.lang || ""),
    contentType: CONTENT_TYPES[ext] ?? "text/plain; charset=utf-8",
    inline: c.req.query("inline") === "1",
    etag: found.obj.etag,
    updatedAt: custom.updatedAt,
    group: custom.group || "",
    tags: parseStoredTags(custom.tags),
  });
});

app.get("/v/:slug/:key", async (c) => {
  const slug = c.req.param("slug");
  const revKey = c.req.param("key");
  if (!isValidSlug(slug) || !REV_KEY_RE.test(revKey)) return jsonError("非法名称", 400);
  const found = await readRaw(c.env.BUCKET, revPrefix(slug) + revKey);
  if (!found) return c.text("Not found", 404);
  const ext = extOf(slug) || "txt";
  return downloadResponse(found.text, {
    filename: `${slug}.${revKey}.${ext}`,
    contentType: CONTENT_TYPES[ext] ?? "text/plain; charset=utf-8",
    inline: c.req.query("inline") === "1",
    etag: found.obj.etag,
  });
});

app.get("/s/:path", async (c) => {
  const pathInput = normalizeSharePath(c.req.param("path"));
  if (!pathInput.ok) return c.text("Not found", 404);

  const share = await readShare(c.env.BUCKET, pathInput.value);
  if (!share) return c.text("Not found", 404);

  if (share.passwordHash) {
    // The password travels in the URL so a shared link works without a prompt;
    // the header is accepted too for plain `curl -H`.
    const supplied = c.req.query("p") ?? c.req.header("x-cfnode-password") ?? "";
    const candidate = await hashPassword(supplied, share.passwordSalt);
    if (!supplied || !timingSafeEqual(candidate, share.passwordHash)) {
      return c.text("密码错误或未提供。请在链接后加 ?p=密码 再试。", 401);
    }
  }

  const found = await readRaw(c.env.BUCKET, bodyKey(share.slug));
  if (!found) return c.text("Not found", 404);

  const custom = found.obj.customMetadata ?? {};
  const ext = extOf(share.slug) || LANG_EXT[custom.lang ?? ""] || "txt";
  return downloadResponse(found.text, {
    filename: share.filename || downloadName(share.slug, custom.lang || ""),
    contentType: CONTENT_TYPES[ext] ?? "text/plain; charset=utf-8",
    inline: c.req.query("inline") === "1",
    etag: found.obj.etag,
    updatedAt: custom.updatedAt,
    group: custom.group || "",
    tags: parseStoredTags(custom.tags),
  });
});

// Unknown API path must not fall through to the SPA shell, or JSON clients get HTML.
app.all("/api/*", (c) => jsonError("接口不存在", 404));

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
