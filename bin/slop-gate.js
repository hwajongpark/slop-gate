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
 * Exit codes: 0 clean (or within the baseline), 1 a tell was found, 2 usage,
 * config, or internal error, or no files were scanned. The non-zero exit is
 * the whole point: it turns a style rule you can skip into a check that runs
 * every time, locally or in CI.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const VERSION = require("../package.json").version;
const RULES_DIR = path.join(__dirname, "..", "rules");
const DEFAULT_BASELINE = ".slop-gate-baseline.json";
const BASELINE_VERSION = 2;

const DEFAULT_CONFIG = {
  include: ["**/*.md", "**/*.mdx", "**/*.txt"],
  exclude: ["node_modules/**", ".git/**"],
  rules: ["punctuation", "vocabulary"],
  rulePacks: [],
  allow: [],
};

const HELP = `slop-gate ${VERSION}
Catch AI writing-tells before they reach your readers.

Usage:
  slop-gate [paths...] [options]

Arguments:
  paths              Files, directories, or globs to scan. A directory scans
                     the config's include patterns under it. Paths override
                     "include" in the config. Globs support **, *, ?, and
                     braces ("**/*.{md,mdx}"). Quote globs so the shell does
                     not expand them.

Options:
  -c, --config FILE  Path to a config file (default: ./slop-gate.config.json)
      --json         Emit findings as JSON instead of human-readable lines
      --baseline [FILE]
                     Compare against a baseline file and fail only when a
                     rule's count in a file grows past its baselined count,
                     or a file the baseline does not list has tells.
                     (default: ${DEFAULT_BASELINE})
      --write-baseline [FILE]
                     Write the current per-file, per-rule tell counts as the
                     baseline. (default: ${DEFAULT_BASELINE})
      --include-code Also scan fenced code blocks and inline code spans
                     (skipped by default)
  -v, --version      Print version and exit
  -h, --help         Print this help and exit

Ignoring lines:
  Put "slop-gate-ignore" anywhere on a line to skip that line. Put
  <!-- slop-gate-ignore-next --> (or {/* slop-gate-ignore-next */} in MDX)
  alone on a line to skip the next non-blank line. If that next line opens a
  fenced code block, the marker covers the block instead.

Examples:
  slop-gate ./content
  slop-gate "docs/**/*.{md,mdx}" --json
  slop-gate --write-baseline      # freeze today's counts on an existing corpus
  slop-gate --baseline            # fail only when the debt grows
  slop-gate                       # uses slop-gate.config.json if present

Exit codes:
  0  clean, or within the baseline
  1  at least one tell was found (or the baseline was exceeded)
  2  usage, config, or internal error, or no files matched
`;

class SlopGateError extends Error {}

function fail(msg) {
  throw new SlopGateError(msg);
}

function plural(n, word, pluralWord) {
  return `${n} ${n === 1 ? word : pluralWord || word + "s"}`;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

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
    else if (a === "-c" || a === "--config") {
      const v = argv[i + 1];
      if (v === undefined || v === "" || v.startsWith("-")) {
        fail(`${a} needs a file path, e.g. ${a} slop-gate.config.json`);
      }
      opts.config = v;
      i++;
    } else if (a.startsWith("--config=")) {
      const v = a.slice("--config=".length);
      if (!v) fail("--config= needs a file path");
      opts.config = v;
    } else if (a.startsWith("--baseline=")) {
      const v = a.slice("--baseline=".length);
      if (!v) fail("--baseline= needs a file path");
      opts.baseline = v;
    } else if (a === "--baseline") {
      const v = optionalFileValue(argv, i);
      if (v) i++;
      opts.baseline = v || DEFAULT_BASELINE;
    } else if (a.startsWith("--write-baseline=")) {
      const v = a.slice("--write-baseline=".length);
      if (!v) fail("--write-baseline= needs a file path");
      opts.writeBaseline = v;
    } else if (a === "--write-baseline") {
      const v = optionalFileValue(argv, i);
      if (v) i++;
      opts.writeBaseline = v || DEFAULT_BASELINE;
    } else if (a.startsWith("-") && a !== "-") {
      fail(`unknown option ${a}`);
    } else opts.paths.push(a);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Globs
// ---------------------------------------------------------------------------

// Expand shell-style braces: "a.{md,mdx}" -> ["a.md", "a.mdx"]. Nested braces
// work; a brace group with no top-level comma is left literal.
function expandBraces(glob) {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" && depth > 0) {
      depth--;
      if (depth === 0) {
        const inner = glob.slice(start + 1, i);
        const parts = [];
        let d = 0;
        let last = 0;
        for (let j = 0; j < inner.length; j++) {
          if (inner[j] === "{") d++;
          else if (inner[j] === "}") d--;
          else if (inner[j] === "," && d === 0) {
            parts.push(inner.slice(last, j));
            last = j + 1;
          }
        }
        parts.push(inner.slice(last));
        if (parts.length < 2) continue; // "{x}" stays literal
        const pre = glob.slice(0, start);
        const post = glob.slice(i + 1);
        const out = [];
        for (const p of parts) out.push(...expandBraces(pre + p + post));
        return out;
      }
    }
  }
  return [glob];
}

