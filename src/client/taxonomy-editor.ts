import { el, toast } from "./ui";
import { MAX_TAGS, MAX_TAG_LENGTH, normalizeGroup, normalizeTags } from "../shared/taxonomy";

export type TagEditorHandle = {
  root: HTMLElement;
  getTags: () => string[];
  setTags: (tags: string[]) => void;
  setDisabled: (disabled: boolean) => void;
  onChange: (handler: () => void) => void;
};

/**
 * Chips plus a free-text field. Enter or comma commits a tag; Backspace on an
 * empty field removes the last chip so the whole thing stays keyboard-only.
 */
export function createTagEditor(initial: string[]): TagEditorHandle {
  let tags = [...initial];
  let disabled = false;
  let listener: () => void = () => {};

  const chips = el("div", { class: "tag-chips" });
  const input = el("input", {
    class: "tag-input",
    placeholder: "添加标签…",
    spellcheck: false,
    autocomplete: "off",
  });

  const root = el("div", { class: "tag-editor" }, [chips, input]);

  function emit() {
    listener();
  }

  function renderChips() {
    const nodes = tags.map((tag) => {
      const remove = el("button", {
        class: "tag-remove",
        type: "button",
        title: `移除标签 ${tag}`,
        disabled,
      }, ["×"]);
      remove.setAttribute("aria-label", `移除标签 ${tag}`);
      remove.addEventListener("click", () => {
        tags = tags.filter((entry) => entry !== tag);
        renderChips();
        emit();
      });
      return el("span", { class: "tag-chip" }, [el("span", {}, [tag]), remove]);
    });
    chips.replaceChildren(...nodes);
    input.placeholder = tags.length >= MAX_TAGS ? `最多 ${MAX_TAGS} 个标签` : "添加标签…";
  }

  function commit(raw: string) {
    if (!raw.trim()) return;
    const result = normalizeTags([...tags, raw]);
    if (!result.ok) {
      toast(result.error, "err");
      return;
    }
    // normalizeTags de-duplicates case-insensitively, so `tags` may be unchanged
    // for a repeat entry; still clear the field so the user sees it took effect.
    tags = result.value;
    renderChips();
    emit();
  }

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit(input.value);
      input.value = "";
      return;
    }
    if (event.key === "Backspace" && !input.value && tags.length) {
      event.preventDefault();
      tags = tags.slice(0, -1);
      renderChips();
      emit();
    }
  });
  input.addEventListener("blur", () => {
    if (input.value.trim()) {
      commit(input.value);
      input.value = "";
    }
  });
  input.addEventListener("input", () => {
    if (input.value.length > MAX_TAG_LENGTH && !input.value.includes(",")) {
      input.value = input.value.slice(0, MAX_TAG_LENGTH);
    }
  });

  renderChips();

  return {
    root,
    getTags: () => [...tags],
    setTags: (next) => {
      tags = [...next];
      renderChips();
    },
    setDisabled: (value) => {
      disabled = value;
      input.disabled = value;
      root.classList.toggle("is-disabled", value);
      for (const button of chips.querySelectorAll<HTMLButtonElement>("button")) {
        button.disabled = value;
      }
      input.hidden = value && tags.length > 0;
      if (!value) input.hidden = false;
    },
    onChange: (handler) => {
      listener = handler;
    },
  };
}

export type GroupPickerHandle = {
  root: HTMLElement;
  getValue: () => string;
  setValue: (value: string) => void;
  setOptions: (paths: string[]) => void;
  setDisabled: (disabled: boolean) => void;
  onChange: (handler: () => void) => void;
};

/**
 * A text field with datalist suggestions: free typing allows creating a new
 * nested path, while the list makes existing branches discoverable.
 */
export function createGroupPicker(initial: string): GroupPickerHandle {
  let listener: () => void = () => {};

  const listId = `group-options-${Math.random().toString(36).slice(2, 8)}`;
  const list = el("datalist", { id: listId });
  const input = el("input", {
    class: "field group-input",
    placeholder: "分组，如 ops/deploy",
    spellcheck: false,
    autocomplete: "off",
  });
  input.setAttribute("list", listId);
  input.value = initial;
  const root = el("div", { class: "group-picker" }, [input, list]);

  input.addEventListener("input", () => listener());

  return {
    root,
    getValue: () => input.value.trim(),
    setValue: (value) => {
      input.value = value;
    },
    setOptions: (paths) => {
      list.replaceChildren(...paths.map((path) => el("option", { value: path })));
    },
    setDisabled: (value) => {
      input.disabled = value;
    },
    onChange: (handler) => {
      listener = handler;
    },
  };
}

/** Inline validation for the group field, so an invalid path is caught before save. */
export function validateGroupInput(value: string): { ok: boolean; value: string; error: string } {
  if (!value) return { ok: true, value: "", error: "" };
  const result = normalizeGroup(value);
  if (!result.ok) return { ok: false, value: "", error: result.error };
  return { ok: true, value: result.value, error: "" };
}
