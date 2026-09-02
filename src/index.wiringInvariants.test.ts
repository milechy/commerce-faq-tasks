// src/index.wiringInvariants.test.ts
//
// src/index.ts は app.listen() を含む起動エントリポイントで、DB/ES接続などの
// 副作用を伴うため supertest で丸ごとimportして統合テストすることができない。
// そのためミドルウェア登録順序という「型では守れない・実行時にしか壊れない」
// 不変条件を、ソースを直接読んで機械的に検査する(confirmPolicy.test.ts と同じ手法)。
//
// このファイルが守る不変条件はいずれも過去に一度壊れた実績がある:
// - webhook登録順序: グローバル express.json が先に来ると req.body が object化され、
//   Stripe署名検証(constructEvent)が常に失敗する(今回のC0修正の対象そのもの)。
// - apiStackの順序: レートリミッタをauth前に置くと全テナント合算の単一バケットになる。
// - search/dialogのtenantId伝播漏れ: legacy検索がデフォルトインデックスへ無差別に流れる。

import { readFileSync } from "fs";
import { join } from "path";

const SOURCE_PATH = join(__dirname, "index.ts");
const source = readFileSync(SOURCE_PATH, "utf-8");

function firstIndexOf(pattern: RegExp): number {
  const m = source.match(pattern);
  if (!m || m.index === undefined) {
    throw new Error(`pattern not found in src/index.ts: ${pattern}`);
  }
  return m.index;
}

