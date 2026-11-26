import "./style.css";
import { api, ApiError, getToken, setToken, type ItemKind, type ItemMeta, type Revision } from "./api";
import { createEditor, type EditorHandle } from "./editor";
import { confirmDialog, el, formatBytes, formatClock, promptDialog, timeAgo, toast } from "./ui";
import { createGroupPicker, createTagEditor, type GroupPickerHandle, type TagEditorHandle } from "./taxonomy-editor";
import { allGroupPaths, buildSections, collectTags, filterItems, isSectionHidden, type GroupSection } from "./taxonomy-view";
import { normalizeGroup } from "../shared/taxonomy";
import { openShareDialog as showShareDialog } from "./share-dialog";
import { isMarkdownLang, MD_VIEW_MODES, renderMarkdown, type MdViewMode } from "./md-preview";
import { diffLayout } from "./diff-layout";
import {
  THEME_OPTIONS,
  getResolvedTheme,
  getThemePreference,
  initTheme,
  onThemeChange,
  setThemePreference,
  type ThemePreference,
} from "./theme";

const DOC_LANGS = ["markdown", "text", "json", "yaml"];
const SCRIPT_LANGS = ["javascript", "typescript", "shell", "python", "powershell", "text"];
const MD_VIEW_STORAGE_KEY = "textlibrary.mdViewMode";

initTheme();

type SaveState = "clean" | "dirty" | "saving" | "error";

function hasUnsavedChanges(): boolean {
  return state.saveState === "dirty" || state.saveState === "error" || state.saveState === "saving";
}

type AppState = {
  items: ItemMeta[];
  filtered: ItemMeta[];
  active: ItemMeta | null;
  draft: boolean;
  saveState: SaveState;
  statusText: string;
  search: string;
  selectedTags: Set<string>;
  collapsedGroups: Set<string>;
  loading: boolean;
  truncated: boolean;
  listLimit: number;
};

const state: AppState = {
  items: [],
  filtered: [],
  active: null,
  draft: false,
  saveState: "clean",
  statusText: "",
  search: "",
  selectedTags: new Set(),
  collapsedGroups: new Set(),
  loading: false,
  truncated: false,
  listLimit: 5000,
};

const root = document.querySelector<HTMLDivElement>("#app")!;

let editor: EditorHandle | null = null;
let listHost: HTMLElement | null = null;
let titleInput: HTMLInputElement | null = null;
let kindSelect: HTMLSelectElement | null = null;
let langSelect: HTMLSelectElement | null = null;
let statusHost: HTMLElement | null = null;
let saveBtn: HTMLButtonElement | null = null;
let downloadBtn: HTMLAnchorElement | null = null;
let shareBtn: HTMLButtonElement | null = null;
let groupPicker: GroupPickerHandle | null = null;
let tagEditor: TagEditorHandle | null = null;
let tagFilterHost: HTMLElement | null = null;
let metaRow: HTMLElement | null = null;
let searchInput: HTMLInputElement | null = null;
let viewModeHost: HTMLElement | null = null;
let previewHost: HTMLElement | null = null;
let editorWrap: HTMLElement | null = null;
let mdViewMode: MdViewMode = loadMdViewMode();

function loadMdViewMode(): MdViewMode {
  const saved = localStorage.getItem(MD_VIEW_STORAGE_KEY);
  if (saved === "edit" || saved === "preview" || saved === "split") return saved;
  return "edit";
}

function saveMdViewMode(mode: MdViewMode) {
  mdViewMode = mode;
  localStorage.setItem(MD_VIEW_STORAGE_KEY, mode);
}

function createThemeToggle(): HTMLElement {
  const host = el("div", {
    class: "theme-toggle",
    role: "radiogroup",
    ariaLabel: "外观主题",
  });

  const buttons = new Map<ThemePreference, HTMLButtonElement>();

  const paint = () => {
    const pref = getThemePreference();
    const resolvedLabel = getResolvedTheme() === "dark" ? "夜晚" : "日间";
    for (const option of THEME_OPTIONS) {
      const button = buttons.get(option.id);
      if (!button) continue;
      const active = pref === option.id;
      button.classList.toggle("active", active);
      button.setAttribute("aria-checked", active ? "true" : "false");
      button.title =
        option.id === "system" ? `${option.title}（当前：${resolvedLabel}）` : option.title;
    }
  };

  for (const option of THEME_OPTIONS) {
    const icon = el("span", { class: "theme-toggle-icon" }, [option.icon]);
    icon.setAttribute("aria-hidden", "true");
    const button = el(
      "button",
      {
        type: "button",
        class: "theme-toggle-btn",
        role: "radio",
        title: option.title,
        onclick: () => setThemePreference(option.id),
      },
      [icon, el("span", {}, [option.label])],
    );
    buttons.set(option.id, button);
    host.append(button);
  }

  paint();
  const stop = onThemeChange(() => {
    if (!host.isConnected) {
      stop();
      return;
    }
    paint();
  });
  return host;
}

