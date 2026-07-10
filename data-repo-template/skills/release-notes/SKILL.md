---
name: release-notes
description: Turn a list of merged PRs into user-facing release notes grouped by theme.
---

Given a list of merged pull requests (titles + descriptions), produce release
notes for end users:

1. Group changes into **Features**, **Improvements**, and **Fixes**.
2. Rewrite each line in user-facing language (no internal jargon or PR numbers
   in the headline; link them at the end).
3. Lead with the highest-impact change.
4. Keep it scannable — one line per change.
