// src/agent/tools/synthesisTool.internalTerms.test.ts
//
// パートナーがアップする書籍(PDF)には社内限定の呼称(RAJIUSEC/ARCSTRAの法則)が
// 書かれている。書籍チャンクは tenant_id='global' で faq_embeddings に入り、
// テナント向け検索は無条件に global を引く(src/search/pgvectorSearch.ts:62)ため、
// 抜粋がそのまま LLM プロンプトに載る。LLM に見せた時点で復唱されうるので、
// プロンプトに載せる前に伏せることを固定する。

import { synthesizeAnswer } from "./synthesisTool";
import { groqClient } from "../llm/groqClient";
import { getPool } from "../../lib/db";

jest.mock("../llm/groqClient", () => ({
  groqClient: { call: jest.fn(), callWithUsage: jest.fn() },
}));

jest.mock("../../lib/db", () => ({ getPool: jest.fn() }));

const BOOK_ITEM = {
  id: "book-1",
  text: "RAJIUSECの法則によれば、顧客の不安を先に取り除くことが成約率を高める。",
  score: 0.9,
  source: "pgvector" as const,
  metadata: { source: "book", book_id: "b1", chunk_index: 0 },
};

const FAQ_ITEM = {
  id: "faq-1",
  text: "当店ではARCSTRAの法則に基づいてご提案しています。",
  score: 0.8,
  source: "es" as const,
};

function mockPool() {
  const query = jest.fn().mockImplementation((sql: string) => {
    if (sql.includes("FROM tuning_rules")) return Promise.resolve({ rows: [] });
    if (sql.includes("FROM tenants")) {
      return Promise.resolve({
        rows: [{ system_prompt: null, system_prompt_variants: [], recorded_variant_id: null }],
      });
    }
    return Promise.resolve({ rows: [] });
  });
  (getPool as jest.Mock).mockReturnValue({ query });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env["GROQ_API_KEY"] = "test-groq-key";
  process.env["GAP_DETECTION_ENABLED"] = "false";
  mockPool();
  (groqClient.callWithUsage as jest.Mock).mockResolvedValue({
    content: "回答",
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
});

afterEach(() => {
  delete process.env["GROQ_API_KEY"];
  delete process.env["GAP_DETECTION_ENABLED"];
});

async function promptsFor(items: Array<Record<string, unknown>>) {
  await synthesizeAnswer({
    query: "おすすめを教えてください",
    items: items as never,
    tenantId: "tenant-1",
  });
  const call = (groqClient.callWithUsage as jest.Mock).mock.calls[0]![0];
  const byRole = (role: string) =>
    call.messages.find((m: { role: string }) => m.role === role).content as string;
  return { system: byRole("system"), user: byRole("user") };
}

describe("社内用語をLLMに見せない", () => {
  it("書籍抜粋の社内用語は user プロンプトに載らない", async () => {
    const { user } = await promptsFor([BOOK_ITEM]);
    expect(user).not.toContain("RAJIUSEC");
    expect(user).not.toContain("の法則");
    expect(user).toContain("独自の考え方");
    // 抜粋の残りの内容は保持される(伏せるのは呼称だけ)
    expect(user).toContain("顧客の不安を先に取り除く");
  });

  it("FAQ由来の抜粋でも伏せる", async () => {
    const { user } = await promptsFor([FAQ_ITEM]);
    expect(user).not.toContain("ARCSTRA");
    expect(user).toContain("独自の考え方");
  });

  it("system プロンプトに禁止指示が入る", async () => {
    const { system } = await promptsFor([FAQ_ITEM]);
    expect(system).toContain("RAJIUSEC");
    expect(system).toContain("社内限定");
  });
});
