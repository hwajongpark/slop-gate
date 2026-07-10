#!/usr/bin/env node
/**
 * slop-gate
 *
 * Catch AI writing-tells before they reach your readers.
 *
 * Zero dependencies. Scans text files for two kinds of tell:
 *   - punctuation tells (the em-dash)
 *   - vocabulary tells  (the words and phrases that show up far more often
 *                        in AI-drafted text than in anything a person writes)
 *
 * Exit code: 0 if clean, 1 if any tell is found. The non-zero exit is the
 * whole point: it turns a style rule you can skip into a check that runs
 * every time, locally or in CI.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const VERSION = require("../package.json").version;
const RULES_DIR = path.join(__dirname, "..", "rules");
const DEFAULT_BASELINE = ".slop-gate-baseline.json";

const DEFAULT_CONFIG = {
  include: ["**/*.md", "**/*.mdx", "**/*.txt"],
  exclude: ["node_modules/**", ".git/**"],
  rules: ["punctuation", "vocabulary"],
  allow: [],
};

const HELP = `slop-gate ${VERSION}
Catch AI writing-tells before they reach your readers.

Usage:
  slop-gate [paths...] [options]

Arguments:
  paths              Files, directories, or globs to scan. A directory scans
                     the config's include patterns under it. Paths override
                     "include" in the config.

Options:
  -c, --config FILE  Path to a config file (default: ./slop-gate.config.json)
      --json         Emit findings as JSON instead of human-readable lines
      --baseline [FILE]
                     Compare against a baseline file and fail only when a
                     file's tell count grows past its baselined count, or a
                     file the baseline does not list has tells.
                     (default: ${DEFAULT_BASELINE})
      --write-baseline [FILE]
                     Write the current per-file tell counts as the baseline.
                     (default: ${DEFAULT_BASELINE})
      --include-code Also scan fenced code blocks (skipped by default)
  -v, --version      Print version and exit
  -h, --help         Print this help and exit

Ignoring lines:
  Put "slop-gate-ignore" anywhere on a line to skip that line, or
  "slop-gate-ignore-next" on the line above to skip the following line
  (usable inside {/* ... */} in MDX, where HTML comments are not valid).

Examples:
  slop-gate ./content
  slop-gate "docs/**/*.md" --json
  slop-gate --write-baseline      # freeze today's counts on an existing corpus
  slop-gate --baseline            # fail only when the debt grows
  slop-gate                       # uses slop-gate.config.json if present

Exit code: 0 when clean (or within the baseline), 1 when a tell is found,
2 on usage or config errors.
`;

// For flags that take an optional file value (--baseline, --write-baseline),
// consume the next argv token only when it clearly names a baseline file.
function optionalFileValue(argv, i) {
  const next = argv[i + 1];
  if (next && !next.startsWith("-") && next.toLowerCase().endsWith(".json")) {
    return next;
  }
  return null;
}

function parseArgs(argv) {
  const opts = {
    paths: [],
    config: null,
    json: false,
    includeCode: false,
    baseline: null,
    writeBaseline: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "-v" || a === "--version") opts.version = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--include-code") opts.includeCode = true;
    else if (a === "-c" || a === "--config") opts.config = argv[++i];
    else if (a.startsWith("--baseline=")) opts.baseline = a.slice("--baseline=".length);
    else if (a === "--baseline") {
      const v = optionalFileValue(argv, i);
      if (v) i++;
      opts.baseline = v || DEFAULT_BASELINE;
    } else if (a.startsWith("--write-baseline=")) {
      opts.writeBaseline = a.slice("--write-baseline=".length);
    } else if (a === "--write-baseline") {
      const v = optionalFileValue(argv, i);
      if (v) i++;
      opts.writeBaseline = v || DEFAULT_BASELINE;
    } else if (a.startsWith("-")) {
      console.error(`slop-gate: unknown option ${a}`);
      process.exit(2);
    } else opts.paths.push(a);
  }
  return opts;
}

// Translate a glob into an anchored RegExp. Supports ** (any depth), * (one
// path segment), and ? (one character). Paths are compared POSIX-style.
function globToRegExp(glob) {
  const g = glob.replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

function loadConfig(explicitPath) {
  const file = explicitPath || path.join(process.cwd(), "slop-gate.config.json");
  if (!fs.existsSync(file)) {
    if (explicitPath) {
      console.error(`slop-gate: config not found: ${explicitPath}`);
      process.exit(2);
    }
    return { ...DEFAULT_CONFIG };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`slop-gate: could not parse ${file}: ${e.message}`);
    process.exit(2);
  }
  return { ...DEFAULT_CONFIG, ...parsed };
}

