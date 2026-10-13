# Agentic setup: proposed changes

Written 2026-10-12 from the delivery stats, the merged PRs of the last two
weeks, two session transcripts, and the nine articles the maintainer
listed. Draft for discussion; nothing here is decided.

## What the data says

| Signal (last 2 weeks)                      | Value                                   |
| ------------------------------------------ | --------------------------------------- |
| PRs merged                                 | 141                                     |
| Blocking findings confirmed / raised       | spec 63%, code 65%, comments 86%        |
| Rejected findings this week                | 125                                     |
| Notes posted (never verified)              | 409                                     |
| Handoffs posted                            | 39                                      |
| Comment-review findings on one PR (#449)   | 155, all "fixed"                        |
| Comment-review findings on #456            | 56 raised, 20 rejected                  |
| Largest delivery session                   | 252M weighted tokens, 127 agents        |
| Opus share of that session                 | 224M of 252M                            |
| Longest single sub-agents                  | 586, 569, 591 turns                     |
| Process prose (rules + skills + agents)    | ~22k words; reviewer.md alone 2.9k      |

Rounds follow size. PRs under 800 lines merged in 0 or 1 rounds. The four
PRs over 3.5k lines (#383, #444, #449, #456) took 4 or 5 rounds each, and
two of them merged only after the maintainer accepted open findings.

Bugs found after merge (#424 token race, #402 waiter timeout, #434, #389)
are interleavings and timing. Review findings are mostly comments, doc
lines and test titles. The review is looking where the bugs are not.

## Changes, in priority order

### 1. Make the comment rule a lint and delete the comment review

Architecture rule 17 ("a comment says why, or it goes") is judged by a
Haiku agent, verified by an Opus agent, fixed by a Sonnet agent, then
judged again next round. On #449 that was 155 findings. On #456, 20 of 56
were rejected as "gives a why": the rule is too subjective for a model to
apply consistently.

Make it mechanical (OpenAI: "when documentation falls short, promote the
rule into code"): a comment is allowed only when it starts with a fixed
marker (`// why:`, a URL, `@ts-expect-error` and the other directives), is
a doc comment on a `src/client` or `src/admin` export, or is a script's
usage header. A pre-commit script rejects every other comment. Delete the
comment review, the comment sweep in the implementer's audit, and the
`comments.mjs` plumbing.

### 2. Cap rounds at two, and only behaviour findings open round two

Today round 2 runs after any confirmed spec or code finding, and rounds
3 to 5 run while the count falls. Change to: round 2 runs only when a
confirmed finding is a behaviour or wrong-state defect. Test-title,
claims and spec-wording findings get one fix run and the claims-only
check. After round 2, anything still open goes to the maintainer as a
Rejected or open line; no round 3 without a person.

Evidence: #353 rounds 3 and 4 needed the maintainer's authorisation and
confirmed nothing new; #456 round 4 found two findings the maintainer
accepted anyway.

### 3. Give the code reviewers the spec

The code review is blind to the issue. That produces rejected findings on
intent: "the spec decides this interim on purpose", "spec line 179 asks
for it as a guard", "predates this change", "the maintainer decided it on
#368". Each costs an Opus verification and a Rejected line.

Keep the reviewer blind to the implementer's narration (PR body, commit
messages), not to the spec and the ADRs. Anthropic's own guidance for an
adversarial reviewer is "the diff and the criteria". Also hand it
`git blame`-style context: a defect on a line the diff did not touch is a
note by definition, so the reviewer never has to argue it.

### 4. Stop posting unverified notes

409 notes in a week, each one reviewer's unverified claim, become a PR
comment and then `bug:new` issues (#451, #450, #430, #258 are comment and
doc nits). Reviewers report at most five notes, only ones that claim a
behaviour or state defect; the rest are not written. Notes never become
issues automatically.

### 5. Cap task size in the spec session

A task is at most roughly 1,500 changed lines and 30 files. Split mode
must cut anything bigger, stacking dependent PRs with `gh stack`.
Addy Osmani: reject large PRs at intake; agent PRs run 51% larger than
human ones. The four biggest PRs here cost 4 to 5 rounds each.

### 6. Calibrate reviewers with rejected findings

Precision is 63 to 65% on spec and code reviews. Anthropic's harness post:
few-shot examples with score breakdowns calibrated the evaluator and cut
drift. `delivery-stats.mjs` already lists rejected findings by class. Put
the five commonest rejected classes, with one example each, at the top of
each review brief, refreshed weekly by the stats script.

### 7. Shrink the prose and let scripts build the briefs

The reviewer agent (Opus) spends most of its 500+ turns on plumbing:
worktrees, running the script, pasting five briefs verbatim. Output
tokens cost five times input. Have `review-inputs.sh` write each brief to
a file (`$R/brief-spec.md`, ...) so the reviewer's prompt is a path.
Then the reviewer definition drops from 2.9k words to a few hundred, and
the orchestrator can run on Sonnet.

Same for `deliver` (2.1k words) and `delivery.md` (3.6k words): every rule
that a script now enforces (PR body shape, the counts line, the budgets,
`*Written by an agent.*`, label invariants) is deleted from the prose and
replaced by one line naming the check. OpenAI's target is an AGENTS.md of
about 100 lines that is a map, not a manual.

### 8. Turn and stall caps for every sub-agent

Three sub-agents in one session ran 570 to 590 turns. `budget-guard.mjs`
counts tokens and hours; add a turn cap per agent (implementer mode 150,
reviewer lens 80) and a stall rule: the same command three times with
the same output ends the agent with a handoff. Addy Osmani kills and
reassigns anything stuck 3 iterations.

### 9. Tier the review by blast radius

A PR that touches only `docs/`, `.agents/`, `.claude/` or tests gets the
claims check and nothing else. A PR under 300 lines outside `src/core`,
`src/leasing` and `src/gateway` gets one code reviewer. Only the rest
gets the full set. Both Addy Osmani posts say to spend review where the
blast radius is.

### 10. Spend the saved review effort on interleavings

The post-merge bugs are races. One behaviour reviewer with a bigger probe
budget, allowed to write and run a new test (not only break code), finds
more of those than two lenses plus claims plus comments. Better still is
product work: a deterministic interleaving runner over the fake clock in
`src/core/testing.ts`, so a spec can say "both at once" and a test can
prove it. Review rounds cannot substitute for that.

### 11. Measure the next ten PRs

Add hours-to-merge, rounds, and weighted tokens per PR (the transcript
parser in `budget-guard.mjs` already has the numbers) to
`delivery-stats.mjs`. Change one thing at a time and compare.

## What to keep

The report blocks, the fresh agent per stage, worktrees per agent, the
merge gate script, the issue-state workflow, Stryker on changed lines,
fallow, and the red-first commit. These are the parts the articles argue
for and the data does not argue against.

## The changes, as PRs

Each is one `chore(agents)` PR on a `chore/<name>` branch, like #459,
#452 and #447: merged on green CI with the claims check only. In this
order, so every later PR is measured against the baseline the first one
records.

### PR 1 `chore/delivery-measure` (point 11)

- `.agents/scripts/usage.mjs`: the transcript parser lifted out of
  `budget-guard.mjs` as a module (`usage(sessionDir) -> { weighted, turns,
  byModel }`); the guard imports it.
- `deliver` step 5: before the end-of-run comment, run
  `node .agents/scripts/usage.mjs self` and write `Tokens: <n>M` and
  `Rounds: <n>` into each PR's `### Status`.
- `delivery-stats.mjs`: per-PR rows (hours open, lines, files, rounds,
  tokens) and weekly medians of each; `--since <sha>` to compare before
  and after a change.

### PR 2 `chore/comment-lint` (point 1)

- `comments.mjs`: export its block extraction; keep the CLI.
- New `.agents/scripts/comment-lint.mjs [--base <ref>] [files...]`: every
  comment block the diff adds or edits must be one of: a block whose first
  line starts with `why:` after the comment marker; a block containing a
  URL; a tool directive (the existing `DIRECTIVE` regex); a `/** */` block
  directly above an `export` in `src/client/**` or `src/admin/**`; the
  first block of a file under `scripts/` or `.agents/scripts/`. Anything
  else fails with `path:line: a comment starts with "why:" or goes`.
- `lefthook.yml` pre-commit: `comments: run: node
  .agents/scripts/comment-lint.mjs {staged_files}`. `package.json`:
  `lint:comments` with `--base origin/main`, added to `check` so CI runs it.
  Old comments are not touched: the weekly `garden-comments` routine from
  #459 migrates them.
- Delete `.claude/agents/comment-reviewer.md`, the comment review in
  `reviewer.md` and delivery rule 14, the `Commented` step of the
  implementer's audit, `comments.txt` in `review-inputs.sh`, the
  `Comment review:` field in the counts line (`deliver` step 4,
  `delivery-stats.mjs`), and `always-in-scope.md` item 11.
- `architecture.md` rule 17 becomes three sentences: a comment starts with
  `why:` or is one of the listed exceptions; the commit hook rejects the
  rest; a test's claim goes in its title.

### PR 3 `chore/review-rounds` (points 2, 3, 4, and the review half of 10)

- `delivery.md` rule 14, rounds paragraph: round 2 runs only when round 1
  confirmed a finding of class *behaviour* or *wrong state*. Test, claims
  and spec-wording findings get one fix run and the claims-only check.
  There is no round 3: a finding still open after round 2 is listed under
  `## Review` as open and the issue parks. `after-pass` stays as it is.
- Same rule, notes: a review returns at most five notes, each a possible
  behaviour or state defect. Nothing else is written down. Notes go out in
  one PR comment and never become issues on their own.
- Same rule, code review inputs: the issue, its parent and `spec/` join
  the diff and the rules. Blind to the PR body and commit messages only.
  A defect on a line the diff does not touch is a note.
- `reviewer.md`: step 5 reduced to the two-round rule; both code briefs
  lose "have not seen the issue" and gain the spec files; the common tail
  gets "at most five N lines"; the behaviour lens gets six probes and may
  write and run one new test file in its worktree, restored afterwards.
- `deliver` step 3: drop "Out of scope lines: open one bug:new issue each";
  only a confirmed behaviour defect outside the diff opens an issue.
  Step 5 posts notes only when there are any.

### PR 4 `chore/review-tiers` (point 9)

- `review-inputs.sh` writes `$R/tier`: `docs` when every path is under
  `docs/`, `.agents/`, `.claude/`, `.github/` or is a test file; `small`
  when under 300 changed lines and no path under `src/core`, `src/leasing`,
  `src/gateway` or `src/daemon`; else `full`.
- `reviewer.md` step 1: `docs` runs the claims review; `small` runs the
  spec review, one code review (behaviour lens, with the tests question
  folded in) and the claims review; `full` runs everything.
- `delivery.md` rule 14: one sentence naming the three tiers.

### PR 5 `chore/review-briefs` (point 7, first half)

- New `.agents/briefs/`: `review-spec.md`, `review-code-behaviour.md`,
  `review-code-tests.md`, `review-claims.md`, `review-rereview.md`,
  `review-tail.md`, with `{{R}}`, `{{worktree}}`, `{{round}}` placeholders.
  `review-inputs.sh` renders them into `$R/brief-*.md`.
- `reviewer.md` shrinks to: run the script, make the worktrees, spawn each
  reviewer with `Read and follow <brief path>`, verify, report. Its
  frontmatter moves to `model: sonnet`; the four reviewers stay on Opus.
- `implementer.md` is split the same way: `.agents/briefs/implement-red.md`,
  `-green.md`, `-audit.md`, `-fix.md`, and a 300-word agent file that
  reads the one its mode names.
- Trim across skills: the session-title step repeated in `deliver`,
  `review`, `implement` and `spec-session` becomes one line in `deliver`;
  the "never poll, never sleep" paragraphs go; `delivery.md` rule 14 keeps
  the policy (which reviews, what is blocking, the two rounds, the tiers)
  and points at the briefs for procedure.

### PR 6 `chore/pr-body-check` (point 7, second half)

- New `.agents/scripts/pr-body-check.mjs <pr>`: `Closes #n` and no other,
  `### Status`, `## Assumptions`, `## Review` with the counts line in
  shape, no "spec needs", last line `*Written by an agent.*`, and 200
  words outside code blocks, checklists and the three sections.
- `merge-pr.sh` calls it in place of its own greps. `issue-state.yml`'s
  PR job runs it: a warning while the PR is a draft, a failed check once
  it is ready.
- `delivery.md` rule 12 and rule 15, and `deliver` step 4, lose the prose
  the script now enforces and keep one line naming it.

### PR 7 `chore/agent-caps` (point 8)

- `budget-guard.mjs`: per transcript, count assistant messages;
  `CLAUDE_BUDGET_AGENT_TURNS` (default 150) soft-blocks a sub-agent with
  "post your report block and end", `CLAUDE_BUDGET_TURNS` (default 600)
  does the same for the main session. Keep the last three Bash commands
  and a hash of each result per transcript: the same command with the
  same result three times blocks with "stop and hand off".
- `delivery.md` rule 2: one sentence that a capped agent hands off like
  any other stop.

### PR 8 `chore/task-size` (point 5)

- `templates/task.md`: a `Size: about N files, N lines` line under
  Technical spec.
- `spec-session` split mode: a task is at most about 30 files and 1,500
  changed lines by that estimate; a bigger slice is cut again, the later
  task under Depends on, delivered as a stack with `gh stack`.
- `spec-checker`: category 10 `size`, a finding when Modules touched and
  Tests imply more than the cap, or the Size line is missing.
- `deliver`: the audit report's diff size over twice the cap is written
  into `### Status` for the stats, not blocking yet.

### PR 9 `chore/review-calibration` (point 6)

- `delivery-stats.mjs --calibration`: the five commonest rejected classes
  of the last four weeks, one example each, as markdown.
- The weekly routine writes it to `.agents/briefs/calibration.md` and
  opens a PR. `review-inputs.sh` copies it to `$R/calibration.md`; every
  brief ends with "findings of these classes were rejected last month;
  raise one only with evidence that distinguishes it".

### Not a PR: the interleaving runner (point 10, product half)

A feature issue for a spec session: a deterministic scheduler over the
fake clock and ports in `src/core/testing.ts`, so a Tests line can say
"A and B at once, in both orders" and one test proves both. The post-merge
bugs (#424, #402, #389, #434) are the examples the spec starts from.

## Expected effect

| Change | Tokens | Speed | Quality |
| --- | --- | --- | --- |
| PR 2 comment lint | large: 150 findings per big PR never reach a model | one fewer agent per round | neutral |
| PR 3 rounds and notes | large: no rounds 3 to 5, 400 notes a week unwritten | 2 to 3 hours per big PR | more probes where bugs are |
| PR 4 tiers | medium | small PRs review in minutes | neutral |
| PR 5 briefs and Sonnet orchestrator | medium: 500 orchestrator turns stop pasting | small | neutral |
| PR 6, 7 | small | fewer stuck agents | neutral |
| PR 8 task size | medium, indirect | fewer rounds per PR | fewer open findings at merge |
| PR 9 calibration | small | fewer verifications | fewer rejected findings |
