"use strict";

// Regression tests for the 0.6.0 review fixes. Each block names the issue it
// pins down. Loaded by test/run.js, which owns the runner and helpers.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const lib = require("../bin/slop-gate.js");

function packFiles() {
  return fs
    .readdirSync(lib.RULES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(lib.RULES_DIR, f));
}

function rulesFor(...packs) {
  return lib.loadRules(packs, [], process.cwd());
}

function scan(text, packs, opts = {}) {
  return lib.scanText("t.md", text, rulesFor(...packs), opts);
}

function ids(findings) {
  return findings.map((f) => f.rule);
}

function trySymlink(target, link, type) {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch {
    return false; // e.g. Windows without symlink privilege
  }
}

// One positive sample per rule. Every rule must have one, so a boundary or
// pattern change that breaks a legitimate match fails here.
const POSITIVE = {
  "em-dash": "a — b",
  delve: "We delved into it.",
  leverage: "Leveraging data.",
  "navigate-complexities": "navigating the complexities of tax",
  "fast-paced-world": "In today's fast-paced world we ship.",
  "comprehensive-guide": "the ultimate guides",
  robust: "a robust plan",
  seamless: "seamlessly done",
  transformative: "a transformative year",
  "cutting-edge": "cutting-edge tools",
  elevate: "elevating the work",
  empower: "empowers teams",
  unlock: "unlocking value",
  harness: "harnessing power",
  streamline: "streamlines it",
  proactive: "proactively",
  "worth-noting": "It's worth noting that",
  "feel-free": "Feel free to ask",
  "end-of-the-day": "At the end of the day",
  "in-conclusion": "In conclusion, yes",
  "dive-in": "Let's dive in",
  tapestry: "rich tapestries",
  testament: "a testament to grit",
  "in-the-realm": "in the realm of law",
  realm: "new realms",
  "when-it-comes-to": "when it comes to tax",
  "game-changer": "real game-changers",
  "top-notch": "top-notch",
  bustling: "a bustling street",
  nestled: "nestled in hills",
  "treasure-trove": "treasure troves",
  embark: "embarked on a trip",
  foster: "fosters a sense of calm",
  meticulous: "meticulously",
  underscore: "underscoring the importance",
  moreover: "Moreover, this",
  furthermore: "Furthermore, this",
  crucial: "crucial step",
  pivotal: "a pivotal year",
  intricate: "intricate details",
  showcase: "showcasing work",
  vibrant: "a vibrant market",
  "ko-ui-gyeongu": "외국인의 경우 신청해요.",
  "ko-ttaraseo": "따라서 미리 준비해요.",
  "ko-ttohan": "또한 필요해요.",
  "ko-e-isseoseo": "일에 있어서 중요해요.",
  "ko-tonghae": "신청서를 통해 제출해요.",
  "ko-hameurosseo": "제출함으로써 끝나요.",
  "ko-e-gwanhayeo": "비자에 관하여",
  "ko-hameul-al-su": "필요함을 알 수 있다",
  "ko-georeuro-boinda": "오를 것으로 보인다",
  "ko-rago-hal-su": "중요하다라고 할 수 있다",
  "ko-mechanical-list": "첫째, 신청해요.",
  "ko-doeeojida": "처리되어진 서류",
  "ko-e-uihae": "법에 의해 정해져요.",
  "ko-e-daehayeo": "비자에 대하여",
  "ko-robuteo-date": "그날로부터 30일",
  "ko-geunyeo": "그녀는 학생이에요.",
  "ru-yavlyaetsya": "Он является студентом.",
  "ru-osushchestvit": "Для осуществления оплаты.",
  "ru-proizvesti": "произвести оплату",
  "ru-v-tselyakh": "В целях безопасности.",
  "ru-v-sluchae-vozn": "в случае возникновения проблем",
  "ru-sleduet-otmetit": "Следует отметить, что",
  "ru-nadlezhashchim": "надлежащим образом",
  "ru-v-sootvetstvii": "в соответствии со статьёй",
  "ru-bylo-prinyato": "было принято решение",
  "ru-dannyj": "данный документ",
  "vi-thuc-hien": "Thực hiện thủ tục.",
  "vi-tien-hanh": "tiến hành đăng ký",
  "vi-luu-cu-tru": "thẻ cư trú",
  "vi-trong-truong-hop": "trong trường hợp này",
  "vi-doi-voi": "Đối với người nước ngoài",
  "vi-tuy-nhien": "Tuy nhiên, bạn",
  "vi-do-do": "do đó bạn cần",
  "vi-bai-viet-nay": "Bài viết này sẽ giải thích",
  "vi-theo-quy-dinh": "theo quy định hiện hành",
  "vi-dam-bao-rang": "đảm bảo rằng bạn",
  "zh-jinxing": "进行审核",
  "zh-yuyi": "予以退回",
  "zh-anzhao-guiding": "按照规定办理",
  "zh-empty-opener": "众所周知，",
  "zh-raner": "然而，你需要",
  "zh-duiyu-front": "对于外国人",
  "zh-xiangguan": "相关部门",
  "fil-upang": "upang makapag-apply",
  "fil-sa-pamamagitan": "sa pamamagitan ng app",
  "fil-hinggil-sa": "hinggil sa visa",
  "fil-samakatuwid": "Samakatuwid, mag-apply",
  "fil-pamahalaan": "ang pamahalaan",
  "fil-ito-ay-gabay": "Ito ay isang gabay",
  "fil-nais-naming": "Nais naming ipaalam",
  "fil-sa-kaso": "sa kaso ng visa",
  "fil-po": "Salamat po.",
};