function slugify(title: string): string {
  const cleaned = title
    .trim()
    .toLowerCase()
    .replace(/[\\/:*?"<>|%\s]+/g, "-")
    .replace(/[^\p{L}\p{N}._-]/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 64);
  return /^[\p{L}\p{N}]/u.test(cleaned) ? cleaned : "";
}

function currentValue(): string {
  return editor?.getValue() ?? "";
}

function langsFor(kind: ItemKind): string[] {
  return kind === "doc" ? DOC_LANGS : SCRIPT_LANGS;
}

/* ------------------------------- render shell ------------------------------ */

function renderGate(message?: string) {
  disposeEditor();

  const input = el("input", {
    class: "field",
    type: "password",
    placeholder: "ADMIN_TOKEN",
    autocomplete: "current-password",
  });
  input.value = getToken();

  const form = el("form", { class: "row" });
  const submitBtn = el("button", { class: "btn btn-primary", type: "submit" }, ["解锁"]);
  form.append(input, submitBtn);

  let busy = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const token = input.value.trim();
    if (!token) {
      toast("请输入令牌", "err");
      input.focus();
      return;
    }
    busy = true;
    submitBtn.disabled = true;
    submitBtn.textContent = "验证中…";
    setToken(token);
    try {
      await api.ping();
      busy = false;
      void boot();
    } catch (error) {
      busy = false;
      submitBtn.disabled = false;
      submitBtn.textContent = "解锁";
      setToken("");
      toast(error instanceof ApiError && error.status === 401 ? "令牌无效" : "连接失败", "err");
      input.focus();
    }
  });

  root.replaceChildren(
    el("div", { class: "gate" }, [
      el("div", { class: "gate-card" }, [
        el("div", { class: "gate-theme" }, [createThemeToggle()]),
        el("h1", {}, ["TextLibrary"]),
        el("p", {}, ["存放脚本与文档的 Cloudflare Worker。输入管理令牌以解锁编辑器。"]),
        form,
        message ? el("div", { class: "modal-error", style: "margin:14px 0 0" }, [message]) : null,
        el("div", { class: "gate-hint" }, [
          "令牌保存在本机 localStorage，仅随请求头发送到本 Worker。",
          "公开的下载链接 /d/<slug> 不需要令牌。",
        ]),
      ]),
    ]),
  );

  queueMicrotask(() => input.focus());
}

