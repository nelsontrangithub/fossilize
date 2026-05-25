# 🦴 fossil

**fossil turns your codebase into a map Claude can afford to read.**

[Install](#install) • [The Agent Workflow](#the-agent-workflow) • [Before / After](#before--after) • [Benchmark](#trust-but-verify-benchmark) • [How](#how-it-works) • [Roadmap](#roadmap)

---

A CLI + Claude Code skill that compresses TypeScript / JavaScript source files into their **AST skeleton** before they ever hit your agent's context window. **Start with structure. Expand implementation only when the agent needs it.**

Same family as caveman — caveman makes Claude *talk* with fewer tokens, fossil makes Claude *read* with fewer tokens. Together, the full Stone Age stack.

## The Agent Workflow

The CLI is nice. The real magic is the agent loop.

```bash
claude install-skill nelsontrangithub/fossilize
```

Then ask Claude to inspect a 200k-token repo. Under the hood:

1. fossil hands Claude a **25k-token skeleton** of the whole repo — every signature, type, interface, class shape, import.
2. Claude reasons about architecture from the skeleton.
3. When Claude needs a specific body, it runs `fossil expand <id>` and pulls just that function.
4. Tokens stay low, signal stays high, edits stay correct.

Every fossilized body carries a **stable ID** in its marker so the agent always knows how to expand it:

```ts
export function verifyJwt(token: string, secret: string): JwtPayload | null { /* fossil:src/auth.ts#verifyJwt 6L */ }
```

That `fossil:src/auth.ts#verifyJwt` is the address. The agent reads it, decides it needs the body, runs `fossil expand --by-id "fossil:src/auth.ts#verifyJwt"`, and gets the original source back. Just-in-time loading instead of upfront everything-into-context.

## Before / After

A real Express auth middleware file:

| Original | Fossilized |
|---|---|
| 748 tokens | **287 tokens (61.6% saved)** |
| 116 lines of code | 32 lines, every signature intact |

On fossil's own source (after v0.2 added find / callers / callees / bench):

```
file                 orig     foss  saved
--------------------------------------------
src/fossilize.ts     4738     1613  66.0%
src/cli.ts           2426      622  74.4%
--------------------------------------------
TOTAL                7164     2235  68.8%
```

On larger real-world repos: typically 70–90% reduction. A 200k-token repo becomes 25–60k tokens — fits in context with room to actually *work*.

## Trust-but-verify benchmark

Tokens saved is the cheap claim. The harder claim is **task quality unchanged**. To measure that honestly, fossil ships `fossil bench`:

```
$ fossil bench src/ --expand 3 --seed 1
files:                    2
raw tokens:               7164
fossilized tokens:        2235  (68.8% saved)
+ 3 random expansions:
    src/fossilize.ts#findCallers      (~261 tokens)
    src/fossilize.ts#estimateTokens   (~24 tokens)
    src/fossilize.ts#getStandaloneNode (~102 tokens)
fossilized + 3 expansions: 2622 tokens  (63.4% net savings)
```

That's the **honest** budget: 68.8% off the skeleton alone, 63.4% net after the agent pulls three bodies it actually needed. That kind of run is what fossil claims and what fossil delivers.

What `fossil bench` *can't* tell you is whether the agent **answers correctly** with fewer tokens. That's a task-quality question — see [docs/BENCHMARK.md](./docs/BENCHMARK.md) for a methodology to run against your own repo and a template results table.

To measure the **actual** delta in a real Claude Code session, run the bundled harness:

```bash
scripts/bench.sh /path/to/your-repo "Where is auth checked?" --runs 3 --skip-permissions
```

It runs the same task twice (raw vs. fossil-skeleton), captures input/output tokens and cost from `claude -p`'s JSON output, and reports the median. Details in [docs/BENCHMARK.md](./docs/BENCHMARK.md#automated-ab-harness).

The honest framing is **not** "Claude doesn't need bodies." It's: **most architectural reasoning works from signatures; expand the few bodies the task actually requires.**

## Install

```bash
npm install -g fossilize-code
```

(The npm package is `fossilize-code` — the CLI is just `fossil`. Avoids the name clash with the [Fossil SCM](https://www.fossil-scm.org/).)

As a Claude Code skill:

```bash
claude install-skill nelsontrangithub/fossilize
```

## Usage

```bash
fossil src/                       # fossilize whole src/ tree to stdout
fossil src/auth.ts                # single file
fossil src/ --out .fossil         # write skeleton copies into .fossil/
fossil src/ --jsx                 # keep JSX returns, fossilize hooks/handlers
fossil src/ --keep foo,bar        # fossilize, but keep foo and bar full
fossil src/ --strip-comments      # also drop comments and JSDoc
fossil stats .                    # see token savings per file
fossil bench src/ --expand 3      # estimate full session cost (skeleton + N expansions)
```

### Agent-proof expand

```bash
fossil expand src/auth.ts verifyJwt              # bare name
fossil expand src/auth.ts TokenService.decode    # dotted (class.method)
fossil expand src/auth.ts verifyJwt --around 3   # ±3 lines of surrounding context
fossil expand --by-id "fossil:src/auth.ts#verifyJwt"
```

### Symbol-graph traversal

```bash
fossil find verifyJwt              # where is this defined?
fossil callers verifyJwt           # who calls this?
fossil callees src/auth.ts TokenService.rotateRefreshToken  # what does this call?
```

These three commands let an agent walk the symbol graph **without re-reading whole files** — discover, follow, expand, modify.

## React / JSX mode

The `--jsx` flag keeps `return (<...>)` JSX trees intact and only fossilizes hooks, handlers, and helpers inside the component:

```tsx
// fossil src/UserCard.tsx --jsx
export function UserCard({ userId, onSelect }: Props) {
  const [user, setUser] = useState<User | null>(null);
  const [isFavorite, setIsFavorite] = useState(false);

  useEffect(() => { /* fossil:src/UserCard.tsx#UserCard.useEffect 10L */ }, [userId]);

  const onClick = () => { /* fossil:src/UserCard.tsx#UserCard.onClick 3L */ };

  const toggleFavorite = () => { /* fossil:src/UserCard.tsx#UserCard.toggleFavorite 9L */ };

  if (!user) {
    return <div className="loading">Loading...</div>;
  }

  return (
    <div className="card" onClick={onClick}>
      <img src={user.avatar} alt={user.name} />
      ...
    </div>
  );
}
```

The render tree is the *interface*. Hooks and handlers are *implementation*. fossil treats them differently.

## How It Works

fossil parses with [ts-morph](https://ts-morph.com) (a TypeScript Compiler API wrapper). It walks the AST and replaces function / method / constructor / accessor / arrow bodies with a marker carrying a stable ID:

```ts
// before
export function verifyJwt(token: string, secret: string): JwtPayload | null {
  try {
    return jwt.verify(token, secret) as JwtPayload;
  } catch {
    return null;
  }
}

// after
export function verifyJwt(token: string, secret: string): JwtPayload | null { /* fossil:src/auth.ts#verifyJwt 6L */ }
```

Everything else stays exactly as-is:
- Imports, exports
- Interfaces, types, enums
- Class declarations and fields
- Function/method **signatures** with full parameter and return types
- JSDoc above declarations

Trivial single-line bodies aren't touched (the marker would be longer than the code).

When the agent actually needs a body, `fossil expand <file> <symbol>` (or `--by-id <id>`) pulls just that function, full source.

### Stable symbol IDs

Marker format: `{ /* fossil:<file>#<dotted-name> <N>L */ }`

- Top-level function: `src/auth.ts#verifyJwt`
- Class method: `src/auth.ts#TokenService.issueAccessToken`
- Constructor: `src/auth.ts#TokenService.constructor`
- Nested arrow / handler: `src/UserCard.tsx#UserCard.onClick`
- Callback to a call: `src/UserCard.tsx#UserCard.useEffect`
- Duplicate names within a file: disambiguated by line, e.g. `UserCard.useEffect@42`

IDs are intentionally agent-readable: the agent sees the marker, knows the address, and can expand without guessing.

## Token Math

Projected scaling (40 files × ~500 lines × ~4k tokens each ≈ a typical mid-size service):

| Approach | Tokens for a 40-file repo (projected) |
|---|---|
| Read every file raw | ~160k |
| Read fossilized | **~25k** |
| Read fossilized + expand 3 functions you actually need | **~28k** |

~83% reduction with no loss of the structural information Claude needs to reason about the architecture. Run `fossil bench` against your own repo for the actual number.

## Roadmap

- [x] **Stable symbol IDs** in markers (v0.2)
- [x] **JSX-aware mode** — keep `return (<...>)` JSX trees in React components, only fossilize hooks and handlers (v0.2)
- [x] **`fossil find` / `fossil callers` / `fossil callees`** — symbol-graph traversal (v0.2)
- [x] **`fossil expand --around N`** — pull surrounding context lines (v0.2)
- [x] **`fossil expand --by-id`** — expand by stable marker ID (v0.2)
- [ ] **C# / Roslyn backend** — same idea, ASP.NET / .NET solutions
- [ ] **Python / tree-sitter backend** — broader language support
- [ ] **`fossil watch`** — live mirror of `src/` → `.fossil/` for use with any agent
- [ ] **MCP server** — expose fossilize and expand as MCP tools so any client (not just Claude Code) can use them
- [ ] **Auto-summary mode** — replace bodies with a one-line natural-language description instead of just a line count (opt-in, calls LLM)

## License

MIT.

## Star this repo

If fossil saves you mass token, mass money — leave mass star ⭐
