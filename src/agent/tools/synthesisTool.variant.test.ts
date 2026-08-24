// src/agent/tools/synthesisTool.variant.test.ts
//
// GID 1216978677398163 (P3): synthesizeAnswer 内の variant 選択(getTenantsPromptWithVariant)の
// 「真のsticky」動作を検証する。従来はハッシュ(hashToUnitInterval)による疑似sticky
// (同じ sessionId なら常に同じハッシュ値 → 同じ計算結果)だったが、variant の並び順や
// weight を変更すると同じ sessionId でも選ばれる variant が変わりうる欠陥があった
// (variantSelector.test.ts の「既知の制約」テスト参照)。
//
// この修正は chat_sessions.prompt_variant_id に記録済みの割当を直接読み、
// 存在すればハッシュを再計算せずそれを使う。DBの記録と実際に使われた
// プロンプトが常に一致することを固定する。
//
// synthesisTool.ts にはこれまで専用のテストファイルが無かった
// (wiring-check.test.ts が副次的に一部を通すのみ)。

import { synthesizeAnswer } from "./synthesisTool";
import { groqClient } from "../llm/groqClient";
import { getPool } from "../../lib/db";

jest.mock("../llm/groqClient", () => ({
  groqClient: { call: jest.fn(), callWithUsage: jest.fn() },
}));

jest.mock("../../lib/db", () => ({ getPool: jest.fn() }));

const VARIANT_A = { id: "variant_a", name: "標準版", prompt: "あなたはAです", weight: 70 };
const VARIANT_B = { id: "variant_b", name: "積極版", prompt: "あなたはBです", weight: 30 };

const FAQ_ITEM = { id: "faq-1", text: "保証は3ヶ月です", score: 0.9, source: "es" as const };

/**
 * SQL文の内容で振り分ける pool.query モック。
 * synthesizeAnswer は tenantId 指定時に tuning_rules / tenants(+chat_sessions) /
 * sentiment の複数クエリを発行するため、呼び出し順ではなくSQL文の特徴的な部分
 * 文字列で応答を決める(呼び出し順への依存を避け、内部実装の変更に強くする)。
 */