// Load the named rule packs (built-in JSON files in rules/) and compile every
// rule into a global RegExp. Pack-level "flags" apply to all rules in the pack
// unless a rule sets its own.
function loadRules(packNames) {
  const rules = [];
  for (const name of packNames) {
    // Rule pack names index a file inside RULES_DIR. Reject anything that is not
    // a plain identifier so a config cannot path-traverse out (e.g. "../../x").
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      console.error(`slop-gate: invalid rule pack name "${name}"`);
      process.exit(2);
    }
    const file = path.join(RULES_DIR, `${name}.json`);
    if (!fs.existsSync(file)) {
      console.error(`slop-gate: no rule pack named "${name}" in ${RULES_DIR}`);
      process.exit(2);
    }
    const pack = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const rule of pack.rules) {
      let flags = rule.flags || pack.flags || "";
      if (!flags.includes("g")) flags += "g";
      rules.push({
        id: rule.id,
        pack: pack.id || name,
        re: new RegExp(rule.match, flags),
        hint: rule.hint || "",
      });
    }
  }
  return rules;
}

// Directories that never hold prose worth scanning. Skipped at any depth.
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build"]);

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(full);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

function collectFiles(config, cliPaths) {
  const explicitFiles = [];
  const globs = [];
  for (const p of cliPaths) {
    let stat = null;
    try {
      stat = fs.statSync(p);
    } catch {
      /* not an existing path: treat it as a glob */
    }
    if (stat && stat.isFile()) {
      explicitFiles.push(p);
      continue;
    }
    if (stat && stat.isDirectory()) {
      // A directory argument scans the same file types the config includes,
      // anywhere under that directory. "./content" and "content" both work.
      const rel = toPosix(path.relative(process.cwd(), path.resolve(p)));
      const prefix = rel === "" || rel === "." ? "" : rel + "/";
      for (const g of config.include) {
        globs.push(prefix + "**/" + g.split("/").pop());
      }
      continue;
    }
    globs.push(p);
  }
  const includeGlobs = (cliPaths.length ? globs : config.include).map(globToRegExp);
  const excludeGlobs = config.exclude.map(globToRegExp);
  const out = new Set(explicitFiles.map((p) => toPosix(path.relative(process.cwd(), p))));
  for (const abs of walk(process.cwd())) {
    const rel = toPosix(path.relative(process.cwd(), abs));
    if (excludeGlobs.some((re) => re.test(rel))) continue;
    if (includeGlobs.some((re) => re.test(rel))) out.add(rel);
  }
  return [...out].sort();
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

// Rule ids that are allowlisted for a given file, summed over every allow
// entry whose path globs match. This is how you keep the em-dash legal in a
// Russian or Japanese directory while banning it everywhere else.
function suppressedRules(file, allow) {
  const off = new Set();
  for (const entry of allow) {
    const globs = (entry.paths || []).map(globToRegExp);
    if (globs.some((re) => re.test(file))) {
      for (const id of entry.rules || []) off.add(id);
    }
  }
  return off;
}

// A fenced code block opens and closes on a line starting with three or more
// backticks or tildes, indented up to three spaces (per CommonMark).
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

function scanFile(file, rules, allow, opts) {
  const off = suppressedRules(file, allow);
  const active = rules.filter((r) => !off.has(r.id) && !off.has(r.pack));
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  const findings = [];
  let fence = null; // "`" or "~" while inside a fenced code block
  let skipNext = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!opts.includeCode) {
      const fm = line.match(FENCE_RE);
      if (fm) {
        const marker = fm[1][0];
        if (fence === null) {
          fence = marker;
          continue;
        }
        if (fence === marker) {
          fence = null;
          continue;
        }
        // A different fence marker inside an open block is code content.
      }
      if (fence !== null) continue;
    }
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (line.includes("slop-gate-ignore-next")) {
      skipNext = true;
      continue;
    }
    if (line.includes("slop-gate-ignore")) continue;
    for (const rule of active) {
      rule.re.lastIndex = 0;
      for (const m of line.matchAll(rule.re)) {
        findings.push({
          file,
          line: i + 1,
          col: m.index + 1,
          rule: rule.id,
          pack: rule.pack,
          text: m[0],
          hint: rule.hint,
        });
      }
    }
  }
  return findings;
}

function perFileCounts(findings) {
  const counts = {};
  for (const f of findings) counts[f.file] = (counts[f.file] || 0) + 1;
  return counts;
}

function writeBaseline(file, findings, filesScanned) {
  const counts = perFileCounts(findings);
  const sorted = {};
  for (const k of Object.keys(counts).sort()) sorted[k] = counts[k];
  const baseline = {
    comment:
      "slop-gate baseline: per-file tell counts. A --baseline run fails only " +
      "when a file's count grows past its entry here, or a file not listed " +
      "here has tells. Regenerate after cleaning: slop-gate --write-baseline",
    generatedAt: new Date().toISOString().slice(0, 10),
    total: findings.length,
    files: sorted,
  };
  fs.writeFileSync(file, JSON.stringify(baseline, null, 2) + "\n");
  console.log(
    `slop-gate: baseline written to ${file} (${findings.length} tell${findings.length === 1 ? "" : "s"} across ${Object.keys(sorted).length} of ${filesScanned} scanned files).`,
  );
  process.exit(0);
}