// Translate a brace-free glob into an anchored RegExp. Supports ** (any
// depth), * (one path segment), and ? (one character). Compared POSIX-style.
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

// One glob (with braces) -> list of RegExps.
function globRegExps(glob) {
  return expandBraces(glob).map(globToRegExp);
}

function matchesAny(regexps, p) {
  return regexps.some((re) => re.test(p));
}

const GLOB_CHARS = /[*?[{]/;

// Split a brace-free glob into the static directory it starts in and the
// pattern below it: "../docs/**/*.md" -> { base: "../docs", rest: "**/*.md" }.
function splitGlobBase(glob) {
  const segs = glob.replace(/\\/g, "/").split("/");
  let i = 0;
  while (i < segs.length - 1 && !GLOB_CHARS.test(segs[i])) i++;
  const baseSegs = segs.slice(0, i);
  let base = baseSegs.join("/");
  if (baseSegs.length === 1 && baseSegs[0] === "") base = "/"; // "/x/**"
  if (/^[A-Za-z]:$/.test(base)) base += "/"; // "C:/**" on Windows
  return { base: base || ".", rest: segs.slice(i).join("/") };
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function displayPath(abs) {
  const rel = path.relative(process.cwd(), abs);
  return toPosix(rel || ".");
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const KNOWN_CONFIG_KEYS = new Set(["include", "exclude", "rules", "rulePacks", "allow"]);

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
}

function validateConfig(cfg, file) {
  if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) {
    fail(`${file}: config must be a JSON object`);
  }
  for (const key of ["include", "exclude", "rules", "rulePacks"]) {
    if (key in cfg && !isStringArray(cfg[key])) {
      fail(`${file}: "${key}" must be an array of non-empty strings`);
    }
  }
  if ("allow" in cfg) {
    if (!Array.isArray(cfg.allow)) fail(`${file}: "allow" must be an array`);
    cfg.allow.forEach((entry, i) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        fail(`${file}: allow[${i}] must be an object with "paths" and "rules"`);
      }
      if (!isStringArray(entry.paths)) {
        fail(`${file}: allow[${i}].paths must be an array of non-empty strings`);
      }
      if (!isStringArray(entry.rules)) {
        fail(`${file}: allow[${i}].rules must be an array of non-empty strings`);
      }
    });
  }
  for (const key of Object.keys(cfg)) {
    if (!KNOWN_CONFIG_KEYS.has(key) && !key.startsWith("$") && key !== "comment") {
      console.error(`slop-gate: warning: ${file}: unknown config key "${key}" ignored`);
    }
  }
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function loadConfig(explicitPath) {
  const file = explicitPath || path.join(process.cwd(), "slop-gate.config.json");
  if (!fs.existsSync(file)) {
    if (explicitPath) fail(`config not found: ${explicitPath}`);
    return { ...DEFAULT_CONFIG, dir: process.cwd() };
  }
  let parsed;
  try {
    parsed = JSON.parse(stripBom(fs.readFileSync(file, "utf8")));
  } catch (e) {
    fail(`could not parse ${file}: ${e.message}`);
  }
  validateConfig(parsed, file);
  return { ...DEFAULT_CONFIG, ...parsed, dir: path.dirname(path.resolve(file)) };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

// Compile one rule the way the scanner uses it: pattern NFC-normalized, pack
// flags applied unless the rule sets its own (an empty string counts), and
// "g" always on.
function compileRule(rule, pack, source) {
  if (!rule || typeof rule.id !== "string" || !rule.id) {
    fail(`${source}: every rule needs a string "id"`);
  }
  if (typeof rule.match !== "string" || !rule.match) {
    fail(`${source}: rule "${rule.id}" needs a string "match"`);
  }
  let flags = typeof rule.flags === "string" ? rule.flags : pack.flags || "";
  if (!flags.includes("g")) flags += "g";
  let re;
  try {
    re = new RegExp(rule.match.normalize("NFC"), flags);
  } catch (e) {
    fail(`${source}: rule "${rule.id}" has an invalid pattern: ${e.message}`);
  }
  return {
    id: rule.id,
    pack: pack.id,
    re,
    hint: typeof rule.hint === "string" ? rule.hint : "",
  };
}

function readPack(file, fallbackId) {
  let pack;
  try {
    pack = JSON.parse(stripBom(fs.readFileSync(file, "utf8")));
  } catch (e) {
    fail(`could not read rule pack ${file}: ${e.message}`);
  }
  if (!pack || typeof pack !== "object" || !Array.isArray(pack.rules)) {
    fail(`${file}: a rule pack must be an object with a "rules" array`);
  }
  if (pack.flags != null && typeof pack.flags !== "string") {
    fail(`${file}: "flags" must be a string`);
  }
  const id = typeof pack.id === "string" && pack.id ? pack.id : fallbackId;
  return { ...pack, id };
}

function compilePack(pack, source) {
  return pack.rules.map((rule) => compileRule(rule, pack, source));
}

// Built-in packs are named; custom packs are file paths resolved against the
// config file's directory.
function loadRules(packNames, customPacks, baseDir) {
  const rules = [];
  for (const name of packNames) {
    // Rule pack names index a file inside RULES_DIR. Reject anything that is not
    // a plain identifier so a config cannot path-traverse out (e.g. "../../x").
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      fail(`invalid rule pack name "${name}" (use "rulePacks" for a pack file path)`);
    }
    const file = path.join(RULES_DIR, `${name}.json`);
    if (!fs.existsSync(file)) fail(`no rule pack named "${name}" in ${RULES_DIR}`);
    rules.push(...compilePack(readPack(file, name), file));
  }
  for (const p of customPacks || []) {
    const file = path.resolve(baseDir || process.cwd(), p);
    if (!fs.existsSync(file)) fail(`rule pack file not found: ${p}`);
    rules.push(...compilePack(readPack(file, path.basename(file, ".json")), file));
  }
  return rules;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

// Directories that never hold prose worth scanning. Pruned at any depth BELOW
// a walk root; a root named explicitly (`slop-gate build`) is still scanned.
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build"]);

function realpathOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

// Yield [absPath, relFromRoot] for every file under root. Follows symlinked
// files and directories; a realpath set guards against cycles.
function* walk(root) {
  const seen = new Set();
  const rootReal = realpathOrNull(root);
  if (rootReal) seen.add(rootReal);
  function* inner(dir, rel) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const r = rel ? rel + "/" + e.name : e.name;
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue; // broken link
        }
        isDir = st.isDirectory();
        isFile = st.isFile();
      }
      if (isDir) {
        if (SKIP_DIRS.has(e.name)) continue;
        const real = realpathOrNull(full);
        if (!real || seen.has(real)) continue;
        seen.add(real);
        yield* inner(full, r);
      } else if (isFile) {
        yield [full, r];
      }
    }
  }
  yield* inner(root, "");
}

