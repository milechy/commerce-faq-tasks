// admin-ui/src/components/admin/KpiCard.test.tsx
// システム稼働状況の「未達成」カードが、ライトテーマで背景色と文字色の区別が
// つかなくなっていた不具合(2026-08-16, PR #754)の回帰テスト。
// ダーク画面前提の半透明色(rgba(127,29,29,*) + #fca5a5)から、
// index.css の --destructive / --destructive-surface / --destructive-border
// トークンへ置換した。ハードコード色への先祖返りをここで検知する。
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import KpiCard from "./KpiCard";

const BASE_PROPS = {
  name: "会話完了率",
  value: "67.1",
  unit: "%",
  threshold: "70% 以上",
};

describe("KpiCard", () => {
  it("met=true のとき「達成」バッジを表示する", () => {
    render(<KpiCard {...BASE_PROPS} met description="お客様との会話が正常に完了した割合" />);
    expect(screen.getByText("達成")).toBeTruthy();
    expect(screen.queryByText("未達成")).toBeNull();
  });

  it("met=false のとき「未達成」バッジを表示する", () => {
    render(<KpiCard {...BASE_PROPS} met={false} />);
    expect(screen.getByText("未達成")).toBeTruthy();
    expect(screen.queryByText("達成")).toBeNull();
  });

  // 壊れやすいポイント: 誰かがこのファイルを直すときに、CSS変数を
  // ハードコードのrgba/hexへ書き戻してしまう(過去に実際に起きた不具合そのもの)。
  // ライトテーマでの見た目はここでは検証できないが、参照している値が
  // 「テーマに応じて変わるトークン」であること自体は固定できる。
  it("met=false のとき、危険状態の配色はハードコード値ではなくテーマ対応トークンを参照する", () => {
    render(<KpiCard {...BASE_PROPS} met={false} description="AIが答えられなかった質問の割合" />);

    const badge = screen.getByText("未達成");
    expect(badge.style.color).toBe("var(--destructive)");
    expect(badge.style.background).toBe("var(--destructive-border)");

    const card = badge.closest("div")?.parentElement as HTMLElement;
    expect(card.style.background).toBe("var(--destructive-surface)");
    expect(card.style.borderColor).toBe("var(--destructive-border)");

    const value = screen.getByText("67.1");
    expect(value.style.color).toBe("var(--destructive)");
    // ライトテーマで実際に不可視化していた具体的な誤り(淡いピンク直書き)が
    // 再導入されていないことも合わせて否定しておく
    expect(value.style.color).not.toBe("#fca5a5");

    const desc = screen.getByText("AIが答えられなかった質問の割合");
    expect(desc.style.color).toBe("var(--destructive)");
  });

  it("met=true のときは危険トークンを使わない(達成カードの見た目まで巻き込んで変えない)", () => {
    render(<KpiCard {...BASE_PROPS} met description="達成時の説明文" />);

    const value = screen.getByText("67.1");
    expect(value.style.color).not.toContain("destructive");
  });

  // 境界値: 任意項目(unit / description)が無い場合
  it("unit・descriptionが無くてもクラッシュせず、該当要素を描画しない", () => {
    render(<KpiCard name="緊急停止スイッチ" value="停止中" threshold="停止中 が正常" met />);

    expect(screen.getByText("停止中")).toBeTruthy();
    // unit相当の別要素が余計に生成されていないこと
    expect(screen.queryByText("%")).toBeNull();
  });

  // 境界値: value が数値のとき(呼び出し元によっては number を渡す設計)
  it("valueが数値でも表示できる", () => {
    render(<KpiCard {...BASE_PROPS} value={0} met={false} />);
    expect(screen.getByText("0")).toBeTruthy();
  });

  // 境界値: 空文字のSLA閾値・空の名前でも例外にならない(サーバ側の異常データ入力への耐性)
  it("threshold や name が空文字でも例外を投げない", () => {
    expect(() => render(<KpiCard name="" value="—" threshold="" met={false} />)).not.toThrow();
  });
});
