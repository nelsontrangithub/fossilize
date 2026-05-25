import { Project, Node, SyntaxKind, SourceFile } from "ts-morph";
import { glob } from "glob";
import * as path from "path";

export interface FossilizeOptions {
  /** Symbol names (bare or dotted, e.g. "verifyJwt" or "TokenService.decode") to keep fully expanded. */
  keep?: string[];
  /** If true, strip leading comments / JSDoc. Default: false (kept — they're cheap and useful). */
  stripComments?: boolean;
  /** If true, preserve any function whose body contains JSX (only fossilize hooks/handlers inside it). */
  keepJsx?: boolean;
  /** Override the path used in marker IDs. Defaults to the file path passed to fossilizeFile. */
  idPath?: string;
}

export interface FossilStats {
  originalChars: number;
  fossilizedChars: number;
  originalTokens: number;
  fossilizedTokens: number;
  /** 0..1 — fraction of tokens removed. */
  savings: number;
}

export interface FossilResult {
  text: string;
  stats: FossilStats;
}

/** Rough token estimate (~4 chars/token is a decent code-shape approximation). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Fossilize a single source file given its on-disk path. */
export function fossilizeFile(
  filePath: string,
  options: FossilizeOptions = {},
): FossilResult {
  const project = newProject();
  const sourceFile = project.addSourceFileAtPath(filePath);
  return fossilizeSourceFile(sourceFile, {
    ...options,
    idPath: options.idPath ?? filePath,
  });
}

/** Fossilize from in-memory text (handy for tests). */
export function fossilizeText(
  text: string,
  fileName = "in.ts",
  options: FossilizeOptions = {},
): FossilResult {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, jsx: 4 /* Preserve */ },
  });
  const sourceFile = project.createSourceFile(fileName, text);
  return fossilizeSourceFile(sourceFile, {
    ...options,
    idPath: options.idPath ?? fileName,
  });
}

function newProject(): Project {
  return new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, jsx: 4 /* Preserve */ },
  });
}

function fossilizeSourceFile(
  sourceFile: SourceFile,
  options: FossilizeOptions,
): FossilResult {
  const originalText = sourceFile.getFullText();
  const idPath = options.idPath ?? sourceFile.getFilePath();

  if (options.stripComments) {
    stripCommentsFromSourceFile(sourceFile);
  }

  const targets = collectFossilTargets(sourceFile, options);

  // Replace in reverse-position order so earlier edits don't invalidate later ones.
  targets.sort((a, b) => b.body.getStart() - a.body.getStart());

  for (const { body, dottedName, lineCount } of targets) {
    body.replaceWithText(
      `{ /* fossil:${idPath}#${dottedName} ${lineCount}L */ }`,
    );
  }

  const fossilizedText = sourceFile.getFullText();

  return {
    text: fossilizedText,
    stats: {
      originalChars: originalText.length,
      fossilizedChars: fossilizedText.length,
      originalTokens: estimateTokens(originalText),
      fossilizedTokens: estimateTokens(fossilizedText),
      savings: 1 - fossilizedText.length / Math.max(originalText.length, 1),
    },
  };
}

type FossilTarget = {
  node: Node;
  body: Node;
  dottedName: string;
  lineCount: number;
  startLine: number;
};

function collectFossilTargets(
  sourceFile: SourceFile,
  options: FossilizeOptions,
): FossilTarget[] {
  const keep = new Set(options.keep ?? []);
  const keepJsx = !!options.keepJsx;
  const targets: FossilTarget[] = [];

  sourceFile.forEachDescendant((node, traversal) => {
    const meta = bodyForNode(node);
    if (!meta) return;

    const dottedName = buildDottedName(node, meta.name);
    if (keep.has(meta.name) || keep.has(dottedName)) {
      traversal.skip();
      return;
    }

    // JSX-aware mode: keep any function whose body contains JSX so the render
    // tree survives. Inner handlers/hooks inside it will still get fossilized.
    if (keepJsx && containsJsx(meta.body)) return;

    const lineCount =
      meta.body.getEndLineNumber() - meta.body.getStartLineNumber();
    // Don't fossilize trivially short bodies — the marker would be longer than the code.
    if (lineCount <= 1) return;

    targets.push({
      node,
      body: meta.body,
      dottedName,
      lineCount,
      startLine: node.getStartLineNumber(),
    });
    traversal.skip();
  });

  const nameCounts = new Map<string, number>();
  for (const t of targets) {
    nameCounts.set(t.dottedName, (nameCounts.get(t.dottedName) ?? 0) + 1);
  }
  for (const t of targets) {
    if ((nameCounts.get(t.dottedName) ?? 0) > 1) {
      t.dottedName = `${t.dottedName}@${t.startLine}`;
    }
  }

  return targets;
}

