// src/api/widget/shopifyBillingSync.test.ts
//
// 固定する不変条件(docs/SHOPIFY_APP_REQUIREMENTS.md §5.2):
//   冪等キー   shopDomain + conversationId のみから導出し、時刻・乱数を含まない
//              (再送しても同一会話は常に同じキーになる)
//   D3         Shopify 経由テナントの請求起点は App Events API のみ
//              (このファイルは stripeSync.ts を一切呼ばない)
//   §5.2       App Events API は同期的な課金エラーを返さない(常に202) — HTTP成功時のみ
//              usage_logs.shopify_event_reported_at を更新する
//   D13/D17    通貨表示は fx.ts(usdToJpy)を呼ぶだけで、独自の換算ロジックを書かない
//   禁止20     「テナントなし/トークン未設定」(not_configured)と
//              「HTTPエラー」(http_error)と「ネットワークエラー」(network_error)を
//              同じ値で表現しない
//
// db.query はSQL文字列に含まれるキーワードでレスポンスを振り分ける
// (shopifyRepository.test.ts と同じ makeDb 流儀を踏襲)。

import {
  buildShopifyUsageIdempotencyKey,
  buildAppEventsApiRequestBody,
  buildShopifyMeterAmountDisplay,
  markUsageReportedToShopify,
  reportConversationUsageToShopify,
  reportConversationUsageIfShopifyTenant,
} from "./shopifyBillingSync";
import { USD_JPY_RATE } from "../../lib/billing/fx";

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

interface MockResponseSpec {
  rows?: any[];
  rowCount?: number;
}

/** SQL文字列に含まれるキーワードでレスポンスを振り分ける(複数SELECTが同一dbを共有するため)。 */
function makeDb(responses: Record<string, MockResponseSpec>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    calls.push({ sql: normalized, params });
    for (const key of Object.keys(responses)) {
      if (normalized.includes(key)) {
        const spec = responses[key];
        return { rows: spec.rows ?? [], rowCount: spec.rowCount ?? (spec.rows?.length ?? 0) };
      }
    }
    return { rows: [], rowCount: 0 };
  });
  return { db: { query } as any, query, calls };
}

const CREDENTIALS_QUERY_KEY = "shopify_access_token_encrypted IS NOT NULL";
const SHOP_DOMAIN_BY_TENANT_QUERY_KEY = "WHERE id = $1 AND shopify_shop_domain IS NOT NULL";
const MARK_REPORTED_QUERY_KEY = "UPDATE usage_logs";

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SHOPIFY_API_VERSION;
  delete process.env.SHOPIFY_CONVERSATION_METER_HANDLE;
});

