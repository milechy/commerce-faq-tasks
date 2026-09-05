// src/api/widget/shopifyBillingSync.ts
//
// Shopify Billing の App Events API へ「会話1件」単位のメーター報告を行う層
// (Asana 1218199856728312)。要件: docs/SHOPIFY_APP_REQUIREMENTS.md §5.2, D3, D12, D13, D17。
//
// ★スコープ★
// このファイルが担うのは「会話1件の報告 → 冪等キーの組み立て → usage_logs への
// 突合フラグ記録」までであり、usageTracker.ts からの実配線(呼び出し)は別タスク09で
// 行う(usageTracker.ts 自体はこのファイルから一切変更しない — 呼ぶだけ)。
// 同様に、原価集計(tenantEconomics.ts)側での「usage_logs 件数 と Shopify 報告件数の
// 突合」監視ダッシュボードの実装も本タスクのスコープ外(§5.2 に明記: 実装時に別途設計)。
//
// ★請求の起点はShopify側(D3)★
// 既存 Stripe 課金レール(src/lib/billing/stripeSync.ts / computeExpectedBilling)とは
// 完全に独立させる。ここから stripeSync.ts を呼ばない・参照しない。
//
// ★実際に課金される金額はPartner Dashboardのメーター単価が決める★
// App Events API は「1会話 = 1イベント発生」を報告するだけで、価格(JPY建て、D13)は
// Shopify 側のメーター定義に紐づく。このファイルは price を計算・送信しない
// (実装すると「公開価格=実際の請求額」の単一情報源が Partner Dashboard とこのファイルの
// 2箇所に割れる — CLAUDE.md 禁止54と同型のリスク)。
//
// ★Shopify Admin GraphQL API 呼び出しについて(要件 §11.2 の遵守)★
// 「フィールド名を推測で書かない」との明文規定があるため、本実装のミューテーション名・
// 引数名は現時点(2026-09-05, docs/SHOPIFY_APP_REQUIREMENTS.md 記載のApp Events API解説)
// での理解に基づく暫定実装であることを明示する。実際の Partner Dashboard / Admin
// GraphQL API スキーマでの実機確認(型確認)は D-2(§7 受け入れ条件: 開発ストア/
// テストモードで確認)で行うこと。変更点はこのファイル内の APP_EVENTS_MUTATION
// 定数1箇所に閉じているため、確認後の修正はここだけで完結する。
//
// ★冪等キー(CLAUDE.md 命名節: 実行系の冪等キーは操作対象+操作種別から導出)★
// shopDomain + conversationId から導出する決定的な文字列にする。時刻・乱数を
// 含めない(含めるとリトライで二重計上になる — usageTracker.ts の request_id と
// 同じ理由)。
//
// db は引数で受け取る。内部で getPool() を呼ばない
// (shopifyRepository.ts / shopifyOAuthRoutes.ts と同じ方針)。
//
// アクセストークンの SELECT について: findTenantByShopDomain(shopifyRepository.ts)の
// 一般 SELECT は秘密値(shopify_access_token_encrypted)を含めない設計になっているため
// (WP版の秘密値除外方針の踏襲)、ここでは独立した最小スコープの SELECT を持つ
// (wpProvisionRepository.ts の getWpProvisioningChallengeHashForVerification と
// 同じ「検証専用・他のSELECTに混ぜない」方針)。新規ファイルはこの実装+テストの
// 2つのみという制約のため、shopifyRepository.ts には追加せずこのファイル内に閉じる。

import type { Pool } from "pg";
import { decryptText } from "../../lib/crypto/textEncrypt";
import { usdToJpy } from "../../lib/billing/fx";
import { logger } from "../../lib/logger";

/** shopifyRepository.ts と同じ最小インターフェース。 */
type Db = Pick<Pool, "query">;

