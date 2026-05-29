"use strict";

// Zero-dependency smoke test. Runs the CLI as a child process and checks the
// behavior that matters: it finds the seeded tells, it exits non-zero when it
// does, it exits zero on clean text, and the path allowlist suppresses a rule.

const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "bin", "slop-gate.js");
const REPO = path.join(__dirname, "..");

function run(args, cwd) {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      cwd: cwd || REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: (e.stdout || "") + (e.stderr || "") };
  }
}

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

test("flags seeded tells in the sample and exits 1", () => {
  const { code, stdout } = run(["examples/sample.md"]);
  assert.strictEqual(code, 1, "expected non-zero exit on dirty file");
  assert.match(stdout, /em-dash/);
  assert.match(stdout, /delve/);
  assert.match(stdout, /11 tells in 1 file/);
});

test("exits 0 on clean text", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-gate-"));
  fs.writeFileSync(path.join(tmp, "clean.md"), "This sentence is plain and direct.\n");
  const { code, stdout } = run(["clean.md"], tmp);
  assert.strictEqual(code, 0, "expected zero exit on clean file");
  assert.match(stdout, /clean/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("path allowlist suppresses a rule", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slop-gate-"));
  fs.mkdirSync(path.join(tmp, "content", "ru"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "content", "en"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "content", "ru", "a.md"), "Тире — здесь нормально.\n");
  fs.writeFileSync(path.join(tmp, "content", "en", "b.md"), "This dash — should fail.\n");
  fs.writeFileSync(
    path.join(tmp, "slop-gate.config.json"),
    JSON.stringify({
      include: ["**/*.md"],
      rules: ["punctuation"],
      allow: [{ paths: ["content/ru/**"], rules: ["em-dash"] }],
    }),
  );
  const { code, stdout } = run([], tmp);
  assert.strictEqual(code, 1);
  assert.match(stdout, /content\/en\/b\.md/);
  assert.doesNotMatch(stdout, /content\/ru\/a\.md/, "ru path should be allowlisted");
  fs.rmSync(tmp, { recursive: true, force: true });
});

console.log(`\n${passed} passed`);
