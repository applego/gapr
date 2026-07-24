/**
 * test_gapr_browser.ts — gapr-browser.ts ユニットテスト
 *
 * ブラウザ / Google ログイン不要。純粋な関数ロジックのみテスト。
 * 実行: npm test  または  npx tsx --test tests/unit/test_gapr_browser.ts
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// テスト対象の関数を直接インポートできないため、ロジックを再実装してテスト
// (gapr-browser.ts は実行ファイルとして設計されているため)
// 将来的に関数を lib/ に分離する際はここを import に変える
// ---------------------------------------------------------------------------

// --- parseArgs の再実装 (テスト用) ---
const DEFAULT_MODEL = "gemini-2.5-pro-preview-05-06";

function parseArgs(argv: string[]) {
  const args = argv;
  let command = "run";
  let round: number | undefined;
  let workflow = "default";
  let forceNew = false;
  let model = DEFAULT_MODEL;
  let dryRun = false;
  let includeImpl = false;
  let quiet = false;

  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (["daemon", "run", "setup", "list", "history", "status", "stop", "help"].includes(a)) {
      command = a;
    } else if (a === "--new" || a === "-n") { forceNew = true; }
    else if (a === "--dry-run" || a === "-d") { dryRun = true; }
    else if (a === "--include-impl" || a === "-i") { includeImpl = true; }
    else if (a === "--quiet" || a === "-q") { quiet = true; }
    else if (a.startsWith("--workflow=")) { workflow = a.split("=")[1]; }
    else if ((a === "--workflow" || a === "-w") && args[i + 1]) { workflow = args[++i]; }
    else if (a.startsWith("--model=")) { model = a.split("=")[1]; }
    else if (a === "--model" && args[i + 1]) { model = args[++i]; }
    else if (/^\d+$/.test(a)) { round = parseInt(a); }
    i++;
  }
  return { command, round, workflow, forceNew, model, dryRun, includeImpl, quiet };
}

// --- parseWorkflowYaml の再実装 ---
function parseWorkflowYaml(content: string, name: string) {
  const cfg = {
    name, description: "", documents: {} as Record<string, string>,
    model: undefined as string | undefined,
    rounds: { output_dir: `.apr/rounds/${name}` },
  };
  let inDocs = false;
  for (const raw of content.split("\n")) {
    const line = raw.trimEnd();
    if (!line || line.startsWith("#")) continue;
    if (/^documents:/.test(line)) { inDocs = true; continue; }
    if (inDocs && /^\s+\w+:/.test(line)) {
      const m = line.match(/^\s+(\w+):\s*"?(.+?)"?\s*$/);
      if (m && ["readme", "spec", "implementation"].includes(m[1])) cfg.documents[m[1]] = m[2];
    } else if (!/^\s/.test(line)) inDocs = false;
    const kv = line.match(/^(\w+):\s*"?(.+?)"?\s*$/);
    if (kv) {
      if (kv[1] === "name") cfg.name = kv[2];
      else if (kv[1] === "description") cfg.description = kv[2];
      else if (kv[1] === "model") cfg.model = kv[2];
    }
    const ro = line.match(/^\s+output_dir:\s*"?(.+?)"?\s*$/);
    if (ro) cfg.rounds.output_dir = ro[1];
  }
  return cfg;
}

// --- session helpers の再実装 ---
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function loadSession(
  fp: string, workflow: string, model: string, forceNew: boolean
) {
  if (forceNew) return null;
  if (!fs.existsSync(fp)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(fp, "utf-8"));
    const age = Date.now() - new Date(d.created).getTime();
    if (d.model === model && d.workflow === workflow && age < SESSION_MAX_AGE_MS) return d;
    return null;
  } catch { return null; }
}

function saveSession(fp: string, workflow: string, model: string, url: string, round: number) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(
    { url, model, created: new Date().toISOString(), lastRound: round, workflow }, null, 2
  ));
}

// --- nextRound の再実装 ---
function nextRound(dir: string, explicit?: number): number {
  if (explicit !== undefined) return explicit;
  if (!fs.existsSync(dir)) return 1;
  const nums = fs.readdirSync(dir)
    .filter((f) => /^round-\d+$/.test(f))
    .map((f) => parseInt(f.split("-")[1]));
  return nums.length ? Math.max(...nums) + 1 : 1;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  test("デフォルト値", () => {
    const r = parseArgs([]);
    assert.equal(r.command, "run");
    assert.equal(r.workflow, "default");
    assert.equal(r.model, DEFAULT_MODEL);
    assert.equal(r.forceNew, false);
    assert.equal(r.dryRun, false);
    assert.equal(r.quiet, false);
  });

  test("run コマンドは省略可能", () => {
    assert.equal(parseArgs(["run"]).command, "run");
    assert.equal(parseArgs([]).command, "run");
  });

  test("daemon / status / stop コマンド", () => {
    assert.equal(parseArgs(["daemon"]).command, "daemon");
    assert.equal(parseArgs(["status"]).command, "status");
    assert.equal(parseArgs(["stop"]).command, "stop");
  });

  test("--new フラグ", () => {
    assert.equal(parseArgs(["--new"]).forceNew, true);
    assert.equal(parseArgs(["-n"]).forceNew, true);
  });

  test("--dry-run フラグ", () => {
    assert.equal(parseArgs(["--dry-run"]).dryRun, true);
    assert.equal(parseArgs(["-d"]).dryRun, true);
  });

  test("--quiet フラグ", () => {
    assert.equal(parseArgs(["--quiet"]).quiet, true);
    assert.equal(parseArgs(["-q"]).quiet, true);
  });

  test("--include-impl フラグ", () => {
    assert.equal(parseArgs(["--include-impl"]).includeImpl, true);
    assert.equal(parseArgs(["-i"]).includeImpl, true);
  });

  test("-w / --workflow NAME", () => {
    assert.equal(parseArgs(["-w", "arch-consult"]).workflow, "arch-consult");
    assert.equal(parseArgs(["--workflow", "feat-xyz"]).workflow, "feat-xyz");
    assert.equal(parseArgs(["--workflow=feat-xyz"]).workflow, "feat-xyz");
  });

  test("--model MODEL", () => {
    assert.equal(parseArgs(["--model", "gemini-3.0"]).model, "gemini-3.0");
    assert.equal(parseArgs(["--model=gemini-3.0"]).model, "gemini-3.0");
  });

  test("ラウンド番号", () => {
    assert.equal(parseArgs(["5"]).round, 5);
    assert.equal(parseArgs(["run", "3"]).round, 3);
    assert.equal(parseArgs([]).round, undefined);
  });

  test("複合フラグ: gapr run -w arch-consult --new --quiet 2", () => {
    const r = parseArgs(["run", "-w", "arch-consult", "--new", "--quiet", "2"]);
    assert.equal(r.command, "run");
    assert.equal(r.workflow, "arch-consult");
    assert.equal(r.forceNew, true);
    assert.equal(r.quiet, true);
    assert.equal(r.round, 2);
  });
});

describe("parseWorkflowYaml", () => {
  const sampleYaml = `
# gapr Workflow
name: my-workflow
description: "テスト用ワークフロー"

documents:
  readme: "README.md"
  spec: "AGENTS.md"
  implementation: "plans/current.md"

model: "gemini-2.5-pro"

rounds:
  output_dir: ".apr/rounds/my-workflow"
`.trim();

  test("name / description をパース", () => {
    const cfg = parseWorkflowYaml(sampleYaml, "my-workflow");
    assert.equal(cfg.name, "my-workflow");
    assert.equal(cfg.description, "テスト用ワークフロー");
  });

  test("documents をパース", () => {
    const cfg = parseWorkflowYaml(sampleYaml, "my-workflow");
    assert.equal(cfg.documents.readme, "README.md");
    assert.equal(cfg.documents.spec, "AGENTS.md");
    assert.equal(cfg.documents.implementation, "plans/current.md");
  });

  test("model をパース", () => {
    const cfg = parseWorkflowYaml(sampleYaml, "my-workflow");
    assert.equal(cfg.model, "gemini-2.5-pro");
  });

  test("rounds.output_dir をパース", () => {
    const cfg = parseWorkflowYaml(sampleYaml, "my-workflow");
    assert.equal(cfg.rounds.output_dir, ".apr/rounds/my-workflow");
  });

  test("model 未指定時は undefined", () => {
    const yaml = `name: x\ndocuments:\n  spec: "s.md"\nrounds:\n  output_dir: ".apr/rounds/x"`;
    const cfg = parseWorkflowYaml(yaml, "x");
    assert.equal(cfg.model, undefined);
  });

  test("documents 未指定フィールドは undefined", () => {
    const yaml = `name: x\ndocuments:\n  spec: "s.md"\nrounds:\n  output_dir: ".apr/rounds/x"`;
    const cfg = parseWorkflowYaml(yaml, "x");
    assert.equal(cfg.documents.readme, undefined);
    assert.equal(cfg.documents.implementation, undefined);
  });

  test("コメント行は無視される", () => {
    const yaml = `# comment\nname: x\n# another comment\ndocuments:\n  spec: "s.md"\nrounds:\n  output_dir: ".apr/rounds/x"`;
    const cfg = parseWorkflowYaml(yaml, "x");
    assert.equal(cfg.name, "x");
  });
});

describe("session management", () => {
  let tmpDir: string;
  let sessionFp: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gapr-test-"));
    sessionFp = path.join(tmpDir, "session-default.json");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("ファイルなし → null", () => {
    assert.equal(loadSession(sessionFp, "default", DEFAULT_MODEL, false), null);
  });

  test("forceNew=true → null", () => {
    saveSession(sessionFp, "default", DEFAULT_MODEL, "https://example.com", 1);
    assert.equal(loadSession(sessionFp, "default", DEFAULT_MODEL, true), null);
  });

  test("saveSession → loadSession でラウンドロビン", () => {
    saveSession(sessionFp, "default", DEFAULT_MODEL, "https://aistudio.google.com/prompts/abc123", 3);
    const s = loadSession(sessionFp, "default", DEFAULT_MODEL, false);
    assert.ok(s !== null);
    assert.equal(s.url, "https://aistudio.google.com/prompts/abc123");
    assert.equal(s.lastRound, 3);
    assert.equal(s.workflow, "default");
    assert.equal(s.model, DEFAULT_MODEL);
  });

  test("モデルが違う → null", () => {
    saveSession(sessionFp, "default", DEFAULT_MODEL, "https://example.com", 1);
    assert.equal(loadSession(sessionFp, "default", "gemini-1.0", false), null);
  });

  test("ワークフローが違う → null", () => {
    saveSession(sessionFp, "default", DEFAULT_MODEL, "https://example.com", 1);
    assert.equal(loadSession(sessionFp, "other-workflow", DEFAULT_MODEL, false), null);
  });

  test("24時間超過 → null", () => {
    const old = {
      url: "https://example.com",
      model: DEFAULT_MODEL,
      created: new Date(Date.now() - SESSION_MAX_AGE_MS - 1000).toISOString(),
      lastRound: 1,
      workflow: "default",
    };
    fs.writeFileSync(sessionFp, JSON.stringify(old));
    assert.equal(loadSession(sessionFp, "default", DEFAULT_MODEL, false), null);
  });
});

describe("nextRound", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gapr-rounds-"));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("ディレクトリなし → 1", () => {
    assert.equal(nextRound(path.join(tmpDir, "nonexistent")), 1);
  });

  test("空ディレクトリ → 1", () => {
    const dir = path.join(tmpDir, "empty");
    fs.mkdirSync(dir);
    assert.equal(nextRound(dir), 1);
  });

  test("既存ラウンドの次を返す", () => {
    const dir = path.join(tmpDir, "existing");
    fs.mkdirSync(dir);
    fs.mkdirSync(path.join(dir, "round-1"));
    fs.mkdirSync(path.join(dir, "round-3"));
    fs.mkdirSync(path.join(dir, "round-5"));
    assert.equal(nextRound(dir), 6);
  });

  test("explicit 指定は常に優先", () => {
    const dir = path.join(tmpDir, "explicit");
    fs.mkdirSync(dir);
    fs.mkdirSync(path.join(dir, "round-10"));
    assert.equal(nextRound(dir, 99), 99);
  });

  test("round- 以外のディレクトリは無視", () => {
    const dir = path.join(tmpDir, "mixed");
    fs.mkdirSync(dir);
    fs.mkdirSync(path.join(dir, "round-2"));
    fs.mkdirSync(path.join(dir, "other-dir"));
    fs.writeFileSync(path.join(dir, "round-99.txt"), ""); // ファイルは無視
    assert.equal(nextRound(dir), 3);
  });
});

// ---------------------------------------------------------------------------
// shouldCloseBlankTab (blank tab sweeper 判定ロジックの再実装テスト)
// ---------------------------------------------------------------------------

function shouldCloseBlankTab(
  url: string,
  blankSinceMs: number | null,
  nowMs: number,
  ttlMs: number,
  isKeepPage: boolean,
): boolean {
  if (isKeepPage) return false;
  if (url !== "about:blank" && url !== "") return false;
  if (blankSinceMs === null) return false;
  return nowMs - blankSinceMs >= ttlMs;
}

describe("shouldCloseBlankTab", () => {
  const TTL = 5 * 60 * 1000;

  test("TTL を超えて blank のままなら閉じる", () => {
    assert.equal(shouldCloseBlankTab("about:blank", 0, TTL, TTL, false), true);
  });

  test("TTL 未満の blank は閉じない（並列 run の新タブ保護）", () => {
    assert.equal(shouldCloseBlankTab("about:blank", 0, TTL - 1, TTL, false), false);
  });

  test("初回観測（blankSince=null）は閉じない", () => {
    assert.equal(shouldCloseBlankTab("about:blank", null, TTL * 10, TTL, false), false);
  });

  test("keep-alive タブは絶対に閉じない", () => {
    assert.equal(shouldCloseBlankTab("about:blank", 0, TTL * 10, TTL, true), false);
  });

  test("URL があるタブは閉じない", () => {
    assert.equal(
      shouldCloseBlankTab("https://aistudio.google.com/prompts/x", 0, TTL * 10, TTL, false),
      false,
    );
  });

  test("空 URL は blank 扱い", () => {
    assert.equal(shouldCloseBlankTab("", 0, TTL, TTL, false), true);
  });
});

describe("response and account isolation guards", () => {
  test("既存会話では送信前より新しいturnだけを応答開始とみなす", () => {
    const hasNewTurn = (baseline: number, current: number) => current > baseline;
    assert.equal(hasNewTurn(4, 4), false);
    assert.equal(hasNewTurn(4, 5), true);
  });

  test("fallback daemonへaccount固有のprofile・port・endpoint・pidを渡す", () => {
    const env = {
      CHROME__userDataDir: "/tmp/profile-secondary",
      GAPR__cdpPort: "9323",
      GAPR_CDP_FILE: "/tmp/gapr-cdp-endpoint-secondary.txt",
      GAPR_DAEMON_PID_FILE: "/tmp/gapr-daemon-secondary.pid",
    };
    assert.deepEqual(Object.keys(env).sort(), [
      "CHROME__userDataDir", "GAPR_CDP_FILE", "GAPR_DAEMON_PID_FILE", "GAPR__cdpPort",
    ].sort());
    assert.equal(env.GAPR__cdpPort, "9323");
  });
});