// ---------------------------------------------------------------------------
// 設定値(遅延読み込み — テストで process.env を切り替えられるようにする。
// shopifyOAuthRoutes.ts の getShopifyApiKey 等と同じ「都度読む」方針)
// ---------------------------------------------------------------------------
function getShopifyApiVersion(): string {
  return process.env.SHOPIFY_API_VERSION || "2025-01";
}

/** Partner Dashboard で定義したメーターの handle(§5.2)。会話課金は既定 "conversation"。 */
function getShopifyConversationMeterHandle(): string {
  return process.env.SHOPIFY_CONVERSATION_METER_HANDLE || "conversation";
}

function buildAppEventsApiUrl(shopDomain: string): string {
  return `https://${shopDomain}/admin/api/${getShopifyApiVersion()}/graphql.json`;
}

// ---------------------------------------------------------------------------
// 冪等キー
// ---------------------------------------------------------------------------
/**
 * Shopify App Events API への報告に使う冪等キー。
 * shopDomain + conversationId のみから導出する決定的な文字列(時刻・乱数を含まない)。
 * 同一会話の再送(タイムアウト後リトライ・重複呼び出し)は常に同じキーになるため、
 * App Events API 側の冪等性保護(§5.2「恒久的に冪等性が保護されることを確認済み」)により
 * 二重計上されない。
 */
export function buildShopifyUsageIdempotencyKey(
  shopDomain: string,
  conversationId: string
): string {
  return `shopify-conversation-usage:${shopDomain}:${conversationId}`;
}

// ---------------------------------------------------------------------------
// App Events API 呼び出し
// ---------------------------------------------------------------------------
// ★要確認(§11.2)★ ミューテーション名・引数名は現時点の理解に基づく暫定実装。
// Partner Dashboard の実スキーマで確認後、ここだけを直せばよいように1箇所へ閉じる。
const APP_EVENTS_MUTATION = `
  mutation ReportConversationUsage($input: AppUsageEventInput!) {
    appUsageEventCreate(appUsageEvent: $input) {
      appUsageEvent { id }
      userErrors { field message }
    }
  }
`;

/** GraphQL リクエストボディを組み立てる(純粋関数、テスト用に export)。 */
export function buildAppEventsApiRequestBody(
  eventHandle: string,
  idempotencyKey: string,
  occurredAt: Date
): { query: string; variables: Record<string, unknown> } {
  return {
    query: APP_EVENTS_MUTATION,
    variables: {
      input: {
        eventHandle,
        idempotencyKey,
        occurredAt: occurredAt.toISOString(),
      },
    },
  };
}

