// GID: LP料金表プラン別機能制限のため、AuthContextにtenantPlanを追加した回帰テスト
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AuthProvider, useAuth } from "./useAuth";
import {
  CHAT_SESSION_SURFACE_FULLSCREEN,
  CHAT_SESSION_SURFACE_PANEL,
  chatSessionKey,
  saveChatSession,
} from "../lib/chatSessionStore";

const mockGetSession = vi.fn();
const mockOnAuthStateChange = vi.fn((..._args: unknown[]) => ({ data: { subscription: { unsubscribe: vi.fn() } } }));

vi.mock("../lib/supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: (...args: any[]) => mockGetSession(...args),
      onAuthStateChange: (...args: any[]) => mockOnAuthStateChange(...args),
      signOut: vi.fn(),
    },
  },
}));

vi.mock("../lib/api", () => ({
  authFetch: vi.fn(),
  API_BASE: "http://localhost:3100",
}));

import { authFetch } from "../lib/api";

const mockOk = (data: unknown): Promise<Response> =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(data) } as Response);

function CLIENT_ADMIN_SESSION() {
  return {
    data: {
      session: {
        user: {
          id: "u1",
          email: "client@example.com",
          app_metadata: { role: "client_admin", tenant_id: "tenant-a" },
          user_metadata: {},
        },
      },
    },
  };
}

function SUPER_ADMIN_SESSION() {
  return {
    data: {
      session: {
        user: {
          id: "u2",
          email: "admin@example.com",
          app_metadata: { role: "super_admin" },
          user_metadata: {},
        },
      },
    },
  };
}

function LogoutProbe() {
  const { isLoading, logout } = useAuth();
  if (isLoading) return <div>loading</div>;
  return <button onClick={() => void logout()}>logout</button>;
}

function Probe() {
  const { tenantPlan, isLoading, previewMode } = useAuth();
  if (isLoading) return <div>loading</div>;
  return <div data-testid="probe">plan={String(tenantPlan)} preview={String(previewMode)}</div>;
}

function OnboardingStageProbe() {
  const { isLoading, onboardingStage, onboardingStageResolved } = useAuth();
  if (isLoading) return <div>loading</div>;
  return (
    <div data-testid="stage-probe">
      resolved={String(onboardingStageResolved)} stage={JSON.stringify(onboardingStage)}
    </div>
  );
}

function PreviewProbe() {
  const { isLoading, previewMode, previewTenantId, enterPreview, exitPreview } = useAuth();
  if (isLoading) return <div>loading</div>;
  return (
    <div>
      <div data-testid="preview-probe">preview={String(previewMode)} tenantId={String(previewTenantId)}</div>
      <button onClick={() => enterPreview("tenant-b", "テナントB")}>enter</button>
      <button onClick={() => exitPreview()}>exit</button>
    </div>
  );
}

describe("useAuth — tenantPlan", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
  });

  it("client_admin: /v1/admin/my-tenant のplanを取得する", async () => {
    mockGetSession.mockResolvedValue(CLIENT_ADMIN_SESSION());
    vi.mocked(authFetch).mockReturnValueOnce(mockOk({ plan: "growth" }));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toContain("plan=growth");
    });
    expect(vi.mocked(authFetch)).toHaveBeenCalledWith("http://localhost:3100/v1/admin/my-tenant");
  });

  it("super_admin(プレビューなし): tenantPlanはnullのまま(集約ビュー)", async () => {
    mockGetSession.mockResolvedValue(SUPER_ADMIN_SESSION());

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toContain("plan=null");
    });
    expect(vi.mocked(authFetch)).not.toHaveBeenCalled();
  });

  it("plan未設定(undefined)時はstarterにフォールバックする", async () => {
    mockGetSession.mockResolvedValue(CLIENT_ADMIN_SESSION());
    vi.mocked(authFetch).mockReturnValueOnce(mockOk({}));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toContain("plan=starter");
    });
  });

  it("取得失敗時はnullのまま(機能側で制限あり扱いにできる)", async () => {
    mockGetSession.mockResolvedValue(CLIENT_ADMIN_SESSION());
    vi.mocked(authFetch).mockRejectedValueOnce(new Error("network"));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toContain("plan=null");
    });
  });
});

