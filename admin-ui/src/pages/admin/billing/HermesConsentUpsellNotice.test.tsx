// admin-ui/src/pages/admin/billing/HermesConsentUpsellNotice.test.tsx
//
// ★このテストが守っているもの★
// (1) share=trueのテナントには一切表示しない(既に同意済みへ勧誘を出さない)。
// (2) share=falseのテナントには前向きな訴求文とCTAを出す。
// (3) 「参加する」を押すと features.learning.share=true でPATCHし、成功後は
//     訴求ではなく完了メッセージに切り替わる(訴求が消えずに残り続けない)。
// (4) 旧フラグ hermes_raw_data_consent のみのテナント(後方互換)でも同様に判定する。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { HermesConsentUpsellNotice } from "./HermesConsentUpsellNotice";

const mockAuthFetch = vi.fn();
vi.mock("../../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

function renderNotice() {
  return render(
    <MemoryRouter initialEntries={["/admin/billing"]}>
      <HermesConsentUpsellNotice />
    </MemoryRouter>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("HermesConsentUpsellNotice", () => {
  it("share:true(新形式)なら何も描画しない", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, {
      features: { learning: { learn: true, share: true } },
    }));
    const { container } = renderNotice();
    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(""));
  });

  it("share:false なら前向きな訴求文とCTAを描画する", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, {
      features: { learning: { learn: true, share: false } },
    }));
    renderNotice();
    expect(await screen.findByText(/他社の接客ノウハウを、無料でAIに取り込みませんか/)).toBeTruthy();
    expect(screen.getByText("🌐 今すぐ参加する")).toBeTruthy();
    expect(screen.getByText(/追加費用は一切かかりません/)).toBeTruthy();
    expect(screen.getByText(/いつでもOFFに戻せます/)).toBeTruthy();
  });

  it("旧フラグ hermes_raw_data_consent=true(後方互換)なら描画しない", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, {
      features: { hermes_raw_data_consent: true },
    }));
    const { container } = renderNotice();
    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(""));
  });

  it("「今すぐ参加する」を押すと share:true でPATCHし、完了メッセージに切り替わる", async () => {
    mockAuthFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (!opts) {
        return Promise.resolve(jsonResponse(200, {
          features: { learning: { learn: true, share: false } },
        }));
      }
      const body = JSON.parse(String(opts.body));
      expect(body.features.learning).toEqual({ learn: true, share: true });
      return Promise.resolve(jsonResponse(200, { features: body.features }));
    });

    renderNotice();
    const btn = await screen.findByText("🌐 今すぐ参加する");
    fireEvent.click(btn);

    expect(await screen.findByText(/ご参加ありがとうございます/)).toBeTruthy();
    expect(screen.queryByText("🌐 今すぐ参加する")).toBeNull();
  });

  it("取得に失敗しても何も表示せず、他の画面機能に影響しない(fail-silent)", async () => {
    mockAuthFetch.mockRejectedValue(new Error("network error"));
    const { container } = renderNotice();
    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(""));
  });
});
