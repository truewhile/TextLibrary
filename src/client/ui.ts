type ElProps<T> = Omit<Partial<T>, "style"> & {
  class?: string;
  style?: string;
  dataset?: Record<string, string>;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElProps<HTMLElementTagNameMap[K]>,
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null) continue;
    if (key === "class") node.className = String(value);
    else if (key === "style") node.setAttribute("style", String(value));
    else if (key === "dataset") Object.assign(node.dataset, value as Record<string, string>);
    else if (key in node) (node as unknown as Record<string, unknown>)[key] = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "未知时间";
  const diff = Date.now() - then;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(then).toLocaleDateString("zh-CN");
}

export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", { hour12: false });
}

type ToastKind = "info" | "ok" | "err";

let toastHost: HTMLElement | null = null;

export function toast(message: string, kind: ToastKind = "info"): void {
  if (!toastHost) {
    toastHost = el("div", { class: "toasts" });
    document.body.append(toastHost);
  }
  const node = el("div", { class: `toast ${kind === "info" ? "" : kind}` }, [message]);
  toastHost.append(node);
  setTimeout(() => {
    node.style.transition = "opacity .2s ease, transform .2s ease";
    node.style.opacity = "0";
    node.style.transform = "translateY(6px)";
    setTimeout(() => node.remove(), 220);
  }, 2600);
}

export function confirmDialog(title: string, desc: string, confirmLabel = "确认"): Promise<boolean> {
  return new Promise((resolve) => {
    const close = (value: boolean) => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(false);
    };
    const backdrop = el("div", { class: "modal-backdrop" }, [
      el("div", { class: "modal" }, [
        el("div", { class: "modal-head" }, [title]),
        el("div", { class: "modal-desc" }, [desc]),
        el("div", { class: "modal-foot" }, [
          el("button", { class: "btn btn-ghost", onclick: () => close(false) }, ["取消"]),
          el("button", { class: "btn btn-primary", onclick: () => close(true) }, [confirmLabel]),
        ]),
      ]),
    ]);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close(false);
    });
    document.addEventListener("keydown", onKey);
    document.body.append(backdrop);
  });
}

/**
 * Text prompt as a real form so Enter submits and Escape cancels, matching the
 * keyboard behaviour users already get from the rest of the modals.
 */
export function promptDialog(
  title: string,
  desc: string,
  initial: string,
  opts: { label?: string; confirmLabel?: string; placeholder?: string; hint?: string } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    const input = el("input", {
      class: "field",
      spellcheck: false,
      placeholder: opts.placeholder ?? "",
      autocomplete: "off",
    });
    input.value = initial;

    const error = el("div", { class: "modal-error hidden" });
    const showError = (message: string) => {
      error.textContent = message;
      error.classList.remove("hidden");
    };

    const close = (value: string | null) => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(null);
    };

    const form = el("form", {}, [
      el("div", { class: "modal-body" }, [
        el("label", {}, [opts.label ?? title, input]),
        opts.hint ? el("div", { class: "modal-desc", style: "padding:0" }, [opts.hint]) : null,
      ]),
      error,
      el("div", { class: "modal-foot" }, [
        el("button", { class: "btn btn-ghost", type: "button", onclick: () => close(null) }, ["取消"]),
        el("button", { class: "btn btn-primary", type: "submit" }, [opts.confirmLabel ?? "确定"]),
      ]),
    ]);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) {
        showError("不能为空");
        input.focus();
        return;
      }
      close(value);
    });

    const backdrop = el("div", { class: "modal-backdrop" }, [
      el("div", { class: "modal" }, [
        el("div", { class: "modal-head" }, [title]),
        el("div", { class: "modal-desc" }, [desc]),
        form,
      ]),
    ]);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close(null);
    });
    document.addEventListener("keydown", onKey);
    document.body.append(backdrop);
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
  });
}
