import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";

export interface AuthContext {
  /** Whether the supervisor tier (publish/reject/register-source) is exposed. */
  canPublish: boolean;
  /** Commit author for privileged actions — the matched token's name. */
  author: string;
}

function header(req: IncomingMessage, name: string): string {
  const v = req.headers[name.toLowerCase()];
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
}

/** Constant-time string compare that tolerates unequal lengths. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Compare against self to keep timing independent of the length mismatch.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Reads are open and suggestions are open, so a request with no token is a
 * valid anonymous caller. An `Authorization: Bearer <token>` matching a
 * configured supervisor token unlocks the privileged tier and names the author.
 * There is no per-user identity and no spoofable username header.
 */
export function authFrom(req: IncomingMessage): AuthContext {
  const bearer = header(req, "authorization").replace(/^Bearer\s+/i, "").trim();
  if (bearer) {
    for (const t of config.supervisorTokens) {
      if (safeEqual(bearer, t.token)) return { canPublish: true, author: t.name };
    }
  }
  return { canPublish: false, author: "anonymous" };
}
