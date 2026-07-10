// The storage abstraction every tool depends on. Tools NEVER touch git (or any
// backend) directly — they go through this interface. That keeps the door open
// to swap the local-clone GitDataStore for a GitHub-API or Cloudflare-KV
// implementation later without touching a single tool.

export interface WriteMeta {
  /** Commit author name (supervisor token name, or a generic suggester label). */
  author: string;
  /** Human-readable commit subject. */
  message: string;
}

export interface DataStore {
  /** Prepare the backend (clone/pull, etc.). Call once at startup. */
  init(): Promise<void>;

  /** List repo-relative file paths under `dir` matching `.md` (recursive). */
  list(dir: string): Promise<string[]>;

  /** Read a UTF-8 file by repo-relative path, or null if absent. */
  read(path: string): Promise<string | null>;

  /** True if a repo-relative path exists. */
  exists(path: string): Promise<boolean>;

  /** Full-text substring search across `.md` files under `dir`. */
  search(dir: string, query: string): Promise<Array<{ path: string; snippet: string }>>;

  /** Create/overwrite a file and commit+push it (serialized). */
  write(path: string, content: string, meta: WriteMeta): Promise<void>;

  /** Delete a file and commit+push (serialized). No-op if absent. */
  remove(path: string, meta: WriteMeta): Promise<void>;

  /** Move a file (e.g. publish a draft) in one commit. Fails if `from` absent. */
  move(from: string, to: string, meta: WriteMeta): Promise<void>;

  /** Sync the local clone to the remote (background refresh + webhook). */
  refresh(): Promise<void>;
}