function stripCommentsFromSourceFile(sourceFile: SourceFile): void {
  sourceFile.getClasses().forEach((c) => c.getJsDocs().forEach((j) => j.remove()));
  sourceFile.getFunctions().forEach((f) => f.getJsDocs().forEach((j) => j.remove()));
  sourceFile.getInterfaces().forEach((i) => i.getJsDocs().forEach((j) => j.remove()));
  sourceFile.getTypeAliases().forEach((t) => t.getJsDocs().forEach((j) => j.remove()));
  sourceFile.getEnums().forEach((e) => e.getJsDocs().forEach((j) => j.remove()));
  const text = sourceFile.getFullText()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/\n\s*\n\s*\n/g, "\n\n");
  sourceFile.replaceWithText(text);
}

/** Build a dotted symbol name like "TokenService.issueAccessToken" by walking ancestors. */
function buildDottedName(node: Node, baseName: string): string {
  const parts: string[] = [baseName];
  let cur: Node | undefined = node.getParent();
  while (cur) {
    if (Node.isClassDeclaration(cur) || Node.isClassExpression(cur)) {
      const cname = cur.getName();
      if (cname) parts.unshift(cname);
      break;
    }
    if (Node.isFunctionDeclaration(cur)) {
      const fname = cur.getName();
      if (fname) parts.unshift(fname);
      break;
    }
    if (Node.isMethodDeclaration(cur)) {
      parts.unshift(cur.getName());
    }
    if (Node.isArrowFunction(cur) || Node.isFunctionExpression(cur)) {
      const enclosingName = nameForFunctionLike(cur);
      if (enclosingName && enclosingName !== "<anonymous>") {
        parts.unshift(enclosingName);
      }
    }
    cur = cur.getParent();
  }
  return parts.join(".");
}

/** Derive a name for an arrow/function expression from its surrounding syntax. */
function nameForFunctionLike(node: Node): string {
  if (Node.isFunctionExpression(node) && node.getName()) return node.getName()!;
  const parent = node.getParent();
  if (!parent) return "<anonymous>";
  if (Node.isVariableDeclaration(parent)) return parent.getName();
  if (Node.isPropertyAssignment(parent)) return parent.getName();
  if (Node.isCallExpression(parent)) {
    const expr = parent.getExpression();
    if (Node.isIdentifier(expr)) return expr.getText();
    if (Node.isPropertyAccessExpression(expr)) return expr.getName();
  }
  return "<anonymous>";
}

function containsJsx(node: Node): boolean {
  let found = false;
  node.forEachDescendant((d, t) => {
    if (
      Node.isJsxElement(d) ||
      Node.isJsxSelfClosingElement(d) ||
      Node.isJsxFragment(d)
    ) {
      found = true;
      t.stop();
    }
  });
  return found;
}

/** Resolve "is this a function-like with a replaceable body?" → {body, name} */
function bodyForNode(node: Node): { body: Node; name: string } | null {
  if (Node.isFunctionDeclaration(node)) {
    const body = node.getBody();
    if (!body) return null;
    return { body, name: node.getName() ?? "<anonymous>" };
  }
  if (Node.isMethodDeclaration(node)) {
    const body = node.getBody();
    if (!body) return null;
    return { body, name: node.getName() };
  }
  if (Node.isConstructorDeclaration(node)) {
    const body = node.getBody();
    if (!body) return null;
    return { body, name: "constructor" };
  }
  if (Node.isGetAccessorDeclaration(node) || Node.isSetAccessorDeclaration(node)) {
    const body = node.getBody();
    if (!body) return null;
    return { body, name: node.getName() };
  }
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    const body = node.getBody();
    if (!body || !Node.isBlock(body)) return null;
    if (Node.isFunctionExpression(node) && node.getName()) {
      return { body, name: node.getName()! };
    }
    const parent = node.getParent();
    let name = "<anonymous>";
    if (Node.isVariableDeclaration(parent)) name = parent.getName();
    else if (Node.isPropertyAssignment(parent)) name = parent.getName();
    else if (Node.isCallExpression(parent)) {
      // Arrow passed as a callback: name it after the function being called.
      const expr = parent.getExpression();
      if (Node.isIdentifier(expr)) name = expr.getText();
      else if (Node.isPropertyAccessExpression(expr)) name = expr.getName();
    }
    return { body, name };
  }
  return null;
}

// =============================================================================
// Symbol lookup / expansion
// =============================================================================

/**
 * Find and return the original text of a function/method by name or dotted path.
 *   "verifyJwt"                  — top-level function or arrow
 *   "TokenService.decode"        — class method / accessor
 *   "TokenService.constructor"   — constructor
 */
