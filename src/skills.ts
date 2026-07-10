import { parse as parseYaml } from "yaml";
import matter from "gray-matter";
import type { Config } from "./config.ts";
import type { DataStore } from "./store.ts";
import { DIRS, slugOf } from "./content.ts";
import { log } from "./log.ts";

// ybrain does NOT copy external skills. It keeps a lightweight index of their
// name+description (parsed from each repo's SKILL.md frontmatter) and, per
// source, knows the correct command to install them client-side.

export type SourceKind = "internal" | "skills-cli" | "marketplace" | "folder";

export interface SkillSource {
  id: string;
  kind: SourceKind;
  /** owner/repo on GitHub — omitted for the internal source. */
  repo?: string;
  branch?: string;
  /** Subdirectory that holds skill folders (default: repo root). */
  path?: string;
  /** Marketplace name, for `/plugin install <skill>@<name>` hints. */
  marketplace?: string;
}

export interface IndexedSkill {
  name: string;
  description: string;
  sourceId: string;
  kind: SourceKind;
  repo?: string;
  /** Repo-relative path to the skill folder. */
  skillPath: string;
}

const SOURCES_FILE = "skill-sources.yaml";

export class SkillIndex {
  private sources: SkillSource[] = [];
  private skills: IndexedSkill[] = [];

  constructor(
    private readonly config: Config,
    private readonly store: DataStore,
  ) {}

  async init(): Promise<void> {
    await this.reindex();
    if (this.config.pullIntervalSec > 0) {
      setInterval(() => {
        this.reindex().catch((e) => log.warn(`skill reindex failed: ${e}`));
      }, this.config.pullIntervalSec * 1000).unref?.();
    }
  }

  getSources(): SkillSource[] {
    return this.sources;
  }

  all(): IndexedSkill[] {
    return this.skills;
  }

  find(name: string): IndexedSkill | undefined {
    return this.skills.find((s) => s.name === name);
  }

  /** All skills sharing a name (skills are namespaced by source; names can collide). */
  findAll(name: string): IndexedSkill[] {
    return this.skills.filter((s) => s.name === name);
  }

  search(query: string): IndexedSkill[] {
    const q = query.toLowerCase();
    return this.skills.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }

  /** Rebuild the index from the sources file + the internal skills dir. */
  async reindex(): Promise<void> {
    this.sources = await this.loadSources();
    const next: IndexedSkill[] = [];
    for (const src of this.sources) {
      try {
        const found = src.kind === "internal" ? await this.indexInternal(src) : await this.indexRemote(src);
        next.push(...found);
      } catch (e) {
        log.warn(`indexing source "${src.id}" failed, keeping previous entries: ${e}`);
        next.push(...this.skills.filter((s) => s.sourceId === src.id));
      }
    }
    this.skills = next;
    log.info(`skill index: ${this.skills.length} skills across ${this.sources.length} sources`);
  }

  /** Re-index a single source without crawling the others (used off the tool
   *  call path so authoring/registering never blocks on a full external crawl). */
  async reindexSource(id: string): Promise<void> {
    this.sources = await this.loadSources();
    const src = this.sources.find((s) => s.id === id);
    const others = this.skills.filter((s) => s.sourceId !== id);
    if (!src) {
      this.skills = others;
      return;
    }
    try {
      const found = src.kind === "internal" ? await this.indexInternal(src) : await this.indexRemote(src);
      this.skills = [...others, ...found];
    } catch (e) {
      log.warn(`reindex source "${id}" failed: ${e}`);
    }
  }

  reindexInternal(): Promise<void> {
    return this.reindexSource("internal");
  }

  private async loadSources(): Promise<SkillSource[]> {
    const raw = await this.store.read(SOURCES_FILE);
    // Always expose the internal source, even if the file is missing.
    const internal: SkillSource = { id: "internal", kind: "internal" };
    if (!raw) return [internal];
    const doc = parseYaml(raw) as { sources?: SkillSource[] } | null;
    const listed = Array.isArray(doc?.sources) ? doc!.sources : [];
    const hasInternal = listed.some((s) => s.kind === "internal");
    return hasInternal ? listed : [internal, ...listed];
  }