async function sendAppEventsApiRequest(
  shopDomain: string,
  accessToken: string,
  idempotencyKey: string,
  occurredAt: Date
): Promise<Response> {
  const body = buildAppEventsApiRequestBody(
    getShopifyConversationMeterHandle(),
    idempotencyKey,
    occurredAt
  );
  return fetch(buildAppEventsApiUrl(shopDomain), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// テナント解決(アクセストークンは専用SELECTでのみ取得。§冒頭の方針参照)
// ---------------------------------------------------------------------------
interface ShopifyAccessCredentials {
  tenantId: string;
  /** 暗号化済み。decryptText() を通してから使う。 */
  accessTokenEncrypted: string;
}

async function getShopifyAccessCredentialsByShopDomain(
  db: Db,
  shopDomain: string
): Promise<ShopifyAccessCredentials | null> {
  const result = await db.query(
    `SELECT id, shopify_access_token_encrypted
       FROM tenants
      WHERE shopify_shop_domain = $1
        AND shopify_access_token_encrypted IS NOT NULL`,
    [shopDomain]
  );
  const row = result.rows[0] as
    | { id: string; shopify_access_token_encrypted: string }
    | undefined;
  if (!row) return null;
  return { tenantId: row.id, accessTokenEncrypted: row.shopify_access_token_encrypted };
}

/**
 * tenantId から shop ドメインを引く(usageTracker 側の統合ポイントは tenantId しか
 * 知らないため必要)。Shopify 経由でないテナント(shopify_shop_domain が NULL)は
 * null を返す(禁止20: 「対象外」を「空文字」等で誤魔化さない)。
 */
async function getShopDomainByTenantId(db: Db, tenantId: string): Promise<string | null> {
  const result = await db.query(
    `SELECT shopify_shop_domain FROM tenants WHERE id = $1 AND shopify_shop_domain IS NOT NULL`,
    [tenantId]
  );
  const row = result.rows[0] as { shopify_shop_domain: string } | undefined;
  return row?.shopify_shop_domain ?? null;
}

// ---------------------------------------------------------------------------
// usage_logs 突合フラグの更新(報告失敗検知の材料 — §5.2)
// ---------------------------------------------------------------------------
/**
 * 会話(tenantId + conversationId = usage_logs.session_id)に属する未報告の
 * usage_logs 行すべてに shopify_event_reported_at を書き込む。
 *
 * NULL のまま残る行(このテナントが Shopify 経由なのに報告されなかった行)を
 * 数えることで報告漏れを検知できる(§5.2 の監視項目。実際の突合クエリは
 * tenantEconomics.ts 側で別途実装 — 本タスクのスコープ外)。
 *
 * 戻り値は実際に更新できた行数(0 は「対象行が無い/既に報告済み」を意味し、
 * エラーではない)。
 *
 * 列は usage_logs.shopify_event_reported_at(migration_usage_logs_shopify_event.sql、
 * 本タスク時点ではDBに未適用・別PRで人間承認待ち)。未適用のDBに対してこの関数を
 * 呼ぶと 42703(undefined_column) で例外になる — 呼び出し側(タスク09の配線)が
 * fire-and-forget で包む場合はここで throw させず catch させること(usageTracker.ts
 * の trackUsage と同じ「記録の失敗でユーザー応答を変えない」方針に委ねる)。
 */
export async function markUsageReportedToShopify(
  db: Db,
  tenantId: string,
  conversationId: string,
  reportedAt: Date
): Promise<number> {
  const result = await db.query(
    `UPDATE usage_logs
        SET shopify_event_reported_at = $3
      WHERE tenant_id = $1
        AND session_id = $2
        AND shopify_event_reported_at IS NULL`,
    [tenantId, conversationId, reportedAt]
  );
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// 金額表示(D13: プランはJPY建てが原則 / D17: 海外マーチャントはShopify側でUSD等に
// 変換表示される)。実際の請求額はPartner Dashboardのメーター単価が決めるため、
// この関数の戻り値は請求そのものには使わない。社内の監査ログ・監視画面(§5.2の
// 突合ダッシュボード等、実装時に別途設計)向けの参考表示を組み立てるだけの
// 純粋関数(独自の換算ロジックは書かず fx.ts の usdToJpy を呼ぶだけ — 制約)。
// ---------------------------------------------------------------------------
export interface ShopifyMeterAmountDisplay {
  currency: "JPY" | "USD";
  amount: number;
  /** currency が "USD" のときのみ設定。fx.ts 経由の参考JPY換算値(D17)。 */
  referenceJpy: number | null;
}

export function buildShopifyMeterAmountDisplay(
  currency: "JPY" | "USD",
  amount: number
): ShopifyMeterAmountDisplay {
  if (currency === "JPY") {
    return { currency, amount, referenceJpy: null };
  }
  return { currency, amount, referenceJpy: usdToJpy(amount) };
}

// ---------------------------------------------------------------------------
// メーター報告本体
// ---------------------------------------------------------------------------
export type ShopifyBillingReportStatus =
  | "reported"
  | "not_configured"
  | "http_error"
  | "network_error";

export interface ShopifyBillingReportResult {
  status: ShopifyBillingReportStatus;
  idempotencyKey: string | null;
  reportedAt: Date | null;
  /** status が "http_error" のときのみ設定。 */
  httpStatus?: number;
  /** status が "reported" のときのみ設定。markUsageReportedToShopify の戻り値。 */
  usageLogsMarked?: number;
}

/**
 * 会話1件について Shopify App Events API へメーター報告を行う。
 *
 * - shopDomain に対応するテナントが見つからない、またはアクセストークンが
 *   未設定(OAuth 未完了)の場合は "not_configured" を返す(fetch を呼ばない)。
 * - App Events API は同期的な課金エラーを返さない(§5.2)ため、HTTP レベルで
 *   成功(2xx、実運用では常に202)であれば "reported" とし、usage_logs の
 *   突合フラグを更新する。実際の計上可否(検証結果)は Partner Dashboard の
 *   Logs 側でのみ確認できる(このファイルの責務外)。
 * - fetch 自体が失敗(ネットワークエラー)した場合は "network_error"、
 *   Shopify が非2xxを返した場合は "http_error" とし、usage_logs は更新しない
 *   (呼び出し側が再送を判断できるよう、成功時のみフラグを立てる)。
 *
 * この関数自体は fire-and-forget にしない(usageTracker.trackUsage と異なり、
 * 呼び出し側(タスク09の配線)が結果を見てリトライ方針を決められるようにする)。
 */
export async function reportConversationUsageToShopify(
  db: Db,
  shopDomain: string,
  conversationId: string,
  eventTimestamp: Date,
  now: Date = new Date()
): Promise<ShopifyBillingReportResult> {
  const credentials = await getShopifyAccessCredentialsByShopDomain(db, shopDomain);
  if (!credentials) {
    logger.warn(
      { shopDomain, conversationId },
      "[shopifyBillingSync] shop domain not linked to a tenant with an access token — skipping report"
    );
    return { status: "not_configured", idempotencyKey: null, reportedAt: null };
  }

  const idempotencyKey = buildShopifyUsageIdempotencyKey(shopDomain, conversationId);
  const accessToken = decryptText(credentials.accessTokenEncrypted);

  let resp: Response;
  try {
    resp = await sendAppEventsApiRequest(shopDomain, accessToken, idempotencyKey, eventTimestamp);
  } catch (err) {
    logger.warn(
      { err, shopDomain, conversationId, idempotencyKey },
      "[shopifyBillingSync] network error reporting conversation usage to Shopify"
    );
    return { status: "network_error", idempotencyKey, reportedAt: null };
  }

  if (!resp.ok) {
    logger.warn(
      { shopDomain, conversationId, idempotencyKey, httpStatus: resp.status },
      "[shopifyBillingSync] Shopify App Events API returned non-2xx for conversation usage report"
    );
    return { status: "http_error", idempotencyKey, reportedAt: null, httpStatus: resp.status };
  }

  const usageLogsMarked = await markUsageReportedToShopify(
    db,
    credentials.tenantId,
    conversationId,
    now
  );

  return { status: "reported", idempotencyKey, reportedAt: now, usageLogsMarked };
}

/**
 * usageTracker.ts の使用量記録処理へのフック用エントリポイント(タスク09で配線)。
 *
 * usageTracker.trackUsage の呼び出し元(/api/chat 等)は tenantId しか知らないため、
 * ここで tenantId → shopDomain を解決してから reportConversationUsageToShopify に
 * 委譲する。Shopify 経由でないテナント(shopify_shop_domain が NULL)は null を返し、
 * 何もしない(禁止20: 「対象外」を偽の成功/失敗値で表現しない)。
 *
 * usageTracker.ts 自体はこのファイルから一切変更しない。この関数を実際に
 * trackUsage の呼び出し元から呼ぶ配線(fire-and-forget にするか等の判断も含む)は
 * 別タスク09の範囲。
 */
export async function reportConversationUsageIfShopifyTenant(
  db: Db,
  tenantId: string,
  conversationId: string,
  eventTimestamp: Date,
  now: Date = new Date()
): Promise<ShopifyBillingReportResult | null> {
  const shopDomain = await getShopDomainByTenantId(db, tenantId);
  if (!shopDomain) {
    return null;
  }
  return reportConversationUsageToShopify(db, shopDomain, conversationId, eventTimestamp, now);
}
