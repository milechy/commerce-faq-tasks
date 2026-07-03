// Phase75: HermesConsentToggle unit tests
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { HermesConsentToggle } from "./HermesConsentToggle";

vi.mock("../../../lib/api", () => ({
  authFetch: vi.fn(),
  API_BASE: "http://localhost:3100",
}));

import { authFetch } from "../../../lib/api";

const mockOk = (data: unknown): Promise<Response> =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
  } as Response);

const mockErr = (status: number): Promise<Response> =>
  Promise.resolve({
    ok: false,
    status,
    json: () => Promise.resolve({ error: "err" }),
  } as Response);

function mockInitialFetch(consent: boolean) {
  vi.mocked(authFetch).mockReturnValueOnce(
    mockOk({ features: { avatar: true, voice: false, rag: true, hermes_raw_data_consent: consent } }),
  );
}

beforeEach(() => {
  vi.mocked(authFetch).mockReset();
});

describe("HermesConsentToggle", () => {
  it("T1: 初期取得でhermes_raw_data_consent=false → 「未同意」ボタンを表示する", async () => {
    mockInitialFetch(false);
    render(<HermesConsentToggle />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /データ提供に同意する/ })).toBeTruthy();
    });
    expect(screen.getByText("⏸️ 未同意")).toBeTruthy();
  });

  it("T2: 初期取得でhermes_raw_data_consent=true → 「同意済み」ボタンを表示する", async () => {
    mockInitialFetch(true);
    render(<HermesConsentToggle />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /同意を取り消す/ })).toBeTruthy();
    });
    expect(screen.getByText("✅ 同意済み")).toBeTruthy();
  });

  it("T3: クリックで楽観的更新→PATCH成功で「同意済み」に変わる", async () => {
    mockInitialFetch(false);
    vi.mocked(authFetch).mockReturnValueOnce(
      mockOk({ features: { avatar: true, voice: false, rag: true, hermes_raw_data_consent: true } }),
    );
    render(<HermesConsentToggle />);

    const btn = await screen.findByRole("button");
    fireEvent.click(btn);

    // 楽観的更新: 即座に「保存中...」になる
    expect(screen.getByText("保存中...")).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText("✅ 同意済み")).toBeTruthy();
    });
  });

  it("T4: PATCH失敗(500)でロールバックし「未同意」のまま、エラートーストが出る", async () => {
    mockInitialFetch(false);
    vi.mocked(authFetch).mockReturnValueOnce(mockErr(500));
    render(<HermesConsentToggle />);

    const btn = await screen.findByRole("button");
    fireEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByText("⏸️ 未同意")).toBeTruthy();
      expect(screen.getByText("❌ 保存に失敗しました。もう一度お試しください。")).toBeTruthy();
    });
  });

  it("T5: ネットワーク例外でもロールバックする", async () => {
    mockInitialFetch(false);
    vi.mocked(authFetch).mockRejectedValueOnce(new Error("network"));
    render(<HermesConsentToggle />);

    const btn = await screen.findByRole("button");
    fireEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByText("⏸️ 未同意")).toBeTruthy();
    });
  });

  it("T6: PATCHリクエストの本文に既存features(avatar/voice/rag)を保持したまま送る", async () => {
    mockInitialFetch(false);
    vi.mocked(authFetch).mockReturnValueOnce(mockOk({ features: {} }));
    render(<HermesConsentToggle />);

    const btn = await screen.findByRole("button");
    fireEvent.click(btn);

    await waitFor(() => {
      expect(vi.mocked(authFetch)).toHaveBeenCalledWith(
        "http://localhost:3100/v1/admin/my-tenant",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            features: {
              avatar: true,
              voice: false,
              rag: true,
              deep_research: undefined,
              pre_dispatch: undefined,
              hermes_raw_data_consent: true,
            },
          }),
        }),
      );
    });
  });

  it("T7: saving中はボタンがdisabledになる", async () => {
    mockInitialFetch(false);
    let resolve!: (v: Response) => void;
    vi.mocked(authFetch).mockReturnValueOnce(
      new Promise<Response>((r) => {
        resolve = r;
      }),
    );
    render(<HermesConsentToggle />);

    const btn = (await screen.findByRole("button")) as HTMLButtonElement;
    fireEvent.click(btn);
    expect(btn.disabled).toBe(true);

    resolve({ ok: true, status: 200, json: () => Promise.resolve({ features: {} }) } as Response);
    await waitFor(() => expect(btn.disabled).toBe(false));
  });
});
