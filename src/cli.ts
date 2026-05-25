#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { glob } from "glob";
import {
  fossilizeFile,
  expandSymbol,
  expandSymbolById,
  expandWithContext,
  findSymbols,
  findCallers,
  findCallees,
  bench,
  FossilResult,
} from "./fossilize";

const HELP = `
🦴 fossil — turn your codebase into a map Claude can afford to read

usage:
  fossil <path> [--out <dir>] [--strip-comments] [--keep <name,...>] [--jsx]
                                  compress a file or directory (stdout, or to --out)

  fossil expand <file> <symbol> [--around <N>]
  fossil expand --by-id <id>      retrieve a body by its fossil marker ID
  fossil find <symbol> [path]     locate where a symbol is defined
  fossil callers <symbol> [path]  list call sites of a symbol across the repo
  fossil callees <file> <symbol>  list things this symbol calls
  fossil stats <path>             summarize token savings without printing source
  fossil bench <path> [--expand N] [--seed S]
                                  estimate full session token cost: raw vs
                                  fossilized vs fossilized + N random expansions
  fossil help                     show this message

examples:
  fossil src/                       # fossilize whole src tree to stdout
  fossil src/auth.ts                # one file
  fossil src/ --out .fossil         # write skeleton copies into .fossil/
  fossil src/ --jsx                 # keep JSX returns, fossilize hooks/handlers
  fossil expand src/auth.ts verifyJwt
  fossil expand src/auth.ts TokenService.decode --around 3
  fossil expand --by-id "fossil:src/auth.ts#verifyJwt"
  fossil find verifyJwt
  fossil callers verifyJwt
  fossil callees src/auth.ts TokenService.decode
  fossil stats .
`;

interface Args {
  command: string;
  positional: string[];
  out?: string;
  stripComments: boolean;
  keep: string[];
  keepJsx: boolean;
  around?: number;
  byId?: string;
  expand?: number;
  seed?: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    command: argv[0] ?? "help",
    positional: [],
    stripComments: false,
    keep: [],
    keepJsx: false,
  };
  for (let i = 1; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--out") a.out = argv[++i];
    else if (v === "--strip-comments") a.stripComments = true;
    else if (v === "--jsx" || v === "--keep-jsx") a.keepJsx = true;
    else if (v === "--keep") a.keep = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (v === "--around") a.around = parseInt(argv[++i] ?? "0", 10);
    else if (v === "--by-id") a.byId = argv[++i];
    else if (v === "--expand") a.expand = parseInt(argv[++i] ?? "0", 10);
    else if (v === "--seed") a.seed = parseInt(argv[++i] ?? "1", 10);
    else a.positional.push(v);
  }
  return a;
}