function renderShell() {
  listHost = el("div", { class: "item-list" });

  kindSelect = el("select", { class: "field" });
  langSelect = el("select", { class: "field" });
  titleInput = el("input", {
    class: "title-input",
    placeholder: "未命名",
    spellcheck: false,
  });
  titleInput.addEventListener("input", () => {
    if (!state.active) return;
    markDirty();
    renderList();
  });

  kindSelect.addEventListener("change", () => {
    const kind = kindSelect!.value as ItemKind;
    const langs = langsFor(kind);
    langSelect!.replaceChildren(...langs.map((l) => el("option", { value: l }, [l])));
    const preferred = kind === "doc" ? "markdown" : "shell";
    langSelect!.value = langs.includes(preferred) ? preferred : langs[0];
    editor?.setMode(kind, langSelect!.value);
    markDirty();
    updateDownloadHref();
    syncMdViewUi();
  });

  langSelect.addEventListener("change", () => {
    const kind = (kindSelect?.value as ItemKind) ?? "doc";
    editor?.setMode(kind, langSelect!.value);
    markDirty();
    updateDownloadHref();
    syncMdViewUi();
  });

  groupPicker = createGroupPicker("");
  groupPicker.onChange(() => {
    if (!state.active) return;
    markDirty();
  });

  tagEditor = createTagEditor([]);
  tagEditor.onChange(() => {
    if (!state.active) return;
    markDirty();
    renderList();
  });

  metaRow = el("div", { class: "meta-row" }, [
    el("div", { class: "meta-field" }, [
      el("span", { class: "meta-label" }, ["分组"]),
      groupPicker.root,
    ]),
    el("div", { class: "meta-field meta-field-grow" }, [
      el("span", { class: "meta-label" }, ["标签"]),
      tagEditor.root,
    ]),
  ]);

  searchInput = el("input", {
    class: "field",
    placeholder: "搜索标题、slug、分组、标签…",
    spellcheck: false,
  });
  searchInput.addEventListener("input", () => {
    state.search = searchInput!.value.trim().toLowerCase();
    renderList();
  });

  tagFilterHost = el("div", { class: "tag-filter" });

  saveBtn = el("button", { class: "btn btn-primary", onclick: () => void save() }, ["保存"]);
  const revBtn = el("button", { class: "btn", onclick: () => void openRevisions() }, ["历史版本"]);
  downloadBtn = el("a", { class: "btn" }, ["下载"]);
  shareBtn = el("button", {
    class: "btn",
    title: "创建自定义下载分享链接",
    onclick: () => openShareDialog(),
  }, ["分享"]);
  const deleteBtn = el("button", { class: "btn btn-ghost btn-danger", onclick: () => void removeActive() }, ["删除"]);
  const logoutBtn = el("button", {
    class: "btn btn-ghost",
    title: "清除本机令牌",
    onclick: () => {
      setToken("");
      renderGate();
    },
  }, ["退出"]);

  statusHost = el("span", { class: "status" });
  viewModeHost = el("div", {
    class: "view-mode-toggle hidden",
    role: "radiogroup",
    ariaLabel: "Markdown 视图",
  });
  previewHost = el("div", {
    class: "md-preview",
    tabIndex: 0,
    ariaLabel: "Markdown 预览",
  });
  editorWrap = el("div", { class: "editor-wrap is-edit" }, [
    el("div", { class: "cm-host" }),
    previewHost,
  ]);

  root.replaceChildren(
    el("div", { class: "shell" }, [
      el("aside", { class: "sidebar" }, [
        el("div", { class: "brand" }, [
          el("div", { class: "brand-mark" }, ["⚡"]),
          el("div", {}, [
            el("div", { class: "brand-title" }, ["TextLibrary"]),
            el("div", { class: "brand-sub" }, ["脚本与文档库"]),
          ]),
        ]),
        el("div", { class: "theme-toggle-row" }, [createThemeToggle()]),
        el("div", { class: "sidebar-tools" }, [
          el("button", {
            class: "btn btn-primary btn-sm",
            style: "height:30px",
            onclick: () => void createNew(),
          }, ["+ 新建"]),
          searchInput,
        ]),
        tagFilterHost,
        listHost,
      ]),
      el("main", { class: "main" }, [
        el("header", { class: "topbar" }, [
          titleInput,
          kindSelect,
          langSelect,
          viewModeHost,
          statusHost,
          downloadBtn,
          shareBtn,
          revBtn,
          saveBtn,
          deleteBtn,
          logoutBtn,
        ]),
        metaRow,
        editorWrap,
      ]),
    ]),
  );

  renderViewModeToggle();
  setKindOptions(kindSelect, "doc");
  langSelect.replaceChildren(...DOC_LANGS.map((l) => el("option", { value: l }, [l])));
  langSelect.value = "markdown";
  setEnabled(false);
  syncTopbar();
  syncMdViewUi();
  renderList();
}

function renderViewModeToggle() {
  if (!viewModeHost) return;
  viewModeHost.replaceChildren(
    ...MD_VIEW_MODES.map((mode) =>
      el(
        "button",
        {
          type: "button",
          class: `view-mode-btn${mdViewMode === mode.id ? " active" : ""}`,
          role: "radio",
          ariaChecked: mdViewMode === mode.id ? "true" : "false",
          title: mode.title,
          onclick: () => setMdViewMode(mode.id),
        },
        [mode.label],
      ),
    ),
  );
}

function setMdViewMode(mode: MdViewMode) {
  if (!isMarkdownLang(langSelect?.value)) return;
  saveMdViewMode(mode);
  renderViewModeToggle();
  applyMdViewMode();
  refreshPreview();
  if (mode !== "preview") queueMicrotask(() => editor?.focus());
}

function syncMdViewUi() {
  const markdown = isMarkdownLang(langSelect?.value);
  viewModeHost?.classList.toggle("hidden", !markdown || !state.active);
  if (!markdown && mdViewMode !== "edit") {
    // Non-markdown langs keep the last preference stored, but always show the editor.
    applyMdViewMode("edit");
    return;
  }
  applyMdViewMode();
  refreshPreview();
}

function applyMdViewMode(override?: MdViewMode) {
  if (!editorWrap) return;
  const mode = override ?? (isMarkdownLang(langSelect?.value) ? mdViewMode : "edit");
  editorWrap.classList.remove("is-edit", "is-preview", "is-split");
  editorWrap.classList.add(`is-${mode}`);
  // Request a layout pass so CodeMirror can resize after the pane toggles.
  queueMicrotask(() => editor?.view.requestMeasure());
}

