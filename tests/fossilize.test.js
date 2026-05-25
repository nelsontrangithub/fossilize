const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");
const { bench, fossilizeText } = require("../dist/fossilize.js");

const nestedSource = `
export function outer() {
  const inner = () => {
    return 1;
  };
  return inner();
}
`;

test("stripComments preserves fossil marker ids", () => {
  const source = `
/** Public entrypoint. */
export function outer() {
  // implementation detail
  return 1;
}
`;

  const result = fossilizeText(source, "sample.ts", {
    stripComments: true,
  });

  assert.match(result.text, /fossil:sample\.ts#outer\b/);
  assert.doesNotMatch(result.text, /Public entrypoint/);
  assert.doesNotMatch(result.text, /implementation detail/);
});

test("--keep preserves the full kept symbol, including nested functions", () => {
  const result = fossilizeText(nestedSource, "sample.ts", {
    keep: ["outer"],
  });

  assert.doesNotMatch(result.text, /fossil:/);
  assert.match(result.text, /const inner = \(\) => \{\n    return 1;\n  \};/);
});

test("single-file --out writes a copy inside the output directory", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fossil-out-"));
  const input = path.join(tmp, "one.ts");
  const outDir = path.join(tmp, "out");
  fs.writeFileSync(input, nestedSource);

  execFileSync(process.execPath, [cliPath, input, "--out", outDir], {
    cwd: repoRoot,
  });

  const outFile = path.join(outDir, "one.ts");
  assert.equal(fs.statSync(outDir).isDirectory(), true);
  assert.match(fs.readFileSync(outFile, "utf8"), /fossil:/);
});

test("bench samples only symbols that appear as fossil markers", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fossil-bench-"));
  const input = path.join(tmp, "sample.ts");
  fs.writeFileSync(input, nestedSource);

  const summary = await bench(input, 10, 1);

  assert.deepEqual(
    summary.sampledSymbols.map((symbol) => symbol.id),
    [`${input}#outer`],
  );
});
