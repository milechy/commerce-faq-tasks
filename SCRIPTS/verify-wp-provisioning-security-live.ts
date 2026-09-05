#!/usr/bin/env ts-node
/**
 * SCRIPTS/verify-wp-provisioning-security-live.ts
 *
 * C-1実地確認（受け入れ条件 §7、docs/WORDPRESS_PLUGIN_REQUIREMENTS.md）:
 * 「サイト所有証明を通さずにAPIキーが発行できない」ことを、モックではなく
 * 実際に稼働している R2C の provision API に対して直接確認する。
 *
 * wpSiteVerifier.test.ts / wpProvisionRoutes.test.ts はこの不変条件を
 * モックで単体・統合テストとして既に十分にカバーしている(WP-11 E2E作業で
 * 確認済み)。このスクリプトが追加で担保するのは「モックの前提が実際の
 * 本番/ステージング環境の挙動と食い違っていないか」であり、CI では
 * 自動実行しない —— 実サイト(example.com)に対して実際に外部からの
 * HTTPリクエスト(SSRF検証エンドポイントの読み取りアクセス)を発生させる、
 * 副作用のある手動確認ツール。
 *
 * やること:
 *   1. 自分たちが所有していないドメイン(既定: https://example.com)を
 *      site_url として POST /v1/public/wp/provision を叩く
 *   2. GET /v1/public/wp/provision/:token を一定間隔でポーリングする
 *   3. どのポーリング応答にも api_key が一度も含まれないことを確認する
 *      (含まれていたら重大なセキュリティ不具合 — サイト所有証明を
 *      経ずにキーが発行されたことになる)
 *
 * 使い方:
 *   API_BASE=https://api.r2c.biz CONFIRM=yes pnpm ts-node \
 *     SCRIPTS/verify-wp-provisioning-security-live.ts
 *
 *   # ステージング/開発環境に対して:
 *   API_BASE=http://localhost:3000 CONFIRM=yes pnpm ts-node \
 *     SCRIPTS/verify-wp-provisioning-security-live.ts
 *
 * 環境変数:
 *   API_BASE    既定 https://api.r2c.biz。本番へ実際にリクエストが飛ぶため
 *               CONFIRM=yes と組み合わせて意図的に指定すること。
 *   CONFIRM     "yes" でない場合は何もせず案内だけ表示して終了する
 *               (誤ってCIや他のスクリプトから呼ばれても実行されないための
 *               安全弁)。
 *   SITE_URL    既定 https://example.com(IANA予約ドメイン。常に公開されて
 *               おり、かつ確実にこちらの検証エンドポイントを持たない)。
 *   TEST_EMAIL  既定 wp-c1-live-check@example.com。所有権証明に失敗する
 *               限り招待メールは送られない(completeWpProvisioning は
 *               検証成功後にしか呼ばれないため)。
 *   MAX_POLLS   既定 20(3秒間隔で約1分)。
 *
 * 終了コード:
 *   0 = PASS       全ポーリングを通じて api_key は一度も発行されなかった
 *   1 = FAIL       api_key が発行された(重大なセキュリティ不具合)
 *   2 = SKIP/ERROR API自体に到達できない等、この確認自体が実行できなかった
 *                  (「不具合が無い」の証明にはならない — オオカミ少年を
 *                  避けるため check-groq-models-live.sh と同じ方針で
 *                  FAILとは区別する)
 */

import { setTimeout as sleep } from "node:timers/promises";

const API_BASE = process.env.API_BASE ?? "https://api.r2c.biz";
const SITE_URL = process.env.SITE_URL ?? "https://example.com";
const TEST_EMAIL = process.env.TEST_EMAIL ?? "wp-c1-live-check@example.com";
const MAX_POLLS = Number(process.env.MAX_POLLS ?? 20);
const POLL_INTERVAL_MS = 3000;

function log(msg: string) {
  console.log(`[verify-wp-provisioning-security-live] ${msg}`);
}

async function main(): Promise<number> {
  if (process.env.CONFIRM !== "yes") {
    log(
      `未実行(安全弁): CONFIRM=yes を指定すると ${API_BASE} へ実際にリクエストを送ります。\n` +
        `  例: API_BASE=${API_BASE} CONFIRM=yes pnpm ts-node SCRIPTS/verify-wp-provisioning-security-live.ts`
    );
    return 2;
  }

  log(`対象: ${API_BASE}`);
  log(`所有していないドメインとして申告する site_url: ${SITE_URL}`);

  let provisionRes: Response;
  try {
    provisionRes = await fetch(`${API_BASE}/v1/public/wp/provision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        site_url: SITE_URL,
        email: TEST_EMAIL,
        site_name: "C-1 live verification (not a real site)",
        wp_version: "6.6",
        plugin_version: "0.1.0",
        locale: "ja",
      }),
    });
  } catch (err) {
    log(`SKIP: provision APIに到達できなかった: ${(err as Error).message}`);
    return 2;
  }

  if (!provisionRes.ok) {
    log(`SKIP: POST /v1/public/wp/provision が ${provisionRes.status} を返した(この確認自体が実行できていない)`);
    return 2;
  }

  const provisionBody = (await provisionRes.json()) as { poll_token?: string };
  if (!provisionBody.poll_token) {
    log("SKIP: poll_token が返らなかった(レスポンス形式の変更等、この確認自体が実行できていない)");
    return 2;
  }
  log(`poll_token を取得。ポーリング開始(最大${MAX_POLLS}回、${POLL_INTERVAL_MS}ms間隔)`);

  for (let i = 1; i <= MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);

    let pollRes: Response;
    try {
      pollRes = await fetch(`${API_BASE}/v1/public/wp/provision/${encodeURIComponent(provisionBody.poll_token)}`);
    } catch (err) {
      log(`SKIP: ポーリング中に到達できなくなった: ${(err as Error).message}`);
      return 2;
    }

    if (pollRes.status === 404) {
      log(`[${i}/${MAX_POLLS}] 404 (試行が見つからない/期限切れ) — api_keyは発行されなかった`);
      log("PASS: サイト所有証明を経ずにAPIキーが発行されることはなかった");
      return 0;
    }

    const pollBody = (await pollRes.json()) as {
      status?: string;
      api_key?: string;
      verify_reason?: string;
      wait_reason?: string;
      reason?: string;
    };

    if (pollBody.api_key) {
      log(
        `[${i}/${MAX_POLLS}] FAIL: status=${pollBody.status} で api_key が返された。` +
          "サイト所有証明を経ずにAPIキーが発行された — 重大なセキュリティ不具合。"
      );
      return 1;
    }

    log(
      `[${i}/${MAX_POLLS}] status=${pollBody.status ?? "?"}` +
        (pollBody.verify_reason ? ` verify_reason=${pollBody.verify_reason}` : "") +
        (pollBody.wait_reason ? ` wait_reason=${pollBody.wait_reason}` : "") +
        (pollBody.reason ? ` reason=${pollBody.reason}` : "")
    );

    if (pollBody.status === "expired" || pollBody.status === "failed") {
      log("PASS: サイト所有証明が完了しないまま終端に達し、APIキーは一度も発行されなかった");
      return 0;
    }
  }

  log(
    `PASS(暫定): ${MAX_POLLS}回のポーリングを通じてapi_keyは一度も発行されなかった。` +
      "終端状態(expired/failed)には到達していないため、TTLが長い場合はMAX_POLLSを増やして再確認することを推奨。"
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[verify-wp-provisioning-security-live] 予期しないエラー:", err);
    process.exit(2);
  });