// Asana 1217040702572796(P6): 着地判定用のオンボーディング段階。my-tenant の
// 同じ応答に相乗りしているため(既存のtenantPlan取得と同じeffect)、新規fetchは無い。
describe("useAuth — onboardingStage", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    window.sessionStorage.clear();
  });

  it("client_admin: my-tenantのonboarding_stageをそのまま公開する", async () => {
    mockGetSession.mockResolvedValue(CLIENT_ADMIN_SESSION());
    vi.mocked(authFetch).mockReturnValueOnce(mockOk({
      plan: "starter",
      onboarding_stage: {
        industryAnswered: true,
        knowledgePublished: false,
        widgetInstalled: false,
        firstConversation: false,
      },
    }));

    render(
      <AuthProvider>
        <OnboardingStageProbe />
      </AuthProvider>,
    );

    // resolved=true を待つだけでは不十分。useAuth の useEffect は
    // [user, previewMode, previewTenantId] に依存しており、マウント直後の
    // user=null の回で最後の分岐に落ちて resolved=true / stage=null を先に確定させる。
    // その後 user が確定して2回目が走り、my-tenant を fetch して stage が入る。
    // resolved=true だけを待つと1回目の結果を掴んでしまい、負荷が高いときだけ
    // stage=null で落ちる(全体実行でのみ再現するフレークだった)。
    // 実際に確認したい値そのものを待つ。
    await waitFor(() => {
      expect(screen.getByTestId("stage-probe").textContent).toContain('"industryAnswered":true');
    });
    const text = screen.getByTestId("stage-probe").textContent ?? "";
    expect(text).toContain("resolved=true");
    expect(text).toContain('"knowledgePublished":false');
  });

  it("my-tenant取得失敗時はstage=nullだがresolvedはtrueになる(未確定のまま止まらない)", async () => {
    mockGetSession.mockResolvedValue(CLIENT_ADMIN_SESSION());
    vi.mocked(authFetch).mockReturnValueOnce(
      Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response),
    );

    render(
      <AuthProvider>
        <OnboardingStageProbe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("stage-probe").textContent).toContain("resolved=true");
    });
    expect(screen.getByTestId("stage-probe").textContent).toContain("stage=null");
  });

  it("super_admin(previewMode無し・集約ビュー)はstage=null・resolved=trueになる(my-tenantを叩かない)", async () => {
    mockGetSession.mockResolvedValue(SUPER_ADMIN_SESSION());

    render(
      <AuthProvider>
        <OnboardingStageProbe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("stage-probe").textContent).toContain("resolved=true");
    });
    expect(screen.getByTestId("stage-probe").textContent).toContain("stage=null");
    expect(vi.mocked(authFetch)).not.toHaveBeenCalled();
  });

  it("previewMode中(super_adminのクライアントビュー)はstage=nullのまま(決定Aはテナント本人の初回ログインの話であり、代行閲覧を新規テナント扱いにしない)", async () => {
    window.sessionStorage.setItem("r2c_admin_preview_tenant", JSON.stringify({ tenantId: "tenant-b", tenantName: "テナントB" }));
    mockGetSession.mockResolvedValue(SUPER_ADMIN_SESSION());
    vi.mocked(authFetch).mockReturnValueOnce(mockOk({ plan: "growth" }));

    render(
      <AuthProvider>
        <OnboardingStageProbe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("stage-probe").textContent).toContain("resolved=true");
    });
    expect(screen.getByTestId("stage-probe").textContent).toContain("stage=null");
  });
});

describe("useAuth — previewMode の sessionStorage永続化", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    window.sessionStorage.clear();
    mockGetSession.mockResolvedValue(SUPER_ADMIN_SESSION());
  });

  it("enterPreview() でsessionStorageに保存され、ページ再読み込み(再マウント)後も復元される", async () => {
    const { unmount } = render(
      <AuthProvider>
        <PreviewProbe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("preview-probe").textContent).toContain("preview=false");
    });

    screen.getByText("enter").click();
    await waitFor(() => {
      expect(screen.getByTestId("preview-probe").textContent).toContain("preview=true tenantId=tenant-b");
    });
    expect(window.sessionStorage.getItem("r2c_admin_preview_tenant")).toContain("tenant-b");

    // ページ再読み込みを模擬(AuthProviderを再マウント)
    unmount();
    render(
      <AuthProvider>
        <PreviewProbe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("preview-probe").textContent).toContain("preview=true tenantId=tenant-b");
    });
  });

  it("exitPreview() でsessionStorageからも消え、再マウント後もプレビューなしのまま", async () => {
    window.sessionStorage.setItem("r2c_admin_preview_tenant", JSON.stringify({ tenantId: "tenant-b", tenantName: "テナントB" }));

    const { unmount } = render(
      <AuthProvider>
        <PreviewProbe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("preview-probe").textContent).toContain("preview=true tenantId=tenant-b");
    });

    screen.getByText("exit").click();
    await waitFor(() => {
      expect(screen.getByTestId("preview-probe").textContent).toContain("preview=false tenantId=null");
    });
    expect(window.sessionStorage.getItem("r2c_admin_preview_tenant")).toBeNull();

    unmount();
    render(
      <AuthProvider>
        <PreviewProbe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("preview-probe").textContent).toContain("preview=false tenantId=null");
    });
  });

  it("sessionStorageの内容が壊れている場合は無視してプレビューなしで起動する", async () => {
    window.sessionStorage.setItem("r2c_admin_preview_tenant", "not-json");

    render(
      <AuthProvider>
        <PreviewProbe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("preview-probe").textContent).toContain("preview=false tenantId=null");
    });
  });
});

// GID 1217007298292152: 会話には顧客名・電話番号などの個人情報が載りうるため、共有端末で
// 次の利用者に残さないよう、ログアウト時にチャット2面ぶんの保存済み会話を消す(多層防御)。
describe("useAuth — ログアウト時にチャット会話を消す(PII保護)", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    window.sessionStorage.clear();
    mockGetSession.mockResolvedValue(SUPER_ADMIN_SESSION());
  });

  it("logout() で全画面UI・パネル両方のキーが消える", async () => {
    saveChatSession(CHAT_SESSION_SURFACE_FULLSCREEN, {
      sessionId: "fullscreen-session",
      messages: [{ id: 1, role: "me", text: "山田様の電話番号は090-0000-0000です" }],
    });
    saveChatSession(CHAT_SESSION_SURFACE_PANEL, {
      sessionId: "panel-session",
      messages: [{ role: "user", content: "山田様の注文状況を教えて" }],
    });
    expect(window.sessionStorage.getItem(chatSessionKey(CHAT_SESSION_SURFACE_FULLSCREEN))).not.toBeNull();
    expect(window.sessionStorage.getItem(chatSessionKey(CHAT_SESSION_SURFACE_PANEL))).not.toBeNull();

    render(
      <AuthProvider>
        <LogoutProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("logout")).toBeTruthy());

    screen.getByText("logout").click();

    await waitFor(() => {
      expect(window.sessionStorage.getItem(chatSessionKey(CHAT_SESSION_SURFACE_FULLSCREEN))).toBeNull();
      expect(window.sessionStorage.getItem(chatSessionKey(CHAT_SESSION_SURFACE_PANEL))).toBeNull();
    });
  });
});