describe("src/index.ts 配線の不変条件（ソース構造検査）", () => {
  describe("Stripe webhook 登録順序", () => {
    it("/v1/billing/webhook の登録が、グローバル express.json より前にある", () => {
      const webhookIdx = firstIndexOf(/app\.post\(\s*["']\/v1\/billing\/webhook["']/);
      const jsonIdx = firstIndexOf(/app\.use\(express\.json\(/);
      expect(webhookIdx).toBeLessThan(jsonIdx);
    });

    it("webhook 登録が express.raw({ type: \"application/json\" }) を使っている（rawボディでの署名検証が前提）", () => {
      const webhookBlock = source.slice(
        firstIndexOf(/app\.post\(\s*["']\/v1\/billing\/webhook["']/),
        firstIndexOf(/app\.post\(\s*["']\/v1\/billing\/webhook["']/) + 300
      );
      expect(webhookBlock).toMatch(/express\.raw\(\s*\{\s*type:\s*["']application\/json["']\s*\}\s*\)/);
    });

    it("webhook ルートは1箇所にしか登録されていない（重複登録による二重処理を防ぐ）", () => {
      const matches = source.match(/app\.(post|use)\(\s*["']\/v1\/billing\/webhook["']/g) ?? [];
      expect(matches.length).toBe(1);
    });
  });

  describe("apiStack のミドルウェア順序（レートリミッタ2段化）", () => {
    // apiStack リテラルの解析を it() の内側に置く: describe 直下（it の外）で throw すると
    // スイート読み込み自体がクラッシュし、他の describe のテストまで巻き込んで
    // 「何が壊れたか」が読み取れなくなる。it() 内の失敗として報告されるよう、
    // 解析をこの関数に閉じ込めて各 it() から呼び出す。
    function getApiStackOrder(): string[] {
      const apiStackMatch = source.match(/const apiStack = \[([\s\S]*?)\] as express\.RequestHandler\[\];/);
      if (!apiStackMatch) throw new Error("apiStack literal not found in src/index.ts");
      const apiStackBody = apiStackMatch[1];
      // 行コメント（例: "// 1. Rate limit (pre-auth, IP-keyed)"）はカンマを含みうるため、
      // まず行ごとに "//" 以降を切り捨ててから識別子を抽出する（単純な split(",") はコメント内の
      // カンマで誤爆する）。
      return apiStackBody
        .split("\n")
        .map((line) => line.split("//")[0].trim().replace(/,$/, ""))
        .filter((name) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name));
    }

    it("ipRateLimiter が authMiddleware より前（認証前のIP段）", () => {
      const order = getApiStackOrder();
      expect(order.indexOf("ipRateLimiter")).toBeGreaterThanOrEqual(0);
      expect(order.indexOf("ipRateLimiter")).toBeLessThan(order.indexOf("authMiddleware"));
    });

    it("tenantRateLimiter が authMiddleware・tenantContext より後（認証後のtenant段）", () => {
      const order = getApiStackOrder();
      expect(order.indexOf("tenantRateLimiter")).toBeGreaterThan(order.indexOf("authMiddleware"));
      expect(order.indexOf("tenantRateLimiter")).toBeGreaterThan(order.indexOf("tenantContext"));
    });

    it("apiStack に旧単一リミッタ(globalRateLimiter)が残っていない（2段化の巻き戻り検出）", () => {
      const order = getApiStackOrder();
      expect(order).not.toContain("globalRateLimiter");
    });

    it("securityPolicy が authMiddleware より後（テナント未確定でorigin検証しない）", () => {
      const order = getApiStackOrder();
      expect(order.indexOf("securityPolicy")).toBeGreaterThan(order.indexOf("authMiddleware"));
    });
  });

  describe("legacy 検索・対話エンドポイントへの tenantId 伝播", () => {
    it("/search が hybridSearch に tenantId を渡している", () => {
      const searchBlock = source.slice(
        firstIndexOf(/app\.post\(\s*["']\/search["'],/),
        firstIndexOf(/app\.post\(\s*["']\/search\.v1["']/)
      );
      expect(searchBlock).toMatch(/hybridSearch\(\s*q\s*,\s*tenantId\s*\)/);
    });

    it("/search.v1 が hybridSearch に tenantId を渡している", () => {
      const idx = firstIndexOf(/app\.post\(\s*["']\/search\.v1["']/);
      const block = source.slice(idx, idx + 2000);
      expect(block).toMatch(/hybridSearch\(\s*q\s*,\s*tenantId\s*\)/);
    });

    it("/dialog/turn が runDialogTurn に tenantId を含めて渡している", () => {
      const idx = firstIndexOf(/app\.post\(\s*["']\/dialog\/turn["']/);
      const block = source.slice(idx, idx + 3000);
      // Phase69-2 [外1]: excluded_ids のマージ結果を options に上書きするため
      // ...parsed.data, tenantId の直後に options: {...} が続く形に変わった。
      expect(block).toMatch(
        /runDialogTurn\(\s*\{\s*\.\.\.parsed\.data\s*,\s*tenantId\s*,\s*options:\s*\{/
      );
    });

    it("/search・/search.v1・/dialog/turn は3箇所とも (req as AuthedRequest).tenantId から取得している（body/queryからの取得を禁止 — CLAUDE.md不変条件1）", () => {
      // AuthedRequest 経由の取得パターンが最低3回（各ルート1回ずつ）出現することを確認
      const authedTenantIdUses = source.match(/\(req as AuthedRequest\)\.tenantId/g) ?? [];
      expect(authedTenantIdUses.length).toBeGreaterThanOrEqual(3);
      // body/query からの tenantId 直接取得が無いこと
      expect(source).not.toMatch(/req\.body\.tenantId/);
      expect(source).not.toMatch(/req\.query\.tenantId/);
    });
  });

  // PR-3(2026-08-25収益監査): Stripe送信バッチが起動直後の tick を持たず、
  // デプロイ頻度が高いR2Cでは実質一度も走らない状態になり得ていた
  // (billingHealthMonitor/billingReconciliationMonitorは起動直後に評価するのに
  // 送金する唯一のジョブだけが持っていなかった)。stripeUsageReporter.start()
  // 経由の配線に戻さない(インライン setInterval を復活させない)ことを固定する。
  describe("Stripe usage reporter の起動配線", () => {
    it("stripeUsageReporter.start() 経由で登録されている", () => {
      expect(source).toMatch(/stripeUsageReporter\.start\(\s*db\s*,\s*logger\s*\)/);
    });

    it("インラインの setInterval(直書きのStripe送信スケジューラ)が復活していない", () => {
      // pipelineQueue の stuck-job監視等、index.ts に無関係な setInterval は他にも
      // 存在するため全面禁止はしない。stripeUsageReporter.start() の呼び出し周辺
      // (前後500文字)だけを見て、そこに reportUsageToStripe を直接包む
      // setInterval が復活していないことを確認する。
      const idx = firstIndexOf(/stripeUsageReporter\.start\(/);
      const nearbyBlock = source.slice(Math.max(0, idx - 500), idx + 500);
      expect(nearbyBlock).not.toMatch(/setInterval\(/);
      expect(nearbyBlock).not.toMatch(/reportUsageToStripe/);
    });

    it("STRIPE_SECRET_KEY 未設定時に無言にならず警告ログを出す", () => {
      const idx = firstIndexOf(/stripeUsageReporter\.start\(/);
      const block = source.slice(Math.max(0, idx - 400), idx + 400);
      expect(block).toMatch(/logger\.warn\(.*STRIPE_SECRET_KEY/s);
    });
  });

  // P1-11(2026-08-26レビュー): billingReconciliationMonitorが導入時に
  // cron/systemd timerのいずれにも登録されず孤立していた(厳格レビューで発覚)
  // のと同じ事故を、billingSyncReconciliationMonitorで再発させない。
  describe("billing_sync 日次照合monitorの起動配線", () => {
    it("billingSyncReconciliationMonitor.start() 経由で起動プロセスへ配線されている", () => {
      expect(source).toMatch(/billingSyncReconciliationMonitor\.start\(\s*db\s*,\s*logger\s*\)/);
    });
  });

  // [P0] セキュリティ: GET /health/business は アクティブ tenant_id 一覧・24h の
  // 会話/CV/RAG 件数・最終会話時刻を返すため、素の /health（機微なし）と違い
  // 内部専用でなければならない（外部から無認証で開示できた実績あり）。/metrics と
  // 同じ二重防御（internalNetworkOnly + X-Internal-Request:1）に配線されている
  // ことを固定する。挙動は index.healthBusinessGuard.test.ts で検証する。
  describe("GET /health/business の内部専用ガード配線 [P0]", () => {
    function healthBusinessBlock(): string {
      const idx = firstIndexOf(/app\.get\(\s*["']\/health\/business["']/);
      // 次の app.get/app.post（/metrics など）までを1ルートのブロックとして切り出す。
      const rest = source.slice(idx + 1);
      const nextIdx = rest.search(/app\.(get|post|use)\(/);
      return source.slice(idx, idx + 1 + (nextIdx >= 0 ? nextIdx : 800));
    }

    it("internalNetworkOnly ミドルウェアを通している（loopback以外は403、ヘッダspoof不可）", () => {
      expect(healthBusinessBlock()).toMatch(/internalNetworkOnly/);
    });

    it("X-Internal-Request ヘッダ（INTERNAL_REQUEST_HEADER）の検査を通している", () => {
      const block = healthBusinessBlock();
      expect(block).toMatch(/INTERNAL_REQUEST_HEADER/);
      expect(block).toMatch(/status\(403\)/);
    });

    it("素の GET /health は公開のまま（内部ガードを付けない — 機微を含まない）", () => {
      const idx = firstIndexOf(/app\.get\(\s*["']\/health["'],\s*healthHandler\s*\)/);
      const block = source.slice(idx, idx + 120);
      expect(block).not.toMatch(/internalNetworkOnly/);
    });
  });

  // [P0] 収益: /dialog/turn・/agent.search・/agent/search は LLM 合成・planner・
  // 埋め込みを実行するのに trackUsage を通っておらず完全に未計上だった。chat 経路
  // (/api/chat) と同じ buildChatUsageTracking で計上する配線を固定する。
  // 二重計上を避けるため合成関数(runDialogTurn/runSearchAgent)の内部ではなく
  // HTTP 直エンドポイント側で計上する（/api/chat は現状維持）。
  describe("課金計上ギャップの配線 [P0]", () => {
    it("/dialog/turn ハンドラが trackUsage を featureUsed:'chat' で呼んでいる", () => {
      const idx = firstIndexOf(/app\.post\(\s*["']\/dialog\/turn["']/);
      // Phase69-2 [外1] で excluded_ids スキーマ + default_excluded_ids の
      // fetch/merge がルート冒頭に増えた分、trackUsage 呼び出しまでの距離が
      // 伸びたためウィンドウを拡張した。
      const block = source.slice(idx, idx + 3500);
      expect(block).toMatch(/trackUsage\(/);
      expect(block).toMatch(/featureUsed:\s*["']chat["']/);
      expect(block).toMatch(/buildChatUsageTracking\(\s*turn\.meta\s*\)/);
    });

    it("/dialog/turn は認証コンテキスト由来の tenantId でのみ計上する（body/ヘッダ非信用）", () => {
      const idx = firstIndexOf(/app\.post\(\s*["']\/dialog\/turn["']/);
      const block = source.slice(idx, idx + 3500);
      // trackUsage は tenantId ガードの内側にある
      expect(block).toMatch(/if\s*\(\s*tenantId\s*\)\s*\{[\s\S]*trackUsage\(/);
    });

    it("index.ts が trackUsage と buildChatUsageTracking を import している", () => {
      expect(source).toMatch(/import\s*\{[^}]*\btrackUsage\b[^}]*\}\s*from\s*["']\.\/lib\/billing\/usageTracker["']/);
      expect(source).toMatch(/import\s*\{[^}]*buildChatUsageTracking[^}]*\}\s*from\s*["']\.\/lib\/billing\/chatUsage["']/);
    });
  });

  // [外1] GID 1218086284362759: /dialog/turn の options に excluded_ids が無く、
  // Zod既定の strip で黙って捨てられていた（AVAS向け仕様書は実装確認済みと誤記）。
  // 実際の safeParse 挙動は src/index.dialogTurnExcludedIds.test.ts が
  // schemaIn 定義の生ソースを抽出して直接検証する（index.ts 丸ごと import 不可のため）。
  // ここでは「そのテストが検査している対象の文字列」が実ソースからズレていないことを
  // 固定する（抽出テストが古いコピーを検査し続ける事故を防ぐ）。
  describe("/dialog/turn options.excluded_ids 配線 [外1]", () => {
    function dialogTurnRouteBlock(): string {
      const idx = firstIndexOf(/app\.post\(\s*["']\/dialog\/turn["']/);
      return source.slice(idx, idx + 2500);
    }

    it("options スキーマに excluded_ids: z.array(z.string()).max(500).optional() を持つ（/agent.search と同一制約）", () => {
      expect(dialogTurnRouteBlock()).toMatch(
        /excluded_ids:\s*z\.array\(z\.string\(\)\)\.max\(500\)\.optional\(\)/
      );
    });

    it("options が .strict() で未知キーを拒否する", () => {
      const block = dialogTurnRouteBlock();
      const optionsIdx = block.indexOf("options: z");
      expect(optionsIdx).toBeGreaterThanOrEqual(0);
      // options: z.object({...}).strict().optional() の並びで .strict() が
      // .object の直後（.optional() より前）に来ていることを確認する。
      const afterOptions = block.slice(optionsIdx, optionsIdx + 800);
      expect(afterOptions).toMatch(/\.strict\(\)\s*\n?\s*\.optional\(\)/);
    });

    it("options 由来の検証エラーは invalid_excluded_ids + Zod flatten() で返す", () => {
      const block = dialogTurnRouteBlock();
      expect(block).toMatch(/error:\s*["']invalid_excluded_ids["']/);
      expect(block).toMatch(/details:\s*parsed\.error\.flatten\(\)/);
    });

    it("options に無関係な検証エラー（message欠落等）は従来どおり invalid_request のまま", () => {
      const block = dialogTurnRouteBlock();
      expect(block).toMatch(/error:\s*["']invalid_request["']/);
    });

    // レビュー指摘(2026-09-02): 当初 default_excluded_ids の fetch/merge を
    // runDialogTurn(dialogAgent.ts) の内部に置いたところ、runDialogTurn は
    // /api/chat からも呼ばれる共有関数のため、/api/chat の全トラフィックにも
    // 無条件のDB往復が増えるという副作用が出た。agentSearchRoute.ts:93-95 の
    // 前例どおり、fetch/merge は HTTP 直エンドポイントである /dialog/turn の
    // ルートハンドラ側だけで行う形に差し戻した。この配置を固定する。
    it("default_excluded_ids の fetch/merge はルートハンドラ側（runDialogTurn呼び出し前）で行う", () => {
      const block = dialogTurnRouteBlock();
      const fetchIdx = block.search(/fetchDefaultExcludedIds\(/);
      const mergeIdx = block.search(/mergeExcludedIds\(/);
      const runDialogTurnIdx = block.search(/runDialogTurn\(/);

      expect(fetchIdx).toBeGreaterThanOrEqual(0);
      expect(mergeIdx).toBeGreaterThanOrEqual(0);
      expect(runDialogTurnIdx).toBeGreaterThanOrEqual(0);
      // fetch → merge → runDialogTurn の順で、fetch/merge の結果が
      // runDialogTurn に渡る前に確定していることを固定する。
      expect(fetchIdx).toBeLessThan(mergeIdx);
      expect(mergeIdx).toBeLessThan(runDialogTurnIdx);
    });

    it("index.ts が fetchDefaultExcludedIds / mergeExcludedIds を lib/defaultExcludedIds から import している", () => {
      expect(source).toMatch(
        /import\s*\{[^}]*fetchDefaultExcludedIds[^}]*mergeExcludedIds[^}]*\}\s*from\s*["']\.\/lib\/defaultExcludedIds["']/
      );
    });

    it("runDialogTurn(dialogAgent.ts) は default_excluded_ids 用のDBフェッチを行わない（/api/chat への副作用防止）", () => {
      const dialogAgentSource = readFileSync(
        join(__dirname, "agent", "dialog", "dialogAgent.ts"),
        "utf-8"
      );
      expect(dialogAgentSource).not.toMatch(/fetchDefaultExcludedIds/);
      expect(dialogAgentSource).not.toMatch(/mergeExcludedIds/);
    });
  });
});