// Each "source" is a walk root plus the patterns (relative to that root) that
// select files under it. Returns the sorted display paths, plus the explicit
// CLI arguments that matched nothing.
function collectFiles(config, cliPaths) {
  const excludeRes = config.exclude.flatMap(globRegExps);
  const out = new Set();
  const sources = []; // { arg, base, patterns: RegExp[] }
  const hitsByArg = new Map();

  if (cliPaths.length) {
    for (const p of cliPaths) {
      let stat = null;
      try {
        stat = fs.statSync(p);
      } catch {
        /* not an existing path: treat it as a glob */
      }
      if (stat && stat.isFile()) {
        // A file named explicitly is scanned even if "exclude" would match it.
        out.add(displayPath(path.resolve(p)));
        hitsByArg.set(p, 1);
      } else if (stat && stat.isDirectory()) {
        // A directory scans the same file types the config includes, anywhere
        // under it. "./content", "content", "../x", and "/abs/x" all work.
        const patterns = config.include
          .flatMap(expandBraces)
          .map((g) => globToRegExp("**/" + g.replace(/\\/g, "/").split("/").pop()));
        sources.push({ arg: p, base: p, patterns });
      } else {
        for (const g of expandBraces(p)) {
          const { base, rest } = splitGlobBase(g);
          sources.push({ arg: p, base, patterns: [globToRegExp(rest)] });
        }
      }
    }
  } else {
    for (const inc of config.include) {
      for (const g of expandBraces(inc)) {
        const { base, rest } = splitGlobBase(g);
        sources.push({ arg: null, base: path.resolve(config.dir, base), patterns: [globToRegExp(rest)] });
      }
    }
  }

  for (const src of sources) {
    let hits = hitsByArg.get(src.arg) || 0;
    let st = null;
    try {
      st = fs.statSync(src.base);
    } catch {
      /* missing base: no files */
    }
    if (st && st.isDirectory()) {
      for (const [abs, rel] of walk(src.base)) {
        if (!matchesAny(src.patterns, rel)) continue;
        const display = displayPath(abs);
        if (matchesAny(excludeRes, display) || matchesAny(excludeRes, rel)) continue;
        out.add(display);
        hits++;
      }
    }
    hitsByArg.set(src.arg, hits);
  }
  const unmatched = cliPaths.filter((p) => !hitsByArg.get(p));
  return { files: [...out].sort(), unmatched };
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

// Rule ids that are allowlisted for a given file, summed over every allow
// entry whose path globs match. This is how you keep the em-dash legal in a
// Russian or Japanese directory while banning it everywhere else.
function suppressedRules(file, allow) {
  const off = new Set();
  for (const entry of allow) {
    const globs = (entry.paths || []).flatMap(globRegExps);
    if (matchesAny(globs, file)) {
      for (const id of entry.rules || []) off.add(id);
    }
  }
  return off;
}

// CommonMark fences: 0-3 spaces of indent, then 3+ backticks or tildes. A
// backtick fence's info string cannot contain a backtick (so ```x``` on one
// line is inline code, not a fence). A closing fence uses the same character,
// is at least as long as the opener, and has no info string.
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

function fenceOpen(line) {
  const m = line.match(FENCE_OPEN_RE);
  if (!m) return null;
  if (m[1][0] === "`" && m[2].includes("`")) return null;
  return { char: m[1][0], len: m[1].length };
}

function closesFence(line, fence) {
  const m = line.match(FENCE_CLOSE_RE);
  return !!m && m[1][0] === fence.char && m[1].length >= fence.len;
}

// The ignore-next marker counts only when it stands alone on its line (bare,
// or wrapped in an HTML or MDX comment), so prose that merely mentions the
// marker does not swallow the line after it.
const IGNORE_NEXT_RE =
  /^\s*(?:<!--\s*slop-gate-ignore-next\b.*?-->|\{\s*\/\*\s*slop-gate-ignore-next\b.*?\*\/\s*\}|slop-gate-ignore-next)\s*$/;

// URLs are never prose. Inline code spans are not prose either, unless
// --include-code. Both are blanked out (same length, so columns stay right).
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()"'`\]]+/gi;
const CODE_SPAN_RE = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g;

function blank(s) {
  return " ".repeat(s.length);
}

function maskLine(line, includeCode) {
  let out = line;
  if (!includeCode) out = out.replace(CODE_SPAN_RE, blank);
  out = out.replace(URL_RE, blank);
  return out;
}

// When two findings overlap and one span contains the other, keep the longer
// one ("in the realm of" wins over "realm").
function dedupeOverlaps(hits) {
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept = [];
  for (const h of hits) {
    if (!kept.some((k) => k.start <= h.start && h.end <= k.end)) kept.push(h);
  }
  return kept;
}

function scanText(file, text, rules, opts) {
  const lines = stripBom(text).split(/\r?\n|\r/);
  const findings = [];
  let fence = null; // the open fence while inside a fenced code block
  let skipNext = false; // a pending slop-gate-ignore-next marker
  let skipFence = false; // that marker landed on a fence: skip the whole block
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].normalize("NFC");

    if (fence !== null) {
      if (closesFence(line, fence)) {
        fence = null;
        skipFence = false;
        continue;
      }
      if (!opts.includeCode || skipFence) continue;
    } else {
      const open = fenceOpen(line);
      if (open) {
        fence = open;
        if (skipNext) {
          skipNext = false;
          skipFence = true;
        }
        continue;
      }
    }

    if (skipNext && line.trim() !== "") {
      skipNext = false;
      continue;
    }
    if (IGNORE_NEXT_RE.test(line)) {
      skipNext = true;
      continue;
    }
    if (line.includes("slop-gate-ignore")) continue;

    const scanned = maskLine(line, opts.includeCode);
    const hits = [];
    for (const rule of rules) {
      rule.re.lastIndex = 0;
      for (const m of scanned.matchAll(rule.re)) {
        if (m[0] === "") continue;
        const end = m.index + m[0].length;
        hits.push({ start: m.index, end, rule, text: line.slice(m.index, end) });
      }
    }
    for (const h of dedupeOverlaps(hits)) {
      findings.push({
        file,
        line: i + 1,
        col: h.start + 1,
        rule: h.rule.id,
        pack: h.rule.pack,
        text: h.text,
        hint: h.rule.hint,
      });
    }
  }
  return findings;
}