  // ── internal: read the local clone ───────────────────────────────────────────
  private async indexInternal(src: SkillSource): Promise<IndexedSkill[]> {
    const paths = await this.store.list(DIRS.skills); // skills/<slug>/SKILL.md
    const out: IndexedSkill[] = [];
    for (const p of paths) {
      if (!p.endsWith("/SKILL.md")) continue;
      const raw = await this.store.read(p);
      if (!raw) continue;
      out.push(this.toSkill(src, p, raw));
    }
    return out;
  }

  // ── remote: GitHub trees API + raw fetch (no clone, no copy) ─────────────────
  private async indexRemote(src: SkillSource): Promise<IndexedSkill[]> {
    if (!src.repo) return [];
    const branch = src.branch ?? "main";
    const tree = await this.ghTree(src.repo, branch);
    const prefix = src.path ? src.path.replace(/\/$/, "") + "/" : "";
    const skillFiles = tree.filter(
      (t) => t.type === "blob" && t.path.endsWith("/SKILL.md") && t.path.startsWith(prefix),
    );

    const out: IndexedSkill[] = [];
    for (const f of skillFiles.slice(0, 300)) {
      const raw = await this.ghRaw(src.repo, branch, f.path);
      if (raw) out.push(this.toSkill(src, f.path, raw));
    }
    if (skillFiles.length > 300) {
      log.warn(`source "${src.id}" has ${skillFiles.length} skills; indexed first 300`);
    }
    return out;
  }

  private toSkill(src: SkillSource, path: string, raw: string): IndexedSkill {
    const fm = matter(raw).data as Record<string, unknown>;
    const folder = path.replace(/\/SKILL\.md$/, "");
    return {
      name: String(fm.name ?? slugOf(folder)),
      description: String(fm.description ?? "").trim(),
      sourceId: src.id,
      kind: src.kind,
      repo: src.repo,
      skillPath: folder,
    };
  }

  private ghHeaders(): Record<string, string> {
    const h: Record<string, string> = { "User-Agent": "ybrain", Accept: "application/vnd.github+json" };
    if (this.config.githubToken) h.Authorization = `Bearer ${this.config.githubToken}`;
    return h;
  }

  private async ghTree(repo: string, branch: string): Promise<Array<{ path: string; type: string }>> {
    const url = `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`;
    const res = await fetch(url, { headers: this.ghHeaders(), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`GitHub tree ${repo}@${branch}: ${res.status}`);
    const body = (await res.json()) as { tree?: Array<{ path: string; type: string }>; truncated?: boolean };
    if (body.truncated) {
      log.warn(`GitHub tree for ${repo} is truncated; some skills may be missing from the index`);
    }
    return body.tree ?? [];
  }

  private async ghRaw(repo: string, branch: string, path: string): Promise<string | null> {
    // Authenticate content fetches too, so private external sources index.
    const headers: Record<string, string> = { "User-Agent": "ybrain" };
    if (this.config.githubToken) headers.Authorization = `Bearer ${this.config.githubToken}`;
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${path}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok ? res.text() : null;
  }
}

/** The exact client-side command(s) to install a skill from its source. */
export function installHint(skill: IndexedSkill, source: SkillSource, dataRepoUrl: string): string {
  const dir = skill.skillPath;
  switch (skill.kind) {
    case "skills-cli":
      return [
        `# ${skill.repo} uses the Agent Skills CLI:`,
        `npx skills@latest add ${skill.repo}`,
        `# then select "${skill.name}" from the list.`,
      ].join("\n");
    case "marketplace": {
      const mp = source.marketplace ?? skill.repo?.split("/")[1] ?? "marketplace";
      return [
        `/plugin marketplace add ${skill.repo}`,
        `/plugin install ${skill.name}@${mp}`,
        `# (run /plugin to browse if the plugin name differs)`,
      ].join("\n");
    }
    case "internal":
      return [
        `# from the company skills repo:`,
        `git clone ${dataRepoUrl || "<ybrain-data-repo>"} /tmp/ybrain-data`,
        `cp -r /tmp/ybrain-data/${dir} ~/.claude/skills/${skill.name}`,
        `# (or symlink it; Phase 2 will offer one-command marketplace install)`,
      ].join("\n");
    case "folder":
    default:
      return [
        `git clone https://github.com/${skill.repo} /tmp/${skill.name}-src`,
        `cp -r /tmp/${skill.name}-src/${dir} ~/.claude/skills/${skill.name}`,
        `# use .claude/skills/ instead of ~/.claude/skills/ for project-only`,
      ].join("\n");
  }
}
