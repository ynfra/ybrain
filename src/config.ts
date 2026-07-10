// Central configuration, resolved once from the environment at startup.

function env(key: string, fallback = ""): string {
  return process.env[key]?.trim() || fallback;
}

function num(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Build the authenticated clone URL. If a token is provided and the URL is an
 * HTTPS github.com remote, inject it as `x-access-token`. SSH URLs and
 * already-tokenised URLs are passed through untouched.
 */
function authedRepoUrl(url: string, token: string): string {
  if (!token || !url.startsWith("https://")) return url;
  if (url.includes("@")) return url; // already carries credentials
  return url.replace("https://", `https://x-access-token:${token}@`);
}

export interface SupervisorToken {
  name: string;
  token: string;
}

/**
 * Parse `name=token,name2=token2` into named supervisor tokens. Each token
 * grants the privileged tier (publish/reject/register-source) and its `name`
 * authors the resulting commit — so authorship is real-ish and one token can be
 * revoked without rotating the rest. Reads and suggestions need no token.
 */
function parseSupervisorTokens(raw: string): SupervisorToken[] {
  return raw
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return { name: "supervisor", token: pair }; // bare token → generic name
      return { name: pair.slice(0, eq).trim() || "supervisor", token: pair.slice(eq + 1).trim() };
    })
    .filter((t) => t.token.length > 0);
}

const dataRepoUrl = env("YBRAIN_DATA_REPO_URL");
const gitToken = env("YBRAIN_GIT_TOKEN");

export const config = {
  port: num("YBRAIN_PORT", 8080),

  dataRepoUrl,
  authedRepoUrl: authedRepoUrl(dataRepoUrl, gitToken),
  // Raw token, reused for GitHub API calls when indexing external skill repos.
  githubToken: gitToken,
  dataBranch: env("YBRAIN_DATA_BRANCH", "main"),
  dataDir: env("YBRAIN_DATA_DIR", "/data/repo"),
  gitAuthorEmail: env("YBRAIN_GIT_AUTHOR_EMAIL", "ybrain@example.com"),
  pullIntervalSec: num("YBRAIN_PULL_INTERVAL", 180),

  // Named tokens for the supervisor tier. Empty ⇒ nobody can publish via MCP
  // (supervisors then manage drafts directly in Git).
  supervisorTokens: parseSupervisorTokens(env("YBRAIN_SUPERVISOR_TOKENS")),

  // Abuse limits — suggestions are open, so cap body size and request rate.
  maxBodyBytes: num("YBRAIN_MAX_BODY_BYTES", 1_000_000), // 1 MB
  rateLimitPerMin: num("YBRAIN_RATE_LIMIT_PER_MIN", 120),

  // Optional secret for the GitHub push webhook (POST /webhook) → HMAC-verified.
  webhookSecret: env("YBRAIN_WEBHOOK_SECRET"),

  // Timeout for individual git operations (ms); guards against a hung network
  // op wedging the write queue.
  gitTimeoutMs: num("YBRAIN_GIT_TIMEOUT_MS", 20_000),
} as const;

export type Config = typeof config;