export function expandSymbol(filePath: string, symbol: string): string | null {
  const project = newProject();
  const sourceFile = project.addSourceFileAtPath(filePath);
  const node = findNodeForSymbol(sourceFile, symbol);
  if (!node) return null;
  return getStandaloneText(node);
}

/** Expand a fossil marker ID of the form `<filePath>#<dotted-name>`. */
export function expandSymbolById(id: string): string | null {
  const hashIdx = id.indexOf("#");
  if (hashIdx === -1) return null;
  // Strip the "fossil:" prefix if the user copied the whole marker token.
  const cleaned = id.startsWith("fossil:") ? id.slice("fossil:".length) : id;
  const splitIdx = cleaned.indexOf("#");
  if (splitIdx === -1) return null;
  const filePath = cleaned.slice(0, splitIdx);
  // Strip a trailing line-count suffix like " 6L" if present.
  const symbol = cleaned.slice(splitIdx + 1).split(/\s/)[0];
  return expandSymbol(filePath, symbol);
}

/** Expand a symbol and include N lines of surrounding context. */
export function expandWithContext(
  filePath: string,
  symbol: string,
  contextLines: number,
): string | null {
  const project = newProject();
  const sourceFile = project.addSourceFileAtPath(filePath);
  const node = findNodeForSymbol(sourceFile, symbol);
  if (!node) return null;

  const allText = sourceFile.getFullText();
  const lines = allText.split("\n");
  const startLine = Math.max(1, node.getStartLineNumber() - contextLines);
  const endLine = Math.min(lines.length, node.getEndLineNumber() + contextLines);
  return lines.slice(startLine - 1, endLine).join("\n");
}

function findNodeForSymbol(sourceFile: SourceFile, symbol: string): Node | null {
  // Strip optional `@<line>` suffix used to disambiguate duplicates.
  const atIdx = symbol.lastIndexOf("@");
  const wantedLine = atIdx >= 0 ? parseInt(symbol.slice(atIdx + 1), 10) : NaN;
  const bareSymbol = atIdx >= 0 ? symbol.slice(0, atIdx) : symbol;
  const parts = bareSymbol.split(".");
  const lastPart = parts[parts.length - 1];

  let result: Node | null = null;

  sourceFile.forEachDescendant((node, traversal) => {
    if (result) {
      traversal.stop();
      return;
    }
    const meta = bodyForNode(node);
    if (!meta) return;
    const dotted = buildDottedName(node, meta.name);

    let nameMatch = false;
    if (dotted === bareSymbol) nameMatch = true;
    else if (parts.length === 1 && (meta.name === lastPart || dotted.endsWith("." + lastPart))) {
      nameMatch = true;
    }
    if (!nameMatch) return;

    if (!isNaN(wantedLine) && node.getStartLineNumber() !== wantedLine) return;

    result = getStandaloneNode(node);
  });

  return result;
}

function getStandaloneNode(node: Node): Node {
  // For arrow/function expressions, walk up to the enclosing VariableStatement
  // so the consumer sees `const foo = () => {...}` rather than just `() => {...}`.
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    const stmt = node.getFirstAncestorByKind(SyntaxKind.VariableStatement);
    if (stmt) return stmt;
  }
  return node;
}

function getStandaloneText(node: Node): string {
  return getStandaloneNode(node).getText();
}

// =============================================================================
// Find / callers / callees
// =============================================================================

export interface SymbolMatch {
  file: string;
  name: string;
  dottedName: string;
  line: number;
  kind: string;
}

const DEFAULT_GLOB = "**/*.{ts,tsx,js,jsx,mts,cts}";
const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/*.d.ts",
];

export async function findSymbols(
  rootPath: string,
  query: string,
): Promise<SymbolMatch[]> {
  const files = await collectSourceFiles(rootPath);
  const matches: SymbolMatch[] = [];
  const project = newProject();

  for (const file of files) {
    let sourceFile: SourceFile;
    try {
      sourceFile = project.addSourceFileAtPath(file);
    } catch {
      continue;
    }
    sourceFile.forEachDescendant((node) => {
      const meta = bodyForNode(node);
      if (!meta) return;
      const dotted = buildDottedName(node, meta.name);
      if (
        meta.name === query ||
        dotted === query ||
        meta.name.includes(query) ||
        dotted.includes(query)
      ) {
        matches.push({
          file,
          name: meta.name,
          dottedName: dotted,
          line: node.getStartLineNumber(),
          kind: node.getKindName(),
        });
      }
    });
  }
  return matches;
}

export interface CallerMatch {
  file: string;
  line: number;
  snippet: string;
}

/** Find call sites of `symbol` (bare name) across the repo via AST. */
export async function findCallers(
  rootPath: string,
  symbol: string,
): Promise<CallerMatch[]> {
  const files = await collectSourceFiles(rootPath);
  const bareName = symbol.includes(".") ? symbol.split(".").pop()! : symbol;
  const matches: CallerMatch[] = [];
  const project = newProject();

  for (const file of files) {
    let sourceFile: SourceFile;
    try {
      sourceFile = project.addSourceFileAtPath(file);
    } catch {
      continue;
    }
    sourceFile.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const expr = node.getExpression();
      let calledName: string | null = null;
      if (Node.isIdentifier(expr)) {
        calledName = expr.getText();
      } else if (Node.isPropertyAccessExpression(expr)) {
        calledName = expr.getName();
      }
      if (calledName !== bareName) return;
      const line = node.getStartLineNumber();
      const snippet = node.getText().split("\n")[0].trim();
      matches.push({ file, line, snippet });
    });
  }
  return matches;
}

