# Changelog

## 0.6.1

### Fixes

- **`exclude` and `allow` resolve against the config file's folder.** With `-c site/slop-gate.config.json` run from another folder, `include` already resolved against the config's folder, but `exclude` and `allow` were matched against paths relative to the current folder, so excluded files were scanned and allowlisted rules still fired. Both now also match the config-relative path.
- **`--baseline` on a few paths** no longer reports every other baselined file as "improved". Only files the run scanned count.
- **Piping into a reader that closes early** (`slop-gate . | head`) exits quietly with the run's exit code instead of printing a Node EPIPE stack trace.
- A config path that points at a folder exits 2 with a plain message.

### Warnings (stderr only; exit codes unchanged)

- A code fence that is never closed names the file and line, because everything after it is skipped as code.
- An `allow` entry that names a rule or pack id no loaded pack has (a typo like `emdash`) is reported.

### Project

- CI runs on Node 18, 22, 24, and 26 with `actions/checkout@v7` and `actions/setup-node@v7`. Node 20 is end of life. The README's CI snippet uses Node 24.
- README: the first example has nine tells, not eight.

## 0.6.0

### Breaking

- **Exit code 2 when nothing is scanned.** A run that scans 0 files now exits 2 instead of 0, and so does any path or glob on the command line that matches no files. A misconfigured CI job can no longer pass by scanning nothing.
- **Baselines count tells per rule.** `--write-baseline` now records `{ "file": { "rule-id": count } }` (`"version": 2`), so swapping one tell for another in the same file fails `--baseline`. Baselines written by 0.5.x (one total per file) are still read and compared by total; re-run `--write-baseline` to upgrade.
- **`slop-gate-ignore-next` must stand alone on its line** (bare, or inside `<!-- -->` or `{/* */}`), so prose that only mentions the marker no longer swallows the next line. It now skips the next non-blank line; if that line opens a fenced code block, the marker covers the block and never leaks past it.

### File discovery

- Brace globs: `"**/*.{md,mdx}"`.
- Directory and glob arguments are walked from their own root, so `../docs`, `/abs/path`, and `../docs/**/*.md` work.
- A directory named explicitly (`slop-gate build`) is scanned even if it is in the skip list; the skip list applies only beneath it.
- Symlinked files and directories are followed, with a realpath guard against cycles.

### Scanning

- Fences follow CommonMark: `~~~` fences, up to 3 spaces of indent, a backtick fence's info string cannot contain backticks (so ` ```inline``` ` is not a fence), and a closing fence must use the same character, be at least as long as the opener, and have no info string.
- URLs (`http://`, `https://`, `www.`) are never flagged. Inline code spans are skipped unless `--include-code`.
- Lines and rule patterns are normalized to NFC before matching, so decomposed Vietnamese (and other) text matches.
- CRLF and lone CR line endings are handled; a UTF-8 BOM is ignored.
- When one match contains another (`in the realm of` and `realm`), only the longer one is reported.

### Rules

- `vocabulary`: matches inflections (`delves`, `delved`, `delving`, `leveraged`, `realms`, `elevating`, `tapestries`, and others). New rules: `intricate`, `showcase`.
- `russian`: Unicode-aware word boundaries, so `появляется`, `выданный`, and `созданный` no longer match; `в соответствии со` and more `осуществить` forms are covered.
- `vietnamese`: word boundaries (`do đóng góp` no longer matches `do đó`).
- `korean`: `에 따라서` ("according to") and `을/를 따라서` ("along") are no longer flagged; `그녀석` no longer matches `그녀`.
- `chinese`: `自然而然` no longer matches `然而`.
- `filipino`: `sa kaso(ng)` needs a word boundary (`sa kasosyo` is clean), and `po` is case-sensitive (`PO Box` is clean). A rule's own `"flags": ""` now overrides the pack flags.

### Config and errors

- New `rulePacks` option: paths to your own pack files, loaded in addition to the built-in `rules`. Paths resolve against the config file's directory.
- The config shape is validated (`include`, `exclude`, `rules`, `rulePacks` must be arrays of strings; `allow` entries need `paths` and `rules` arrays). Unknown keys print a warning.
- `-c` / `--config` without a value is a usage error.
- Invalid rule patterns, unreadable files, and internal errors exit 2 with a one-line message instead of a stack trace (set `SLOP_GATE_DEBUG=1` for the trace).
- "1 file scanned" is no longer "1 files scanned".

### Project

- `bugs` and `homepage` in package.json.
- CI runs on Ubuntu and Windows with Node 18, 20, and 22, on pushes to main and on pull requests, with read-only permissions.
