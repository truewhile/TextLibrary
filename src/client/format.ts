import type { Options, Plugin } from "prettier";
import { canonicalLang } from "./editor";

/**
 * One-click formatting, per language.
 *
 * Everything here is loaded lazily: the two WASM formatters ship binaries, and
 * Prettier's parser plugins are hundreds of kilobytes each. A reader who never
 * presses the button never downloads any of it, and formatting Python does not
 * pull in the TypeScript parser.
 */

type Formatter = (source: string) => Promise<string>;

/**
 * Refuse absurdly large documents instead of freezing the tab. Prettier parses
 * in JavaScript on the main thread, and a multi-hundred-kilobyte Markdown file
 * can block for seconds with no way to cancel.
 */
const MAX_INPUT_CHARS = 500_000;

/** Display names for the button tooltip; a missing entry means "no formatter". */
const FORMAT_LABELS: Record<string, string> = {
  python: "Python",
  shell: "Shell",
  json: "JSON",
  yaml: "YAML",
  markdown: "Markdown",
  javascript: "JavaScript",
  typescript: "TypeScript",
};

/* -------------------------------- Prettier -------------------------------- */

type PrettierModule = typeof import("prettier/standalone");

let prettierModule: Promise<PrettierModule> | null = null;

function loadPrettier(): Promise<PrettierModule> {
  prettierModule ??= import("prettier/standalone");
  return prettierModule;
}

/**
 * One loader per plugin, each with a literal specifier so Vite emits a separate
 * chunk. A computed `import("prettier/plugins/" + name)` would also match every
 * plugin Prettier ships — including the 1.7 MB Flow parser — and put them all in
 * the build output.
 */
const PLUGIN_LOADERS = {
  estree: () => import("prettier/plugins/estree"),
  babel: () => import("prettier/plugins/babel"),
  typescript: () => import("prettier/plugins/typescript"),
  yaml: () => import("prettier/plugins/yaml"),
  markdown: () => import("prettier/plugins/markdown"),
};

type PluginName = keyof typeof PLUGIN_LOADERS;

const pluginCache = new Map<PluginName, Promise<Plugin>>();

function loadPlugin(name: PluginName): Promise<Plugin> {
  let pending = pluginCache.get(name);
  if (!pending) {
    pending = PLUGIN_LOADERS[name]().then((module) => module as unknown as Plugin);
    pluginCache.set(name, pending);
  }
  return pending;
}

async function prettier(
  source: string,
  parser: string,
  pluginNames: PluginName[],
  options?: Options,
): Promise<string> {
  const [prettierModule, ...plugins] = await Promise.all([
    loadPrettier(),
    ...pluginNames.map(loadPlugin),
  ]);
  return prettierModule.format(source, {
    printWidth: 100,
    tabWidth: 2,
    ...(options ?? {}),
    parser,
    plugins,
  });
}

/* --------------------------------- errors --------------------------------- */

/**
 * ruff reports failures as a bare string, not an `Error`, and points at a
 * UTF-8 byte offset ("at byte range 6..7"). Prettier instead reports
 * "Unexpected token (1:7)" followed by a multi-line code frame.
 *
 * Both are bad toast text as-is: one stringifies to `undefined` through
 * `.message`, the other is taller than the toast. This turns either into a
 * single human sentence with a real line and column.
 */
const BYTE_RANGE_RE = /\s*at byte range (\d+)\.\.\d+\s*$/;

function lineColumnAt(text: string, byteOffset: number): { line: number; column: number } {
  const head = new TextEncoder().encode(text).subarray(0, byteOffset);
  const decoded = new TextDecoder().decode(head);
  const lines = decoded.split("\n");
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
}

function normalizeError(error: unknown, source: string): Error {
  const raw =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : String(error);

  const byteMatch = BYTE_RANGE_RE.exec(raw);
  if (byteMatch) {
    const { line, column } = lineColumnAt(source, Number(byteMatch[1]));
    const reason = raw.replace(BYTE_RANGE_RE, "").trim();
    return new Error(`${reason}（第 ${line} 行第 ${column} 列）`);
  }

  // Prettier appends a code frame after the first line; the toast needs the
  // verdict, not the drawing.
  const firstLine = raw.split("\n")[0]?.trim();
  return new Error(firstLine && firstLine.length > 0 ? firstLine : "格式化失败");
}

/* ------------------------------- Formatters ------------------------------- */

const FORMATTERS: Record<string, Formatter> = {
  python: async (source) => {
    const ruff = await import("@wasm-fmt/ruff_fmt/vite");
    await ruff.default();
    return ruff.format(source, "document.py", {
      // PEP 8 indentation, but the author's quote style: a format pass that
      // rewrites every string literal buries the real changes in the diff.
      indent_style: "space",
      indent_width: 4,
      line_width: 88,
      quote_style: "preserve",
    });
  },

  shell: async (source) => {
    const shfmt = await import("@wasm-fmt/shfmt/vite");
    await shfmt.default();
    // Two spaces to match the editor's indent unit (shfmt defaults to tabs).
    return shfmt.format(source, "document.sh", { indent: 2 });
  },

  json: async (source) => {
    try {
      // `json-stringify` is the strict printer: it expands nested arrays and
      // objects one element per line, as an editor's JSON format is expected to,
      // and it keeps number literals exactly as written (`1.500` stays `1.500`).
      // The plain `json` parser collapses short objects onto one line and
      // reprints numbers through a JS float, losing both.
      return await prettier(source, "json-stringify", ["estree", "babel"]);
    } catch (strictError) {
      // Real-world JSON here is often JSONC or JSON5: comments, trailing commas,
      // single-quoted or bare keys. Only the `jsonc` parser accepts those, so
      // retry rather than rejecting a file the reader can clearly see is fine.
      // If the retry fails too the input was plain broken; its message is the
      // one that names the real problem, so surface that one.
      try {
        return await prettier(source, "jsonc", ["estree", "babel"]);
      } catch {
        throw strictError;
      }
    }
  },

  yaml: (source) => prettier(source, "yaml", ["yaml"]),

  // Fenced code blocks are left byte-for-byte: the app's own highlighter owns
  // them, and reformatting samples inside documentation is surprising.
  markdown: (source) =>
    prettier(source, "markdown", ["markdown"], { embeddedLanguageFormatting: "off" }),

  javascript: (source) => prettier(source, "babel", ["estree", "babel"]),

  typescript: (source) => prettier(source, "typescript", ["estree", "typescript"]),
};

/**
 * The formatter's display name for a language, or `null` when there is none.
 * Callers use this to enable the button and to word the tooltip.
 */
export function formatSupport(lang: string | null | undefined): string | null {
  const canonical = canonicalLang(lang);
  if (!canonical) return null;
  return FORMAT_LABELS[canonical] ?? null;
}

/**
 * Format a whole document. Throws an `Error` whose message is safe to show the
 * user: Prettier and the WASM formatters report the offset where parsing failed,
 * which is exactly what the reader needs to fix.
 */
export async function formatDocument(
  lang: string | null | undefined,
  source: string,
): Promise<string> {
  const canonical = canonicalLang(lang);
  const formatter = canonical ? FORMATTERS[canonical] : undefined;
  if (!formatter) throw new Error("当前语言没有可用的格式化器");
  if (!source.trim()) throw new Error("文档是空的，没有可格式化的内容");
  if (source.length > MAX_INPUT_CHARS) {
    throw new Error(`文档超过 ${Math.round(MAX_INPUT_CHARS / 1000)}k 字符，为避免卡顿已跳过`);
  }
  try {
    return await formatter(source);
  } catch (error) {
    throw normalizeError(error, source);
  }
}
