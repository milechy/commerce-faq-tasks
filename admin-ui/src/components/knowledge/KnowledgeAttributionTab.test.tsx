// admin-ui/src/components/knowledge/KnowledgeAttributionTab.test.tsx
// Phase68: ナレッジ別CV影響度タブの回帰テスト(このコンポーネントには元々テストが無かった)。
// 読み手は書籍の著者(赤嶺氏)やテナント管理者でITリテラシーは高くない前提のため、
// 専門用語を画面に出さない方針と、母数不足時のゼロ埋め禁止(架空の「効果0%」を出さない)
// を中心に検証する。

import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import KnowledgeAttributionTab from "./KnowledgeAttributionTab";

vi.mock("../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
  authFetch: vi.fn(),
}));

// happy-dom は canvas 2d context を提供しないため、Chart.js を経由する
// react-chartjs-2 のコンポーネントはテスト用スタブに差し替える(本番コードは触らない)。
// analytics/index.test.tsx と同じ既存パターン。
vi.mock("react-chartjs-2", () => ({
  Bar: () => null,
}));

import { authFetch } from "../../lib/api";

const mockFetch = authFetch as unknown as ReturnType<typeof vi.fn>;

// この画面に出してはいけない内部語(著者・テナント管理者向けの言い換え方針)
const FORBIDDEN_WORDS = [
  "チャンク",
  "ベクトル",
  "埋め込み",
  "再埋め込み",
  "原則注入",
  "RAG",
  "閾値",
  "スコープ",
  "テナント",
  "metadata",
  "反映済み",
  "未反映",
];

const BOOK_ITEM_SUFFICIENT = {
  chunk_id: "b1",
  source: "book" as const,
  title: "返報性の一節",
  principle: "返報性の原理",
  usage_count: 12,
  injected_count: 7,
  conversation_count: 10,
  conversion_count: 3,
  conversion_rate: 0.3,
  avg_judge_score: 82.5,
  trend: "up" as const,
};

const FAQ_ITEM_INSUFFICIENT = {
  chunk_id: "f1",
  source: "faq" as const,
  title: "送料について",
  usage_count: 4,
  injected_count: 0,
  conversation_count: 2,
  conversion_count: 0,
  conversion_rate: 0,
  avg_judge_score: null,
  trend: "insufficient_data" as const,
};

function mockAttribution(items: unknown[], summaryOverrides: Record<string, unknown> = {}) {
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        period: "30d",
        tenant_id: "tenant-abc",
        source_type: "all",
        sort_by: "conversion_rate",
        items,
        summary: {
          total_chunks_used: items.length,
          avg_conversion_rate: 0.15,
          top_performer: items[0] ?? null,
          worst_performer: items[items.length - 1] ?? null,
          ...summaryOverrides,
        },
      }),
  } as Response);
}

function renderTab() {
  return render(<KnowledgeAttributionTab tenantId="tenant-abc" />);
}

describe("KnowledgeAttributionTab", () => {
  it("禁止語(チャンク/ベクトル/埋め込み/原則注入/RAG/閾値/スコープ/テナント/metadata/反映済み・未反映)を画面に出さない", async () => {
    mockAttribution([BOOK_ITEM_SUFFICIENT, FAQ_ITEM_INSUFFICIENT]);
    renderTab();

    // テーブルの見出し(表側にしか出ない一意な文言)が出たら描画完了とみなす
    await screen.findByText("教えとして使われた回数");

    const bodyText = document.body.textContent ?? "";
    for (const word of FORBIDDEN_WORDS) {
      expect(bodyText).not.toContain(word);
    }
  });

  it("母数が閾値未満のとき、ゼロ埋めして「効果0%」と出さず、まだ判断できない旨とあと何件で見られるかを出す", async () => {
    mockAttribution([FAQ_ITEM_INSUFFICIENT]);
    renderTab();

    // 単独アイテムだと「最高パフォーマー」サマリーカードにも同じ文言が出るため
    // (母数不足の表示は共通ロジック)、それも含めて全出現を確認する
    const messages = await screen.findAllByText(
      "まだ判断できる会話数がありません（現在2件。あと3件で見られます）",
    );
    expect(messages.length).toBeGreaterThanOrEqual(1);
    // 母数不足を「0.0%」のような架空の割合で埋めていないこと
    expect(screen.queryByText("0.0%")).not.toBeTruthy();
  });

  it("injected_count は「教えとして使われた回数」として表示され、FAQ行では出ない", async () => {
    mockAttribution([BOOK_ITEM_SUFFICIENT, FAQ_ITEM_INSUFFICIENT]);
    renderTab();

    expect(await screen.findByText("教えとして使われた回数")).toBeTruthy();
    // サマリーカードの「最高パフォーマー」にも同じタイトルが出るため、テーブル内に絞って検証する
    const table = screen.getByRole("table");

    const bookRow = within(table).getByText("返報性の一節").closest("tr");
    expect(bookRow).toBeTruthy();
    expect(within(bookRow as HTMLElement).getByText("7回")).toBeTruthy();

    const faqRow = within(table).getByText("送料について").closest("tr");
    expect(faqRow).toBeTruthy();
    const faqCells = Array.from((faqRow as HTMLElement).querySelectorAll("td"));
    // ナレッジ / 種別 / 利用回数 / 教えとして使われた回数 / 割合 / 出来ばえ / トレンド
    expect(faqCells[3]?.textContent).toBe("—");
  });

  it("avg_judge_score が null の行は「—」で表示され、0点など誤解を招く表示にならない", async () => {
    mockAttribution([FAQ_ITEM_INSUFFICIENT]);
    renderTab();

    const table = await screen.findByRole("table");
    const faqRow = within(table).getByText("送料について").closest("tr") as HTMLElement;
    const cells = Array.from(faqRow.querySelectorAll("td"));
    // 回答の出来ばえ列
    expect(cells[5]?.textContent).toBe("—");
    expect(cells[5]?.textContent).not.toBe("0点");
    expect(cells[5]?.textContent).not.toBe("0.0点");
  });

  it("conversion_rate は母数が十分な行で実数併記される(「N人中M人」の形)", async () => {
    mockAttribution([BOOK_ITEM_SUFFICIENT]);
    renderTab();

    // 単独アイテムだと「最高パフォーマー」サマリーカードにも同じ実数併記が出るため、
    // テーブル内に絞って一意に検証する
    const table = await screen.findByRole("table");
    expect(within(table).getByText("10人中3人（30.0%）")).toBeTruthy();
  });
});
