#!/usr/bin/env npx tsx
/**
 * gapr-browser.ts — Gemini Automated Plan Reviser (Browser Edition)
 *
 * Google AI Studio を Playwright で自動操作し、計画をレビューする。
 * API key 不要。Google ログインのみ。
 *
 * ── ブラウザ管理 ──────────────────────────────────────────────────
 * Chrome は「daemon」として1プロセスだけ起動し、全エージェントが
 * CDP (Chrome DevTools Protocol) で接続して「タブ」単位で作業する。
 * セッションURLがタブのIDになるため、複数エージェントが同時実行
 * しても絶対に混線しない。
 *
 * ── コマンド ─────────────────────────────────────────────────────
 *   gapr daemon             Chrome を起動して待機（初回 or 再起動時）
 *   gapr run                ワークフロー default でラウンド実行
 *   gapr run --new          強制新規チャット（セッション無視）
 *   gapr run -w NAME        ワークフロー指定
 *   gapr run --dry-run      プロンプトをプレビューして終了（Chrome不要）
 *   gapr run -i             実装ドキュメントも含める
 *   gapr setup              新規ワークフロー作成ウィザード
 *   gapr list               ワークフロー一覧
 *   gapr history            ラウンド履歴
 *   gapr status             daemon の状態確認
 *   gapr stop               daemon を停止
 *
 * ── オプション ───────────────────────────────────────────────────
 *   -w, --workflow NAME     ワークフロー名（デフォルト: default）
 *   --new                   強制新規チャット
 *   --model MODEL           Gemini モデル
 *   --dry-run               Chrome不要・プロンプト確認のみ
 *   -i, --include-impl      実装ドキュメントも含める
 *   --quiet                 最小限ログ（flywheel向け）
 *
 * ── 典型的な使い方 ───────────────────────────────────────────────
 *   # 初回セットアップ
 *   gapr daemon             # Chrome 起動（Googleログイン済みプロファイル使用）
 *   gapr setup              # ワークフロー設定
 *   gapr run --new          # 初回レビュー（新規チャット）
 *
 *   # 2回目以降（daemon が起動中なら自動接続）
 *   gapr run                # 既存会話を継続
 *   gapr run -w arch-consult --new   # 別ワークフロー・新規チャット
 *
 *   # 複数エージェントの並列実行（全員同じ daemon を共有）
 *   gapr run -w default     # Agent-A のタブ
 *   gapr run -w feat-xyz    # Agent-B の別タブ（混線なし）
 */

import { chromium, type Browser, type BrowserContext, type Page, type ElementHandle } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as http from "http";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// "auto-pro" = navigate without ?model= so AI Studio uses its own latest default pro model.
// Never hardcode a version number here — it will become stale.
const DEFAULT_MODEL = "auto-pro";
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

// Account-specific settings — mutable so multi-account fallback can switch at runtime
let _userDataDir =
  process.env.CHROME__userDataDir ??
  path.join(process.env.HOME!, ".gapr-playwright-profile");

let _cdpPort = parseInt(process.env.GAPR__cdpPort ?? "9322");
let _cdpEndpointFile = process.env.GAPR_CDP_FILE ?? "/tmp/gapr-cdp-endpoint.txt";
let _daemonPidFile = "/tmp/gapr-daemon.pid";

/** Switch active account. index=0 → default profile/port, index>0 → named profile on port 9322+index. */
function resolveAccount(name: string, index: number): void {
  if (index === 0) {
    _userDataDir = process.env.CHROME__userDataDir ?? path.join(process.env.HOME!, ".gapr-playwright-profile");
    _cdpPort = parseInt(process.env.GAPR__cdpPort ?? "9322");
    _cdpEndpointFile = process.env.GAPR_CDP_FILE ?? "/tmp/gapr-cdp-endpoint.txt";
    _daemonPidFile = "/tmp/gapr-daemon.pid";
  } else {
    _userDataDir = path.join(process.env.HOME!, `.gapr-playwright-profile-${name}`);
    _cdpPort = 9322 + index;
    _cdpEndpointFile = `/tmp/gapr-cdp-endpoint-${name}.txt`;
    _daemonPidFile = `/tmp/gapr-daemon-${name}.pid`;
  }
}

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  command: string;   // daemon | run | setup | list | history | status | stop | help
  round?: number;
  workflow: string;
  forceNew: boolean;
  model: string;
  dryRun: boolean;
  includeImpl: boolean;
  quiet: boolean;
  account?: string;  // explicit account name (skips to that account in the fallback list)
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let command = "run";
  let round: number | undefined;
  let workflow = "default";
  let forceNew = false;
  let model = DEFAULT_MODEL;
  let dryRun = false;
  let includeImpl = false;
  let quiet = false;

  let account: string | undefined;
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (["daemon", "run", "setup", "list", "history", "status", "stop", "help"].includes(a)) {
      command = a;
    } else if (a === "--new" || a === "-n") {
      forceNew = true;
    } else if (a === "--dry-run" || a === "-d") {
      dryRun = true;
    } else if (a === "--include-impl" || a === "-i") {
      includeImpl = true;
    } else if (a === "--quiet" || a === "-q") {
      quiet = true;
    } else if (a === "--version") {
      console.log("gapr 2.2.0 (Playwright CDP edition)");
      process.exit(0);
    } else if (a.startsWith("--workflow=")) {
      workflow = a.split("=")[1];
    } else if ((a === "--workflow" || a === "-w") && args[i + 1]) {
      workflow = args[++i];
    } else if (a.startsWith("--model=")) {
      model = a.split("=")[1];
    } else if (a === "--model" && args[i + 1]) {
      model = args[++i];
    } else if (a.startsWith("--account=")) {
      account = a.split("=")[1];
    } else if (a === "--account" && args[i + 1]) {
      account = args[++i];
    } else if (/^\d+$/.test(a)) {
      round = parseInt(a);
    }
    i++;
  }
  return { command, round, workflow, forceNew, model, dryRun, includeImpl, quiet, account };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

let _quiet = false;
const log = (...args: unknown[]) => { if (!_quiet) console.log(...args); };
const logAlways = (...args: unknown[]) => console.log(...args);

// ---------------------------------------------------------------------------
// CDP Daemon Management
// ---------------------------------------------------------------------------