function scanFile(file, rules, allow, opts) {
  const off = suppressedRules(file, allow);
  const active = rules.filter((r) => !off.has(r.id) && !off.has(r.pack));
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    fail(`could not read ${file}: ${e.message}`);
  }
  return scanText(file, text, active, opts);
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

// { file: { ruleId: count } }
function perFileRuleCounts(findings) {
  const counts = {};
  for (const f of findings) {
    const byRule = (counts[f.file] = counts[f.file] || {});
    byRule[f.rule] = (byRule[f.rule] || 0) + 1;
  }
  return counts;
}

function sum(obj) {
  return Object.values(obj).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0);
}

function writeBaseline(file, findings, filesScanned) {
  const counts = perFileRuleCounts(findings);
  const sorted = {};
  for (const k of Object.keys(counts).sort()) {
    sorted[k] = {};
    for (const r of Object.keys(counts[k]).sort()) sorted[k][r] = counts[k][r];
  }
  const baseline = {
    comment:
      "slop-gate baseline: per-file, per-rule tell counts. A --baseline run " +
      "fails only when a rule's count in a file grows past its entry here, or " +
      "a file not listed here has tells. Regenerate after cleaning: " +
      "slop-gate --write-baseline",
    version: BASELINE_VERSION,
    generatedAt: new Date().toISOString().slice(0, 10),
    total: findings.length,
    files: sorted,
  };
  fs.writeFileSync(file, JSON.stringify(baseline, null, 2) + "\n");
  console.log(
    `slop-gate: baseline written to ${file} (${plural(findings.length, "tell")} across ${Object.keys(sorted).length} of ${plural(filesScanned, "scanned file")}).`,
  );
  return 0;
}

