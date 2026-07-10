# ybrain-data (template)

This is the **data repo** ybrain reads and writes — fork it into your own
(private) repo, point `YBRAIN_DATA_REPO_URL` at it, and give the ybrain service
account push access.

Everything is plain Markdown with YAML frontmatter, so it stays diff-able,
reviewable, and editable directly on GitHub as well as through the MCP server.

```
prompts/<slug>.md        # title, tags, variables, usage + body   (live)
owners/<area>.md         # area, owner, backup, contact, systems   (live)
docs/<system>.md         # system, category, links[] + description (live)
skills/<slug>/SKILL.md   # name, description + instructions         (live)
skill-sources.yaml       # external skill repos ybrain indexes
drafts/…                 # open suggestions awaiting supervisor review
```

**Live vs draft.** Anyone can read the live dirs and `suggest_*` new entries,
which land under `drafts/`. A supervisor promotes a draft to its live dir with
`publish_draft` (a `git mv`), rejects it, or just merges/edits it in Git —
Git's own review/merge rights are the real access control.
