// COPY-2: アバター画像の生成/アップロード確定は、第三者の権利を侵害しないことの
// 確認チェックボックスがONになるまで実行できないことを検証する。
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StudioImageSection } from "./StudioImageSection";

vi.mock("../../../i18n/LangContext", () => ({
  useLang: () => ({ lang: "ja" }),
}));

function baseProps(overrides: Partial<Parameters<typeof StudioImageSection>[0]> = {}) {
  return {
    isDefault: false,
    imageUrl: "",
    setImageUrl: vi.fn(),
    imageTab: "generate" as const,
    setImageTab: vi.fn(),
    imageDesc: "30代の女性、笑顔",
    setImageDesc: vi.fn(),
    imageDescError: null,
    setImageDescError: vi.fn(),
    generatingImage: false,
    generatedImages: [],
    selectedImageIdx: null,
    handleGenerateImage: vi.fn(async () => {}),
    handleSelectImage: vi.fn(),
    uploadPreview: null,
    uploadConfirmed: false,
    handleFileUpload: vi.fn(),
    handleConfirmUpload: vi.fn(),
    handleResetUpload: vi.fn(),
    fileInputRef: { current: null },
    rightsConfirmed: false,
    setRightsConfirmed: vi.fn(),
    ...overrides,
  };
}

describe("StudioImageSection — COPY-1/2 権利確認ゲート", () => {
  it("チェックボックス未チェックでは「画像を生成する」ボタンが無効", () => {
    render(<StudioImageSection {...baseProps()} />);
    const btn = screen.getByRole("button", { name: "画像を生成する (4枚)" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("チェックボックスをONにすると「画像を生成する」ボタンが有効になる", () => {
    render(<StudioImageSection {...baseProps({ rightsConfirmed: true })} />);
    const btn = screen.getByRole("button", { name: "画像を生成する (4枚)" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("チェックボックスのonChangeはsetRightsConfirmedを呼ぶ", () => {
    const setRightsConfirmed = vi.fn();
    render(<StudioImageSection {...baseProps({ setRightsConfirmed })} />);
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    expect(setRightsConfirmed).toHaveBeenCalledWith(true);
  });

  it("アップロードタブ: チェック未確認では「この画像を使う」ボタンが無効", () => {
    render(
      <StudioImageSection
        {...baseProps({ imageTab: "upload", uploadPreview: "data:image/png;base64,xxx" })}
      />
    );
    const btn = screen.getByRole("button", { name: "この画像を使う" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("アップロードタブ: チェック確認済みなら「この画像を使う」ボタンが有効", () => {
    render(
      <StudioImageSection
        {...baseProps({ imageTab: "upload", uploadPreview: "data:image/png;base64,xxx", rightsConfirmed: true })}
      />
    );
    const btn = screen.getByRole("button", { name: "この画像を使う" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("デフォルトアバター(画像変更不可)ではチェックボックス自体が表示されない", () => {
    render(<StudioImageSection {...baseProps({ isDefault: true })} />);
    expect(screen.queryByRole("checkbox")).toBe(null);
  });
});