async function collectFiles(target: string): Promise<string[]> {
  if (!fs.existsSync(target)) {
    throw new Error(`path not found: ${target}`);
  }
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  const pattern = path.posix.join(
    target.replace(/\\/g, "/"),
    "**/*.{ts,tsx,js,jsx,mts,cts}",
  );
  return glob(pattern, {
    ignore: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/*.d.ts"],
    nodir: true,
  });
}

function outputRelativePath(target: string, file: string): string {
  const stat = fs.statSync(target);
  return stat.isFile() ? path.basename(file) : path.relative(target, file);
}

function formatPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    console.log(HELP);
    return;
  }

  if (args.command === "expand") {
    if (args.byId) {
      const out = expandSymbolById(args.byId);
      if (out == null) {
        console.error(`symbol not found for id: ${args.byId}`);
        process.exit(1);
      }
      console.log(out);
      return;
    }
    const [file, symbol] = args.positional;
    if (!file || !symbol) {
      console.error("usage: fossil expand <file> <symbol> [--around <N>]");
      console.error("   or: fossil expand --by-id <id>");
      process.exit(2);
    }
    const out =
      args.around && args.around > 0
        ? expandWithContext(file, symbol, args.around)
        : expandSymbol(file, symbol);
    if (out == null) {
      console.error(`symbol not found: ${symbol} in ${file}`);
      process.exit(1);
    }
    console.log(out);
    return;
  }

  if (args.command === "find") {
    const [symbol, root] = args.positional;
    if (!symbol) {
      console.error("usage: fossil find <symbol> [path]");
      process.exit(2);
    }
    const matches = await findSymbols(root ?? ".", symbol);
    if (matches.length === 0) {
      console.error(`no symbols matching: ${symbol}`);
      process.exit(1);
    }
    for (const m of matches) {
      console.log(`${m.file}:${m.line}  ${m.dottedName}  (${m.kind})`);
    }
    return;
  }

  if (args.command === "callers") {
    const [symbol, root] = args.positional;
    if (!symbol) {
      console.error("usage: fossil callers <symbol> [path]");
      process.exit(2);
    }
    const matches = await findCallers(root ?? ".", symbol);
    if (matches.length === 0) {
      console.error(`no callers found for: ${symbol}`);
      process.exit(1);
    }
    for (const m of matches) {
      console.log(`${m.file}:${m.line}  ${m.snippet}`);
    }
    return;
  }

  if (args.command === "bench") {
    const [root] = args.positional;
    if (!root) {
      console.error("usage: fossil bench <path> [--expand N] [--seed S]");
      process.exit(2);
    }
    const expandN = args.expand ?? 0;
    const seed = args.seed ?? 1;
    const summary = await bench(root, expandN, seed);
    console.log(`files:                    ${summary.files}`);
    console.log(`raw tokens:               ${summary.rawTokens}`);
    console.log(`fossilized tokens:        ${summary.fossilTokens}  (${formatPct(summary.fossilSavingsPct)} saved)`);
    if (expandN > 0) {
      console.log(`+ ${summary.expansions} random expansions:`);
      for (const s of summary.sampledSymbols) {
        console.log(`    ${s.id}  (~${s.tokens} tokens)`);
      }
      console.log(
        `fossilized + ${summary.expansions} expansions: ${summary.fossilPlusExpansionTokens} tokens  (${formatPct(summary.netSavingsPct)} net savings)`,
      );
    }
    return;
  }

  if (args.command === "callees") {
    const [file, symbol] = args.positional;
    if (!file || !symbol) {
      console.error("usage: fossil callees <file> <symbol>");
      process.exit(2);
    }
    const callees = findCallees(file, symbol);
    if (callees.length === 0) {
      console.error(`no callees found for ${symbol} in ${file}`);
      process.exit(1);
    }
    for (const c of callees) console.log(c);
    return;
  }

  // For `stats` and the default compress action, the target path is either
  // the command itself (default) or the first positional (stats).
  const isStats = args.command === "stats";
  const target = isStats ? args.positional[0] : args.command;
  if (!target) {
    console.log(HELP);
    process.exit(2);
  }

  const files = await collectFiles(target);
  if (files.length === 0) {
    console.error(`no source files found under ${target}`);
    process.exit(1);
  }

  let totalOrig = 0;
  let totalFoss = 0;
  const perFile: { file: string; result: FossilResult }[] = [];

  for (const file of files) {
    const result = fossilizeFile(file, {
      stripComments: args.stripComments,
      keep: args.keep,
      keepJsx: args.keepJsx,
    });
    totalOrig += result.stats.originalTokens;
    totalFoss += result.stats.fossilizedTokens;
    perFile.push({ file, result });
  }

  if (isStats) {
    const rows = perFile
      .map(({ file, result }) => {
        const o = result.stats.originalTokens;
        const f = result.stats.fossilizedTokens;
        const save = formatPct(result.stats.savings);
        return { file, o, f, save };
      })
      .sort((a, b) => b.o - a.o);

    const maxName = Math.max(...rows.map((r) => r.file.length), 4);
    console.log(`${"file".padEnd(maxName)}  ${"orig".padStart(7)}  ${"foss".padStart(7)}  saved`);
    console.log("-".repeat(maxName + 28));
    for (const r of rows) {
      console.log(
        `${r.file.padEnd(maxName)}  ${String(r.o).padStart(7)}  ${String(r.f).padStart(7)}  ${r.save}`,
      );
    }
    console.log("-".repeat(maxName + 28));
    const totalSave = 1 - totalFoss / Math.max(totalOrig, 1);
    console.log(
      `${"TOTAL".padEnd(maxName)}  ${String(totalOrig).padStart(7)}  ${String(totalFoss).padStart(7)}  ${formatPct(totalSave)}`,
    );
    return;
  }

  if (args.out) {
    for (const { file, result } of perFile) {
      const rel = outputRelativePath(target, file);
      const outPath = path.join(args.out, rel);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, result.text);
    }
    const totalSave = 1 - totalFoss / Math.max(totalOrig, 1);
    console.error(
      `🦴 ${files.length} files → ${args.out}: ${totalOrig} → ${totalFoss} tokens (${formatPct(totalSave)} saved)`,
    );
  } else {
    for (const { file, result } of perFile) {
      console.log(`// ===== ${file} =====`);
      console.log(result.text);
      console.log();
    }
    const totalSave = 1 - totalFoss / Math.max(totalOrig, 1);
    console.error(
      `🦴 ${files.length} files: ${totalOrig} → ${totalFoss} tokens (${formatPct(totalSave)} saved)`,
    );
  }
}

main().catch((e) => {
  console.error(`fossil: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
