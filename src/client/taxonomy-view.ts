import type { ItemMeta } from "./api";
import { groupAncestors, groupLabel, groupSegments } from "../shared/taxonomy";

export type GroupSection = {
  path: string;
  label: string;
  depth: number;
  /** Items whose group is exactly this path. */
  items: ItemMeta[];
  /** Items this path or any descendant holds. */
  total: number;
  hasChildren: boolean;
};

export type TagSummary = { tag: string; count: number };

/**
 * Flatten the group tree into ordered sections so a nested path set renders as
 * indented rows instead of a recursive component tree.
 */
export function buildSections(items: ItemMeta[]): GroupSection[] {
  const paths = new Set<string>();
  for (const item of items) {
    if (!item.group) continue;
    paths.add(item.group);
    for (const ancestor of groupAncestors(item.group)) paths.add(ancestor);
  }

  const ordered = [...paths].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const sections: GroupSection[] = ordered.map((path) => ({
    path,
    label: groupLabel(path),
    depth: groupSegments(path).length - 1,
    items: items.filter((item) => item.group === path),
    total: items.filter((item) => item.group === path || item.group.startsWith(path + "/")).length,
    hasChildren: ordered.some((other) => other.startsWith(path + "/")),
  }));

  const ungrouped = items.filter((item) => !item.group);
  if (ungrouped.length) {
    sections.push({
      path: "",
      label: "未分组",
      depth: 0,
      items: ungrouped,
      total: ungrouped.length,
      hasChildren: false,
    });
  }
  return sections;
}

/** Hide a section when any of its ancestors is collapsed. */
export function isSectionHidden(section: GroupSection, collapsed: Set<string>): boolean {
  if (!section.path) return false;
  for (const ancestor of groupAncestors(section.path)) {
    if (collapsed.has(ancestor)) return true;
  }
  return false;
}

export function collectTags(items: ItemMeta[]): TagSummary[] {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const item of items) {
    for (const tag of item.tags) {
      const key = tag.toLowerCase();
      const existing = counts.get(key);
      if (existing) existing.count++;
      else counts.set(key, { tag, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "zh-CN"));
}

export function matchesQuery(item: ItemMeta, query: string): boolean {
  if (!query) return true;
  return (
    item.slug.toLowerCase().includes(query) ||
    item.title.toLowerCase().includes(query) ||
    item.lang.toLowerCase().includes(query) ||
    item.group.toLowerCase().includes(query) ||
    item.tags.some((tag) => tag.toLowerCase().includes(query))
  );
}

/** Selected tags combine as an intersection: an item must carry every one. */
export function matchesTags(item: ItemMeta, selected: Set<string>): boolean {
  if (selected.size === 0) return true;
  const own = new Set(item.tags.map((tag) => tag.toLowerCase()));
  for (const tag of selected) if (!own.has(tag)) return false;
  return true;
}

export function filterItems(items: ItemMeta[], query: string, selected: Set<string>): ItemMeta[] {
  return items.filter((item) => matchesQuery(item, query) && matchesTags(item, selected));
}

/** Every group path currently in use, for the group input's suggestions. */
export function allGroupPaths(items: ItemMeta[]): string[] {
  const paths = new Set<string>();
  for (const item of items) {
    if (!item.group) continue;
    paths.add(item.group);
    for (const ancestor of groupAncestors(item.group)) paths.add(ancestor);
  }
  return [...paths].sort((a, b) => a.localeCompare(b, "zh-CN"));
}