function runBaselineCheck(file, findings, asJson) {
  if (!fs.existsSync(file)) {
    fail(
      `baseline not found: ${file}. Create one first: slop-gate --write-baseline${file === DEFAULT_BASELINE ? "" : ` ${file}`}`,
    );
  }
  let baseline;
  try {
    baseline = JSON.parse(stripBom(fs.readFileSync(file, "utf8")));
  } catch (e) {
    fail(`could not parse baseline ${file}: ${e.message}`);
  }
  if (
    !baseline ||
    typeof baseline !== "object" ||
    (baseline.files != null && (typeof baseline.files !== "object" || Array.isArray(baseline.files)))
  ) {
    fail(`baseline ${file}: "files" must be an object`);
  }
  const allowed = baseline.files || {};
  const counts = perFileRuleCounts(findings);
  const violations = [];
  const improved = [];

  for (const [f, byRule] of Object.entries(counts)) {
    const cap = allowed[f];
    const total = sum(byRule);
    if (cap == null) {
      violations.push({ file: f, rule: null, count: total, allowed: 0, reason: "new" });
    } else if (typeof cap === "number") {
      // Version 1 baseline (0.5.x): one total per file.
      if (total > cap) violations.push({ file: f, rule: null, count: total, allowed: cap, reason: "grew" });
      else if (total < cap) improved.push(f);
    } else if (typeof cap === "object" && !Array.isArray(cap)) {
      for (const [rule, n] of Object.entries(byRule)) {
        const c = typeof cap[rule] === "number" ? cap[rule] : 0;
        if (n > c) violations.push({ file: f, rule, count: n, allowed: c, reason: "grew" });
      }
      if (Object.entries(cap).some(([rule, c]) => (byRule[rule] || 0) < c)) improved.push(f);
    } else {
      fail(`baseline ${file}: entry for "${f}" must be a number or an object of rule counts`);
    }
  }
  for (const [f, cap] of Object.entries(allowed)) {
    if (f in counts) continue;
    const n = typeof cap === "number" ? cap : cap && typeof cap === "object" ? sum(cap) : 0;
    if (n > 0) improved.push(f);
  }
  violations.sort((a, b) => a.file.localeCompare(b.file) || String(a.rule).localeCompare(String(b.rule)));
  improved.sort();

  const badKeys = new Set(violations.map((v) => (v.rule ? `${v.file}\0${v.rule}` : v.file)));
  const badFindings = findings.filter((x) => badKeys.has(x.file) || badKeys.has(`${x.file}\0${x.rule}`));

  if (asJson) {
    process.stdout.write(
      JSON.stringify({ baseline: file, violations, improved, findings: badFindings }, null, 2) + "\n",
    );
    return violations.length ? 1 : 0;
  }

  if (violations.length) {
    printFindings(badFindings);
    console.error("");
    for (const v of violations) {
      if (v.reason === "new") {
        console.error(
          `slop-gate: ${v.file}: ${plural(v.count, "tell")} in a file the baseline does not list. New files must be clean.`,
        );
      } else if (v.rule) {
        console.error(
          `slop-gate: ${v.file}: ${plural(v.count, `"${v.rule}" tell`)}, baseline allows ${v.allowed}. Fix the new ones.`,
        );
      } else {
        console.error(
          `slop-gate: ${v.file}: ${plural(v.count, "tell")}, baseline allows ${v.allowed}. Fix the new ones.`,
        );
      }
    }
    const badFileCount = new Set(violations.map((v) => v.file)).size;
    console.error(`slop-gate: ${plural(badFileCount, "file")} over the baseline (${file}).`);
    return 1;
  }

  const fileCount = Object.keys(counts).length;
  console.log(
    `slop-gate: ${plural(findings.length, "tell")} across ${plural(fileCount, "file")}, within the baseline (${file}).` +
      (improved.length
        ? ` ${plural(improved.length, "file")} improved: run --write-baseline to lock the lower counts in.`
        : ""),
  );
  return 0;
}

