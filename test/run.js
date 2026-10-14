"use strict";

// Zero-dependency smoke test. Runs the CLI as a child process and checks the
// behavior that matters: it finds the seeded tells, it exits non-zero when it
// does, it exits zero on clean text, the path allowlist suppresses a rule,
// directory arguments scan the files under them, and the baseline mode fails
// only when the debt grows.

const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "bin", "slop-gate.js");
const REPO = path.join(__dirname, "..");

function run(args, cwd) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: cwd || REPO,
    encoding: "utf8",
  });
  return {
    code: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    out: r.stdout + r.stderr,
  };
}

function tmpProject(files) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-gate-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return tmp;
}

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

test("flags seeded tells in the sample and exits 1", () => {
  const { code, out } = run(["examples/sample.md"]);
  assert.strictEqual(code, 1, "expected non-zero exit on dirty file");
  assert.match(out, /em-dash/);
  assert.match(out, /delve/);
  assert.match(out, /11 tells in 1 file/);
});

test("exits 0 on clean text", () => {
  const tmp = tmpProject({ "clean.md": "This sentence is plain and direct.\n" });
  const { code, out } = run(["clean.md"], tmp);
  assert.strictEqual(code, 0, "expected zero exit on clean file");
  assert.match(out, /clean/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("path allowlist suppresses a rule", () => {
  const tmp = tmpProject({
    "content/ru/a.md": "Тире — здесь нормально.\n",
    "content/en/b.md": "This dash — should fail.\n",
    "slop-gate.config.json": JSON.stringify({
      include: ["**/*.md"],
      rules: ["punctuation"],
      allow: [{ paths: ["content/ru/**"], rules: ["em-dash"] }],
    }),
  });
  const { code, out } = run([], tmp);
  assert.strictEqual(code, 1);
  assert.match(out, /content\/en\/b\.md/);
  assert.doesNotMatch(out, /content\/ru\/a\.md/, "ru path should be allowlisted");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("a ./dir argument scans the files under it", () => {
  const tmp = tmpProject({
    "content/a.md": "We will delve into this.\n",
    "content/deep/b.md": "A robust plan.\n",
    "elsewhere/c.md": "Seamless everywhere.\n",
  });
  const { code, out } = run(["./content"], tmp);
  assert.strictEqual(code, 1, "expected findings under ./content");
  assert.match(out, /content\/a\.md/);
  assert.match(out, /content\/deep\/b\.md/, "should recurse into subdirectories");
  assert.doesNotMatch(out, /elsewhere\/c\.md/, "must not scan outside the directory");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("a bare dir argument scans the files under it", () => {
  const tmp = tmpProject({
    "content/a.md": "We will delve into this.\n",
    "content/skip.py": "delve = 1\n",
  });
  const { code, out } = run(["content"], tmp);
  assert.strictEqual(code, 1);
  assert.match(out, /content\/a\.md/);
  assert.doesNotMatch(out, /skip\.py/, "directory scan keeps the include file types");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("glob arguments still work", () => {
  const tmp = tmpProject({
    "content/a.md": "We will delve into this.\n",
    "content/b.txt": "A robust plan.\n",
  });
  const { code, out } = run(["content/**/*.md"], tmp);
  assert.strictEqual(code, 1);
  assert.match(out, /content\/a\.md/);
  assert.doesNotMatch(out, /content\/b\.txt/, "glob should only match .md");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("exits 2 when 0 files are scanned, so a misconfigured CI job cannot pass", () => {
  const tmp = tmpProject({ "notes.py": "delve = 1\n" });
  const { code, stderr } = run(["no-such-dir/**/*.md"], tmp);
  assert.strictEqual(code, 2, "an empty match must not look green");
  assert.match(stderr, /0 files scanned/i);
  const viaConfig = run([], tmp);
  assert.strictEqual(viaConfig.code, 2, "config include matching nothing also exits 2");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("--write-baseline freezes counts and --baseline passes at parity", () => {
  const tmp = tmpProject({
    "content/a.md": "We will delve into this robust plan.\n",
  });
  const w = run(["--write-baseline"], tmp);
  assert.strictEqual(w.code, 0);
  assert.match(w.out, /baseline written/);
  const baseline = JSON.parse(fs.readFileSync(path.join(tmp, ".slop-gate-baseline.json"), "utf8"));
  assert.deepStrictEqual(
    baseline.files["content/a.md"],
    { delve: 1, robust: 1 },
    "baseline should record per-file, per-rule counts",
  );
  const b = run(["--baseline"], tmp);
  assert.strictEqual(b.code, 0, "unchanged debt should pass the baseline");
  assert.match(b.out, /within the baseline/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("--baseline fails when a file's count grows", () => {
  const tmp = tmpProject({
    "content/a.md": "We will delve into this robust plan.\n",
  });
  run(["--write-baseline"], tmp);
  fs.appendFileSync(path.join(tmp, "content/a.md"), "A seamless addition.\n");
  const { code, out } = run(["--baseline"], tmp);
  assert.strictEqual(code, 1, "grown count must fail");
  assert.match(out, /content\/a\.md: 1 "seamless" tell, baseline allows 0/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("--baseline fails on a new file with findings", () => {
  const tmp = tmpProject({
    "content/a.md": "We will delve into this.\n",
  });
  run(["--write-baseline"], tmp);
  fs.writeFileSync(path.join(tmp, "content/new.md"), "A robust newcomer.\n");
  const { code, out } = run(["--baseline"], tmp);
  assert.strictEqual(code, 1, "new dirty file must fail");
  assert.match(out, /content\/new\.md: 1 tell in a file the baseline does not list/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("--baseline passes and reports improvement when a count shrinks", () => {
  const tmp = tmpProject({
    "content/a.md": "We will delve into this robust plan.\n",
  });
  run(["--write-baseline"], tmp);
  fs.writeFileSync(path.join(tmp, "content/a.md"), "We will delve into this plan.\n");
  const { code, out } = run(["--baseline"], tmp);
  assert.strictEqual(code, 0, "shrunk count should pass");
  assert.match(out, /1 file improved/);
  assert.match(out, /--write-baseline/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("--baseline without a baseline file exits 2 with a hint", () => {
  const tmp = tmpProject({ "content/a.md": "Plain.\n" });
  const { code, stderr } = run(["--baseline"], tmp);
  assert.strictEqual(code, 2);
  assert.match(stderr, /--write-baseline/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("fenced code blocks are skipped by default, scanned with --include-code", () => {
  const tmp = tmpProject({
    "doc.md": "# Doc\n\n```text\nan example: delve into a robust plan\n```\n\nPlain prose here.\n",
  });
  const clean = run(["doc.md"], tmp);
  assert.strictEqual(clean.code, 0, "tells inside a code fence should not count");
  const dirty = run(["doc.md", "--include-code"], tmp);
  assert.strictEqual(dirty.code, 1, "--include-code should scan the fence");
  assert.match(dirty.out, /delve/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("slop-gate-ignore-next skips the following line", () => {
  const tmp = tmpProject({
    "doc.md": "{/* slop-gate-ignore-next */}\nWe will delve into this.\nBut robust here still fails.\n",
  });
  const { code, out } = run(["doc.md"], tmp);
  assert.strictEqual(code, 1);
  assert.doesNotMatch(out, /delve/, "line after the marker should be skipped");
  assert.match(out, /robust/, "later lines are still scanned");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("walker prunes build output directories", () => {
  const tmp = tmpProject({
    "dist/a.md": "We will delve into this.\n",
    "build/b.md": "A robust plan.\n",
    ".next/c.md": "Seamless.\n",
    "docs/d.md": "We will delve into this.\n",
  });
  const { code, out } = run([], tmp);
  assert.strictEqual(code, 1);
  assert.match(out, /docs\/d\.md/);
  assert.doesNotMatch(out, /dist\//);
  assert.doesNotMatch(out, /build\//);
  assert.doesNotMatch(out, /\.next\//);
  fs.rmSync(tmp, { recursive: true, force: true });
});

require("./regressions.js")({ test, run, tmpProject });

console.log(`\n${passed} passed`);