async function fetchWsEndpoint(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data).webSocketDebuggerUrl); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function isDaemonRunning(): Promise<boolean> {
  if (!fs.existsSync(_cdpEndpointFile)) return false;
  try {
    await fetchWsEndpoint(_cdpPort);
    return true;
  } catch {
    // endpoint file 残ってるが Chrome 死んでる → クリーンアップ
    fs.rmSync(_cdpEndpointFile, { force: true });
    fs.rmSync(_daemonPidFile, { force: true });
    return false;
  }
}

async function connectToDaemon(): Promise<BrowserContext> {
  const wsUrl = fs.readFileSync(_cdpEndpointFile, "utf-8").trim();
  const browser = await chromium.connectOverCDP(wsUrl, { timeout: 10000 });
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error("CDP context が見つかりません");
  return ctx;
}

/** daemon が起動してなければ自動起動（バックグラウンド子プロセス） */
async function ensureDaemon(): Promise<void> {
  if (await isDaemonRunning()) return;

  log("🚀 daemon が未起動のため自動起動します...");
  const child = require("child_process").spawn(
    process.execPath,
    // tsx v4+ doesn't export ./dist/cli.mjs; resolve via package.json then build path
    [require("path").join(require("path").dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs"), __filename, "daemon"],
    { detached: true, stdio: "ignore", env: { ...process.env, GAPR_DAEMON_MODE: "1" } }
  );
  child.unref();

  // 起動を最大10秒待つ
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isDaemonRunning()) {
      log("✅ daemon 起動確認");
      return;
    }
  }
  throw new Error("daemon の起動がタイムアウトしました。'gapr daemon' を手動で実行してください。");
}

// ---------------------------------------------------------------------------
// Tab Manager
// ---------------------------------------------------------------------------

/** sessionURL に対応するタブを返す。なければ新タブを作成。 */
async function getOrCreateTab(ctx: BrowserContext, sessionUrl: string | null): Promise<Page> {
  if (sessionUrl) {
    const existing = ctx.pages().find((p) => p.url() === sessionUrl);
    if (existing) {
      log(`♻️  既存タブ再利用: ${sessionUrl}`);
      return existing;
    }
  }
  log("➕ 新タブ作成");
  return ctx.newPage();
}

// ---------------------------------------------------------------------------
// Project Root & Workflow Config
// ---------------------------------------------------------------------------

