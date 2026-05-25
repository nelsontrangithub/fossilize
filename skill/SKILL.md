---
name: fossil
description: Compress source files to AST skeletons so you can read repo structure first and expand bodies only when the task requires them. Use whenever you need to load multiple source files, when context is filling up, when the user asks for "the codebase" / "the repo", or when they mention "fossil", "skeleton", or "compress repo". Trigger words include "fossilize", "skeleton view", "save tokens on this repo".
---

# 🦴 fossil — read repos as skeletons, expand on demand

## When to use

- You need to load more than ~2 source files at once
- The user asks "look at the codebase" / "what does this project do" / similar
- Context window is filling and you want to keep working
- The user explicitly says "fossil", "skeleton", "compress"

## The workflow

The honest framing: **start with structure, expand implementation only when the task requires it.** Most architectural reasoning works from signatures + types + class shapes. Bodies are needed for bug fixing, refactoring, security review, and behavior-sensitive work — fetch them then.

### Step 1 — read the whole repo as a skeleton

```
npx fossilize-code <path>
```

Token cost typically drops 70–90%. You'll see a summary on stderr:
`🦴 42 files: 184,302 → 21,448 tokens (88.4% saved)`

Every fossilized body carries a marker like:

```ts
export function verifyJwt(token: string, secret: string): JwtPayload | null { /* fossil:src/auth.ts#verifyJwt 6L */ }
```

The `fossil:src/auth.ts#verifyJwt` is the **stable address** — use it to expand.

### Step 2 — locate the symbols you need

```
npx fossilize-code find verifyJwt              # where is this defined?
npx fossilize-code callers verifyJwt           # who calls this?
npx fossilize-code callees src/auth.ts verifyJwt   # what does this call?
```

These let you walk the symbol graph without re-reading whole files.

### Step 3 — expand only what you need

```
npx fossilize-code expand src/auth.ts verifyJwt
npx fossilize-code expand src/auth.ts TokenService.decode    # dotted: class.method
npx fossilize-code expand src/auth.ts verifyJwt --around 3   # ±3 lines of context
npx fossilize-code expand --by-id "fossil:src/auth.ts#verifyJwt"
```

Prefer `--by-id` when you've just read a skeleton — you already have the exact ID in the marker, so there's nothing to guess.

### Keeping certain symbols intact during the initial pass

If you know up front you'll need full bodies for specific functions:

```
npx fossilize-code <path> --keep authMiddleware,TokenService.issueAccessToken
```

`--keep` accepts both bare names and dotted names.

### React / TSX

For React-heavy projects, use `--jsx` so render trees stay intact:

```
npx fossilize-code src/ --jsx
```

The JSX `return (...)` is the component's interface; hooks and handlers inside it get fossilized:

```tsx
export function UserCard({ user }: Props) {
  useEffect(() => { /* fossil:src/UserCard.tsx#UserCard.useEffect 8L */ }, []);
  const onClick = () => { /* fossil:src/UserCard.tsx#UserCard.onClick 3L */ };

  return (
    <Card>
      <Avatar src={user.avatar} />
      <Text>{user.name}</Text>
    </Card>
  );
}
```

## When NOT to use

- Single file under ~200 lines — the marker overhead isn't worth it
- You're debugging behavior of one specific function — read it directly
- Non-JS/TS files (Python, Go, etc.) — fossil is TS/JS/JSX/TSX only in v0.2

## What gets preserved

- All imports and exports
- All `interface` and `type` declarations (already compact)
- All function/method/constructor **signatures** with full parameter and return types
- All class declarations and field declarations
- JSDoc comments above declarations (unless `--strip-comments`)
- JSX return trees (only with `--jsx`)

## What gets removed

- Function bodies → `{ /* fossil:<id> NL */ }`
- Method bodies → same
- Arrow function bodies (block form) → same
- Trivial 1-line bodies are **not** fossilized (the marker would be longer than the code)

## Reading a fossil marker

`{ /* fossil:src/auth.ts#TokenService.decode 6L */ }` means:

- File: `src/auth.ts`
- Symbol: `TokenService.decode` (class method)
- Body length: 6 lines

If you need the body, run `npx fossilize-code expand src/auth.ts TokenService.decode`. **Don't guess at body behavior from the signature alone if exact behavior matters — expand and read it.**

## ID format reference

| Symbol kind                  | ID example                                |
|------------------------------|-------------------------------------------|
| Top-level function           | `src/auth.ts#verifyJwt`                   |
| Class method                 | `src/auth.ts#TokenService.issueAccessToken` |
| Constructor                  | `src/auth.ts#TokenService.constructor`    |
| Get/set accessor             | `src/auth.ts#TokenService.config`         |
| Arrow assigned to const      | `src/auth.ts#requireRole`                 |
| Handler inside a function    | `src/UserCard.tsx#UserCard.onClick`       |
| Callback to a call (e.g. hook) | `src/UserCard.tsx#UserCard.useEffect`   |
| Duplicate names (same file)  | `src/UserCard.tsx#UserCard.useEffect@42`  |
