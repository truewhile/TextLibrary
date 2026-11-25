import { api, ApiError, type ShareSummary } from "./api";
import { confirmDialog, el, formatBytes, toast } from "./ui";
import {
  MAX_FILENAME,
  MAX_PASSWORD_LENGTH,
  MAX_SHARE_PATH,
  MIN_PASSWORD_LENGTH,
  normalizeFilename,
  normalizePassword,
  normalizeSharePath,
} from "../shared/share";

/**
 * A share link's password is only ever stored as a hash on the server, so the
 * creator's browser keeps the plaintext to rebuild the full link later. This is
 * the same trust boundary as the admin token already in localStorage.
 */
const passwordKey = (path: string) => `cfnode.sharepw.${path}`;

function rememberPassword(path: string, password: string) {
  if (password) localStorage.setItem(passwordKey(path), password);
  else localStorage.removeItem(passwordKey(path));
}

function recallPassword(path: string): string {
  return localStorage.getItem(passwordKey(path)) ?? "";
}

export function fullShareUrl(share: { path: string; protected: boolean }): string {
  const path = `/s/${encodeURIComponent(share.path)}`;
  const password = share.protected ? recallPassword(share.path) : "";
  const url = new URL(password ? `${path}?p=${encodeURIComponent(password)}` : path, location.origin);
  return url.toString();
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard APIs need a secure context; fall back to a temporary selection.
    try {
      const area = el("textarea", { style: "position:fixed;opacity:0;top:0;left:0" });
      area.value = text;
      document.body.append(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function openShareDialog(share: { slug: string; title: string; size: number }) {
  const body = el("div", { class: "share-body" }, [el("div", { class: "empty-hint" }, ["加载中…"])]);

  const backdrop = el("div", { class: "modal-backdrop" });
  const modal = el("div", { class: "modal share-modal" }, [
    el("div", { class: "modal-head" }, [`分享 · ${share.title || share.slug}`]),
    el("div", { class: "modal-desc" }, [
      "分享链接是独立别名，公开可访问，不影响原有的 /d/ 链接。设置密码后，密码会拼在链接里一起发给对方。",
    ]),
    body,
  ]);

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };
  function close() {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  }
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener("keydown", onKey);
  backdrop.append(modal);
  document.body.append(backdrop);

  async function refresh() {
    try {
      const { shares } = await api.shares(share.slug);
      body.replaceChildren(builtinSection(), listSection(shares), createSection());
    } catch (error) {
      body.replaceChildren(
        el("div", { class: "empty-hint" }, ["加载失败：" + (error as Error).message]),
      );
    }
  }

  /** The built-in /d/ link stays available; share links are extra aliases. */
  function builtinSection() {
    const url = new URL(`/d/${encodeURIComponent(share.slug)}`, location.origin).toString();
    const copyBtn = el("button", { class: "btn btn-sm", type: "button" }, ["复制"]);
    copyBtn.addEventListener("click", async () => {
      const ok = await copyText(url);
      toast(ok ? "已复制内置下载链接" : url, ok ? "ok" : "info");
    });
    return el("div", { class: "share-group" }, [
      el("div", { class: "share-group-title" }, ["内置下载链接"]),
      el("div", { class: "share-row" }, [
        el("div", { class: "share-row-main" }, [el("code", { class: "share-path" }, [`/d/${share.slug}`])]),
        el("div", { class: "share-row-sub" }, ["始终可用，路径跟随标题生成的 slug"]),
        el("div", { class: "share-row-actions" }, [
          copyBtn,
          el("a", { class: "btn btn-sm btn-ghost", href: url, target: "_blank", rel: "noreferrer" }, ["打开"]),
        ]),
      ]),
    ]);
  }

  function listSection(shares: ShareSummary[]) {
    if (!shares.length) {
      return el("div", { class: "share-group" }, [
        el("div", { class: "share-group-title" }, ["已有分享链接"]),
        el("div", { class: "empty-hint", style: "padding:14px 0" }, ["还没有分享链接。"]),
      ]);
    }

    const rows = shares.map((item) => {
      const copyBtn = el("button", { class: "btn btn-sm", type: "button" }, ["复制"]);
      copyBtn.addEventListener("click", async () => {
        const ok = await copyText(fullShareUrl(item));
        toast(ok ? "已复制分享链接" : fullShareUrl(item), ok ? "ok" : "info");
      });

      const openBtn = el("a", {
        class: "btn btn-sm btn-ghost",
        href: `${item.url}${item.protected && recallPassword(item.path) ? `?p=${encodeURIComponent(recallPassword(item.path))}` : ""}`,
        target: "_blank",
        rel: "noreferrer",
      }, ["打开"]);

      if (item.protected && !recallPassword(item.path)) {
        // Without the stored plaintext we can only offer the bare link.
        copyBtn.title = "密码只在创建时可见，该浏览器已没有记录，请手动补上 ?p=密码";
      }

      const delBtn = el("button", { class: "btn btn-sm btn-ghost btn-danger", type: "button" }, ["删除"]);
      delBtn.addEventListener("click", async () => {
        const ok = await confirmDialog(
          `删除分享链接 /s/${item.path}？`,
          "删除后该链接立即失效，条目本身不受影响。",
          "删除链接",
        );
        if (!ok) return;
        try {
          await api.removeShare(item.path);
          rememberPassword(item.path, "");
          toast("分享链接已删除", "ok");
          await refresh();
        } catch (error) {
          toast("删除失败：" + (error as Error).message, "err");
        }
      });

      return el("div", { class: "share-row" }, [
        el("div", { class: "share-row-main" }, [
          el("code", { class: "share-path" }, [`/s/${item.path}`]),
          item.protected ? el("span", { class: "share-badge" }, ["含密码"]) : null,
        ]),
        el("div", { class: "share-row-sub" }, [
          item.filename ? `另存为 ${item.filename}` : "文件名自动推断",
        ]),
        el("div", { class: "share-row-actions" }, [copyBtn, openBtn, delBtn]),
      ]);
    });

    return el("div", { class: "share-group" }, [
      el("div", { class: "share-group-title" }, ["已有分享链接"]),
      ...rows,
    ]);
  }

  function createSection() {
    const pathInput = el("input", {
      class: "field",
      placeholder: "例如 team-deploy",
      spellcheck: false,
      autocomplete: "off",
      maxLength: MAX_SHARE_PATH,
    });
    pathInput.setAttribute("aria-label", "分享路径");

    const filenameInput = el("input", {
      class: "field",
      placeholder: "留空则自动推断",
      spellcheck: false,
      autocomplete: "off",
      maxLength: MAX_FILENAME,
    });
    filenameInput.setAttribute("aria-label", "下载后的文件名");

    const passwordInput = el("input", {
      class: "field",
      type: "text",
      placeholder: `可选，至少 ${MIN_PASSWORD_LENGTH} 位`,
      spellcheck: false,
      autocomplete: "off",
      maxLength: MAX_PASSWORD_LENGTH,
    });
    passwordInput.setAttribute("aria-label", "访问密码");

    const error = el("div", { class: "modal-error hidden" });
    const showError = (message: string) => {
      error.textContent = message;
      error.classList.remove("hidden");
    };

    const submitBtn = el("button", { class: "btn btn-primary", type: "submit" }, ["创建链接"]);

    const form = el("form", { class: "share-form" }, [
      el("label", { class: "share-field" }, [el("span", {}, ["分享路径"]), pathInput]),
      el("div", { class: "share-preview" }, [el("code", {}, ["/s/"]), el("span", { class: "share-preview-path" }, ["…"])]),
      el("label", { class: "share-field" }, [el("span", {}, ["文件名（可选）"]), filenameInput]),
      el("label", { class: "share-field" }, [el("span", {}, ["密码（可选）"]), passwordInput]),
      el("div", { class: "share-form-foot" }, [el("span", { class: "share-size" }, [formatBytes(share.size)]), submitBtn]),
      error,
    ]);

    const previewPath = form.querySelector<HTMLElement>(".share-preview-path")!;
    pathInput.addEventListener("input", () => {
      const parsed = normalizeSharePath(pathInput.value);
      previewPath.textContent = parsed.ok ? parsed.value : "…";
      previewPath.classList.toggle("invalid", Boolean(pathInput.value) && !parsed.ok);
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.classList.add("hidden");

      const path = normalizeSharePath(pathInput.value);
      if (!path.ok) return showError(path.error);
      const filename = normalizeFilename(filenameInput.value);
      if (!filename.ok) return showError(filename.error);
      const password = normalizePassword(passwordInput.value);
      if (!password.ok) return showError(password.error);

      submitBtn.disabled = true;
      submitBtn.textContent = "创建中…";
      try {
        const created = await api.createShare({
          slug: share.slug,
          path: path.value,
          filename: filename.value,
          password: password.value,
        });
        rememberPassword(created.path, password.value);
        const url = new URL(created.url, location.origin).toString();
        const full = password.value ? `${url}?p=${encodeURIComponent(password.value)}` : url;
        const ok = await copyText(full);
        toast(ok ? "分享链接已创建并复制" : `分享链接已创建：${full}`, "ok");
        await refresh();
      } catch (err) {
        const message = err instanceof ApiError ? err.message : (err as Error).message;
        showError(message);
        submitBtn.disabled = false;
        submitBtn.textContent = "创建链接";
      }
    });

    return el("div", { class: "share-group" }, [
      el("div", { class: "share-group-title" }, ["新建分享链接"]),
      form,
    ]);
  }

  void refresh();
  return { close, refresh };
}