// ---------------------------------------------------------------------------
// Output and main
// ---------------------------------------------------------------------------

function printFindings(findings) {
  for (const h of findings) {
    console.log(`${h.file}:${h.line}:${h.col}  ${h.text}`);
    if (h.hint) console.log(`  ${h.rule}: ${h.hint}`);
  }
}

function run(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (opts.version) {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  if (opts.baseline && opts.writeBaseline) {
    fail("pass either --baseline or --write-baseline, not both.");
  }

  const config = loadConfig(opts.config);
  const rules = loadRules(config.rules, config.rulePacks, config.dir);
  const { files, unmatched } = collectFiles(config, opts.paths);

  if (files.length === 0 || unmatched.length) {
    for (const p of unmatched) console.error(`slop-gate: error: "${p}" matched no files.`);
    if (files.length === 0) {
      console.error(
        "slop-gate: error: 0 files scanned. Check your paths, globs, and the config's include patterns.",
      );
    }
    return 2;
  }

  const findings = [];
  for (const f of files) findings.push(...scanFile(f, rules, config.allow, opts));
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col);

  if (opts.writeBaseline) return writeBaseline(opts.writeBaseline, findings, files.length);
  if (opts.baseline) return runBaselineCheck(opts.baseline, findings, opts.json);

  if (opts.json) {
    process.stdout.write(JSON.stringify(findings, null, 2) + "\n");
    return findings.length ? 1 : 0;
  }

  if (findings.length === 0) {
    console.log(`slop-gate: clean (${plural(files.length, "file")} scanned).`);
    return 0;
  }

  printFindings(findings);
  const fileCount = new Set(findings.map((f) => f.file)).size;
  console.error("");
  console.error(
    `slop-gate: ${plural(findings.length, "tell")} in ${plural(fileCount, "file")}. Fix these before publishing.`,
  );
  return 1;
}

function main() {
  let code;
  try {
    code = run(process.argv.slice(2));
  } catch (e) {
    if (e instanceof SlopGateError) {
      console.error(`slop-gate: ${e.message}`);
    } else {
      console.error(`slop-gate: internal error: ${e && e.message ? e.message : e}`);
      if (process.env.SLOP_GATE_DEBUG) console.error(e && e.stack);
      else console.error("slop-gate: set SLOP_GATE_DEBUG=1 for a stack trace, and please report it.");
    }
    code = 2;
  }
  // exitCode (not process.exit) so piped stdout is flushed before exiting.
  process.exitCode = code;
}

if (require.main === module) main();

module.exports = {
  RULES_DIR,
  compileRule,
  readPack,
  loadRules,
  scanText,
  expandBraces,
  globToRegExp,
  splitGlobBase,
  maskLine,
};
