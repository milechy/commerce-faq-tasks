// admin-ui/src/components/common/SectionErrorBoundary.test.tsx
//
// P0-1 (GID 1217808384631918) の再発防止。
// admin-ui/index.html はグローバルの window error ハンドラで #root ごと
// "起動エラー" 画面に差し替える。1セクションのレンダーエラーがそこまで
// 伝播せず、このバウンダリで止まることを固定する。
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SectionErrorBoundary } from "./SectionErrorBoundary";

function Boom(): never {
  throw new Error("boom");
}

describe("SectionErrorBoundary", () => {
  it("子コンポーネントが例外を投げても、ここで止まりページ全体を巻き込まない", () => {
    // React はエラーバウンダリのテストで console.error を出すため抑制する
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <div data-testid="outer">
        <SectionErrorBoundary sectionLabel="会話フロー 遷移ファネル">
          <Boom />
        </SectionErrorBoundary>
        <div data-testid="sibling">兄弟セクションは生きている</div>
      </div>,
    );
    expect(screen.getByText(/会話フロー 遷移ファネル.*表示に失敗/)).toBeTruthy();
    expect(screen.getByTestId("sibling").textContent).toBe("兄弟セクションは生きている");
    spy.mockRestore();
  });

  it("子コンポーネントが正常なら何も出さずそのまま描画する", () => {
    render(
      <SectionErrorBoundary sectionLabel="テスト">
        <div data-testid="normal">通常表示</div>
      </SectionErrorBoundary>,
    );
    expect(screen.getByTestId("normal").textContent).toBe("通常表示");
    expect(screen.queryByText(/表示に失敗/)).toBeNull();
  });

  it("sectionLabel未指定でも例外を投げず、汎用文言で出す", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <SectionErrorBoundary>
        <Boom />
      </SectionErrorBoundary>,
    );
    expect(screen.getByText(/この項目の表示に失敗しました/)).toBeTruthy();
    spy.mockRestore();
  });
});
