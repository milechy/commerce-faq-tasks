// テナント自身のプラン変更UI。
// ここで固定するのは見た目ではなく「開示義務」に当たる挙動:
//   - 実行前に確認を挟むこと（1クリックでプランが変わらない）
//   - ダウングレードで失う機能を名指しで出すこと
//   - free_ad の制約（上限・バッジ・共有プール必須）を出すこと
//   - 「即時反映」と言わないこと（CLAUDE.md 禁止38: ウィジェットは最大24hキャッシュ）
//   - tenantId を body に載せないこと（CLAUDE.md 禁止1）
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PlanSection } from "./PlanSection";
import { authFetch } from "../../../lib/api";

vi.mock("../../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
  authFetch: vi.fn(),
}));

const mockUseAuth = vi.fn();
vi.mock("../../../auth/useAuth", () => ({
  useAuth: () => mockUseAuth(),
}));

const asClientAdmin = () => mockUseAuth.mockReturnValue({ user: { role: "client_admin" } });

beforeEach(() => {
  vi.clearAllMocks();
  asClientAdmin();
  (authFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    json: async () => ({ plan: "growth" }),
  });
});

function renderSection(
  currentPlan: "free_ad" | "starter" | "standard" | "growth" | "enterprise" | null,
  planStatus?: "loading" | "error" | "ready"
) {
  const onChanged = vi.fn();
  const showToast = vi.fn();
  render(
    <PlanSection
      currentPlan={currentPlan}
      planStatus={planStatus}
      onChanged={onChanged}
      showToast={showToast}
    />
  );
  return { onChanged, showToast };
}

