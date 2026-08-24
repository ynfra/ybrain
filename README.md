# ynfra / ybrain

Company knowledge MCP server (Bun + TypeScript): one HTTP endpoint an ordinary
user adds to their MCP client to ask *"what prompts do we have?"*, *"who owns
billing?"*, *"where are the Grafana docs?"*, and *"what skills exist and how do
I install them?"*. Anyone can read and **suggest**; suggestions land as drafts
that a supervisor publishes, and every change is a real Git commit in a single
data repo.

```
MCP client ──HTTP──▶ ybrain (this server) ──git clone/pull/push──▶ github.com/<acct>/ybrain-data
   read + suggest = open                    (drafts/ → supervisor publishes → live)
```

## Prerequisites

- [Bun](https://bun.sh) (or Docker with Compose v2).
- A Git data repo — fork [`data-repo-template/`](data-repo-template/) — and a
  token with push access to it.

## Usage

```bash
cp .env.example .env    # set YBRAIN_DATA_REPO_URL, YBRAIN_GIT_TOKEN; optional YBRAIN_SUPERVISOR_TOKENS
bun install
bun run dev             # or: docker compose up --build
curl localhost:8080/healthz
```

Then add the Streamable HTTP endpoint (`POST /mcp`) to an MCP client — read +
suggest need no token:

```json
{ "mcpServers": { "ybrain": { "url": "https://ybrain.example.com/mcp" } } }
```

A supervisor adds a named Bearer token to unlock publish/reject/register-source:

```json
{ "mcpServers": { "ybrain": {
  "url": "https://ybrain.example.com/mcp",
  "headers": { "Authorization": "Bearer YOUR_SUPERVISOR_TOKEN" } } } }
```

## Tools

| Tool | Access | Description |
|---|---|---|
| `list_prompts`, `get_prompt`, `search_prompts` | open | Company prompts |
| `who_owns`, `list_owners` | open | Who owns what |
| `list_docs`, `get_doc`, `search_docs` | open | Docs / links to systems |
| `list_skill_sources`, `list_skills`, `search_skills`, `get_skill` | open | Skills index — internal + external, with per-source install commands |
| `list_drafts`, `get_draft` | open | Pending suggestions |
| `suggest_prompt`, `suggest_owner`, `suggest_doc`, `suggest_skill` | open | Propose content — committed under `drafts/`, never live |
| `publish_draft`, `reject_draft` | supervisor token | Promote / discard a draft |
| `add_skill_source` | supervisor token | Register an external skill repo to index |

## Notes

- Content lives in a **separate** data repo (`YBRAIN_DATA_REPO_URL`): `prompts/`, `owners/`, `docs/`, `skills/`, `skill-sources.yaml`, `drafts/` — never in this code repo.
- A suggestion never goes live: the real access control is Git merge/publish rights — a supervisor promotes with `publish_draft` (or edits/merges directly on GitHub); ybrain implements no roles of its own.
- Supervisor tokens are named (`YBRAIN_SUPERVISOR_TOKENS=alice=…,bob=…`) so one can be revoked without rotating the rest; `suggested_by` is client-supplied, **unverified** metadata.
- Because reads and suggestions are open, the server caps request body size and rate-limits per IP.
- Skills are indexed, **not vendored**: ybrain reads each source's `SKILL.md` frontmatter via the GitHub API and prints the client-side install command per source `kind` (`skills-cli`, `marketplace`, `folder`, `internal`); external descriptions are labelled untrusted.
- Reads hit a local clone, not the GitHub API; a background fetch every `YBRAIN_PULL_INTERVAL` seconds — or an HMAC-verified `POST /webhook` — picks up edits made on GitHub.
- Run exactly **one** server instance: writes go through a single in-process queue, and two clones pushing will race.

See [AGENTS.md](AGENTS.md) for conventions, internals, and day-2 operations.