function refreshPreview() {
  if (!previewHost) return;
  const markdown = isMarkdownLang(langSelect?.value);
  const showing = markdown && (mdViewMode === "preview" || mdViewMode === "split");
  if (!showing) return;
  const source = currentValue();
  if (!source.trim()) {
    previewHost.replaceChildren(el("div", { class: "md-preview-empty" }, ["开始编写 Markdown，预览会出现在这里。"]));
    return;
  }
  previewHost.innerHTML = renderMarkdown(source);
}

function setEnabled(enabled: boolean) {
  if (titleInput) titleInput.disabled = !enabled;
  if (kindSelect) kindSelect.disabled = !enabled;
  if (langSelect) langSelect.disabled = !enabled;
  if (saveBtn) saveBtn.disabled = !enabled;
  if (statusHost) statusHost.classList.toggle("hidden", !enabled);
  groupPicker?.setDisabled(!enabled);
  tagEditor?.setDisabled(!enabled);
  metaRow?.classList.toggle("is-disabled", !enabled);
}

function setKindOptions(select: HTMLSelectElement, kind: ItemKind) {
  select.replaceChildren(
    el("option", { value: "doc" }, ["文档"]),
    el("option", { value: "script" }, ["脚本"]),
  );
  select.value = kind;
}

/* -------------------------------- list ------------------------------------ */

function toggleTag(tag: string) {
  const key = tag.toLowerCase();
  if (state.selectedTags.has(key)) state.selectedTags.delete(key);
  else state.selectedTags.add(key);
  renderTagFilter();
  renderList();
}

function clearTagFilter() {
  state.selectedTags.clear();
  renderTagFilter();
  renderList();
}

function toggleGroup(path: string) {
  if (state.collapsedGroups.has(path)) state.collapsedGroups.delete(path);
  else state.collapsedGroups.add(path);
  renderList();
}

function renderTagFilter() {
  if (!tagFilterHost) return;
  const summaries = collectTags(state.items);
  if (!summaries.length) {
    tagFilterHost.replaceChildren();
    tagFilterHost.classList.add("hidden");
    return;
  }
  tagFilterHost.classList.remove("hidden");

  const chips = summaries.map(({ tag, count }) => {
    const selected = state.selectedTags.has(tag.toLowerCase());
    const chip = el("button", {
      class: `filter-chip${selected ? " selected" : ""}`,
      title: selected ? `取消筛选 ${tag}` : `只看标签 ${tag}`,
      onclick: () => toggleTag(tag),
    }, [el("span", {}, [tag]), el("span", { class: "filter-chip-count" }, [String(count)])]);
    chip.setAttribute("aria-pressed", selected ? "true" : "false");
    return chip;
  });

  const head =
    state.selectedTags.size > 0
      ? el("button", { class: "filter-clear", onclick: clearTagFilter }, ["清除筛选"])
      : null;

  tagFilterHost.replaceChildren(
    el("div", { class: "tag-filter-head" }, [el("span", {}, ["标签筛选"]), head ?? el("span", {})]),
    el("div", { class: "tag-filter-chips" }, chips),
  );
}

function renderItemNode(item: ItemMeta, inGroup: boolean): HTMLElement {
  const isActive = !state.draft && state.active?.slug === item.slug;
  const tags = item.tags.length
    ? el("div", { class: "item-tags" }, item.tags.map((tag) => {
        const selected = state.selectedTags.has(tag.toLowerCase());
        const chip = el("span", {
          class: `mini-tag${selected ? " selected" : ""}`,
          title: `筛选标签 ${tag}`,
          onclick: (event: MouseEvent) => {
            event.stopPropagation();
            toggleTag(tag);
          },
        }, [tag]);
        return chip;
      }))
    : null;

  const node = el("div", { class: `item${isActive ? " active" : ""}${inGroup ? " nested" : ""}` }, [
    el("div", { class: "item-name", title: item.slug }, [item.title || item.slug]),
    el("span", { class: `item-tag ${item.kind}` }, [item.kind === "doc" ? "文档" : "脚本"]),
    el("div", { class: "item-meta" }, [
      el("span", { class: "item-slug", title: item.slug }, [item.slug]),
      el("span", {}, ["·"]),
      el("span", {}, [timeAgo(item.updatedAt)]),
      el("span", {}, ["·"]),
      el("span", {}, [formatBytes(item.size)]),
    ]),
    tags,
  ]);
  node.addEventListener("click", () => void selectItem(item.slug));
  return node;
}