module.exports = function register({ test, run, tmpProject }) {
  // ---- Rule packs ---------------------------------------------------------

  test("every pattern in every pack compiles with the CLI's flags", () => {
    const seen = new Set();
    let count = 0;
    for (const file of packFiles()) {
      const pack = lib.readPack(file, path.basename(file, ".json"));
      for (const rule of pack.rules) {
        const compiled = lib.compileRule(rule, pack, file);
        assert.ok(compiled.re.flags.includes("g"), `${rule.id} is global`);
        assert.ok(!compiled.re.test(""), `${rule.id} must not match the empty string`);
        assert.ok(!seen.has(rule.id), `duplicate rule id ${rule.id}`);
        seen.add(rule.id);
        count++;
      }
    }
    assert.ok(count > 50, "expected every pack to load");
  });

  test("every rule matches its positive sample", () => {
    for (const file of packFiles()) {
      const pack = lib.readPack(file, path.basename(file, ".json"));
      for (const rule of pack.rules) {
        const sample = POSITIVE[rule.id];
        assert.ok(sample, `add a positive sample for ${rule.id} in test/regressions.js`);
        const re = lib.compileRule(rule, pack, file).re;
        re.lastIndex = 0;
        assert.ok(re.test(sample.normalize("NFC")), `${rule.id} should match "${sample}"`);
      }
    }
  });

  test("vocabulary matches inflections", () => {
    const got = ids(scan("delves delved delving leveraged leverages realms elevating", ["vocabulary"]));
    assert.deepStrictEqual(got, ["delve", "delve", "delve", "leverage", "leverage", "realm", "elevate"]);
  });

  test("'in the realm of' is reported once, by the more specific rule", () => {
    const got = scan("Work in the realm of ideas.", ["vocabulary"]);
    assert.deepStrictEqual(ids(got), ["in-the-realm"]);
  });

  test("URLs and inline code are not flagged; --include-code scans code spans", () => {
    const text = "See https://example.com/delve-robust and www.x.com/seamless and `leverage` here.";
    assert.deepStrictEqual(scan(text, ["vocabulary"]), []);
    assert.deepStrictEqual(ids(scan(text, ["vocabulary"], { includeCode: true })), ["leverage"]);
    const cols = scan("`code` then delve", ["vocabulary"]);
    assert.strictEqual(cols[0].col, 13, "masking keeps columns");
  });

  test("russian: no substring hits inside other words", () => {
    const text = "Это появляется. Выданный документ. Созданный файл. Это данные.";
    assert.deepStrictEqual(scan(text, ["russian"]), []);
    assert.deepStrictEqual(ids(scan("Документ является данным? Нет, данный.", ["russian"])), [
      "ru-yavlyaetsya",
      "ru-dannyj",
    ]);
  });

  test("korean: 에 따라서 (according to) is not flagged", () => {
    assert.deepStrictEqual(scan("법에 따라서 처리해요. 길을 따라서 걸어요. 뒤따라서 왔어요.", ["korean"]), []);
    assert.deepStrictEqual(ids(scan("따라서 미리 준비해요.", ["korean"])), ["ko-ttaraseo"]);
  });

  test("filipino: 'sa kasosyo' and 'PO Box' are not flagged", () => {
    assert.deepStrictEqual(scan("Kausap ko sa kasosyo. Send to PO Box 12.", ["filipino"]), []);
    assert.deepStrictEqual(ids(scan("sa kasong ito, salamat po", ["filipino"])), ["fil-sa-kaso", "fil-po"]);
  });

  test("vietnamese and chinese: no hits inside longer words", () => {
    assert.deepStrictEqual(scan("Cảm ơn sự do đóng góp.", ["vietnamese"]), []);
    assert.deepStrictEqual(scan("这是自然而然的。", ["chinese"]), []);
  });

  test("lines and patterns are NFC-normalized before matching", () => {
    const nfd = "Thực hiện".normalize("NFD");
    assert.notStrictEqual(nfd, "Thực hiện");
    assert.deepStrictEqual(ids(scan(nfd, ["vietnamese"])), ["vi-thuc-hien"]);
    const rule = lib.compileRule({ id: "x", match: "café".normalize("NFD") }, { id: "p" }, "inline");
    rule.re.lastIndex = 0;
    assert.ok(rule.re.test("café".normalize("NFC")), "an NFD pattern matches NFC text");
  });

  test("custom rule packs load from the config's rulePacks", () => {
    const tmp = tmpProject({
      "doc.md": "Our synergy is plain.\n",
      "packs/house.json": JSON.stringify({
        id: "house",
        flags: "i",
        rules: [{ id: "synergy", match: "\\bsynergy\\b", hint: "Say what works together." }],
      }),
      "slop-gate.config.json": JSON.stringify({ rules: ["punctuation"], rulePacks: ["./packs/house.json"] }),
    });
    const { code, out } = run(["doc.md"], tmp);
    assert.strictEqual(code, 1);
    assert.match(out, /synergy: Say what works together/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ---- A. File discovery --------------------------------------------------

  test("an explicit path that matches nothing exits 2, even if others match", () => {
    const tmp = tmpProject({ "docs/a.md": "Plain.\n" });
    const { code, stderr } = run(["docs", "typo-dir"], tmp);
    assert.strictEqual(code, 2);
    assert.match(stderr, /"typo-dir" matched no files/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("brace globs expand", () => {
    const tmp = tmpProject({
      "docs/a.md": "We delve.\n",
      "docs/deep/b.mdx": "A robust plan.\n",
      "docs/c.txt": "Seamless.\n",
    });
    const { code, out } = run(["docs/**/*.{md,mdx}"], tmp);
    assert.strictEqual(code, 1);
    assert.match(out, /docs\/a\.md/);
    assert.match(out, /docs\/deep\/b\.mdx/);
    assert.doesNotMatch(out, /c\.txt/);
    assert.deepStrictEqual(lib.expandBraces("a/{b,c{d,e}}.md"), ["a/b.md", "a/cd.md", "a/ce.md"]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("directory and glob arguments outside cwd (../ and absolute) are walked", () => {
    const tmp = tmpProject({ "work/plain.md": "Plain.\n", "other/c.md": "We delve.\n" });
    const cwd = path.join(tmp, "work");
    const rel = run(["../other"], cwd);
    assert.strictEqual(rel.code, 1);
    assert.match(rel.out, /\.\.\/other\/c\.md/);
    const abs = run([path.join(tmp, "other")], cwd);
    assert.strictEqual(abs.code, 1);
    assert.match(abs.out, /other\/c\.md/);
    const glob = run(["../other/**/*.md"], cwd);
    assert.strictEqual(glob.code, 1);
    assert.match(glob.out, /\.\.\/other\/c\.md/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("a directory named explicitly is scanned even if it is in SKIP_DIRS", () => {
    const tmp = tmpProject({ "build/x.md": "We delve.\n", "build/dist/y.md": "Robust.\n" });
    const { code, out } = run(["build"], tmp);
    assert.strictEqual(code, 1);
    assert.match(out, /build\/x\.md/);
    assert.doesNotMatch(out, /build\/dist\/y\.md/, "skip dirs still apply beneath the root");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("'1 file scanned' is singular", () => {
    const tmp = tmpProject({ "a.md": "Plain.\n" });
    assert.match(run(["a.md"], tmp).out, /clean \(1 file scanned\)/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ---- B. Symlinks --------------------------------------------------------

  test("symlinked files and directories are followed, cycles terminate", () => {
    const tmp = tmpProject({ "real/r.md": "We delve.\n", "outside/o.md": "A robust plan.\n", "docs/d.md": "Plain.\n" });
    const okDir = trySymlink(path.join(tmp, "real"), path.join(tmp, "docs", "linked"), "dir");
    const okFile = trySymlink(path.join(tmp, "outside", "o.md"), path.join(tmp, "docs", "file.md"), "file");
    const okLoop = trySymlink(tmp, path.join(tmp, "real", "loop"), "dir");
    if (!okDir || !okFile || !okLoop) {
      console.log("  (skipped: cannot create symlinks here)");
      fs.rmSync(tmp, { recursive: true, force: true });
      return;
    }
    const { code, out } = run(["docs"], tmp);
    assert.strictEqual(code, 1);
    assert.match(out, /docs\/linked\/r\.md/);
    assert.match(out, /docs\/file\.md/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ---- C. Fences ----------------------------------------------------------

  test("```inline``` on one line is not a fence", () => {
    const got = scan("```inline``` text\nWe delve here.\n", ["vocabulary"]);
    assert.deepStrictEqual(ids(got), ["delve"]);
  });

  test("a shorter fence or one with an info string does not close the block", () => {
    const text = ["````md", "```", "robust", "``` js", "delve", "````", "seamless"].join("\n");
    assert.deepStrictEqual(ids(scan(text, ["vocabulary"])), ["seamless"]);
  });

  test("tilde fences are honored and a backtick line does not close them", () => {
    const text = ["~~~", "```", "robust", "~~~", "delve"].join("\n");
    assert.deepStrictEqual(ids(scan(text, ["vocabulary"])), ["delve"]);
  });

  test("fences allow up to 3 spaces of indent; 4 is not a fence", () => {
    assert.deepStrictEqual(scan("   ```\nrobust\n   ```\n", ["vocabulary"]), []);
    assert.deepStrictEqual(ids(scan("    ```\nrobust\n", ["vocabulary"])), ["robust"]);
  });

  test("CRLF line endings are handled", () => {
    const got = scan("```\r\nrobust\r\n```\r\nWe delve.\r\n", ["vocabulary"]);
    assert.deepStrictEqual(ids(got), ["delve"]);
    assert.strictEqual(got[0].line, 4);
    assert.strictEqual(got[0].text, "delve");
  });

  // ---- D. ignore-next -----------------------------------------------------

  test("ignore-next before a fence does not swallow the line after the block", () => {
    const text = ["<!-- slop-gate-ignore-next -->", "```", "robust", "```", "We delve."].join("\n");
    assert.deepStrictEqual(ids(scan(text, ["vocabulary"])), ["delve"]);
    assert.deepStrictEqual(
      ids(scan(text, ["vocabulary"], { includeCode: true })),
      ["delve"],
      "with --include-code the marker covers the whole block",
    );
  });

  test("ignore-next skips blank lines to reach the next prose line", () => {
    const text = ["{/* slop-gate-ignore-next */}", "", "We delve.", "A robust plan."].join("\n");
    assert.deepStrictEqual(ids(scan(text, ["vocabulary"])), ["robust"]);
  });

  test("prose that only mentions the ignore-next marker does not skip the next line", () => {
    const text = ["Use slop-gate-ignore-next above a line.", "We delve."].join("\n");
    assert.deepStrictEqual(ids(scan(text, ["vocabulary"])), ["delve"]);
  });

  // ---- F. Config validation and errors -------------------------------------

  test("malformed config shapes exit 2 with a clear message, no stack trace", () => {
    const cases = [
      [{ include: "**/*.md" }, /"include" must be an array/],
      [{ rules: "vocabulary" }, /"rules" must be an array/],
      [{ allow: [{ paths: "x/**", rules: ["em-dash"] }] }, /allow\[0\]\.paths/],
      [{ allow: {} }, /"allow" must be an array/],
      [["**/*.md"], /must be a JSON object/],
      [{ rulePacks: [42] }, /"rulePacks" must be an array/],
    ];
    for (const [cfg, msg] of cases) {
      const tmp = tmpProject({ "a.md": "Plain.\n", "c.json": JSON.stringify(cfg) });
      const { code, stderr } = run(["-c", "c.json"], tmp);
      assert.strictEqual(code, 2, JSON.stringify(cfg));
      assert.match(stderr, msg);
      assert.doesNotMatch(stderr, /\n\s+at /, "no stack trace");
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("-c without a value is a usage error", () => {
    const tmp = tmpProject({ "a.md": "Plain.\n" });
    for (const args of [["-c"], ["--config"], ["-c", "--json"]]) {
      const { code, stderr } = run(args, tmp);
      assert.strictEqual(code, 2, args.join(" "));
      assert.match(stderr, /needs a file path/);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("an invalid pattern in a custom pack exits 2 naming the rule", () => {
    const tmp = tmpProject({
      "a.md": "Plain.\n",
      "bad.json": JSON.stringify({ rules: [{ id: "broken", match: "(unclosed" }] }),
      "slop-gate.config.json": JSON.stringify({ rulePacks: ["bad.json"] }),
    });
    const { code, stderr } = run(["a.md"], tmp);
    assert.strictEqual(code, 2);
    assert.match(stderr, /rule "broken" has an invalid pattern/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("an unknown config key warns but still runs", () => {
    const tmp = tmpProject({ "a.md": "Plain.\n", "slop-gate.config.json": JSON.stringify({ exlude: [] }) });
    const { code, stderr } = run(["a.md"], tmp);
    assert.strictEqual(code, 0);
    assert.match(stderr, /unknown config key "exlude"/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ---- G. Baseline by rule ------------------------------------------------

  test("--baseline fails when one tell is swapped for another", () => {
    const tmp = tmpProject({ "content/a.md": "We will delve into this.\n" });
    run(["--write-baseline"], tmp);
    fs.writeFileSync(path.join(tmp, "content/a.md"), "A robust plan.\n");
    const { code, out } = run(["--baseline"], tmp);
    assert.strictEqual(code, 1, "same total, different rule, must fail");
    assert.match(out, /1 "robust" tell, baseline allows 0/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("--baseline still reads the 0.5.x per-file-total format", () => {
    const tmp = tmpProject({
      "content/a.md": "We will delve into this robust plan.\n",
      ".slop-gate-baseline.json": JSON.stringify({ files: { "content/a.md": 2 } }),
    });
    assert.strictEqual(run(["--baseline"], tmp).code, 0);
    fs.appendFileSync(path.join(tmp, "content/a.md"), "Seamless.\n");
    const grown = run(["--baseline"], tmp);
    assert.strictEqual(grown.code, 1);
    assert.match(grown.out, /3 tells, baseline allows 2/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
};
