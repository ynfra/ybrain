# drafts/

Open suggestions land here (via the `suggest_*` MCP tools) as:

```
drafts/prompts/<slug>.md
drafts/owners/<slug>.md
drafts/docs/<slug>.md
drafts/skills/<slug>/SKILL.md
```

A supervisor promotes a draft to live with `publish_draft` (which `git mv`s it
up to `prompts/`, `owners/`, `docs/`, or `skills/`), discards it with
`reject_draft`, or simply edits/moves it in Git directly. Nothing here is live
until published.
