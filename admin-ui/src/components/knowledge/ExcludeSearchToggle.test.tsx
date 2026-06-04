// Phase69-2-B (a): ExcludeSearchToggle unit tests
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import ExcludeSearchToggle from "./ExcludeSearchToggle";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("./shared", () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
}));

import { fetchWithAuth } from "./shared";

// ── Helpers ────────────────────────────────────────────────────────────────

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

function setup(isExcluded: boolean) {
  const onToggled = vi.fn();
  const onError = vi.fn();

  render(
    <ExcludeSearchToggle
      faqId={42}
      tenantId="tenant-abc"
      isExcluded={isExcluded}
      onToggled={onToggled}
      onError={onError}
    />
  );

  return { onToggled, onError };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("ExcludeSearchToggle", () => {
  beforeEach(() => {
    vi.mocked(fetchWithAuth).mockReset();
  });

  it("T1: 初期状態 isExcluded=false → 「検索対象」ボタンを表示する", () => {
    setup(false);
    expect(screen.getByRole("button", { name: /検索から除外する/ })).toBeTruthy();
    expect(screen.getByText("検索対象")).toBeTruthy();
  });

  it("T2: 初期状態 isExcluded=true → 「除外中」ボタンを表示する", () => {
    setup(true);
    expect(screen.getByRole("button", { name: /検索除外を解除する/ })).toBeTruthy();
    expect(screen.getByText("除外中")).toBeTruthy();
  });

  it("T3: クリックで onToggled(42, true) が即座に呼ばれる（楽観的更新）", async () => {
    vi.mocked(fetchWithAuth).mockReturnValue(
      mockOk({ id: 42, is_excluded_from_search: true })
    );
    const { onToggled } = setup(false);

    const btn = screen.getByRole("button");
    fireEvent.click(btn);

    // 楽観的更新は同期的に呼ばれる
    expect(onToggled).toHaveBeenCalledWith(42, true);
  });

  it("T4: API成功後 onError は呼ばれない", async () => {
    vi.mocked(fetchWithAuth).mockReturnValue(
      mockOk({ id: 42, is_excluded_from_search: true })
    );
    const { onError } = setup(false);

    const btn = screen.getByRole("button");
    fireEvent.click(btn);

    await waitFor(() => {
      expect(onError).not.toHaveBeenCalled();
    });
  });

  it("T5: API失敗（500）でロールバック onToggled(42, false) が呼ばれ onError が発火する", async () => {
    vi.mocked(fetchWithAuth).mockReturnValue(mockErr(500));
    const { onToggled, onError } = setup(false);

    const btn = screen.getByRole("button");
    fireEvent.click(btn);

    await waitFor(() => {
      // 楽観的更新 → ロールバックの順で2回呼ばれる
      expect(onToggled).toHaveBeenCalledTimes(2);
      expect(onToggled).toHaveBeenNthCalledWith(1, 42, true);
      expect(onToggled).toHaveBeenNthCalledWith(2, 42, false);
      expect(onError).toHaveBeenCalledWith(
        "除外設定を保存できませんでした。ネットワークを確認してください"
      );
    });
  });

  it("T6: API失敗（409）でロールバックし、409専用エラーメッセージを返す", async () => {
    vi.mocked(fetchWithAuth).mockReturnValue(mockErr(409));
    const { onToggled, onError } = setup(false);

    const btn = screen.getByRole("button");
    fireEvent.click(btn);

    await waitFor(() => {
      expect(onToggled).toHaveBeenNthCalledWith(2, 42, false);
      expect(onError).toHaveBeenCalledWith(
        "他の処理中のため、少し時間をおいて再度お試しください"
      );
    });
  });

  it("T7: ネットワークエラー（例外）でロールバックし onError が発火する", async () => {
    vi.mocked(fetchWithAuth).mockRejectedValue(new Error("Network Error"));
    const { onToggled, onError } = setup(false);

    const btn = screen.getByRole("button");
    fireEvent.click(btn);

    await waitFor(() => {
      expect(onToggled).toHaveBeenNthCalledWith(2, 42, false);
      expect(onError).toHaveBeenCalledWith(
        "除外設定を保存できませんでした。ネットワークを確認してください"
      );
    });
  });

  it("T8: saving中は button が disabled になる", async () => {
    let resolve!: (v: Response) => void;
    vi.mocked(fetchWithAuth).mockReturnValue(
      new Promise<Response>((r) => {
        resolve = r;
      })
    );
    setup(false);

    const btn = screen.getByRole("button") as HTMLButtonElement;
    fireEvent.click(btn);

    // クリック直後 saving=true
    expect(btn.disabled).toBe(true);

    // 解決してcleaup
    await act(async () => {
      resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response);
    });

    expect(btn.disabled).toBe(false);
  });

  it("T9: PATCH リクエストに正しい tenant が渡される", async () => {
    vi.mocked(fetchWithAuth).mockReturnValue(mockOk({}));
    setup(false);

    const btn = screen.getByRole("button");
    fireEvent.click(btn);

    await waitFor(() => {
      expect(vi.mocked(fetchWithAuth)).toHaveBeenCalledWith(
        "http://localhost:3100/v1/admin/knowledge/faq/42/exclude?tenant=tenant-abc",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ is_excluded_from_search: true }),
        })
      );
    });
  });
});
