// GID 1217808308055510: PreviewModeBannerの高さを固定値(PREVIEW_MODE_BANNER_HEIGHT)だけで
// 見積もると、実際の描画高さ(テナント名の長さ・折り返し等で変動する)とズレて、
// 呼び出し側のスペーサー計算(App.tsx / copilot-preview/index.tsx)が後続のヘッダーに
// 重なってしまう不具合の回帰テスト。バナーが自分の実測高さを
// documentElementのCSS変数(--preview-banner-height)へ書き込んでいることを検証する。
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import {
  PreviewModeBanner,
  PREVIEW_BANNER_HEIGHT_CSS_VAR,
} from "./PreviewModeBanner";
import { useAuth } from "../auth/useAuth";

vi.mock("../auth/useAuth", () => ({
  useAuth: vi.fn(),
}));

function getCssVar(): string {
  return document.documentElement.style.getPropertyValue(PREVIEW_BANNER_HEIGHT_CSS_VAR);
}

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty(PREVIEW_BANNER_HEIGHT_CSS_VAR);
});

describe("PreviewModeBanner — 実測高さのCSS変数反映", () => {
  it("previewMode中は自身の実測高さ(offsetHeight)をdocumentElementへ書き込む", () => {
    vi.mocked(useAuth).mockReturnValue({
      previewMode: true,
      previewTenantName: "Preview Tenant",
      exitPreview: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);

    render(<PreviewModeBanner />);

    // happy-domではレイアウト計算(offsetHeight)は常に0を返すが、それでも
    // 「固定値を書かず、計測結果をそのまま反映している」ことは検証できる
    // — 呼び出し側は var(--preview-banner-height, <定数フォールバック>) の
    // 形で参照するため、変数自体が「未設定」のままにならないことが重要。
    expect(getCssVar()).toBe("0px");
  });

  it("previewMode=falseでは何も描画せず、CSS変数を0pxにする", () => {
    vi.mocked(useAuth).mockReturnValue({
      previewMode: false,
      previewTenantName: null,
      exitPreview: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);

    const { container } = render(<PreviewModeBanner />);

    expect(container.firstChild).toBeNull();
    expect(getCssVar()).toBe("0px");
  });

  it("アンマウント時にCSS変数を0pxへ戻す(前のプレビューの高さを持ち越さない)", () => {
    vi.mocked(useAuth).mockReturnValue({
      previewMode: true,
      previewTenantName: "Preview Tenant",
      exitPreview: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);

    const { unmount } = render(<PreviewModeBanner />);
    unmount();

    expect(getCssVar()).toBe("0px");
  });
});