describe("buildShopifyUsageIdempotencyKey", () => {
  it("shopDomain + conversationId から決定的な文字列を作る", () => {
    const key = buildShopifyUsageIdempotencyKey("example.myshopify.com", "conv-1");
    expect(key).toBe("shopify-conversation-usage:example.myshopify.com:conv-1");
  });

  it("同じ入力なら常に同じキーになる(再送で二重計上しないための前提)", () => {
    const a = buildShopifyUsageIdempotencyKey("example.myshopify.com", "conv-1");
    const b = buildShopifyUsageIdempotencyKey("example.myshopify.com", "conv-1");
    expect(a).toBe(b);
  });

  it("shop・conversationIdのいずれかが異なればキーも変わる", () => {
    const a = buildShopifyUsageIdempotencyKey("example.myshopify.com", "conv-1");
    const b = buildShopifyUsageIdempotencyKey("other.myshopify.com", "conv-1");
    const c = buildShopifyUsageIdempotencyKey("example.myshopify.com", "conv-2");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("buildAppEventsApiRequestBody", () => {
  it("event_handle・idempotencyKey・occurredAt(ISO文字列)を含む", () => {
    const occurredAt = new Date("2026-09-05T00:00:00.000Z");
    const body = buildAppEventsApiRequestBody("conversation", "idem-key-1", occurredAt);
    const input = body.variables.input as Record<string, unknown>;
    expect(input.eventHandle).toBe("conversation");
    expect(input.idempotencyKey).toBe("idem-key-1");
    expect(input.occurredAt).toBe("2026-09-05T00:00:00.000Z");
    expect(typeof body.query).toBe("string");
  });
});

describe("buildShopifyMeterAmountDisplay", () => {
  it("JPYのときはreferenceJpyがnull(換算不要)", () => {
    const result = buildShopifyMeterAmountDisplay("JPY", 20);
    expect(result).toEqual({ currency: "JPY", amount: 20, referenceJpy: null });
  });

  it("USDのときはfx.ts(usdToJpy)を経由した参考JPY値を持つ", () => {
    const result = buildShopifyMeterAmountDisplay("USD", 1);
    expect(result.currency).toBe("USD");
    expect(result.amount).toBe(1);
    expect(result.referenceJpy).toBe(Math.round(1 * USD_JPY_RATE));
  });

  it("小数のUSD金額もfx.ts(usdToJpy)の丸め規則に一致する(独自の換算ロジックを書いていないことの確認)", () => {
    const result = buildShopifyMeterAmountDisplay("USD", 0.133);
    expect(result.referenceJpy).toBe(Math.round(0.133 * USD_JPY_RATE));
  });
});

describe("markUsageReportedToShopify", () => {
  it("tenant_id + session_id(conversationId) が一致し未報告の行を更新する", async () => {
    const { db, query } = makeDb({ [MARK_REPORTED_QUERY_KEY]: { rowCount: 3 } });
    const reportedAt = new Date("2026-09-05T00:00:00.000Z");
    const updated = await markUsageReportedToShopify(db, "tenant-a", "conv-1", reportedAt);
    expect(updated).toBe(3);
    const call = query.mock.calls[0];
    expect(String(call[0])).toContain("shopify_event_reported_at IS NULL");
    expect(call[1]).toEqual(["tenant-a", "conv-1", reportedAt]);
  });

  it("対象行が無い(0件)場合はエラーではなく0を返す", async () => {
    const { db } = makeDb({ [MARK_REPORTED_QUERY_KEY]: { rowCount: 0 } });
    const updated = await markUsageReportedToShopify(
      db,
      "tenant-a",
      "conv-none",
      new Date("2026-09-05T00:00:00.000Z")
    );
    expect(updated).toBe(0);
  });
});

describe("reportConversationUsageToShopify", () => {
  const SHOP = "example.myshopify.com";
  const CONVERSATION_ID = "conv-1";
  const EVENT_TIMESTAMP = new Date("2026-09-05T00:00:00.000Z");
  const NOW = new Date("2026-09-05T00:00:05.000Z");

  it("shopドメインに紐づくアクセストークンが無ければ not_configured を返し fetch を呼ばない", async () => {
    const { db } = makeDb({}); // credentials query returns 0 rows (default)
    const result = await reportConversationUsageToShopify(
      db,
      SHOP,
      CONVERSATION_ID,
      EVENT_TIMESTAMP,
      NOW
    );
    expect(result).toEqual({ status: "not_configured", idempotencyKey: null, reportedAt: null });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("成功時(2xx)は reported を返し、usage_logs の突合フラグを更新する", async () => {
    const { db, query } = makeDb({
      [CREDENTIALS_QUERY_KEY]: {
        rows: [{ id: "tenant-a", shopify_access_token_encrypted: "raw-access-token" }],
      },
      [MARK_REPORTED_QUERY_KEY]: { rowCount: 2 },
    });
    mockFetch.mockResolvedValueOnce({ ok: true, status: 202 });

    const result = await reportConversationUsageToShopify(
      db,
      SHOP,
      CONVERSATION_ID,
      EVENT_TIMESTAMP,
      NOW
    );

    expect(result.status).toBe("reported");
    expect(result.reportedAt).toBe(NOW);
    expect(result.usageLogsMarked).toBe(2);
    expect(result.idempotencyKey).toBe(
      buildShopifyUsageIdempotencyKey(SHOP, CONVERSATION_ID)
    );

    // fetchはshopドメイン宛・アクセストークンヘッダ付きで呼ばれる
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain(SHOP);
    expect(init.headers["X-Shopify-Access-Token"]).toBe("raw-access-token");

    // usage_logs 更新は正しい tenantId(credentials由来)・conversationIdで呼ばれる
    const markCall = query.mock.calls.find((c: any) => String(c[0]).includes("UPDATE usage_logs"));
    expect(markCall).toBeDefined();
    expect(markCall![1]).toEqual(["tenant-a", CONVERSATION_ID, NOW]);
  });

  it("Shopifyが非2xxを返した場合は http_error を返し、usage_logsは更新しない", async () => {
    const { db, query } = makeDb({
      [CREDENTIALS_QUERY_KEY]: {
        rows: [{ id: "tenant-a", shopify_access_token_encrypted: "raw-access-token" }],
      },
    });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await reportConversationUsageToShopify(
      db,
      SHOP,
      CONVERSATION_ID,
      EVENT_TIMESTAMP,
      NOW
    );

    expect(result.status).toBe("http_error");
    expect(result.httpStatus).toBe(500);
    expect(result.reportedAt).toBeNull();
    expect(query.mock.calls.some((c: any) => String(c[0]).includes("UPDATE usage_logs"))).toBe(
      false
    );
  });

  it("fetch自体が例外を投げた場合(ネットワークエラー)は network_error を返す", async () => {
    const { db } = makeDb({
      [CREDENTIALS_QUERY_KEY]: {
        rows: [{ id: "tenant-a", shopify_access_token_encrypted: "raw-access-token" }],
      },
    });
    mockFetch.mockRejectedValueOnce(new Error("network down"));

    const result = await reportConversationUsageToShopify(
      db,
      SHOP,
      CONVERSATION_ID,
      EVENT_TIMESTAMP,
      NOW
    );

    expect(result.status).toBe("network_error");
    expect(result.reportedAt).toBeNull();
    expect(result.idempotencyKey).toBe(buildShopifyUsageIdempotencyKey(SHOP, CONVERSATION_ID));
  });

  it("同一会話を2回報告してもidempotencyKeyは変わらない(再送で二重計上しない設計の確認)", async () => {
    const { db } = makeDb({
      [CREDENTIALS_QUERY_KEY]: {
        rows: [{ id: "tenant-a", shopify_access_token_encrypted: "raw-access-token" }],
      },
      [MARK_REPORTED_QUERY_KEY]: { rowCount: 1 },
    });
    mockFetch.mockResolvedValue({ ok: true, status: 202 });

    const first = await reportConversationUsageToShopify(
      db,
      SHOP,
      CONVERSATION_ID,
      EVENT_TIMESTAMP,
      NOW
    );
    const second = await reportConversationUsageToShopify(
      db,
      SHOP,
      CONVERSATION_ID,
      EVENT_TIMESTAMP,
      NOW
    );
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
  });
});

describe("reportConversationUsageIfShopifyTenant", () => {
  const CONVERSATION_ID = "conv-1";
  const EVENT_TIMESTAMP = new Date("2026-09-05T00:00:00.000Z");
  const NOW = new Date("2026-09-05T00:00:05.000Z");

  it("Shopify経由でないテナント(shopify_shop_domainがNULL)はnullを返し、fetchを呼ばない", async () => {
    const { db } = makeDb({}); // shop domain lookup returns 0 rows
    const result = await reportConversationUsageIfShopifyTenant(
      db,
      "tenant-non-shopify",
      CONVERSATION_ID,
      EVENT_TIMESTAMP,
      NOW
    );
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("Shopify経由テナントはshopドメインを解決してreportConversationUsageToShopifyへ委譲する", async () => {
    const SHOP = "example.myshopify.com";
    const { db } = makeDb({
      [SHOP_DOMAIN_BY_TENANT_QUERY_KEY]: { rows: [{ shopify_shop_domain: SHOP }] },
      [CREDENTIALS_QUERY_KEY]: {
        rows: [{ id: "tenant-a", shopify_access_token_encrypted: "raw-access-token" }],
      },
      [MARK_REPORTED_QUERY_KEY]: { rowCount: 1 },
    });
    mockFetch.mockResolvedValueOnce({ ok: true, status: 202 });

    const result = await reportConversationUsageIfShopifyTenant(
      db,
      "tenant-a",
      CONVERSATION_ID,
      EVENT_TIMESTAMP,
      NOW
    );

    expect(result).not.toBeNull();
    expect(result?.status).toBe("reported");
    const [url] = mockFetch.mock.calls[0];
    expect(String(url)).toContain(SHOP);
  });
});
