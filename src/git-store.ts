import { mkdir, readFile, writeFile, unlink, readdir, access } from "node:fs/promises";
import { join, dirname, relative, sep } from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import type { Config } from "./config.ts";
import type { DataStore, WriteMeta } from "./store.ts";
import { log } from "./log.ts";

/**
 * Local-clone Git backend. Reads hit the filesystem (fast, searchable, offline
 * once cloned). Writes go through a single in-process queue; each write commits
 * first, then rebases onto the remote and pushes, with clean recovery on
 * conflict/rejection so a failed write is a true no-op and never wedges the
 * clone. This relies on there being exactly ONE server instance.
 *
 * Invariant: between queued operations the clone always equals `origin/<branch>`
 * (a write either pushes successfully or resets back). That makes refresh() and
 * boot bulletproof — they just fetch + hard-reset to the remote.
 */
export class GitDataStore implements DataStore {
  private git!: SimpleGit;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: Config) {}

  private get remote(): boolean {
    return Boolean(this.config.authedRepoUrl);
  }
  private get branch(): string {
    return this.config.dataBranch;
  }

  async init(): Promise<void> {
    const { dataDir, authedRepoUrl, dataBranch, gitTimeoutMs } = this.config;
    await mkdir(dataDir, { recursive: true });
    const gitOpts = { timeout: { block: gitTimeoutMs } };

    const cloned = await this.pathExists(join(dataDir, ".git"));
    if (cloned) {
      this.git = simpleGit(dataDir, gitOpts);
      await this.configureIdentity();
      log.info(`data repo present at ${dataDir}, syncing to remote`);
      await this.refresh();
    } else if (authedRepoUrl) {
      log.info(`cloning data repo into ${dataDir}`);
      try {
        await simpleGit(gitOpts).clone(authedRepoUrl, dataDir, ["--branch", dataBranch]);
      } catch (e) {
        // Never let the token in the remote URL leak into logs/stack traces.
        throw new Error(`clone failed: ${this.scrub(String(e))}`);
      }
      this.git = simpleGit(dataDir, gitOpts);
      await this.configureIdentity();
    } else {
      log.warn("no YBRAIN_DATA_REPO_URL set; initialising an empty local repo");
      this.git = simpleGit(dataDir, gitOpts);
      await this.git.init();
      await this.configureIdentity();
    }

    if (this.config.pullIntervalSec > 0 && this.remote) {
      setInterval(() => {
        this.refresh().catch((e) => log.warn(`background refresh failed: ${this.scrub(String(e))}`));
      }, this.config.pullIntervalSec * 1000).unref?.();
    }
  }

  private async configureIdentity(): Promise<void> {
    // Author is set per-commit; committer identity is a stable service account.
    await this.git.addConfig("user.name", "ybrain");
    await this.git.addConfig("user.email", this.config.gitAuthorEmail);
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  async list(dir: string): Promise<string[]> {
    const abs = join(this.config.dataDir, dir);
    const out: string[] = [];
    await this.walk(abs, out);
    return out
      .filter((p) => p.endsWith(".md"))
      .map((p) => relative(this.config.dataDir, p).split(sep).join("/"))
      .sort();
  }

  async read(path: string): Promise<string | null> {
    try {
      return await readFile(join(this.config.dataDir, path), "utf8");
    } catch {
      return null;
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.pathExists(join(this.config.dataDir, path));
  }

  async search(dir: string, query: string): Promise<Array<{ path: string; snippet: string }>> {
    const q = query.toLowerCase();
    const files = await this.list(dir);
    const hits: Array<{ path: string; snippet: string }> = [];
    for (const path of files) {
      const content = await this.read(path);
      if (!content) continue;
      const idx = content.toLowerCase().indexOf(q);
      if (idx >= 0) {
        const start = Math.max(0, idx - 60);
        const snippet = content.slice(start, idx + query.length + 60).replace(/\s+/g, " ").trim();
        hits.push({ path, snippet: (start > 0 ? "…" : "") + snippet + "…" });
      }
    }
    return hits;
  }

  // ── writes (serialized) ──────────────────────────────────────────────────────

  write(path: string, content: string, meta: WriteMeta): Promise<void> {
    return this.enqueue(async () => {
      const abs = join(this.config.dataDir, path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
      await this.commitPush([path], meta);
    });
  }

  remove(path: string, meta: WriteMeta): Promise<void> {
    return this.enqueue(async () => {
      const abs = join(this.config.dataDir, path);
      if (!(await this.pathExists(abs))) return;
      await unlink(abs);
      await this.commitPush([path], meta);
    });
  }

  move(from: string, to: string, meta: WriteMeta): Promise<void> {
    return this.enqueue(async () => {
      const src = join(this.config.dataDir, from);
      const content = await readFile(src, "utf8").catch(() => null);
      if (content === null) throw new Error(`nothing to move at "${from}"`);
      const dst = join(this.config.dataDir, to);
      await mkdir(dirname(dst), { recursive: true });
      await writeFile(dst, content, "utf8");
      await unlink(src);
      await this.commitPush([from, to], meta);
    });
  }

  /** Fetch + hard-reset to the remote. Safe because the clone has no local-only
   *  state between queued ops. Never throws fatally — the server stays up. */
  refresh(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.remote) return;
      try {
        await this.git.fetch("origin", this.branch);
        await this.git.reset(["--hard", `origin/${this.branch}`]);
      } catch (e) {
        log.warn(`refresh failed (clone left as-is): ${this.scrub(String(e))}`);
      }
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Chain all mutating/pulling ops so they never interleave (no push races). */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    // keep the chain alive even if a task rejects
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Stage the given paths, commit, then rebase-onto-remote and push. On any
   *  failure, discard the local commit (reset to remote) and rethrow, so the
   *  reported failure is a real no-op and the clone stays clean. */
  private async commitPush(paths: string[], meta: WriteMeta): Promise<void> {
    for (const p of paths) await this.git.add(p); // `add` stages deletions too
    const subject = `${meta.message}\n\nvia ybrain (${meta.author})`;
    await this.git.commit(subject, undefined, {
      "--author": `${meta.author} via ybrain <${this.config.gitAuthorEmail}>`,
    });
    if (!this.remote) return;

    try {
      await this.git.fetch("origin", this.branch);
      await this.git.rebase([`origin/${this.branch}`]);
      await this.git.push("origin", this.branch);
    } catch (e) {
      // Retry once for a benign non-fast-forward (remote advanced mid-push).
      const recovered = await this.retryPush().catch(() => false);
      if (!recovered) {
        await this.resetToRemote();
        throw new Error(`write failed, change discarded: ${this.scrub(String(e))}`);
      }
    }
  }

  private async retryPush(): Promise<boolean> {
    await this.git.raw(["rebase", "--abort"]).catch(() => {});
    await this.git.fetch("origin", this.branch);
    await this.git.rebase([`origin/${this.branch}`]);
    await this.git.push("origin", this.branch);
    return true;
  }

  private async resetToRemote(): Promise<void> {
    await this.git.raw(["rebase", "--abort"]).catch(() => {});
    await this.git.reset(["--hard", `origin/${this.branch}`]).catch((e) =>
      log.error(`resetToRemote failed: ${this.scrub(String(e))}`),
    );
  }

  /** Strip an embedded `x-access-token:<token>@` credential from any string. */
  private scrub(s: string): string {
    return s.replace(/x-access-token:[^@]*@/g, "x-access-token:***@");
  }

  private async walk(dir: string, out: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // dir doesn't exist yet
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await this.walk(full, out);
      else out.push(full);
    }
  }

  private async pathExists(p: string): Promise<boolean> {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  }
}
