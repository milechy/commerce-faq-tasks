// src/agent/tools/synthesisTool.rolePrompt.test.ts
//
// ナレッジ配線是正 P17 (Asana GID 1217811237245022):
// BASE_SYSTEM_PROMPT が「あなたは中古車販売店のAIコンシェルジュです」で固定され、
// テナントの system_prompt はその後ろに追記されるだけだった(基底を置換しない)。
// 本番テナントには carnation(フラワー系)等、業種の異なるテナントが含まれており、
// 業種を誤って名乗る欠陥だった。役割定義はテナントの system_prompt を第一候補にし、
// 未設定時のみ業種を名乗らない中立既定を使うことを固定する。

import { synthesizeAnswer } from "./synthesisTool";
import { groqClient } from "../llm/groqClient";
import { getPool } from "../../lib/db";

jest.mock("../llm/groqClient", () => ({
  groqClient: { call: jest.fn(), callWithUsage: jest.fn() },
}));

jest.mock("../../lib/db", () => ({ getPool: jest.fn() }));

const FAQ_ITEM = { id: "faq-1", text: "保証は3ヶ月です", score: 0.9, source: "es" as const };

function mockPool(tenantSystemPrompt: string | null) {
  const query = jest.fn().mockImplementation((sql: string) => {
    if (sql.includes("FROM tuning_rules")) return Promise.resolve({ rows: [] });
    if (sql.includes("FROM tenants")) {
      return Promise.resolve({
        rows: [{ system_prompt: tenantSystemPrompt, system_prompt_variants: [], recorded_variant_id: null }],
      });
    }
    if (sql.includes("FROM faq_docs")) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: [] });
  });
  (getPool as jest.Mock).mockReturnValue({ query });
  return query;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env["GROQ_API_KEY"] = "test-groq-key";
  process.env["GAP_DETECTION_ENABLED"] = "false";
  (groqClient.callWithUsage as jest.Mock).mockResolvedValue({
    content: "回答",
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
});

afterEach(() => {
  delete process.env["GROQ_API_KEY"];
  delete process.env["GAP_DETECTION_ENABLED"];
});

async function systemPromptOf(tenantSystemPrompt: string | null) {
  mockPool(tenantSystemPrompt);
  await synthesizeAnswer({
    query: "保証について教えてください",
    items: [FAQ_ITEM],
    tenantId: "tenant-1",
  });
  const call = (groqClient.callWithUsage as jest.Mock).mock.calls[0]![0];
  return call.messages.find((m: { role: string }) => m.role === "system").content as string;
}

describe("synthesizeAnswer — 役割定義の脱・業種固定(ナレッジ配線是正P17)", () => {
  it("system_prompt を持つテナントでは「中古車販売店」がsystemPromptに含まれない(是正対象バグの回帰)", async () => {
    const systemPrompt = await systemPromptOf("あなたはお花屋さんのAIコンシェルジュです。");
    expect(systemPrompt).not.toContain("中古車販売店");
    expect(systemPrompt).toContain("あなたはお花屋さんのAIコンシェルジュです。");
  });

  it("system_prompt が未設定のテナントでは中立既定が入り、業種名(中古車販売店)が入らない", async () => {
    const systemPrompt = await systemPromptOf(null);
    expect(systemPrompt).not.toContain("中古車販売店");
    expect(systemPrompt).toContain("あなたはこの店舗のAIコンシェルジュです。");
  });

  it("業種非依存のルール群は system_prompt の有無に関わらず両方のケースで維持される", async () => {
    const withTenant = await systemPromptOf("あなたはお花屋さんのAIコンシェルジュです。");
    const withoutTenant = await systemPromptOf(null);
    for (const rule of ["回答は200文字以内で簡潔に", "FAQにない情報は推測で答えない", "敬語を使う"]) {
      expect(withTenant).toContain(rule);
      expect(withoutTenant).toContain(rule);
    }
  });

  it("回帰: tuning_rulesの注入位置が変わっていない(役割定義・ルールの直後に続く)", async () => {
    const query = jest.fn().mockImplementation((sql: string) => {
      if (sql.includes("FROM tuning_rules")) {
        return Promise.resolve({
          rows: [
            {
              id: 1,
              tenant_id: "tenant-1",
              trigger_pattern: "保証",
              expected_behavior: "3年保証と案内する",
              priority: 1,
              is_active: true,
              created_by: "test",
              source_message_id: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              approved_responses: [],
            },
          ],
        });
      }
      if (sql.includes("FROM tenants")) {
        return Promise.resolve({
          rows: [{ system_prompt: "お花屋さんです。", system_prompt_variants: [], recorded_variant_id: null }],
        });
      }
      if (sql.includes("FROM faq_docs")) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    (getPool as jest.Mock).mockReturnValue({ query });

    await synthesizeAnswer({
      query: "保証について教えてください",
      items: [FAQ_ITEM],
      tenantId: "tenant-1",
    });
    const call = (groqClient.callWithUsage as jest.Mock).mock.calls[0]![0];
    const systemPrompt = call.messages.find((m: { role: string }) => m.role === "system").content as string;

    const roleIdx = systemPrompt.indexOf("お花屋さんです。");
    const rulesIdx = systemPrompt.indexOf("回答は200文字以内で簡潔に");
    const tuningIdx = systemPrompt.indexOf("3年保証と案内する");
    expect(roleIdx).toBeGreaterThanOrEqual(0);
    expect(rulesIdx).toBeGreaterThan(roleIdx);
    expect(tuningIdx).toBeGreaterThan(rulesIdx);
  });
});
