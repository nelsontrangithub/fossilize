# Benchmarking fossil

The cheap claim is **tokens saved**. The honest claim is **tokens saved without losing task quality**. This doc tells you how to measure both on your own repo.

## What `fossil bench` measures

```bash
fossil bench <path> [--expand N] [--seed S]
```

It reports three numbers:

| Number | Meaning |
|---|---|
| **raw tokens** | What it costs to read every source file in full |
| **fossilized tokens** | What it costs to read every file as a skeleton |
| **fossilized + N expansions** | Skeleton cost plus the body cost of `N` randomly sampled functions (simulating the case where an agent reads the skeleton, then expands a handful of bodies the task actually needs) |

The third number is the **honest token budget for a real agent session**, not the marketing-only "tokens saved on the skeleton alone."

`--seed` makes the random sample deterministic so different fossil versions or repo states can be compared apples-to-apples.

### Example run (this repo)

```
$ fossil bench src/ --expand 3 --seed 1
files:                    2
raw tokens:               7164
fossilized tokens:        2235  (68.8% saved)
+ 3 random expansions:
    src/fossilize.ts#findCallers       (~261 tokens)
    src/fossilize.ts#estimateTokens    (~24 tokens)
    src/fossilize.ts#getStandaloneNode (~102 tokens)
fossilized + 3 expansions: 2622 tokens  (63.4% net savings)
```

68.8% savings on the skeleton alone, 63.4% net after pulling three bodies. That's defensible.

## What `fossil bench` does **not** measure

`fossil bench` cannot tell you whether the agent **answers correctly**. That's a task-quality question and you have to run it yourself. The minimum methodology:

1. Pick 4 tasks of different shapes:
   - **Architecture**: "Where does X happen in this repo?"
   - **Endpoint**: "Add a new endpoint that does Y."
   - **Refactor**: "Refactor function Z without changing behavior."
   - **Bug fix**: "Fix the bug where W returns null when it shouldn't."
2. Run each task twice in identical sessions:
   - **Raw**: agent reads every file in full.
   - **Fossil**: agent reads the fossilized skeleton, calls `fossil expand` when it needs a body.
3. Record three things per task:
   - **Tokens consumed** (in + out)
   - **Task outcome** (pass / fail)
   - **Number of expansions** the fossil run needed

The viral version of fossil's claim is **not** "Claude doesn't need bodies." It's:

> Most architectural reasoning works from signatures. Expand the few bodies the task actually requires.

So a passing fossil run with 4 expansions on a bug-fix task is a *better* result than a passing fossil run with 0 expansions — it shows the agent correctly identified what it needed and went and got it.

## Template results table

Fill this in for your repo:

| Task class                  | Raw tokens | Fossil tokens | Expansions used | Tests pass? |
|-----------------------------|-----------:|--------------:|----------------:|:-----------:|
| Find auth flow              |            |               |                 |             |
| Add new endpoint            |            |               |                 |             |
| Refactor helper             |            |               |                 |             |
| Bug fix needing body        |            |               |                 |             |

If a fossil row fails where the raw row passes, that's a fossil bug — file an issue with the task description so we can improve the skeleton or the expand UX.

## Automated A/B harness

The repo ships a bash harness that runs both conditions against a real Claude Code session and captures token counts from `claude -p`'s JSON output:

```bash
# from the fossil repo, after `npm run build`:
scripts/bench.sh /path/to/target-repo "Where is auth checked in this repo?" --runs 3 --skip-permissions
```

What it does, per run:

1. Pre-fossilizes the target repo into `<repo>/.fossil/` (skeleton mirror).
2. Runs `claude -p "<task>"` against the raw repo. Captures input/output tokens, cache hits, cost, duration.
3. Runs `claude -p "<task>"` again with a system-prompt appendix instructing Claude to read `.fossil/<path>` first, only reading raw source when a specific body is needed.
4. Repeats `--runs N` times and reports the **median** per condition.

Per-run numbers go to `./fossil-bench.tsv` (overridable with `--out`). The printed summary is the median.

```
================ median across 3 run(s) ================
metric             raw          fossil       delta
input tokens       142,318      24,907       -82.5%
output tokens      4,210        3,890        -7.6%
cost (USD)         $0.4123      $0.0892      -78.4%
duration (ms)      48,200       21,400       -55.6%
============================================================
```

(Example numbers — yours will vary by repo and task.)

The `--skill-mode` flag flips the harness to test "agent decides when to fossilize" instead of pre-fossilizing — slower setup but a more realistic measurement of the deployed skill.

Requires: `claude`, `jq`, `node` on PATH, and a built fossil at `dist/cli.js`.

## Reporting back

If you run this benchmark on a public repo, please share the table — concrete real-world numbers are worth a lot more than marketing claims.
