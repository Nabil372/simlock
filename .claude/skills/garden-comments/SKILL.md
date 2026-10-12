---
name: garden-comments
description: Weekly routine — apply the comment rule (architecture rule 17) to every comment in the code files main changed since the last run, delete what the rule does not allow, and land one comments-only PR through the reviews and the merge gate. Use when a Claude Code routine or the user says "garden comments".
model: sonnet
effort: low
---

# Garden comments

Rules: `docs/internal/agent-rules/architecture.md` rule 17, and
`delivery.md` rules 14 and 15. You are the author of this PR: there is no
issue and no implementer.

## 1. Workspace and list

```bash
[ "$(git rev-parse --is-shallow-repository)" = true ] && git fetch -q --unshallow
git fetch -q origin
dir=$(.agents/scripts/worktree.sh chore/garden-comments-$(date +%F)) && cd "$dir"
base=$(git log -1 --format=%H --grep='^chore(comments):' origin/main)
[ -n "$base" ] || base=$(git rev-list -1 --before='7 days ago' origin/main)
node .agents/scripts/comments.mjs --all "$base" HEAD > <scratch>/comments.txt
```

An empty list: report `PR: none` and stop.

## 2. Judge

Split the list into chunks of about 150 blocks, never one file across two
chunks. Start one `comment-reviewer` per chunk, in one message, each an
Agent call with `run_in_background: false`, `rules: docs/internal/agent-rules`,
`comments: <chunk file>` and `worktree: <dir>`.

## 3. Delete

Delete each part a reviewer flags. Never reword it into a new comment, and
change no code: a block whose deletion would leave an empty comment goes
whole. Then:

```bash
pnpm test:changed
git add -A && git commit -m "chore(comments): delete comments that say what, not why, since <short base>"
git push -u origin HEAD
gh pr create --draft --title "chore(comments): delete comments that say what, not why, since <short base>" --body-file <scratch>/pr.md
```

The body: `<base>..<head>`, how many blocks were judged and how many
deleted, and `*Written by an agent.*`.

## 4. Review and merge

`reviewer` with the PR number, round 1: its kind must be `comments-only`.
Any other kind means a code line changed: undo it and push again. Fix each
Fix line yourself, comments only, then the next round as rule 14 says.
`Rerun: none` with findings open: leave the PR in draft and report them.

Add the `## Review` section exactly as the deliver skill's step 4 shapes it,
with `Spec review: skipped. Code review: skipped.`. Then `gh pr ready <M>`
and `.agents/scripts/merge-pr.sh <M>`. Anything but a merge: leave the PR
open and report.

## Report

```
Routine: garden-comments  Base: <short sha>  Judged: <n>  Deleted: <d>
PR: #M merged | #M open (<why>) | none
```