function findProjectRoot(): string {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (
      fs.existsSync(path.join(dir, ".apr")) ||
      fs.existsSync(path.join(dir, ".gapr")) ||
      fs.existsSync(path.join(dir, "AGENTS.md")) ||
      fs.existsSync(path.join(dir, ".git"))
    ) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

interface WorkflowConfig {
  name: string;
  description: string;
  documents: { readme?: string; spec?: string; implementation?: string };
  model?: string;
  rounds: { output_dir: string };
  accounts?: string[];  // multi-account fallback list (e.g. ["default", "work2", "personal"])
}

function loadWorkflowConfig(projectRoot: string, name: string): WorkflowConfig | null {
  for (const base of [".apr", ".gapr"]) {
    const fp = path.join(projectRoot, base, "workflows", `${name}.yaml`);
    if (fs.existsSync(fp)) return parseWorkflowYaml(fs.readFileSync(fp, "utf-8"), name);
  }
  return null;
}

function parseWorkflowYaml(content: string, name: string): WorkflowConfig {
  const cfg: WorkflowConfig = {
    name,
    description: "",
    documents: {},
    rounds: { output_dir: `.apr/rounds/${name}` },
  };
  let inDocs = false;
  let inAccounts = false;
  const accounts: string[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trimEnd();
    if (!line || line.startsWith("#")) continue;
    if (/^accounts:/.test(line)) { inAccounts = true; inDocs = false; continue; }
    if (inAccounts) {
      const item = raw.match(/^\s+-\s+"?(.+?)"?\s*$/);
      if (item) { accounts.push(item[1]); continue; }
      if (!/^\s/.test(line)) inAccounts = false;
    }
    if (/^documents:/.test(line)) { inDocs = true; inAccounts = false; continue; }
    if (inDocs && /^\s+\w+:/.test(line)) {
      const m = line.match(/^\s+(\w+):\s*"?(.+?)"?\s*$/);
      if (m && ["readme", "spec", "implementation"].includes(m[1]))
        (cfg.documents as any)[m[1]] = m[2];
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
  if (accounts.length > 0) cfg.accounts = accounts;
  return cfg;
}

// ---------------------------------------------------------------------------
// Session Persistence
// ---------------------------------------------------------------------------

interface Session { url: string; model: string; created: string; lastRound: number; workflow: string }

function sessionFile(projectRoot: string, workflow: string): string {
  const base = fs.existsSync(path.join(projectRoot, ".apr")) ? ".apr" : ".gapr";
  return path.join(projectRoot, base, `session-${workflow}.json`);
}

function loadSession(projectRoot: string, workflow: string, model: string, forceNew: boolean): Session | null {
  if (forceNew) return null;
  const fp = sessionFile(projectRoot, workflow);
  if (!fs.existsSync(fp)) return null;
  try {
    const d: Session = JSON.parse(fs.readFileSync(fp, "utf-8"));
    const age = Date.now() - new Date(d.created).getTime();
    if (d.model === model && d.workflow === workflow && age < SESSION_MAX_AGE_MS) return d;
    log("📋 セッション期限切れ or モデル変更 → 新規チャット");
    return null;
  } catch { return null; }
}

function saveSession(projectRoot: string, workflow: string, model: string, url: string, round: number): void {
  fs.writeFileSync(sessionFile(projectRoot, workflow), JSON.stringify(
    { url, model, created: new Date().toISOString(), lastRound: round, workflow } satisfies Session,
    null, 2
  ));
}

// ---------------------------------------------------------------------------
// Prompt Building
// ---------------------------------------------------------------------------

function loadFile(fp: string | undefined, cwd = process.cwd()): string {
  if (!fp) return "";
  const abs = path.isAbsolute(fp) ? fp : path.join(cwd, fp);
  if (!fs.existsSync(abs)) { log(`  ⚠️  見つかりません: ${abs}`); return ""; }
  return fs.readFileSync(abs, "utf-8");
}

function loadCurrentQuestion(projectRoot: string): string {
  for (const b of [".apr", ".gapr"]) {
    const fp = path.join(projectRoot, b, "spec", "current-question.md");
    if (fs.existsSync(fp)) return fs.readFileSync(fp, "utf-8");
  }
  return "";
}

function buildInitialPrompt(cfg: WorkflowConfig, projectRoot: string, includeImpl: boolean): string {
  const readme = loadFile(cfg.documents.readme, projectRoot);
  const spec = loadFile(cfg.documents.spec, projectRoot);
  const impl = includeImpl ? loadFile(cfg.documents.implementation, projectRoot) : "";
  const question = loadCurrentQuestion(projectRoot);

  const lines = [
    `あなたは Dicklesworthstone 流 AI 駆動開発のエキスパートレビュアーです。`,
    `ワークフロー「${cfg.name}」の計画ドキュメントを精査し、改善提案をしてください。`,
    ``,
    `## レビュー観点`,
    `1. **計画の完全性** — ゴール・制約・成功条件は明確か？`,
    `2. **実行可能性** — 各ステップは具体的で担当者が迷わず実行できるか？`,
    `3. **依存関係** — タスク間の依存は正しく定義されているか？並列化できるものは並列化されているか？`,
    `4. **リスク** — 見落としているリスクや障害点はないか？`,
    `5. **収束性** — 計画は収束するか？無限ループや発散するポイントはないか？`,
    ``,
    `## 出力形式`,
    `### 総合評価: [A/B/C/D/F]`,
    `### サマリー（3行以内）`,
    `### 強み`,
    `### 改善必須（Critical）`,
    `### 改善推奨（Important）`,
    `### 改善検討（Nice to have）`,
    `### アクションアイテム（優先度順）`,
    `---`,
  ];
  if (readme) lines.push(`## README / Overview\n\n${readme}\n`);
  if (spec) lines.push(`## 計画・仕様\n\n${spec}\n`);
  if (impl) lines.push(`## 実装詳細\n\n${impl}\n`);
  if (question) lines.push(`## 相談 (current-question.md)\n\n${question}\n`);
  return lines.join("\n");
}

function buildFollowUpPrompt(cfg: WorkflowConfig, projectRoot: string): string {
  return `前回のレビューから進捗しました。最新の計画ドキュメントを確認し、前回の指摘が反映されているかチェックして、新たな問題があれば同フォーマットで出力してください。\n\n=== 最新計画 ===\n${loadFile(cfg.documents.spec, projectRoot)}`;
}

// ---------------------------------------------------------------------------
// Playwright Helpers
// ---------------------------------------------------------------------------

async function findInput(page: Page): Promise<ElementHandle | null> {
  for (const sel of [
    'textarea[aria-label*="prompt" i]',
    'textarea[aria-label*="Type" i]',
    'div[contenteditable="true"]',
    'div[role="textbox"]',
    "textarea",
  ]) {
    try {
      await page.waitForSelector(sel, { timeout: 8000, state: "visible" });
      const el = await page.$(sel);
      if (el) return el;
    } catch { continue; }
  }
  return null;
}

async function typeAndSend(page: Page, el: ElementHandle, text: string): Promise<boolean> {
  await el.click();
  await page.waitForTimeout(300);
  // Clear existing content, then insert all text at once (no per-character simulation)
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(text);
  log(`  入力完了: ${text.length} chars`);
  await page.waitForTimeout(1000);

  const btn = (await page.$('button[aria-label*="Run" i]')) ?? (await page.$('button[aria-label*="Send" i]'));
  if (btn) { try { await btn.click(); } catch { /* ignore */ } }
  await el.click(); await page.waitForTimeout(200);
  await page.keyboard.press("Meta+Enter");
  await page.waitForTimeout(3000);

  return page.evaluate(() => {
    const t = document.body.innerText;
    return t.includes("stop_circle") || t.includes("Generating") || /User\s+\d/.test(t);
  });
}

async function checkQuota(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const t = document.body.innerText;
    return t.includes("exceeded quota") || t.includes("rate limit") ||
      t.includes("try again later") || t.includes("Too Many Requests");
  });
}

// Network-observed Gemini response text (populated by page.on("response") listener).
// AI Studio renders model responses in closed/inaccessible shadow DOM;
// passively observing API responses avoids intercepting the request flow.
let _interceptedResponse = "";

// Parse "text" fields from a raw Gemini API JSON payload.
// Handles both REST API and $rpc/gRPC-web formats from AI Studio.
function extractTextFromChunk(raw: string): string {
  const parts: string[] = [];

  // Pattern 1: Standard REST API — "text": "content..."
  const textMatches = raw.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g);
  for (const m of textMatches) {
    try {
      parts.push(JSON.parse(`"${m[1]}"`));
    } catch {
      parts.push(m[1].replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"'));
    }
  }

  // Pattern 2: gRPC-web / $rpc chunked — look for long strings (>50 chars)
  // that look like natural language content (not JSON keys or URLs)
  if (parts.join("").length < 100) {
    const longStrings = raw.matchAll(/"((?:[^"\\]|\\.){50,})"/g);
    for (const m of longStrings) {
      try {
        const decoded = JSON.parse(`"${m[1]}"`);
        // Skip URLs, base64, and JSON-like strings
        if (decoded.startsWith("http") || /^[A-Za-z0-9+/=]{50,}$/.test(decoded)) continue;
        // Accept strings with spaces (natural language)
        if ((decoded.match(/\s/g) || []).length > 5) {
          parts.push(decoded);
        }
      } catch { /* skip */ }
    }
  }

  return parts.join("");
}

// Install a passive response listener to capture Gemini API responses.
// Uses page.on("response") instead of page.route() to avoid interfering
// with streaming requests (route.fetch() on SSE/chunked streams can crash).
// Must be called before the prompt is sent.
function installResponseInterceptor(page: Page): void {
  _interceptedResponse = "";

  page.on("response", async (response) => {
    try {
      const url = response.url();
      const method = response.request().method();
      // Log all POST responses for debugging
      if (method === "POST") {
        log(`🔍 POST response: ${response.status()} ${url.substring(0, 100)}`);
      }
      // Match any Gemini API or AI Studio backend endpoint
      const isGeminiApi =
        url.includes("streamGenerateContent") ||
        url.includes("generateContent") ||
        url.includes("/v1beta/models/") ||
        url.includes("/v1/models/") ||
        url.includes("alkalimakersuite") ||
        url.includes("generativelanguage.googleapis.com") ||
        url.includes("aiplatform.googleapis.com");
      if (!isGeminiApi) return;

      // Try text() first, fall back to body() for streaming/binary responses
      let body = await response.text().catch(() => "");
      if (body.length < 100) {
        const buf = await response.body().catch(() => null);
        if (buf) body = buf.toString("utf-8");
      }
      if (body.length < 100) return;

      const extracted = extractTextFromChunk(body);
      if (extracted.length > 0) {
        _interceptedResponse += extracted;
        log(`📡 Gemini レスポンス: +${extracted.length} chars (合計 ${_interceptedResponse.length})`);
      }
    } catch { /* ignore errors in listener */ }
  });
}