describe("PlanSection", () => {
  it("現在のプランを利用中として示し、そのボタンは押せない", () => {
    renderSection("starter");
    expect(screen.getByText(/利用中/)).toBeTruthy();
    const starterBtn = screen.getByRole("button", { name: /Starter/ });
    expect((starterBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("プランを選んだだけでは変更されず、確認が出る", () => {
    renderSection("starter");
    fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
    expect(screen.getByText(/変更しますか？/)).toBeTruthy();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("アップグレードでは使えるようになる機能を出す", () => {
    renderSection("starter");
    fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
    expect(screen.getByText("使えるようになる機能")).toBeTruthy();
    expect(screen.getByText("AIアバター（R2C既定アバター）")).toBeTruthy();
    expect(screen.getByText("アバターの作成・カスタマイズ")).toBeTruthy();
  });

  // Standard は「既定アバターは使えるが、自社アバターは作れない」段。
  // ラベルが両方とも「AIアバター」だと、この2つが確認画面で区別できず、
  // テナントは Growth 相当を期待して Standard を選ぶ(CLAUDE.md 禁止54)。
  it("starter → Standard では既定アバターだけが増え、カスタマイズは増えない", () => {
    renderSection("starter");
    fireEvent.click(screen.getByRole("button", { name: /Standard/ }));
    expect(screen.getByText("使えるようになる機能")).toBeTruthy();
    expect(screen.getByText("AIアバター（R2C既定アバター）")).toBeTruthy();
    expect(screen.queryByText("アバターの作成・カスタマイズ")).toBeNull();
  });

  it("Growth → Standard の降格で失うのはカスタマイズであって、アバター本体ではない", () => {
    renderSection("growth");
    fireEvent.click(screen.getByRole("button", { name: /Standard/ }));
    expect(screen.getByText("使えなくなる機能")).toBeTruthy();
    expect(screen.getByText("アバターの作成・カスタマイズ")).toBeTruthy();
    expect(screen.queryByText("AIアバター（R2C既定アバター）")).toBeNull();
  });

  // Standard(×1.25)を toFixed(1) で出すと「×1.3」になり、画面の説明と
  // 実請求が食い違う。倍率は請求単価そのものなので丸めない。
  it("Standard の倍率は ×1.25 と表示される(×1.3 に丸めない)", () => {
    renderSection("standard");
    expect(screen.getByText(/対話単価 ×1\.25/)).toBeTruthy();
    expect(screen.queryByText(/×1\.3(?!\d)/)).toBeNull();
  });

  it("ダウングレードでは失う機能を名指しで出す", () => {
    renderSection("enterprise");
    fireEvent.click(screen.getByRole("button", { name: /Starter/ }));
    expect(screen.getByText("使えなくなる機能")).toBeTruthy();
    expect(screen.getByText("音声クローン")).toBeTruthy();
    expect(screen.getByText("ディープリサーチ")).toBeTruthy();
  });

  // S5b(#918): free_ad への遷移はサーバが 403 で塞いでいる。
  // 押せるのに失敗するボタンを出さない(CLAUDE.md 禁止15: 動線として閉じていないものを足さない)。
  it("free_ad は選択できず、受け付けていない理由を出す", () => {
    renderSection("growth");
    const freeBtn = screen.getByRole("button", { name: /Free/ }) as HTMLButtonElement;
    expect(freeBtn.disabled).toBe(true);
    expect(screen.getByText(/無料プランへの変更は現在受け付けていません/)).toBeTruthy();

    fireEvent.click(freeBtn);
    expect(screen.queryByText(/変更しますか？/)).toBeNull();
  });

  it("free_ad が現在のプランなら「利用中」として表示は残る", () => {
    renderSection("free_ad");
    expect(screen.getByText(/利用中/)).toBeTruthy();
  });

  it("既発生分が遡らないことを明示する", () => {
    renderSection("starter");
    fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
    expect(screen.getByText(/変更前の単価のまま請求されます/)).toBeTruthy();
  });

  // ★禁止38★ ウィジェット配信は最大24hキャッシュ。即時反映を約束してはいけない。
  it("「即時反映」と書かず、反映に時間がかかることを伝える", () => {
    renderSection("starter");
    fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
    const dialogText = document.body.textContent ?? "";
    expect(dialogText).not.toMatch(/即時反映|すぐに反映されます/);
    expect(dialogText).toMatch(/最大24時間/);
  });

  it("確認後に PUT /v1/admin/my-tenant/plan を呼び、body にテナントIDを載せない", async () => {
    const { onChanged } = renderSection("starter");
    fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
    fireEvent.click(screen.getByRole("button", { name: /Growth に変更する/ }));

    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    const [url, init] = (authFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/v1/admin/my-tenant/plan");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ plan: "growth" });
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith("growth"));
  });

  it("APIが失敗したらメッセージを出し、変更済みとして扱わない", async () => {
    (authFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: async () => ({ message: "テナントIDが見つかりません" }),
    });
    const { onChanged } = renderSection("starter");
    fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
    fireEvent.click(screen.getByRole("button", { name: /Growth に変更する/ }));

    await waitFor(() => expect(screen.getByText("テナントIDが見つかりません")).toBeTruthy());
    expect(onChanged).not.toHaveBeenCalled();
  });

  // super_admin の JWT には tenant_id が無く API が 403 を返すため、
  // 押せるボタンとして出さない。判定は生の role（CLAUDE.md 禁止13: isSuperAdmin を使わない）。
  it("client_admin 以外には変更ボタンを出さない", () => {
    mockUseAuth.mockReturnValue({ user: { role: "super_admin" } });
    renderSection("starter");
    expect((screen.getByRole("button", { name: /Growth/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/テナント管理者アカウントから/)).toBeTruthy();
  });

  it("プラン未確定でも画面が壊れない（状態不明なら「不明」、確認中を騙らない）", () => {
    renderSection(null);
    expect(screen.getByText(/不明/)).toBeTruthy();
    expect(screen.queryByText(/確認中/)).toBeNull();
  });

  // GID 1217808323616744(P1-7): super_admin で常に「確認中」に固まっていたバグの直接の回帰テスト。
  // loading/error/ready の3状態を無言のフォールバックではなく明示的に描き分けること。
  describe("planStatus の3状態", () => {
    it("loading: 「読み込み中」と出し、プラン名やエラー文言は出さない", () => {
      renderSection(null, "loading");
      expect(screen.getByText(/読み込み中/)).toBeTruthy();
      expect(screen.queryByText(/確認中/)).toBeNull();
      expect(screen.queryByText(/取得できませんでした/)).toBeNull();
    });

    it("error: 「取得できませんでした」と出し、無言で確認中のまま固まらない", () => {
      renderSection(null, "error");
      expect(screen.getByText(/取得できませんでした/)).toBeTruthy();
      expect(screen.queryByText(/確認中/)).toBeNull();
      // 専門用語を使わず、次にやることが分かる
      expect(screen.getByText(/再読み込みしてください/)).toBeTruthy();
    });

    it("ready: プラン名をそのまま出す（従来通り）", () => {
      renderSection("growth", "ready");
      expect(screen.getByText(/現在のプラン/).textContent).toContain("Growth");
      expect(screen.queryByText(/取得できませんでした/)).toBeNull();
      expect(screen.queryByText(/読み込み中/)).toBeNull();
    });

    it("loading でも対話単価バッジは出さない（未確定の値を確定情報のように見せない）", () => {
      renderSection("growth", "loading");
      expect(screen.queryByText(/対話単価/)).toBeNull();
    });
  });
  // ─── ユーザーがやりそうなイレギュラー操作 ───────────────────────────────
  describe("イレギュラー操作", () => {
    const fetchMock = () => authFetch as unknown as ReturnType<typeof vi.fn>;

    // 「反応が無い」と思って何度も押す。プラン変更は課金に効くので多重送信させない。
    it("確認ボタンを連打しても PUT は1回だけ", async () => {
      renderSection("starter");
      fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
      const btn = screen.getByRole("button", { name: /Growth に変更する/ });
      fireEvent.click(btn);
      fireEvent.click(btn);
      fireEvent.click(btn);

      await waitFor(() => expect(fetchMock()).toHaveBeenCalled());
      expect(fetchMock().mock.calls).toHaveLength(1);
    });

    // 確認を出したまま気が変わって別のプランを押す。最後に選んだものが送られること。
    it("確認中に別プランへ切り替えると、最後に選んだプランが送られる", async () => {
      renderSection("starter");
      fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
      expect(screen.getByText(/→ Growth に変更しますか/)).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: /Enterprise/ }));
      expect(screen.getByText(/→ Enterprise に変更しますか/)).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: /Enterprise に変更する/ }));
      await waitFor(() => expect(fetchMock()).toHaveBeenCalled());
      expect(JSON.parse(fetchMock().mock.calls[0][1].body)).toEqual({ plan: "enterprise" });
    });

    it("失敗 → やめる → 別プラン選択 で、前のエラーが残らない", async () => {
      fetchMock().mockResolvedValue({ ok: false, json: async () => ({ message: "一時的な失敗" }) });
      renderSection("starter");

      fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
      fireEvent.click(screen.getByRole("button", { name: /Growth に変更する/ }));
      await waitFor(() => expect(screen.getByText("一時的な失敗")).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: "やめる" }));
      expect(screen.queryByText("一時的な失敗")).toBeNull();
    });

    // ★「やめる」を経由せず直接別プランを押す経路★
    // 取消でもエラーは消えるため、この経路を分けないと
    // プラン選択時の setError(null) を外しても検出できない。
    it("失敗 → やめずに別プランを選び直しても、前のエラーが残らない", async () => {
      fetchMock().mockResolvedValue({ ok: false, json: async () => ({ message: "一時的な失敗" }) });
      renderSection("starter");

      fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
      fireEvent.click(screen.getByRole("button", { name: /Growth に変更する/ }));
      await waitFor(() => expect(screen.getByText("一時的な失敗")).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: /Enterprise/ }));
      expect(screen.queryByText("一時的な失敗")).toBeNull();
      expect(screen.getByText(/→ Enterprise に変更しますか/)).toBeTruthy();
    });

    // 無料プラン利用中のテナントが課金プランへ上がる導線。ここが塞がると収益が止まる。
    it("free_ad 利用中でも有料プランへは上げられる", () => {
      renderSection("free_ad");
      for (const name of [/Starter/, /Growth/, /Enterprise/]) {
        expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false);
      }
      fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
      expect(screen.getByText(/変更しますか/)).toBeTruthy();
    });

    it("通信が切れた(fetchがreject)場合もクラッシュせずエラー表示で確定する", async () => {
      fetchMock().mockRejectedValue(new TypeError("Failed to fetch"));
      const { onChanged, showToast } = renderSection("starter");

      fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
      fireEvent.click(screen.getByRole("button", { name: /Growth に変更する/ }));

      await waitFor(() => expect(screen.getByText("プランの変更に失敗しました")).toBeTruthy());
      expect(onChanged).not.toHaveBeenCalled();
      expect(showToast).not.toHaveBeenCalled();
      // 再試行できる状態が残っていること
      expect(screen.getByRole("button", { name: /Growth に変更する/ })).toBeTruthy();
    });

    // nginx の 502 HTML など、本文がJSONでない失敗応答。json() が throw する。
    it("非JSONのエラー応答でも汎用メッセージで確定する", async () => {
      fetchMock().mockResolvedValue({
        ok: false,
        json: async () => { throw new SyntaxError("Unexpected token < in JSON"); },
      });
      renderSection("starter");
      fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
      fireEvent.click(screen.getByRole("button", { name: /Growth に変更する/ }));

      await waitFor(() => expect(screen.getByText("プランの変更に失敗しました")).toBeTruthy());
    });

    // サーバが要求と違う値を確定した場合(将来の強制降格など)、画面はサーバ値に従う。
    it("サーバが返したプランを採用する（要求値を信じない）", async () => {
      fetchMock().mockResolvedValue({ ok: true, json: async () => ({ plan: "starter" }) });
      const { onChanged } = renderSection("growth");

      fireEvent.click(screen.getByRole("button", { name: /Enterprise/ }));
      fireEvent.click(screen.getByRole("button", { name: /Enterprise に変更する/ }));

      await waitFor(() => expect(onChanged).toHaveBeenCalledWith("starter"));
    });

    it("成功したら確認が閉じ、トーストが出る", async () => {
      const { showToast } = renderSection("starter");
      fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
      fireEvent.click(screen.getByRole("button", { name: /Growth に変更する/ }));

      await waitFor(() => expect(showToast).toHaveBeenCalled());
      expect(screen.queryByText(/変更しますか/)).toBeNull();
    });

    it("送信中は確認・取消の両方を押せない", async () => {
      let release: (v: unknown) => void = () => {};
      fetchMock().mockReturnValue(new Promise((r) => { release = r; }));
      renderSection("starter");
      fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
      fireEvent.click(screen.getByRole("button", { name: /Growth に変更する/ }));

      await waitFor(() =>
        expect((screen.getByRole("button", { name: "変更中..." }) as HTMLButtonElement).disabled).toBe(true)
      );
      expect((screen.getByRole("button", { name: "やめる" }) as HTMLButtonElement).disabled).toBe(true);
      release({ ok: true, json: async () => ({ plan: "growth" }) });
    });

    // plan 未確定(null)。差分は出さないが、操作自体は塞がない。
    it("プラン未確定でも確認まで進める（機能差分は出さない）", () => {
      renderSection(null);
      fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
      expect(screen.getByText(/変更しますか/)).toBeTruthy();
      expect(screen.queryByText("使えなくなる機能")).toBeNull();
      expect(screen.queryByText("使えるようになる機能")).toBeNull();
    });
    // ★成功したのに失敗表示になる経路★
    // 204・空ボディ・プロキシの割り込みで res.json() が throw する。
    // サーバは変更済みなので、失敗表示にするとユーザーが無駄に再送する。
    it("成功応答の本文がJSONでなくても成功として扱う", async () => {
      fetchMock().mockResolvedValue({
        ok: true,
        json: async () => { throw new SyntaxError("Unexpected end of JSON input"); },
      });
      const { onChanged, showToast } = renderSection("starter");

      fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
      fireEvent.click(screen.getByRole("button", { name: /Growth に変更する/ }));

      await waitFor(() => expect(onChanged).toHaveBeenCalledWith("growth"));
      expect(showToast).toHaveBeenCalled();
      expect(screen.queryByText("プランの変更に失敗しました")).toBeNull();
      expect(screen.queryByText(/変更しますか/)).toBeNull();
    });

    it("成功応答に plan が無くても、要求したプランで確定する", async () => {
      fetchMock().mockResolvedValue({ ok: true, json: async () => ({}) });
      const { onChanged } = renderSection("starter");
      fireEvent.click(screen.getByRole("button", { name: /Enterprise/ }));
      fireEvent.click(screen.getByRole("button", { name: /Enterprise に変更する/ }));
      await waitFor(() => expect(onChanged).toHaveBeenCalledWith("enterprise"));
    });
  });

  // UX-A(2026-08-26): プラン変更自体は成功しても、Stripe側のsubscription item
  // 追随(syncSubscriptionForTenant)が失敗すると請求が1円も動かない。
  // 「✅ 変更しました」の成功トーストに混ぜず、消えない案内として残ることを固定する
  // (CLAUDE.md 禁止20: 別の状態を同じ表示に潰さない)。
  describe("billing_sync の可視化", () => {
    it("no_subscription のときは支払い設定の案内とボタンを出す", async () => {
      (authFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({ plan: "growth", billing_sync: "no_subscription" }),
      });
      const { onChanged } = renderSection("starter");
      fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
      fireEvent.click(screen.getByRole("button", { name: /Growth に変更する/ }));

      await waitFor(() => expect(onChanged).toHaveBeenCalledWith("growth"));
      expect(screen.getByText(/お支払い設定の確認が必要です/)).toBeTruthy();
      expect(screen.getByRole("button", { name: "お支払い設定へ進む" })).toBeTruthy();
    });

    // price_not_configured 等は env未設定やStripe障害など運用側の問題で、
    // テナントが押しても解決しない。ボタンは出さず案内だけにする。
    it("no_subscription 以外の needs-attention ステータスではボタンを出さない", async () => {
      (authFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({ plan: "growth", billing_sync: "price_not_configured" }),
      });
      const { onChanged } = renderSection("starter");
      fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
      fireEvent.click(screen.getByRole("button", { name: /Growth に変更する/ }));

      await waitFor(() => expect(onChanged).toHaveBeenCalledWith("growth"));
      expect(screen.getByText(/お支払い設定の確認が必要です/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "お支払い設定へ進む" })).toBeNull();
    });

    it("billing_sync が synced/no_change のときは案内を出さない", async () => {
      (authFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({ plan: "growth", billing_sync: "synced" }),
      });
      const { onChanged } = renderSection("starter");
      fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
      fireEvent.click(screen.getByRole("button", { name: /Growth に変更する/ }));

      await waitFor(() => expect(onChanged).toHaveBeenCalledWith("growth"));
      expect(screen.queryByText(/お支払い設定の確認が必要です/)).toBeNull();
    });

    it("「お支払い設定へ進む」を押すとCheckoutセッションを作成し、返ってきたURLへ遷移する", async () => {
      (authFetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ plan: "growth", billing_sync: "no_subscription" }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ url: "https://checkout.stripe.com/cs_test_1" }) });

      const originalLocation = window.location;
      // jsdom の location は代入不可なので defineProperty で差し替える
      Object.defineProperty(window, "location", { value: { href: "" }, writable: true });

      renderSection("starter");
      fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
      fireEvent.click(screen.getByRole("button", { name: /Growth に変更する/ }));
      await waitFor(() => expect(screen.getByRole("button", { name: "お支払い設定へ進む" })).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: "お支払い設定へ進む" }));

      await waitFor(() => expect(window.location.href).toBe("https://checkout.stripe.com/cs_test_1"));
      const [url, init] = (authFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[1];
      expect(url).toContain("/v1/admin/my-tenant/billing/checkout-session");
      expect(init.method).toBe("POST");

      Object.defineProperty(window, "location", { value: originalLocation, writable: true });
    });

    it("Checkoutセッション作成が失敗したらエラーを表示し、遷移しない", async () => {
      (authFetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ plan: "growth", billing_sync: "no_subscription" }) })
        .mockResolvedValueOnce({ ok: false, json: async () => ({ message: "Checkoutセッションの作成に失敗しました" }) });

      renderSection("starter");
      fireEvent.click(screen.getByRole("button", { name: /Growth/ }));
      fireEvent.click(screen.getByRole("button", { name: /Growth に変更する/ }));
      await waitFor(() => expect(screen.getByRole("button", { name: "お支払い設定へ進む" })).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: "お支払い設定へ進む" }));

      await waitFor(() => expect(screen.getByText("Checkoutセッションの作成に失敗しました")).toBeTruthy());
    });
  });
});