function renderSectionHeader(section: GroupSection): HTMLElement {
  const collapsed = state.collapsedGroups.has(section.path);
  const header = el("div", {
    class: `group-head depth-${Math.min(section.depth, 3)}${collapsed ? " collapsed" : ""}`,
  }, [
    el("span", { class: "group-caret" }, [collapsed ? "▸" : "▾"]),
    el("span", { class: "group-name", title: section.path || "未分组" }, [section.label]),
    el("span", { class: "group-count" }, [String(section.total)]),
  ]);

  if (!section.path) return header;

  const actions = el("span", { class: "group-actions" }, [
    (() => {
      const rename = el("button", {
        class: "icon-btn",
        title: `重命名分组 ${section.path}`,
        onclick: (event: MouseEvent) => {
          event.stopPropagation();
          void renameGroup(section.path);
        },
      }, ["✎"]);
      rename.setAttribute("aria-label", `重命名分组 ${section.path}`);
      return rename;
    })(),
  ]);
  header.append(actions);

  header.addEventListener("click", () => toggleGroup(section.path));
  header.setAttribute("role", "button");
  header.setAttribute("aria-expanded", collapsed ? "false" : "true");
  header.tabIndex = 0;
  header.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleGroup(section.path);
    }
  });
  return header;
}

function renderList() {
  if (!listHost) return;
  state.filtered = filterItems(state.items, state.search, state.selectedTags);

  const draftNode = state.draft
    ? (() => {
        const draftName = titleInput?.value.trim() || "未命名";
        return el("div", { class: "item active" }, [
          el("div", { class: "item-name" }, [draftName]),
          el("span", { class: "item-tag" }, ["草稿"]),
          el("div", { class: "item-meta" }, ["尚未保存"]),
        ]);
      })()
    : null;

  if (state.loading && state.items.length === 0) {
    listHost.replaceChildren(el("div", { class: "empty-hint" }, ["加载中…"]));
    return;
  }

  if (!state.filtered.length && !state.draft) {
    const filtered = state.search !== "" || state.selectedTags.size > 0;
    listHost.replaceChildren(
      el("div", { class: "empty-hint" }, [
        filtered ? "没有匹配的条目" : "还没有内容。点击「+ 新建」开始写第一份脚本或文档。",
      ]),
    );
    return;
  }

  const children: HTMLElement[] = [];
  if (draftNode) children.push(draftNode);

  const sections = buildSections(state.filtered);
  for (const section of sections) {
    // While filtering, an empty branch is noise: only show sections that still
    // hold matches, and drop the synthetic "未分组" header in the flat case.
    const isFiltering = state.search !== "" || state.selectedTags.size > 0;
    if (isFiltering && section.items.length === 0) continue;
    if (isSectionHidden(section, state.collapsedGroups)) continue;

    if (section.path || sections.some((other) => other.path)) {
      children.push(renderSectionHeader(section));
    }
    if (state.collapsedGroups.has(section.path)) continue;
    for (const item of section.items) {
      children.push(renderItemNode(item, Boolean(section.path)));
    }
  }

  if (state.truncated) {
    children.push(
      el("div", { class: "empty-hint" }, [
        `条目过多，仅显示前 ${state.listLimit} 条。请用搜索缩小范围。`,
      ]),
    );
  }

  listHost.replaceChildren(...children);
}

/* ------------------------------- topbar sync ------------------------------- */

function syncTopbar() {
  const active = state.active;
  if (titleInput) titleInput.value = active?.title ?? (state.draft ? "" : "");
  if (kindSelect) kindSelect.value = active?.kind ?? "doc";
  if (langSelect) langSelect.value = active?.lang ?? "markdown";
  if (groupPicker) {
    groupPicker.setValue(active?.group ?? "");
    groupPicker.setOptions(allGroupPaths(state.items));
  }
  if (tagEditor) tagEditor.setTags(active?.tags ?? []);
  if (downloadBtn) {
    if (!active || state.draft) downloadBtn.classList.add("hidden");
    else {
      downloadBtn.classList.remove("hidden");
      downloadBtn.href = `/d/${encodeURIComponent(active.slug)}`;
    }
  }
  if (shareBtn) shareBtn.classList.toggle("hidden", !active || state.draft);
  renderStatus();
  syncMdViewUi();
}

function renderStatus() {
  if (!statusHost) return;
  const map: Record<SaveState, { cls: string; text: string }> = {
    clean: { cls: "saved", text: state.active ? `已保存 · ${timeAgo(state.active.updatedAt)}` : "就绪" },
    dirty: { cls: "dirty", text: "有未保存的修改" },
    saving: { cls: "dirty", text: "保存中…" },
    error: { cls: "error", text: state.statusText || "保存失败" },
  };
  const info = map[state.saveState];
  statusHost.replaceChildren(el("span", { class: `dot ${info.cls}` }), el("span", {}, [info.text]));
}