// Extract the last model response text from AI Studio.
// AI Studio 2026-Q1+: ms-chat-turn elements are at document root level (no shadow DOM).
// data-turn-role="Model" (capitalized) identifies model response containers inside virtual scroll.
// Virtual scroll renders content lazily — caller should scroll to bottom before calling this.
async function extractLastModelResponse(page: Page): Promise<string> {
  // Step A: Scroll to bottom to trigger virtual scroll rendering of the last model turn.
  try {
    await page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
    await page.waitForTimeout(800);
    // Wait until at least one model turn-content has real text.
    await page.waitForFunction(`(function() {
      var containers = document.querySelectorAll('[data-turn-role="Model"] .turn-content');
      return Array.from(containers).some(function(c) {
        return c.textContent && c.textContent.trim().length > 50;
      });
    })()`, { timeout: 8000 });
    log("  ✅ virtual scroll: model turn-content rendered");
  } catch { /* timeout ok — content may already be rendered or selector changed */ }

  // Step B: Primary — [data-turn-role="Model"] .turn-content (AI Studio 2026-Q1+ DOM)
  try {
    const turnContent = page.locator('[data-turn-role="Model"] .turn-content');
    const count = await turnContent.count().catch(() => 0);
    if (count > 0) {
      const text = await turnContent.last().innerText({ timeout: 5000 }).catch(() => "");
      if (text.trim().length > 200) {
        log(`  turn-content: ${text.length} chars`);
        return cleanUiChrome(text);
      }
      log(`  turn-content: too short (${text.length} chars), trying next`);
    }
  } catch { /* try next */ }

  // Step C: Direct ms-chat-turn locator (no pierce/ — shadow DOM removed in AI Studio 2026-Q1)
  const TURN_SELECTORS = [
    "ms-chat-turn",
    ".chat-turn",
    "model-response",
    ".model-response-text",
  ];

  for (const sel of TURN_SELECTORS) {
    try {
      const locator = page.locator(sel);
      const count = await locator.count().catch(() => 0);
      if (count === 0) continue;

      // Last turn = model response. For thinking-mode, second-to-last = "Thoughts".
      const lastText = await locator.last().innerText({ timeout: 5000 }).catch(() => "");
      if (lastText.trim().length < 500 && count >= 2) {
        // Possibly truncated — also grab second-to-last if it looks like model output
        const prevText = await locator.nth(count - 2).innerText({ timeout: 3000 }).catch(() => "");
        if (prevText.length > 100 && prevText.length < 30000) {
          const merged = prevText + "\n---\n" + lastText;
          log(`  ${sel}: ${merged.length} chars (merged last 2 turns)`);
          return cleanUiChrome(merged);
        }
      }
      if (lastText.trim().length > 0) {
        log(`  selector matched: ${sel} — ${lastText.length} chars`);
        return cleanUiChrome(lastText);
      }
    } catch { /* try next */ }
  }

  // Step D: evaluate-based fallback (handles both old shadow DOM and new flat DOM patterns)
  const raw = await page.evaluate(`(function() {
    function getDeepText(node, depth) {
      if (!node || depth > 80) return '';
      var result = '';
      if (node.nodeType === 3) {
        var t = (node.textContent || '').trim();
        if (t) result += t + '\\n';
      }
      if (node.shadowRoot) {
        for (var i = 0; i < node.shadowRoot.childNodes.length; i++) {
          result += getDeepText(node.shadowRoot.childNodes[i], depth + 1);
        }
      }
      for (var j = 0; j < node.childNodes.length; j++) {
        result += getDeepText(node.childNodes[j], depth + 1);
      }
      return result;
    }
    // AI Studio 2026-Q1+: data-turn-role uses capitalized "Model"
    var modelContainers = document.querySelectorAll('[data-turn-role="Model"] .turn-content');
    if (modelContainers.length > 0) {
      var lastContent = modelContainers[modelContainers.length - 1];
      var contentText = getDeepText(lastContent, 0);
      if (contentText.length > 100) return contentText;
    }
    // Legacy: scan ms-chat-turn (covers both lowercase and uppercase data-turn-role)
    var selectors = ['ms-chat-turn','.chat-turn','[data-turn-role="model"]','model-response','.model-response-text','.response-container'];
    var turns = [];
    for (var s = 0; s < selectors.length; s++) {
      turns = Array.from(document.querySelectorAll(selectors[s]));
      if (turns.length > 0) break;
    }
    if (turns.length === 0) {
      var mdContainers = document.querySelectorAll('.markdown-content, .response-text, [class*="message-content"], [class*="model-response"]');
      if (mdContainers.length > 0) return getDeepText(mdContainers[mdContainers.length - 1], 0);
      return '';
    }
    var lastText = getDeepText(turns[turns.length - 1], 0);
    if (lastText.length < 500 && turns.length >= 2) {
      var prevText = getDeepText(turns[turns.length - 2], 0);
      if (prevText.length > 100 && prevText.length < 30000) lastText = prevText + '\\n---\\n' + lastText;
    }
    return lastText;
  })()`).catch(() => "") as string;

  return cleanUiChrome(raw || "");
}