function mockPoolDispatchingOn(opts: {
  variants?: typeof VARIANT_A[];
  recordedVariantId?: string | null;
  systemPrompt?: string | null;
}) {
  const query = jest.fn().mockImplementation((sql: string) => {
    if (sql.includes("FROM tuning_rules")) {
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes("FROM tenants")) {
      return Promise.resolve({
        rows: [
          {
            system_prompt: opts.systemPrompt ?? null,
            system_prompt_variants: opts.variants ?? [],
            recorded_variant_id: opts.recordedVariantId ?? null,
          },
        ],
      });
    }
    if (sql.includes("FROM chat_messages") && sql.includes("sentiment")) {
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  });
  (getPool as jest.Mock).mockReturnValue({ query });
  return query;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env["GROQ_API_KEY"] = "test-groq-key";
  // Phase46 Knowledge Gap Detection は tenantId 指定時に setImmediate 経由で
  // 動的importを発火する(この変体テストの対象外)。無効化しないとテスト終了後に
  // "import after Jest environment has been torn down" の警告ノイズが出る。
  process.env["GAP_DETECTION_ENABLED"] = "false";
  (groqClient.callWithUsage as jest.Mock).mockResolvedValue({
    content: "3ヶ月保証です。",
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
});

afterEach(() => {
  delete process.env["GROQ_API_KEY"];
  delete process.env["GAP_DETECTION_ENABLED"];
});

describe("synthesizeAnswer — variant選択(真のsticky)", () => {
  it("回帰: chat_sessions に記録済みのvariantIdがあれば、ハッシュを再計算せずそれを使う", async () => {
    // ハッシュ計算に使われれば variant_a(weight 70)が選ばれやすい sessionId でも、
    // 記録が variant_b を指していれば variant_b を返す。
    const query = mockPoolDispatchingOn({
      variants: [VARIANT_A, VARIANT_B],
      recordedVariantId: "variant_b",
    });

    const result = await synthesizeAnswer({
      query: "保証について",
      items: [FAQ_ITEM],
      tenantId: "tenant-1",
      sessionId: "sess-sticky-1",
    });

    expect(result.variantId).toBe("variant_b");
    expect(result.variantName).toBe("積極版");

    // JOIN で chat_sessions.session_id を絞り込んでいることを確認する
    // S3(共有学習プールの参加モデル): tuning_rules クエリの EXISTS 述語にも
    // "FROM tenants" という部分文字列が含まれるようになったため、実際の
    // variant取得クエリだけに現れる "system_prompt_variants" で区別する。
    const tenantsCall = query.mock.calls.find(([sql]) => sql.includes("system_prompt_variants"));
    expect(tenantsCall![0]).toContain("LEFT JOIN chat_sessions");
    expect(tenantsCall![1]).toEqual(["tenant-1", "sess-sticky-1"]);
  });

  it("記録済みvariantIdが現在のvariant一覧に存在しない(削除済み)場合はハッシュ選択にフォールバックする", async () => {
    const query = mockPoolDispatchingOn({
      variants: [VARIANT_A, VARIANT_B],
      recordedVariantId: "variant_deleted",
    });

    const result = await synthesizeAnswer({
      query: "保証について",
      items: [FAQ_ITEM],
      tenantId: "tenant-1",
      sessionId: "sess-1",
    });

    // 例外にならず、現存するvariantのどちらかが選ばれる
    expect(["variant_a", "variant_b"]).toContain(result.variantId);
    void query;
  });

  it("初回ターン(chat_sessionsに行がまだ無い)はハッシュで選択する", async () => {
    // LEFT JOIN が0行を返す = recorded_variant_id は null になる
    const query = mockPoolDispatchingOn({
      variants: [VARIANT_A, VARIANT_B],
      recordedVariantId: null,
    });

    const result = await synthesizeAnswer({
      query: "保証について",
      items: [FAQ_ITEM],
      tenantId: "tenant-1",
      sessionId: "brand-new-session",
    });

    expect(["variant_a", "variant_b"]).toContain(result.variantId);
    void query;
  });

  it("同一セッションで2ターン連続しても同じvariantが選ばれる(記録が無い1ターン目の結果を2ターン目が再現する)", async () => {
    // 1ターン目: 記録なし → ハッシュで選択される
    const firstQuery = mockPoolDispatchingOn({
      variants: [VARIANT_A, VARIANT_B],
      recordedVariantId: null,
    });
    const first = await synthesizeAnswer({
      query: "保証について",
      items: [FAQ_ITEM],
      tenantId: "tenant-1",
      sessionId: "sess-two-turns",
    });
    void firstQuery;

    // 2ターン目: saveMessage が1ターン目の結果を記録済みという想定
    mockPoolDispatchingOn({
      variants: [VARIANT_A, VARIANT_B],
      recordedVariantId: first.variantId,
    });
    const second = await synthesizeAnswer({
      query: "配送について",
      items: [FAQ_ITEM],
      tenantId: "tenant-1",
      sessionId: "sess-two-turns",
    });

    expect(second.variantId).toBe(first.variantId);
  });

  it("sessionId未指定時はJOINしない従来クエリのままで、例外にならない", async () => {
    const query = mockPoolDispatchingOn({ variants: [VARIANT_A, VARIANT_B] });

    const result = await synthesizeAnswer({
      query: "保証について",
      items: [FAQ_ITEM],
      tenantId: "tenant-1",
      // sessionId 省略
    });

    expect(["variant_a", "variant_b"]).toContain(result.variantId);
    // S3(共有学習プールの参加モデル): tuning_rules クエリの EXISTS 述語にも
    // "FROM tenants" という部分文字列が含まれるようになったため、実際の
    // variant取得クエリだけに現れる "system_prompt_variants" で区別する。
    const tenantsCall = query.mock.calls.find(([sql]) => sql.includes("system_prompt_variants"));
    expect(tenantsCall![0]).not.toContain("chat_sessions");
  });

  it("variantsが未設定(空配列)ならvariantIdはnullでfallback promptを使う", async () => {
    mockPoolDispatchingOn({ variants: [], systemPrompt: "既定のプロンプトです" });

    const result = await synthesizeAnswer({
      query: "保証について",
      items: [FAQ_ITEM],
      tenantId: "tenant-1",
      sessionId: "sess-1",
    });

    expect(result.variantId).toBeNull();
    expect(result.variantName).toBeNull();
  });

  it("DB例外時はvariant情報を含めず、応答自体は失敗させない(catchでnullに倒す)", async () => {
    const query = jest.fn().mockRejectedValue(new Error("db down"));
    (getPool as jest.Mock).mockReturnValue({ query });

    const result = await synthesizeAnswer({
      query: "保証について",
      items: [FAQ_ITEM],
      tenantId: "tenant-1",
      sessionId: "sess-1",
    });

    expect(result.variantId).toBeNull();
    expect(result.answer.length).toBeGreaterThan(0); // 応答自体は生成される
  });
});