function markDirty() {
  state.saveState = "dirty";
  renderStatus();
  document.title = "● TextLibrary · 脚本与文档";
}

function updateDownloadHref() {
  if (downloadBtn && state.active && !state.draft) {
    downloadBtn.href = `/d/${encodeURIComponent(state.active.slug)}`;
  }
}

function openShareDialog() {
  const active = state.active;
  if (!active || state.draft) {
    toast("请先保存条目，再创建分享链接");
    return;
  }
  showShareDialog({ slug: active.slug, title: active.title, size: active.size });
}

/* ------------------------------- groups ---------------------------------- */

async function renameGroup(from: string) {
  if (hasUnsavedChanges() && state.active?.group && (state.active.group === from || state.active.group.startsWith(from + "/"))) {
    const proceed = await confirmDialog(
      "当前条目有未保存的修改",
      `重命名会移动分组 ${from} 下的条目；当前条目未保存的正文与标签不会丢失，但需要先保存才能看到最新分组。`,
      "继续",
    );
    if (!proceed) return;
  }

  const next = await promptDialog(
    `重命名分组 ${from}`,
    "整棵子树会一起移动。留空表示把该分组下的条目改为未分组。",
    from,
    { label: "新分组路径", confirmLabel: "重命名", hint: "支持多级路径，如 ops/deploy" },
  );
  if (next === null) return;

  const parsed = normalizeGroup(next);
  if (!parsed.ok) {
    toast(parsed.error, "err");
    return;
  }
  if (parsed.value === from) return;

  try {
    const { moved } = await api.renameGroup(from, parsed.value);
    const { items, truncated, limit } = await api.list();
    state.items = items;
    state.truncated = truncated;
    state.listLimit = limit;
    state.collapsedGroups.delete(from);
    if (state.active && !state.draft) {
      const refreshed = items.find((item) => item.slug === state.active!.slug);
      if (refreshed && refreshed.group !== state.active.group) {
        const hadUnsaved = hasUnsavedChanges();
        state.active = { ...state.active, group: refreshed.group };
        if (!hadUnsaved) state.saveState = "clean";
      }
    }
    syncTopbar();
    renderTagFilter();
    renderList();
    toast(`已移动 ${moved} 个条目`, "ok");
  } catch (error) {
    toast("重命名失败：" + (error as Error).message, "err");
  }
}

/* ------------------------------- operations ------------------------------- */

async function boot() {
  state.loading = true;
  renderShell();
  try {
    const { items, truncated, limit } = await api.list();
    state.items = items;
    state.truncated = truncated;
    state.listLimit = limit;
    state.loading = false;
    renderTagFilter();
    renderList();
    if (items.length > 0) {
      await selectItem(items[0].slug, true);
    } else {
      editor?.focus();
    }
  } catch (error) {
    state.loading = false;
    if (error instanceof ApiError && error.status === 401) {
      setToken("");
      renderGate("令牌已失效，请重新输入。");
      return;
    }
    toast("加载列表失败：" + (error as Error).message, "err");
    renderList();
  }
}

function createEditorFor(content: string, kind: ItemKind, lang: string) {
  const host = root.querySelector<HTMLElement>(".cm-host");
  if (!host) return;
  disposeEditor();
  const handle = createEditor(
    host,
    { content, kind, lang, theme: getResolvedTheme() },
    () => {
      markDirty();
      refreshPreview();
    },
  );
  editor = handle;
  syncMdViewUi();
  if (mdViewMode !== "preview" || !isMarkdownLang(lang)) handle.focus();
}

function disposeEditor() {
  editor?.destroy();
  editor = null;
}

async function selectItem(slug: string, initial = false) {
  if (!initial && hasUnsavedChanges() && state.active) {
    const ok = await confirmDialog("放弃未保存的修改？", "当前条目有未保存的更改，切换后将丢失。");
    if (!ok) return;
  }

  const host = root.querySelector<HTMLElement>(".cm-host");
  if (!host) return;
  disposeEditor();
  host.replaceChildren();

  try {
    const item = await api.get(slug);
    state.active = item;
    state.draft = false;
    state.saveState = "clean";
    setEnabled(true);
    setKindOptions(kindSelect!, item.kind);
    langSelect!.replaceChildren(...langsFor(item.kind).map((l) => el("option", { value: l }, [l])));
    langSelect!.value = item.lang;
    createEditorFor(item.content, item.kind, item.lang);
    syncTopbar();
    renderTagFilter();
    renderList();
    document.title = `${item.title} · TextLibrary`;
  } catch (error) {
    toast("读取失败：" + (error as Error).message, "err");
    if (state.items.length && initial) {
      state.active = null;
      syncTopbar();
    }
  }
}

