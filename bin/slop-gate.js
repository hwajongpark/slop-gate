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
  paths              Files or globs to scan. Overrides "include" in the config.

Options:
  -c, --config FILE  Path to a config file (default: ./slop-gate.config.json)
      --json         Emit findings as JSON instead of human-readable lines
  -v, --version      Print version and exit
  -h, --help         Print this help and exit

Examples:
  slop-gate ./content
  slop-gate "docs/**/*.md" --json
  slop-gate                       # uses slop-gate.config.json if present

Exit code: 0 when clean, 1 when any tell is found.
`;

function parseArgs(argv) {
  const opts = { paths: [], config: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "-v" || a === "--version") opts.version = true;
    else if (a === "--json") opts.json = true;
    else if (a === "-c" || a === "--config") opts.config = argv[++i];
    else if (a.startsWith("-")) {
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
      if (e.name === "node_modules" || e.name === ".git") continue;
      yield* walk(full);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

function collectFiles(config, cliPaths) {
  const includeGlobs = (cliPaths.length ? cliPaths : config.include).map(globToRegExp);
  const excludeGlobs = config.exclude.map(globToRegExp);
  // If the caller passed explicit existing files, take them as-is.
  const explicitFiles = cliPaths.filter(
    (p) => fs.existsSync(p) && fs.statSync(p).isFile(),
  );
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
// German or Russian directory while banning it everywhere else.
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

function scanFile(file, rules, allow) {
  const off = suppressedRules(file, allow);
  const active = rules.filter((r) => !off.has(r.id) && !off.has(r.pack));
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
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

  const config = loadConfig(opts.config);
  const rules = loadRules(config.rules);
  const files = collectFiles(config, opts.paths);

  const findings = [];
  for (const f of files) findings.push(...scanFile(f, rules, config.allow));
  findings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col,
  );

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