// Strip known AI Studio UI chrome patterns from extracted text.
function cleanUiChrome(text: string): string {
  const UI_CHROME_PATTERNS = [
    /^more_vert\n/gm,
    /^Model\n/gm,
    /^\d{1,2}:\d{2}\n/gm,
    // Material icon names
    /^(key_off|widgets|close|add_circle|progress_activity|expand_more|reset_settings|code|stop_circle|content_copy|edit|check|arrow_drop_down|arrow_upward|arrow_downward|thumb_up|thumb_down|share|bookmark|flag|star|search|menu|settings|info|help|warning|error|delete|refresh|mic|stop|Stop)\n/gm,
    // AI Studio sidebar labels
    /^(Run settings|Get code|System instructions|No API Key|Temperature|Media resolution|Thinking level|Default|High|Structured outputs|Code execution|Function calling|Grounding with Google Search|Grounding with Google Maps|URL context|Advanced settings|Tools|Safety settings|Source:|Edit|Google Search)\n/gm,
    // Model selector text
    /^(Gemini\s+[\d.]+\s+\S+(\s+Preview)?|gemini-[\w.-]+)\n/gm,
    /^(Our latest|Switch to a paid|Optional tone and style|Use Arrow Up)\b[^\n]*/gm,
    /^google\n/gm,
  ];
  let cleaned = text;
  for (const pat of UI_CHROME_PATTERNS) {
    cleaned = cleaned.replace(pat, "");
  }
  return cleaned.replace(/\n{3,}/g, "\n\n").trim();
}

// Try to read the last model response via the Copy button + clipboard.
// Fallback when shadow DOM traversal is insufficient.
async function tryReadViaClipboard(page: Page): Promise<string> {
  try {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  } catch { /* ignore if already granted */ }

  // Confirmed selector: mattooltip="Copy to clipboard" (aria-label is null in current AI Studio)
  const btns = await page.$$('button[mattooltip="Copy to clipboard"], button[mattooltip*="Copy" i]').catch(() => []);
  if (btns.length === 0) {
    log("  ⚠ コピーボタンが見つかりません");
    return "";
  }

  // Click the LAST copy button (most recent model response code block)
  await btns[btns.length - 1].click().catch(() => {});
  log(`  📋 コピーボタンクリック (${btns.length}個中最後)`);
  await page.waitForTimeout(800);

  const text = await page.evaluate(`(async function() {
    try { return await navigator.clipboard.readText(); }
    catch(e) { return '__clipboard_error__:' + e; }
  })()`).catch(() => "") as string;

  if (!text || text.startsWith("__clipboard_error__")) {
    log(`  ⚠ クリップボード読み取り失敗: ${(text ?? "").substring(0, 80)}`);
    return "";
  }
  return text;
}

