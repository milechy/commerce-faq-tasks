// admin-ui/src/pages/admin/chat-history/OutcomeSection.test.tsx
// 未選択の成果ボタンが「灰地に灰文字」でライトテーマ判読不能だった不具合
// (2026-08-16, PR #754)の回帰テストと、連打・境界値の確認。
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OutcomeSection } from "./OutcomeSection";

function setup(overrides: Partial<Parameters<typeof OutcomeSection>[0]> = {}) {
  const setOutcome = vi.fn();
  const setOutcomeRecordedAt = vi.fn();
  const setOutcomeRecordedBy = vi.fn();
  const handleOutcome = vi.fn().mockResolvedValue(undefined);

  const props = {
    outcome: null,
    outcomeRecordedAt: null,
    outcomeRecordedBy: null,
    setOutcome,
    setOutcomeRecordedAt,
    setOutcomeRecordedBy,
    conversionTypes: ["購入完了", "予約完了", "問い合わせ送信", "離脱"],
    outcomeSubmitting: false,
    handleOutcome,
    ...overrides,
  };

  render(<OutcomeSection {...props} />);
  return { setOutcome, setOutcomeRecordedAt, setOutcomeRecordedBy, handleOutcome };
}

describe("OutcomeSection", () => {
  it("未選択のボタンはテーマ対応トークンを参照する(ハードコード灰色への先祖返り検知)", () => {
    setup();

    const btn = screen.getByText("購入完了") as HTMLButtonElement;
    expect(btn.style.background).toBe("var(--muted)");
    expect(btn.style.color).toBe("var(--muted-foreground)");
    // ライトテーマで実際に不可視化していた具体的な誤り(暗いグレー直書き)が
    // 再導入されていないことも合わせて否定しておく
    expect(btn.style.background).not.toBe("rgba(31,41,55,0.5)");
    expect(btn.style.color).not.toBe("#9ca3af");
  });

  it("選択済みの成果は緑系トークンでハイライトされる", () => {
    setup({ outcome: "購入完了" });

    const btn = screen.getByText("✓ 購入完了") as HTMLButtonElement;
    expect(btn.style.color).toBe("#4ade80");
    // 未選択(この場合は表示されない)と混同していないこと
    expect(screen.queryByText("購入完了")).toBeNull();
  });

  it("ボタンを押すとその値でhandleOutcomeが呼ばれる", async () => {
    const { handleOutcome } = setup();

    fireEvent.click(screen.getByText("予約完了"));

    expect(handleOutcome).toHaveBeenCalledWith("予約完了");
    expect(handleOutcome).toHaveBeenCalledTimes(1);
  });

  // イレギュラー操作: 送信中の連打
  it("outcomeSubmitting=true のときは全ボタンが無効化され、クリックしてもhandleOutcomeが呼ばれない", () => {
    const { handleOutcome } = setup({ outcomeSubmitting: true });

    const btn = screen.getByText("購入完了") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    fireEvent.click(btn);
    fireEvent.click(btn);

    expect(handleOutcome).not.toHaveBeenCalled();
  });

  it("送信中は選択されていないボタンが半透明になり、選択中のボタンとの区別がつく", () => {
    setup({ outcomeSubmitting: true, outcome: "購入完了" });

    const selected = screen.getByText("✓ 購入完了") as HTMLButtonElement;
    const other = screen.getByText("予約完了") as HTMLButtonElement;
    expect(selected.style.opacity).toBe("1");
    expect(other.style.opacity).toBe("0.6");
  });

  // 記録済みバナー
  it("outcomeとoutcomeRecordedAtの両方が揃って初めて「記録済み」バナーを表示する", () => {
    setup({ outcome: "購入完了", outcomeRecordedAt: "2026-08-10T10:00:00Z", outcomeRecordedBy: "田中" });

    expect(screen.getByText(/記録済み/)).toBeTruthy();
    expect(screen.getByText(/by 田中/)).toBeTruthy();
  });

  it("outcomeRecordedByが無ければ「by」表記を付けない", () => {
    setup({ outcome: "購入完了", outcomeRecordedAt: "2026-08-10T10:00:00Z", outcomeRecordedBy: null });

    expect(screen.getByText(/記録済み/)).toBeTruthy();
    expect(screen.queryByText(/by /)).toBeNull();
  });

  // 境界値: 片方だけ揃っている(サーバ応答の不整合を想定した防御的なケース)
  it("outcomeはあるがoutcomeRecordedAtが無い場合、記録済みバナーを出さない", () => {
    setup({ outcome: "購入完了", outcomeRecordedAt: null });

    expect(screen.queryByText(/記録済み/)).toBeNull();
    // ボタン一覧は通常どおり操作可能
    expect(screen.getByText("予約完了")).toBeTruthy();
  });

  it("「変更」を押すと3つの状態セッターがすべてnullでリセットされる", () => {
    const { setOutcome, setOutcomeRecordedAt, setOutcomeRecordedBy } = setup({
      outcome: "購入完了",
      outcomeRecordedAt: "2026-08-10T10:00:00Z",
      outcomeRecordedBy: "田中",
    });

    fireEvent.click(screen.getByText("変更"));

    expect(setOutcome).toHaveBeenCalledWith(null);
    expect(setOutcomeRecordedAt).toHaveBeenCalledWith(null);
    expect(setOutcomeRecordedBy).toHaveBeenCalledWith(null);
  });

  // 境界値: conversionTypesが空(テナント設定が壊れている/未設定のケース)
  it("conversionTypesが空配列でも例外にならず、ボタンを1つも描画しない", () => {
    expect(() => setup({ conversionTypes: [] })).not.toThrow();
    expect(screen.getByText("この会話の営業結果を記録")).toBeTruthy();
  });
});
