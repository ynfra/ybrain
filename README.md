# ybrain

**Company knowledge MCP server.** One HTTP endpoint an ordinary user adds to
their MCP client to ask *"what prompts do we have?"*, *"who owns billing?"*,
*"where are the Grafana docs?"*, and *"what skills exist and how do I install
them?"*. Anyone can also **suggest** a new prompt/owner/doc/skill — it's saved
as a **draft** that a supervisor reviews and publishes. Every change is a real
Git commit in a single data repo.

```
MCP client ──HTTP──▶ ybrain (this server) ──git clone/pull/push──▶ github.com/<acct>/ybrain-data
   read + suggest = open                    (drafts/ → supervisor publishes → live)
```

## What it does

| Ask (open, no token) | Read tools |
|---|---|
| List / detail company **prompts** | `list_prompts`, `get_prompt`, `search_prompts` |
| **Who owns what** | `who_owns`, `list_owners` |
| **Docs / links** to systems | `list_docs`, `get_doc`, `search_docs` |
| **Skills** — internal + external, with install commands | `list_skill_sources`, `list_skills`, `search_skills`, `get_skill` |
| See **pending suggestions** | `list_drafts`, `get_draft` |

| Contribute (open, → drafts/) | Suggest tools |
|---|---|
| Propose a prompt / owner / doc / skill | `suggest_prompt`, `suggest_owner`, `suggest_doc`, `suggest_skill` |

| Supervisor (named token) | Privileged tools |
|---|---|
| Promote / discard a draft | `publish_draft`, `reject_draft` |
| Register an external **skill source** | `add_skill_source` |

## Access model: read-only + suggest → draft → supervisor merges

- **Reads and `suggest_*` are open** — no token. A suggestion never goes live;
  it's committed under `drafts/` for review.
- **The real access control is Git itself.** A supervisor promotes a draft with
  `publish_draft` (a `git mv` from `drafts/x` to live), rejects it, or just
  merges/edits it directly in GitHub. "Write rights only for some" = whoever can
  merge/publish — ybrain implements no roles of its own.
- **Supervisor tokens are named** (`YBRAIN_SUPERVISOR_TOKENS=alice=…,bob=…`):
  the name authors published commits, and one token can be revoked without
  rotating the rest. Suggestion commits use a fixed `suggestion` author (the
  `suggested_by` field is client-supplied and **unverified** — metadata only).
- Because suggestions are open, the server **caps request body size** and
  **rate-limits per IP**.

> This dissolves the shared-write-token blast radius: a leaked credential (or an
> anonymous caller) can only *propose a draft* — never overwrite live content or
> forge merged history.

## Data repo layout

ybrain reads and writes **one** Git repo (`YBRAIN_DATA_REPO_URL`):

```
prompts/<slug>.md        # title, tags, variables, usage (frontmatter) + body
owners/<area>.md         # area, owner, backup, contact, systems
docs/<system>.md         # system, category, links[] + description
skills/<slug>/SKILL.md   # name, description + instructions
skill-sources.yaml       # external skill repos to index
drafts/…                 # open suggestions awaiting publish (mirrors the above)
```

See [`data-repo-template/`](data-repo-template/) for a ready-to-fork seed.

## Skills: index, don't copy

ybrain gives one searchable view over **your internal skills** and **external
skill repos** (e.g. [`mattpocock/skills`](https://github.com/mattpocock/skills),
Claude Code plugin marketplaces). It **does not vendor** anyone's skills — it
reads each repo's `SKILL.md` frontmatter (name + description) via the GitHub
API and, for each skill, returns **the exact client-side install command for
that source**. (An MCP server can't install into your `~/.claude/skills/` — so
ybrain discovers and advises; the client installs.)

Sources live in `skill-sources.yaml` in the data repo:

```yaml
sources:
  - id: internal
    kind: internal            # this data repo's skills/ dir
  - id: mattpocock
    repo: mattpocock/skills
    kind: skills-cli          # → npx skills@latest add mattpocock/skills
    path: skills
  - id: anthropic
    repo: anthropics/skills
    kind: marketplace         # → /plugin marketplace add … ; /plugin install …@…
```

`kind` drives the install advice `get_skill` prints: `skills-cli`,
`marketplace`, `folder` (git clone + copy into `.claude/skills/`), or
`internal`. Register more with `add_skill_source` (supervisor only — a source is
served to every user, so it's an injection surface). External descriptions are
labelled untrusted in `get_skill` output.

> **Phase 2 (planned):** ship a `.claude-plugin/marketplace.json` in the data
> repo so internal skills get one-command native `/plugin install` + auto-update,
> alongside this MCP discovery layer.

## How the Git backend works

- **Local clone, not the GitHub API.** Reads hit the filesystem — instant,
  searchable, and they keep working if GitHub is briefly down. (The API would
  burn rate limits on every "list everything".) The only GitHub-API use is the
  read-only indexing of *external* skill repos.
- **Single in-process write queue.** Each write commits first, then rebases onto
  the remote and pushes; on conflict/rejection it hard-resets to the remote so a
  failed write is a true no-op. Git ops have timeouts so a hung network op can't
  wedge the queue. Assumes exactly **one** server instance.
- **Freshness:** a background `git fetch + reset --hard origin` every
  `YBRAIN_PULL_INTERVAL` seconds picks up edits/merges made on GitHub. An
  optional `POST /webhook` (HMAC-verified) refreshes immediately on push.
- **Swappable:** tools talk to a `DataStore` interface
  ([`src/store.ts`](src/store.ts)), so a future GitHub-API or Cloudflare-KV
  backend is one file — no tool changes. **Do not** horizontally scale the
  local-clone backend (two clones pushing = races the queue can't fix).

## Run

```bash
cp .env.example .env      # set YBRAIN_DATA_REPO_URL, YBRAIN_GIT_TOKEN; optional YBRAIN_SUPERVISOR_TOKENS
bun install
bun run dev               # or: docker compose up --build
curl localhost:8080/healthz
```

## Add it to an MCP client

Streamable HTTP endpoint at `POST /mcp`. Read + suggest (no token):

```json
{ "mcpServers": { "ybrain": { "url": "https://ybrain.example.com/mcp" } } }
```

Supervisor (add a named token to unlock publish/reject/register-source):

```json
{
  "mcpServers": {
    "ybrain": {
      "url": "https://ybrain.example.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_SUPERVISOR_TOKEN" }
    }
  }
}
```

## Layout

```
src/
  server.ts     # HTTP + Streamable HTTP transport; /mcp /healthz /webhook; rate limit + body cap
  auth.ts       # Bearer token → { canPublish, author }; constant-time compare
  config.ts     # env resolution (named supervisor tokens, limits)
  store.ts      # DataStore interface (backend-agnostic): read/write/remove/move/refresh
  git-store.ts  # local-clone Git backend: commit-then-rebase queue, resilient refresh
  content.ts    # frontmatter parse/format + renderers; live/draft path helpers
  skills.ts     # skill source registry + unified index + install-hint generator
  tools.ts      # read + suggest (open) tools, supervisor tools (token-gated)
  log.ts
```

Built with Bun + TypeScript + [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk),
matching the `yreview` toolchain.