async function waitForResponse(page: Page, maxSec: number): Promise<string> {
  // AI Studio renders model responses in shadow DOM — document.body.innerText won't capture them.
  // Strategy:
  //   1. Wait for Stop button to appear/disappear (generation lifecycle)
  //   2. Poll for model response turn to be added to DOM (ms-chat-turns >= 2)
  //   3. Extract text via shadow DOM traversal
  //   4. Fallback to clipboard (copy button click)
  //   5. Last resort: body text

  const stopSel = [
    'button[aria-label*="Stop" i]',
    'button:has-text("Stop")',
  ].join(", ");

  // Step 1: Wait for Stop button to appear (generation started)
  log("  Step1: 生成開始待機...");
  try {
    await page.waitForSelector(stopSel, { state: "visible", timeout: 45000 });
    log("  ▶ 生成開始");
  } catch {
    log("  ⚠ Stop ボタン未検出 (Flash など高速モデルは既に完了している場合がある)");
  }

  // Step 2: Wait for Stop button to disappear (generation complete)
  log("  Step2: 生成完了待機...");
  try {
    await page.waitForSelector(stopSel, { state: "hidden", timeout: maxSec * 1000 });
    log("  ✅ 生成完了 (Stop 消滅)");
  } catch {
    log("  ⚠ タイムアウト");
  }

  // Step 3: Poll until model response turn appears in DOM (>=2 ms-chat-turn elements)
  // AI Studio 2026-Q1+: ms-chat-turn elements are at document root (no shadow DOM).
  // Use direct locator without pierce/ which fails when there are no shadow roots.
  log("  Step3: モデルターン出現待機...");
  const pollStart = Date.now();
  const pollMax = 30000; // 30s max
  while (Date.now() - pollStart < pollMax) {
    const turnCount = await page.locator("ms-chat-turn").count().catch(() => 0);
    if (turnCount >= 2) {
      log(`  ✅ ms-chat-turn x${turnCount} — モデルターン確認`);
      break;
    }
    await page.waitForTimeout(1000);
    log(`  ... ターン待機中 (${Math.round((Date.now() - pollStart) / 1000)}s, turns=${turnCount})`);
  }
  await page.waitForTimeout(1500); // Extra settle time for DOM to finish rendering

  // Step 4: Primary — shadow DOM traversal
  const shadowText = await extractLastModelResponse(page);
  log(`  Shadow DOM: ${shadowText.length} chars`);
  if (shadowText.length > 200) {
    return shadowText;
  }

  // Step 4: Secondary — clipboard via Copy button
  const clipText = await tryReadViaClipboard(page);
  log(`  Clipboard: ${clipText.length} chars`);
  if (clipText.length > 100) {
    return clipText;
  }

  // Step 5: API-intercepted gRPC text (usually empty for AI Studio)
  if (_interceptedResponse.length > 100) {
    log(`  API intercepted: ${_interceptedResponse.length} chars`);
    return _interceptedResponse;
  }

  // Step 6: Last resort — body text with aggressive UI chrome cleanup.
  // Previous versions returned raw body.innerText which captured settings panels,
  // sidebar labels, and other UI chrome instead of the actual model response.
  log("  ⚠ フォールバック: body.innerText (UI chrome フィルタ適用)");
  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
  const cleaned = cleanUiChrome(bodyText);

  // If cleaned text is <200 chars, it's almost certainly just residual UI chrome — not a real response.
  // Return an explicit error marker so callers know extraction failed.
  if (cleaned.length < 200) {
    log(`  ❌ body.innerText after cleanup: ${cleaned.length} chars — extraction failed`);
    return `[GAPR_EXTRACTION_FAILED] Shadow DOM, clipboard, API interception, and body.innerText all failed to capture the model response. The page may have changed structure. Raw body length: ${bodyText.length}, cleaned: ${cleaned.length}`;
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Round Directory
// ---------------------------------------------------------------------------

function roundsDir(projectRoot: string, cfg: WorkflowConfig): string {
  const d = cfg.rounds.output_dir;
  return path.isAbsolute(d) ? d : path.join(projectRoot, d);
}

function nextRound(dir: string, explicit?: number): number {
  if (explicit !== undefined) return explicit;
  if (!fs.existsSync(dir)) return 1;
  const nums = fs.readdirSync(dir).filter((f) => /^round-\d+$/.test(f)).map((f) => parseInt(f.split("-")[1]));
  return nums.length ? Math.max(...nums) + 1 : 1;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdDaemon(): Promise<void> {
  if (await isDaemonRunning()) {
    logAlways("✅ daemon は既に起動中です");
    logAlways(`   endpoint: ${fs.readFileSync(_cdpEndpointFile, "utf-8").trim()}`);
    return;
  }

  logAlways(`🚀 [daemon] Chrome 起動中 (CDP port=${_cdpPort})...`);
  const lock = path.join(_userDataDir, "SingletonLock");
  if (fs.existsSync(lock)) fs.unlinkSync(lock);

  const ctx = await chromium.launchPersistentContext(_userDataDir, {
    headless: false,
    channel: "chrome",
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      `--remote-debugging-port=${_cdpPort}`,
    ],
    viewport: { width: 1400, height: 900 },
    timeout: 30000,
  });

  // CDP ready 待ち
  await new Promise((r) => setTimeout(r, 1500));

  let wsUrl = "";
  for (let i = 0; i < 10; i++) {
    try { wsUrl = await fetchWsEndpoint(_cdpPort); break; }
    catch { await new Promise((r) => setTimeout(r, 500)); }
  }

  if (!wsUrl) {
    logAlways("❌ CDP エンドポイント取得失敗");
    await ctx.close(); process.exit(1);
  }

  fs.writeFileSync(_cdpEndpointFile, wsUrl);
  fs.writeFileSync(_daemonPidFile, String(process.pid));
  logAlways(`✅ [daemon] 起動完了`);
  logAlways(`   WS: ${wsUrl}`);
  logAlways(`   PID: ${process.pid}`);
  logAlways(`   プロファイル: ${_userDataDir}`);
  logAlways(`\n   Google AI Studio でログインしてください（初回のみ）`);
  logAlways(`   停止: gapr stop\n`);

  // 初期タブ
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto("about:blank");

  // 終了シグナル
  const cleanup = async () => {
    logAlways("\n🛑 [daemon] 停止中...");
    fs.rmSync(_cdpEndpointFile, { force: true });
    fs.rmSync(_daemonPidFile, { force: true });
    await ctx.close();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // daemon は終了しない
  await new Promise(() => {});
}

async function cmdStatus(): Promise<void> {
  const running = await isDaemonRunning();
  logAlways(running ? "✅ daemon: 起動中" : "❌ daemon: 停止中");
  if (running) {
    logAlways(`   endpoint: ${fs.readFileSync(_cdpEndpointFile, "utf-8").trim()}`);
    const pid = fs.existsSync(_daemonPidFile) ? fs.readFileSync(_daemonPidFile, "utf-8").trim() : "不明";
    logAlways(`   PID: ${pid}`);
    // タブ一覧
    try {
      const ctx = await connectToDaemon();
      const pages = ctx.pages();
      logAlways(`   タブ数: ${pages.length}`);
      pages.forEach((p, i) => logAlways(`   tab[${i}]: ${p.url()}`));
      await ctx.browser()?.close();
    } catch { /* ignore */ }
  }
}

async function cmdStop(): Promise<void> {
  if (!fs.existsSync(_daemonPidFile)) { logAlways("daemon は起動していません"); return; }
  const pid = parseInt(fs.readFileSync(_daemonPidFile, "utf-8").trim());
  try {
    process.kill(pid, "SIGTERM");
    logAlways(`🛑 daemon (PID=${pid}) に停止シグナルを送りました`);
  } catch {
    logAlways("daemon プロセスが見つかりません（既に停止済み？）");
    fs.rmSync(_cdpEndpointFile, { force: true });
    fs.rmSync(_daemonPidFile, { force: true });
  }
}

async function cmdRun(args: CliArgs, projectRoot: string): Promise<void> {
  const cfg = loadWorkflowConfig(projectRoot, args.workflow);
  if (!cfg) {
    logAlways(`❌ ワークフロー '${args.workflow}' が見つかりません`);
    logAlways(`   'gapr setup' でセットアップしてください`);
    process.exit(4);
  }

  const model = args.model !== DEFAULT_MODEL ? args.model : (cfg.model ?? DEFAULT_MODEL);
  const session = loadSession(projectRoot, args.workflow, model, args.forceNew);

  log(`🚀 gapr — workflow: ${args.workflow}, model: ${model}`);
  log(`   mode: ${session ? "RESUME (既存会話継続)" : "NEW (新規チャット)"}`);
  if (session) log(`   session URL: ${session.url}`);

  const prompt = session
    ? buildFollowUpPrompt(cfg, projectRoot)
    : buildInitialPrompt(cfg, projectRoot, args.includeImpl);

  log(`📝 プロンプト: ${prompt.length} chars`);

  if (args.dryRun) {
    logAlways("\n--- DRY RUN ---\n");
    logAlways(prompt.slice(0, 2000));
    if (prompt.length > 2000) logAlways(`... (${prompt.length - 2000} chars 省略)`);
    return;
  }

  // Round setup
  const rDir = roundsDir(projectRoot, cfg);
  const roundNum = nextRound(rDir, args.round);
  const roundPath = path.join(rDir, `round-${roundNum}`);
  fs.mkdirSync(roundPath, { recursive: true });
  fs.writeFileSync(path.join(roundPath, "prompt.md"), prompt);
  log(`📂 Round ${roundNum} → ${roundPath}/`);

  // "auto-pro": let AI Studio pick its own latest default (no ?model= param)
  const newChatUrl = (model === "auto-pro")
    ? "https://aistudio.google.com/prompts/new_chat"
    : `https://aistudio.google.com/prompts/new_chat?model=${model}`;

  // Multi-account fallback: try each account in order until quota not exceeded
  const accountsList = cfg.accounts?.length ? cfg.accounts : ["default"];
  let accountIdx = 0;
  if (args.account) {
    const found = accountsList.indexOf(args.account);
    if (found >= 0) accountIdx = found;
  }

  let ctx!: Awaited<ReturnType<typeof connectToDaemon>>;
  let page!: import("playwright").Page;

  while (accountIdx < accountsList.length) {
    const acctName = accountsList[accountIdx];
    resolveAccount(acctName, accountIdx);
    if (accountIdx > 0) logAlways(`🔄 アカウント[${acctName}]で再試行 (${accountIdx + 1}/${accountsList.length})`);

    // daemon に接続（なければ自動起動）
    await ensureDaemon();
    ctx = await connectToDaemon();

    // タブ取得（2番目以降は常に新規タブ）
    page = await getOrCreateTab(ctx, accountIdx === 0 ? (session?.url ?? null) : null);

    try {
      if (!session || accountIdx > 0 || page.url() === "about:blank" || page.url() === "") {
        log(`🔗 ${newChatUrl} を開いています...`);
        await page.goto(newChatUrl, { waitUntil: "networkidle", timeout: 60000 });
        await page.waitForTimeout(3000);

        // Auto-dismiss cookie consent banner if present
        try {
          const consentBtn = await page.$('button:has-text("同意する"), button:has-text("Accept"), button:has-text("I agree"), button[aria-label="Accept"]');
          if (consentBtn) {
            await consentBtn.click();
            log("🍪 Cookie consent を自動で承認しました");
            await page.waitForTimeout(1000);
          }
        } catch { /* consent not present */ }
      } else {
        await page.bringToFront();
        log(`🔗 既存タブをフォアグラウンドに: ${page.url()}`);
        await page.waitForTimeout(1000);
      }

      // ログイン確認
      const inputEl = await findInput(page);
      if (!inputEl) {
        const needsLogin = await page.$('a[href*="accounts.google.com"], button:has-text("Sign in")');
        if (needsLogin) {
          logAlways(`🔐 [${acctName}] Google ログインが必要です。ブラウザでログインしてください。`);
          logAlways("   ログイン後、再度 'gapr run' を実行してください。");
          return;
        }
        await page.screenshot({ path: path.join(roundPath, "debug-no-input.png"), fullPage: true });
        logAlways("❌ 入力欄が見つかりません（debug-no-input.png を確認）");
        process.exit(1);
      }

      // Install passive response listener BEFORE sending the prompt to capture Gemini API responses.
      // Uses page.on("response") — non-intercepting, won't crash on streaming responses.
      installResponseInterceptor(page);

      log("📋 プロンプト入力中...");
      const sent = await typeAndSend(page, inputEl, prompt);
      if (!sent) {
        log("⚠️  送信不明");
        await page.screenshot({ path: path.join(roundPath, "debug-send.png") });
      } else {
        log("✅ 送信完了");
      }

      // Quota チェック
      await page.waitForTimeout(3000);
      if (await checkQuota(page)) {
        logAlways(`❌ [${acctName}] クォータ超過`);
        await page.screenshot({ path: path.join(roundPath, `quota-error-${acctName}.png`) });
        accountIdx++;
        if (accountIdx < accountsList.length) {
          logAlways(`🔄 次のアカウント [${accountsList[accountIdx]}] に切替...`);
          await ctx.browser()?.close();
          continue;
        }
        logAlways("❌ 全アカウントのクォータ超過。後で再試行してください。");
        process.exit(10);
      }
      break; // quota OK → proceed

    // セッションURL保存（new_chat → /prompts/<id> に変わるタイミング）
    await page.waitForTimeout(5000);
    const curUrl = page.url();
    if (curUrl.includes("/prompts/") && !curUrl.includes("new_chat")) {
      saveSession(projectRoot, args.workflow, model, curUrl, roundNum);
      log(`💾 セッションURL保存: ${curUrl}`);
      fs.writeFileSync(path.join(roundPath, "session-url.txt"), curUrl);
    }

    await page.screenshot({ path: path.join(roundPath, "post-send.png"), fullPage: true });

    log("⏳ Gemini レスポンス待機中...");
    const response = await waitForResponse(page, sent ? 300 : 30);

    const isExtractionFailure = response.startsWith("[GAPR_EXTRACTION_FAILED]");
    if (!isExtractionFailure && response.length > 500) {
      log(`✅ レスポンス: ${response.length} chars`);
      fs.writeFileSync(path.join(roundPath, "response.md"), response);
    } else {
      log(`⚠️  レスポンス不十分 (${response.length} chars, extraction_failed=${isExtractionFailure}) → 診断情報保存`);
      const full = await page.evaluate(() => document.body.innerText).catch(() => "");
      const cleaned = cleanUiChrome(full);
      // Save both raw (for debugging) and cleaned (for possible use)
      fs.writeFileSync(path.join(roundPath, "response-partial.md"),
        `<!-- GAPR: extraction incomplete. Cleaned body text below. Raw body: ${full.length} chars -->\n\n${cleaned}`);
      fs.writeFileSync(path.join(roundPath, "response-debug.txt"),
        `--- GAPR Extraction Debug ---\nwaitForResponse returned: ${response.length} chars\nisExtractionFailure: ${isExtractionFailure}\nRaw body.innerText: ${full.length} chars\nCleaned: ${cleaned.length} chars\n\n--- Raw Response ---\n${response}\n\n--- Cleaned Body ---\n${cleaned}`);
    }

    await page.screenshot({ path: path.join(roundPath, "screenshot.png"), fullPage: true });
    logAlways(`\n🎉 Round ${roundNum} 完了 → ${roundPath}/`);

    } catch (err) {
      logAlways("❌ エラー:", err);
      await page.screenshot({ path: path.join(roundPath, "error.png") }).catch(() => {});
      process.exit(1);
    }
  } // end while (multi-account loop)

  // タブは残す（daemon が管理）。CDP接続のみ閉じる。
  await ctx.browser()?.close();
}

function cmdList(projectRoot: string): void {
  let found = false;
  for (const base of [".apr", ".gapr"]) {
    const dir = path.join(projectRoot, base, "workflows");
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
      const name = f.replace(".yaml", "");
      const cfg = loadWorkflowConfig(projectRoot, name);
      logAlways(`  ${name}${cfg?.description ? ` — ${cfg.description}` : ""}`);
      found = true;
    }
  }
  if (!found) logAlways("ワークフローなし。'gapr setup' でセットアップしてください。");
}

function cmdHistory(args: CliArgs, projectRoot: string): void {
  const cfg = loadWorkflowConfig(projectRoot, args.workflow);
  if (!cfg) { logAlways(`ワークフロー '${args.workflow}' が見つかりません`); return; }
  const dir = roundsDir(projectRoot, cfg);
  if (!fs.existsSync(dir)) { logAlways("ラウンド履歴なし"); return; }
  const rounds = fs.readdirSync(dir).filter((f) => /^round-\d+$/.test(f))
    .sort((a, b) => parseInt(a.split("-")[1]) - parseInt(b.split("-")[1]));
  logAlways(`\nワークフロー: ${args.workflow} (${rounds.length} rounds)\n`);
  for (const r of rounds) {
    const rp = path.join(dir, r);
    const ok = fs.existsSync(path.join(rp, "response.md"));
    const url = fs.existsSync(path.join(rp, "session-url.txt"))
      ? fs.readFileSync(path.join(rp, "session-url.txt"), "utf-8").trim() : "";
    logAlways(`  ${r}: ${ok ? "✅" : "⚠️ "}${url ? ` — ${url}` : ""}`);
  }
}

async function cmdSetup(args: CliArgs, projectRoot: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise((r) => rl.question(q, r));

  logAlways("\n🔧 gapr セットアップウィザード\n");
  const name = await ask(`ワークフロー名 [${args.workflow}]: `) || args.workflow;
  const desc = await ask("説明: ");
  const readme = await ask("README / 概要ファイルのパス (空でスキップ): ");
  const spec = await ask("計画・仕様ドキュメントのパス: ");
  const impl = await ask("実装詳細のパス (空でスキップ): ");
  const model = await ask(`Gemini モデル [${DEFAULT_MODEL}]: `) || DEFAULT_MODEL;
  rl.close();

  const aprDir = path.join(projectRoot, ".apr");
  fs.mkdirSync(path.join(aprDir, "workflows"), { recursive: true });
  fs.mkdirSync(path.join(aprDir, "spec"), { recursive: true });
  fs.mkdirSync(path.join(aprDir, "rounds", name), { recursive: true });

  const yaml = [
    `# gapr Workflow — generated ${new Date().toISOString()}`,
    `name: ${name}`,
    `description: "${desc}"`,
    ``,
    `documents:`,
    readme ? `  readme: "${readme}"` : `  # readme: ""`,
    spec ? `  spec: "${spec}"` : `  spec: ""`,
    impl ? `  implementation: "${impl}"` : `  # implementation: ""`,
    ``,
    `model: "${model}"`,
    ``,
    `rounds:`,
    `  output_dir: ".apr/rounds/${name}"`,
  ].join("\n");

  const fp = path.join(aprDir, "workflows", `${name}.yaml`);
  fs.writeFileSync(fp, yaml);
  logAlways(`\n✅ 保存: ${fp}`);
  logAlways(`\n次のステップ:`);
  logAlways(`  gapr daemon        # Chrome 起動（初回のみ）`);
  logAlways(`  gapr run --new -w ${name}   # レビュー開始`);
}

function showHelp(): void {
  logAlways(`
gapr — Gemini Automated Plan Reviser (Playwright Edition)
API key 不要。Google AI Studio をブラウザで自動操作。

━━ コマンド ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  gapr daemon             Chrome を起動して待機（デーモンモード）
  gapr status             daemon の状態・タブ一覧を表示
  gapr stop               daemon を停止

  gapr run                ワークフロー default でラウンド実行
  gapr run --new          強制新規チャット（セッション無視）
  gapr run -w NAME        ワークフロー指定
  gapr run -i             実装ドキュメントも含める
  gapr run --dry-run      Chrome 不要・プロンプト確認のみ
  gapr run --quiet        最小限ログ（flywheel/CI 向け）

  gapr setup              新規ワークフロー作成ウィザード
  gapr list               ワークフロー一覧
  gapr history            ラウンド履歴
  gapr help               このヘルプ

━━ オプション（run コマンド） ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  -w, --workflow NAME     ワークフロー名（デフォルト: default）
  --new                   強制新規チャット
  --model MODEL           Gemini モデル（デフォルト: ${DEFAULT_MODEL}）
  --dry-run               プロンプト確認のみ（Chrome 不要）
  -i, --include-impl      実装ドキュメントも含める
  --quiet                 最小限ログ

━━ ブラウザ管理（重要） ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Chrome は「daemon」1プロセスが管理し、全エージェントが
  CDP (Chrome DevTools Protocol) で接続してタブを共有します。

  セッション URL = タブの ID として機能するため、
  複数エージェントが同時実行しても絶対に混線しません。

  daemon が未起動の場合、gapr run が自動起動を試みます。

━━ 初回セットアップ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  gapr daemon             # Chrome 起動
  gapr setup              # ワークフロー設定
  gapr run --new          # 初回レビュー（ブラウザで Google ログイン）
  gapr run                # 2回目以降は自動で既存会話を継続

━━ 複数エージェントの並列実行 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  # daemon は1つ。タブで並列。
  Agent-A: gapr run -w default      → タブ1
  Agent-B: gapr run -w arch-consult → タブ2（混線なし）
  Agent-C: gapr run -w default      → タブ1 を再利用（同じ会話を継続）

━━ 環境変数 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  CHROME__userDataDir    ブラウザプロファイル（デフォルト: ~/.gapr-playwright-profile）
  GAPR__cdpPort           CDP ポート番号（デフォルト: 9322）
  GAPR_CDP_FILE           endpoint ファイルパス（デフォルト: /tmp/gapr-cdp-endpoint.txt）
`);
}

// ---------------------------------------------------------------------------
// Entry Point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  _quiet = args.quiet;

  if (args.command === "daemon") { await cmdDaemon(); return; }
  if (args.command === "status") { await cmdStatus(); return; }
  if (args.command === "stop")   { await cmdStop(); return; }
  if (args.command === "help")   { showHelp(); return; }

  const projectRoot = findProjectRoot();
  if (!args.quiet) log(`📁 プロジェクト: ${projectRoot}`);

  switch (args.command) {
    case "run":     await cmdRun(args, projectRoot); break;
    case "setup":   await cmdSetup(args, projectRoot); break;
    case "list":    cmdList(projectRoot); break;
    case "history": cmdHistory(args, projectRoot); break;
    default:        showHelp();
  }
}

main().catch((e) => { logAlways("❌ Fatal:", e); process.exit(1); });