async function createNew() {
  if (hasUnsavedChanges() && state.active) {
    const ok = await confirmDialog("放弃未保存的修改？", "当前条目有未保存的更改，新建后将丢失。");
    if (!ok) return;
  }
  const host = root.querySelector<HTMLElement>(".cm-host");
  if (!host) return;
  disposeEditor();
  host.replaceChildren();

  state.active = { slug: "", title: "", kind: "doc", lang: "markdown", group: "", tags: [], createdAt: "", updatedAt: "", size: 0, etag: "" };
  state.draft = true;
  state.saveState = "dirty";
  setEnabled(true);
  setKindOptions(kindSelect!, "doc");
  langSelect!.replaceChildren(...DOC_LANGS.map((l) => el("option", { value: l }, [l])));
  langSelect!.value = "markdown";
  createEditorFor("", "doc", "markdown");
  syncTopbar();
  renderTagFilter();
  titleInput?.focus();
  renderList();
}

async function save(): Promise<boolean> {
  const title = titleInput?.value.trim() ?? "";
  const kind = (kindSelect?.value as ItemKind) ?? "doc";
  const lang = langSelect?.value ?? "markdown";
  const groupInput = normalizeGroup(groupPicker?.getValue() ?? "");
  const tags = tagEditor?.getTags() ?? [];

  if (!title) {
    toast("请先填写标题", "err");
    titleInput?.focus();
    return false;
  }
  if (!groupInput.ok) {
    toast(groupInput.error, "err");
    groupPicker?.root.querySelector("input")?.focus();
    return false;
  }

  const slug = state.draft ? slugify(title) || `untitled-${Date.now().toString(36)}` : state.active!.slug;

  state.saveState = "saving";
  renderStatus();

  try {
    const meta = await api.save(slug, {
      content: currentValue(),
      title,
      kind,
      lang,
      group: groupInput.value,
      tags,
      etag: state.draft ? undefined : state.active!.etag,
    });

    const existed = state.items.some((item) => item.slug === meta.slug);
    if (existed) state.items = state.items.map((item) => (item.slug === meta.slug ? meta : item));
    else state.items = [meta, ...state.items];

    state.active = meta;
    state.draft = false;
    state.saveState = "clean";
    state.statusText = "";
    // A brand-new group changes the sidebar shape, so it must follow the save.
    syncTopbar();
    renderTagFilter();
    renderList();
    document.title = `${meta.title} · TextLibrary`;
    toast("已保存", "ok");
    return true;
  } catch (error) {
    state.saveState = "error";
    state.statusText = (error as Error).message;
    renderStatus();
    if (error instanceof ApiError && error.status === 409) {
      toast("保存冲突：" + error.message, "err");
    } else {
      toast("保存失败：" + (error as Error).message, "err");
    }
    return false;
  }
}

async function removeActive() {
  const active = state.active;
  if (!active) return;

  if (state.draft) {
    state.active = null;
    state.draft = false;
    state.saveState = "clean";
    const host = root.querySelector<HTMLElement>(".cm-host");
    disposeEditor();
    host?.replaceChildren();
    setEnabled(false);
    syncTopbar();
    renderList();
    document.title = "TextLibrary · 脚本与文档";
    return;
  }

  const ok = await confirmDialog(
    `删除 ${active.slug}？`,
    "条目及其全部历史版本都会被永久删除，无法恢复。",
    "永久删除",
  );
  if (!ok) return;

  try {
    await api.remove(active.slug);
    state.items = state.items.filter((item) => item.slug !== active.slug);
    state.active = state.items[0] ?? null;
    setEnabled(Boolean(state.active));
    const host = root.querySelector<HTMLElement>(".cm-host");
    disposeEditor();
    host?.replaceChildren();
    if (state.active) await selectItem(state.active.slug, true);
    else {
      state.saveState = "clean";
      syncTopbar();
      renderList();
      document.title = "TextLibrary · 脚本与文档";
    }
    toast("已删除", "ok");
  } catch (error) {
    toast("删除失败：" + (error as Error).message, "err");
  }
}

/* ------------------------------- revisions ------------------------------- */

