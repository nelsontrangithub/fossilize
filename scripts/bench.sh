#!/usr/bin/env bash
# scripts/bench.sh — A/B token-usage harness for fossil
#
# Runs the same task in Claude Code twice: once against the raw repo, once
# with a fossilized skeleton dropped into the working tree. Captures input
# tokens, output tokens, cache hits, cost, and duration from `claude -p`'s
# JSON output, then reports the median over N runs.
#
# Requires: `claude` CLI on PATH, `jq` on PATH, and this fossil build at
# ../dist/cli.js (run `npm run build` first).

set -euo pipefail

usage() {
  cat <<'EOF'
usage: scripts/bench.sh <repo-path> <task-string-or-@file> [options]

  <repo-path>             Path to the target repo to test against.
  <task>                  Task prompt string, OR @path/to/task.md to read from a file.

options:
  --runs N                Repetitions per condition (default 3, median reported)
  --model M               Pass through to `claude --model`
  --keep-fossil           Don't delete the .fossil/ skeleton dir on exit
  --skill-mode            Instead of pre-fossilizing, instruct Claude to use the
                          fossil skill (fossilize-code) via Bash. Slower setup but
                          tests the "agent decides when to fossilize" workflow.
  --out PATH              Write per-run TSV to this path (default ./fossil-bench.tsv)
  --skip-permissions      Pass --dangerously-skip-permissions to claude
                          (required for non-interactive runs that touch tools)

examples:
  scripts/bench.sh ~/code/some-repo "Where is auth checked?" --runs 3
  scripts/bench.sh ~/code/some-repo @./tasks/refactor-helper.md --runs 5

The TSV captures every run; the printed summary takes the median input-token
count per condition. Compare those two numbers — that's your real delta.
EOF
}

if [[ $# -lt 2 ]] || [[ "${1:-}" == "-h" ]] || [[ "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

REPO="$1"; shift
TASK_INPUT="$1"; shift

RUNS=3
MODEL=""
KEEP_FOSSIL=0
SKILL_MODE=0
TSV="./fossil-bench.tsv"
SKIP_PERMS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runs)              RUNS="$2"; shift 2;;
    --model)             MODEL="$2"; shift 2;;
    --keep-fossil)       KEEP_FOSSIL=1; shift;;
    --skill-mode)        SKILL_MODE=1; shift;;
    --out)               TSV="$2"; shift 2;;
    --skip-permissions)  SKIP_PERMS=1; shift;;
    *) echo "unknown arg: $1" >&2; usage; exit 2;;
  esac
done

# Resolve task prompt — supports inline string or @file
if [[ "$TASK_INPUT" == @* ]]; then
  TASK_FILE="${TASK_INPUT:1}"
  if [[ ! -f "$TASK_FILE" ]]; then
    echo "task file not found: $TASK_FILE" >&2
    exit 1
  fi
  TASK="$(cat "$TASK_FILE")"
else
  TASK="$TASK_INPUT"
fi

# Resolve repo to absolute, locate fossil binary
REPO="$(cd "$REPO" && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FOSSIL_BIN="$SCRIPT_DIR/../dist/cli.js"

if [[ ! -f "$FOSSIL_BIN" ]]; then
  echo "fossil not built at $FOSSIL_BIN — run 'npm run build' from the fossil repo first" >&2
  exit 1
fi

for tool in claude jq node; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "required tool not on PATH: $tool" >&2
    exit 1
  fi
done

CLAUDE_BASE_ARGS=(-p --output-format json)
if [[ -n "$MODEL" ]]; then
  CLAUDE_BASE_ARGS+=(--model "$MODEL")
fi
if [[ "$SKIP_PERMS" -eq 1 ]]; then
  CLAUDE_BASE_ARGS+=(--dangerously-skip-permissions)
fi

# Pre-fossilize unless --skill-mode
if [[ "$SKILL_MODE" -eq 0 ]]; then
  echo "==> pre-fossilizing $REPO into $REPO/.fossil/" >&2
  node "$FOSSIL_BIN" "$REPO" --out "$REPO/.fossil" 2>&1 | tail -1 >&2
fi

# System prompt appendix that flips Claude into "skeleton-first" mode
if [[ "$SKILL_MODE" -eq 1 ]]; then
  FOSSIL_SYSTEM="When this repo's source is large, run \`npx fossilize-code <path>\` via Bash to get an AST skeleton (signatures + types + class shapes, function bodies replaced by markers like '{ /* fossil:src/auth.ts#verifyJwt 6L */ }'). Read that skeleton first for navigation and architecture. When you need a specific body, run \`npx fossilize-code expand <file> <symbol>\` or \`expand --by-id <id>\`. Only Read raw source files when you've decided exactly which body you need and the function is large."
