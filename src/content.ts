import matter from "gray-matter";

// Repo-relative directory layout of the data repo.
export const DIRS = {
  prompts: "prompts",
  owners: "owners",
  docs: "docs",
  skills: "skills",
  // Open suggestions land here as drafts; a supervisor promotes them to the
  // live dirs above (publish_draft) or merges/edits them directly in Git.
  drafts: "drafts",
} as const;

// Live path for a given content type + slug, and its draft counterpart.
export type ContentType = "prompts" | "owners" | "docs" | "skills";

export function livePath(type: ContentType, slug: string): string {
  return type === "skills" ? `skills/${slug}/SKILL.md` : `${type}/${slug}.md`;
}

export function draftPath(type: ContentType, slug: string): string {
  return type === "skills" ? `drafts/skills/${slug}/SKILL.md` : `drafts/${type}/${slug}.md`;
}

export interface Doc {
  data: Record<string, unknown>;
  body: string;
}

export function parse(raw: string): Doc {
  const { data, content } = matter(raw);
  return { data: data as Record<string, unknown>, body: content.trim() };
}

/** Serialize frontmatter + body back to a `.md` file. Undefined values are
 *  dropped — the YAML dumper rejects them. */
export function stringify(data: Record<string, unknown>, body: string): string {
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  return matter.stringify(body.trim() + "\n", clean);
}

/** `prompts/incident-postmortem.md` → `incident-postmortem`. */
export function slugOf(path: string): string {
  return path.replace(/^.*\//, "").replace(/\.md$/, "");
}

/** Sanitize arbitrary user input into a filesystem-safe slug. */
export function toSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// ── human-readable renderers (tools return markdown) ─────────────────────────

export function renderPrompt(path: string, d: Doc): string {
  const vars = asArray(d.data.variables);
  const tags = asArray(d.data.tags);
  return [
    `# ${d.data.title ?? slugOf(path)}`,
    d.data.usage ? `\n**When to use:** ${d.data.usage}` : "",
    tags.length ? `**Tags:** ${tags.join(", ")}` : "",
    vars.length ? `**Variables:** ${vars.map((v) => `\`{{${v}}}\``).join(", ")}` : "",
    `\n---\n\n${d.body}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderOwner(path: string, d: Doc): string {
  return [
    `## ${d.data.area ?? slugOf(path)}`,
    d.data.owner ? `- **Owner:** ${d.data.owner}` : "",
    d.data.backup ? `- **Backup:** ${d.data.backup}` : "",
    d.data.contact ? `- **Contact:** ${d.data.contact}` : "",
    asArray(d.data.systems).length ? `- **Systems:** ${asArray(d.data.systems).join(", ")}` : "",
    d.body ? `\n${d.body}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderDoc(path: string, d: Doc): string {
  const links = Array.isArray(d.data.links) ? (d.data.links as Array<Record<string, unknown>>) : [];
  const linkLines = links.map((l) => `- [${l.label ?? l.url}](${l.url})`);
  return [
    `## ${d.data.system ?? slugOf(path)}`,
    d.data.category ? `_${d.data.category}_` : "",
    linkLines.length ? `\n${linkLines.join("\n")}` : "",
    d.body ? `\n${d.body}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function asArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v) return [v];
  return [];
}