async function openRevisions() {
  if (!state.active || state.draft) {
    toast("请先保存条目再查看历史版本");
    return;
  }
  const slug = state.active.slug;

  const backdrop = el("div", { class: "drawer-backdrop" });
  const body = el("div", { class: "drawer-body" }, [el("div", { class: "empty-hint" }, ["加载中…"])]);
  const drawer = el("aside", {
    class: "drawer",
    onclick: (event: MouseEvent) => event.stopPropagation(),
  }, [
    el("div", { class: "drawer-head" }, [
      el("h2", {}, ["历史版本"]),
      el("div", { class: "spacer", style: "flex:1" }),
      el("button", {
        class: "btn btn-ghost btn-sm",
        onclick: () => close(),
      }, ["关闭"]),
    ]),
    body,
  ]);

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };
  function close() {
    backdrop.remove();
    drawer.remove();
    document.removeEventListener("keydown", onKey);
  }
  backdrop.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.append(backdrop, drawer);

  try {
    const { revisions } = await api.revisions(slug);
    if (!revisions.length) {
      body.replaceChildren(el("div", { class: "empty-hint" }, ["还没有历史版本。每次保存都会生成一份快照。"]));
      return;
    }
    body.replaceChildren(
      ...revisions.map((rev: Revision) => {
        const viewBtn = el("button", { class: "btn btn-sm" }, ["查看"]);
        viewBtn.addEventListener("click", () => void previewRevision(slug, rev));
        const restoreBtn = el("button", { class: "btn btn-sm btn-primary" }, ["恢复"]);
        restoreBtn.addEventListener("click", async () => {
          const ok = await confirmDialog(
            "恢复这个版本？",
            "将用该快照覆盖当前内容；当前内容会先自动存为一份新的历史版本。",
            "恢复",
          );
          if (!ok) return;
          try {
            await api.restore(slug, rev.key);
            toast("已恢复", "ok");
            close();
            await selectItem(slug, true);
          } catch (error) {
            toast("恢复失败：" + (error as Error).message, "err");
          }
        });
        return el("div", { class: "rev" }, [
          el("span", { class: "rev-time" }, [formatClock(rev.savedAt)]),
          el("span", { class: "rev-size" }, [formatBytes(rev.size)]),
          viewBtn,
          restoreBtn,
        ]);
      }),
    );
  } catch (error) {
    body.replaceChildren(el("div", { class: "empty-hint" }, ["加载失败：" + (error as Error).message]));
  }
}

async function previewRevision(slug: string, rev: Revision) {
  try {
    const { content } = await api.revision(slug, rev.key);
    const current = currentValue();
    const active = state.active;
    // A revision can only be diffed against the same language it was saved with.
    const kind: ItemKind = active?.kind ?? "doc";
    const lang = active?.lang ?? "markdown";
    const layout = diffLayout();

    let destroyDiff: (() => void) | null = null;
    let closed = false;

    const diffHost = el("div", { class: "diff-host" });
    const backdrop = el("div", { class: "modal-backdrop" });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    function close() {
      closed = true;
      destroyDiff?.();
      destroyDiff = null;
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
    }

    const modal = el("div", { class: "modal modal-wide" }, [
      el("div", { class: "modal-head" }, [`快照 ${formatClock(rev.savedAt)}`]),
      el("div", { class: "modal-desc" }, [
        layout === "split"
          ? "左侧是该快照，右侧是当前编辑中的内容；只读。"
          : "红色行是快照中被删改的内容，下方是当前编辑中的内容；只读。",
      ]),
      diffHost,
      el("div", { class: "modal-foot" }, [
        el("a", {
          class: "btn btn-sm",
          href: `/v/${encodeURIComponent(slug)}/${encodeURIComponent(rev.key)}`,
        }, ["下载该版本"]),
        el("button", { class: "btn btn-primary btn-sm", onclick: () => close() }, ["关闭"]),
      ]),
    ]);
    backdrop.append(modal);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close();
    });
    document.addEventListener("keydown", onKey);
    document.body.append(backdrop);

    try {
      const { mountDiff } = await import("./revision-diff");
      // The dialog can be dismissed while that import is in flight; mounting
      // into a detached host would create editor views nothing ever destroys.
      if (closed) return;
      destroyDiff = mountDiff(diffHost, {
        original: content || "",
        current,
        kind,
        lang,
        theme: getResolvedTheme(),
        layout,
      });
    } catch (error) {
      diffHost.replaceChildren(
        el("div", { class: "diff-fallback" }, ["无法渲染对比：" + (error as Error).message]),
      );
    }
  } catch (error) {
    toast("读取版本失败：" + (error as Error).message, "err");
  }
}

/* -------------------------------- shortcuts ------------------------------ */

document.addEventListener("keydown", (event) => {
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (editor && !saveBtn?.disabled) void save();
  }
});

window.addEventListener("beforeunload", (event) => {
  if (hasUnsavedChanges()) {
    event.preventDefault();
    event.returnValue = "";
  }
});

/* --------------------------------- bootstrap ----------------------------- */

onThemeChange((resolved) => {
  editor?.setTheme(resolved);
});

if (!getToken()) {
  renderGate();
} else {
  boot();
}