function runBaselineCheck(file, findings, asJson) {
  if (!fs.existsSync(file)) {
    console.error(
      `slop-gate: baseline not found: ${file}. Create one first: slop-gate --write-baseline${file === DEFAULT_BASELINE ? "" : ` ${file}`}`,
    );
    process.exit(2);
  }
  let baseline;
  try {
    baseline = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`slop-gate: could not parse baseline ${file}: ${e.message}`);
    process.exit(2);
  }
  const allowed = baseline.files || {};
  const counts = perFileCounts(findings);
  const violations = [];
  const improved = [];
  for (const [f, n] of Object.entries(counts)) {
    const cap = allowed[f];
    if (cap == null) violations.push({ file: f, count: n, allowed: 0, reason: "new" });
    else if (n > cap) violations.push({ file: f, count: n, allowed: cap, reason: "grew" });
    else if (n < cap) improved.push(f);
  }
  for (const f of Object.keys(allowed)) {
    if (!(f in counts) && allowed[f] > 0) improved.push(f);
  }
  violations.sort((a, b) => a.file.localeCompare(b.file));
  improved.sort();

  const badFiles = new Set(violations.map((v) => v.file));
  const badFindings = findings.filter((x) => badFiles.has(x.file));

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        { baseline: file, violations, improved, findings: badFindings },
        null,
        2,
      ) + "\n",
    );
    process.exit(violations.length ? 1 : 0);
  }

  if (violations.length) {
    for (const h of badFindings) {
      console.log(`${h.file}:${h.line}:${h.col}  ${h.text}`);
      if (h.hint) console.log(`  ${h.rule}: ${h.hint}`);
    }
    console.error("");
    for (const v of violations) {
      if (v.reason === "new") {
        console.error(
          `slop-gate: ${v.file}: ${v.count} tell${v.count === 1 ? "" : "s"} in a file the baseline does not list. New files must be clean.`,
        );
      } else {
        console.error(
          `slop-gate: ${v.file}: ${v.count} tell${v.count === 1 ? "" : "s"}, baseline allows ${v.allowed}. Fix the new ones.`,
        );
      }
    }
    console.error(
      `slop-gate: ${violations.length} file${violations.length === 1 ? "" : "s"} over the baseline (${file}).`,
    );
    process.exit(1);
  }

  const fileCount = Object.keys(counts).length;
  console.log(
    `slop-gate: ${findings.length} tell${findings.length === 1 ? "" : "s"} across ${fileCount} file${fileCount === 1 ? "" : "s"}, within the baseline (${file}).` +
      (improved.length
        ? ` ${improved.length} file${improved.length === 1 ? "" : "s"} improved: run --write-baseline to lock the lower counts in.`
        : ""),
  );
  process.exit(0);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (opts.version) {
    process.stdout.write(VERSION + "\n");
    process.exit(0);
  }
  if (opts.baseline && opts.writeBaseline) {
    console.error("slop-gate: pass either --baseline or --write-baseline, not both.");
    process.exit(2);
  }

  const config = loadConfig(opts.config);
  const rules = loadRules(config.rules);
  const files = collectFiles(config, opts.paths);

  if (files.length === 0) {
    console.error(
      "slop-gate: warning: 0 files scanned. Check your paths, globs, and the config's include patterns.",
    );
  }

  const findings = [];
  for (const f of files) findings.push(...scanFile(f, rules, config.allow, opts));
  findings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col,
  );

  if (opts.writeBaseline) writeBaseline(opts.writeBaseline, findings, files.length);
  if (opts.baseline) runBaselineCheck(opts.baseline, findings, opts.json);

  if (opts.json) {
    process.stdout.write(JSON.stringify(findings, null, 2) + "\n");
    process.exit(findings.length ? 1 : 0);
  }

  if (findings.length === 0) {
    console.log(`slop-gate: clean (${files.length} files scanned).`);
    process.exit(0);
  }

  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  for (const [file, hits] of byFile) {
    for (const h of hits) {
      console.log(`${file}:${h.line}:${h.col}  ${h.text}`);
      if (h.hint) console.log(`  ${h.rule}: ${h.hint}`);
    }
  }

  const fileCount = byFile.size;
  console.error("");
  console.error(
    `slop-gate: ${findings.length} tell${findings.length === 1 ? "" : "s"} in ${fileCount} file${fileCount === 1 ? "" : "s"}. Fix these before publishing.`,
  );
  process.exit(1);
}

main();