export interface BenchSummary {
  files: number;
  rawTokens: number;
  fossilTokens: number;
  fossilSavingsPct: number;
  expansions: number;
  fossilPlusExpansionTokens: number;
  netSavingsPct: number;
  sampledSymbols: { id: string; tokens: number }[];
}

/**
 * Estimate the token cost of an agent session over `rootPath`:
 *   raw         = sum of all file tokens read in full
 *   fossilized  = sum of all file tokens after fossilize
 *   + expansions = fossilized total plus the tokens of `expansions` randomly
 *                  sampled function bodies (simulating expand calls)
 *
 * Deterministic: with the same seed, returns the same sample.
 */
export async function bench(
  rootPath: string,
  expansions = 0,
  seed = 1,
): Promise<BenchSummary> {
  const files = await collectSourceFiles(rootPath);
  let rawTokens = 0;
  let fossilTokens = 0;
  const allSymbols: { file: string; dottedName: string; tokens: number }[] = [];
  const project = newProject();

  for (const file of files) {
    const result = fossilizeFile(file);
    rawTokens += result.stats.originalTokens;
    fossilTokens += result.stats.fossilizedTokens;

    let sf: SourceFile;
    try {
      sf = project.addSourceFileAtPath(file);
    } catch {
      continue;
    }
    for (const target of collectFossilTargets(sf, {})) {
      allSymbols.push({
        file,
        dottedName: target.dottedName,
        tokens: estimateTokens(getStandaloneText(target.node)),
      });
    }
  }

  const sampled = sampleDeterministic(allSymbols, expansions, seed);
  const expansionTokens = sampled.reduce((s, x) => s + x.tokens, 0);
  const fossilPlusExpansionTokens = fossilTokens + expansionTokens;

  return {
    files: files.length,
    rawTokens,
    fossilTokens,
    fossilSavingsPct: 1 - fossilTokens / Math.max(rawTokens, 1),
    expansions: sampled.length,
    fossilPlusExpansionTokens,
    netSavingsPct: 1 - fossilPlusExpansionTokens / Math.max(rawTokens, 1),
    sampledSymbols: sampled.map((s) => ({
      id: `${s.file}#${s.dottedName}`,
      tokens: s.tokens,
    })),
  };
}

function sampleDeterministic<T>(arr: T[], n: number, seed: number): T[] {
  if (n <= 0 || arr.length === 0) return [];
  if (n >= arr.length) return [...arr];
  // Tiny mulberry32 PRNG for deterministic sampling.
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pool = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(rand() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

/** List identifier names called from inside `symbol`'s body. */
export function findCallees(filePath: string, symbol: string): string[] {
  const project = newProject();
  const sourceFile = project.addSourceFileAtPath(filePath);
  const node = findNodeForSymbol(sourceFile, symbol);
  if (!node) return [];

  const calls = new Set<string>();
  node.forEachDescendant((d) => {
    if (Node.isCallExpression(d)) {
      const expr = d.getExpression();
      if (Node.isIdentifier(expr)) {
        calls.add(expr.getText());
      } else if (Node.isPropertyAccessExpression(expr)) {
        calls.add(expr.getText());
      }
    }
  });
  return [...calls].sort();
}

async function collectSourceFiles(rootPath: string): Promise<string[]> {
  const fs = await import("fs");
  if (!fs.existsSync(rootPath)) return [];
  const stat = fs.statSync(rootPath);
  if (stat.isFile()) return [rootPath];
  const pattern = path.posix.join(rootPath.replace(/\\/g, "/"), DEFAULT_GLOB);
  return glob(pattern, { ignore: DEFAULT_IGNORE, nodir: true });
}