else
  FOSSIL_SYSTEM="You have a pre-computed AST skeleton of this repo in .fossil/. Before opening any source file with Read, first Read its .fossil/<same-relative-path> counterpart — it has every signature, type, interface, and class shape, with function bodies replaced by markers like '{ /* fossil:src/auth.ts#verifyJwt 6L */ }'. Only Read the raw source file when you actually need a specific function body. Prefer the skeleton for architectural understanding and navigation. The .fossil/ directory was generated for this run — treat it as ground truth."
fi

# TSV header
echo -e "run\tcondition\tinput_tokens\toutput_tokens\tcache_creation\tcache_read\tcost_usd\tduration_ms\tnum_turns" > "$TSV"

run_condition() {
  local condition="$1"
  local run_n="$2"
  local extra_args=()
  if [[ "$condition" == "fossil" ]]; then
    extra_args=(--append-system-prompt "$FOSSIL_SYSTEM")
  fi

  local raw_out
  if ! raw_out=$(cd "$REPO" && claude "${CLAUDE_BASE_ARGS[@]}" "${extra_args[@]}" "$TASK" 2>/tmp/fossil-bench-err.$$); then
    echo "  $condition: FAILED (stderr at /tmp/fossil-bench-err.$$)" >&2
    return 1
  fi

  local in_tok out_tok cache_c cache_r cost dur turns
  in_tok=$(jq -r '.usage.input_tokens // 0' <<<"$raw_out")
  out_tok=$(jq -r '.usage.output_tokens // 0' <<<"$raw_out")
  cache_c=$(jq -r '.usage.cache_creation_input_tokens // 0' <<<"$raw_out")
  cache_r=$(jq -r '.usage.cache_read_input_tokens // 0' <<<"$raw_out")
  cost=$(jq -r '.total_cost_usd // 0' <<<"$raw_out")
  dur=$(jq -r '.duration_ms // 0' <<<"$raw_out")
  turns=$(jq -r '.num_turns // 0' <<<"$raw_out")

  echo -e "$run_n\t$condition\t$in_tok\t$out_tok\t$cache_c\t$cache_r\t$cost\t$dur\t$turns" >> "$TSV"
  printf "  %-7s in=%-8s out=%-6s cache_read=%-8s cost=\$%s\n" \
    "$condition" "$in_tok" "$out_tok" "$cache_r" "$cost" >&2
}

for r in $(seq 1 "$RUNS"); do
  echo "==> run $r/$RUNS" >&2
  run_condition raw "$r"     || true
  run_condition fossil "$r"  || true
done

# Cleanup
if [[ "$SKILL_MODE" -eq 0 && "$KEEP_FOSSIL" -eq 0 ]]; then
  rm -rf "$REPO/.fossil"
fi

# Median over runs, per column, per condition
median_col() {
  local col="$1" cond="$2"
  awk -F'\t' -v c="$col" -v k="$cond" 'NR>1 && $2==k { print $c }' "$TSV" \
    | sort -n \
    | awk '{ a[NR]=$1 }
           END {
             if (NR==0) { print 0; exit }
             if (NR%2==1) { print a[(NR+1)/2] }
             else         { printf "%.4f\n", (a[NR/2]+a[NR/2+1])/2 }
           }'
}

pct_delta() {
  local a="$1" b="$2"
  awk -v a="$a" -v b="$b" 'BEGIN { if (a==0) { print "n/a"; exit } printf "%+.1f%%", (b-a)/a*100 }'
}

raw_in=$(median_col 3 raw)
fos_in=$(median_col 3 fossil)
raw_out_t=$(median_col 4 raw)
fos_out_t=$(median_col 4 fossil)
raw_cost=$(median_col 7 raw)
fos_cost=$(median_col 7 fossil)
raw_dur=$(median_col 8 raw)
fos_dur=$(median_col 8 fossil)

echo "" >&2
echo "================ median across $RUNS run(s) ================" >&2
printf "%-18s %-12s %-12s %-12s\n" "metric" "raw" "fossil" "delta"   >&2
printf "%-18s %-12s %-12s %-12s\n" "input tokens"  "$raw_in"  "$fos_in"  "$(pct_delta "$raw_in"  "$fos_in")"  >&2
printf "%-18s %-12s %-12s %-12s\n" "output tokens" "$raw_out_t" "$fos_out_t" "$(pct_delta "$raw_out_t" "$fos_out_t")" >&2
printf "%-18s \$%-11s \$%-11s %-12s\n" "cost (USD)"   "$raw_cost" "$fos_cost" "$(pct_delta "$raw_cost" "$fos_cost")" >&2
printf "%-18s %-12s %-12s %-12s\n" "duration (ms)" "$raw_dur"  "$fos_dur"  "$(pct_delta "$raw_dur"  "$fos_dur")"  >&2
echo "============================================================" >&2
echo "per-run TSV: $TSV" >&2
