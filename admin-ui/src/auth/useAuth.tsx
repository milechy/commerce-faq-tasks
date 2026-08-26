import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { authFetch, API_BASE } from "../lib/api";
import {
  CHAT_SESSION_SURFACE_FULLSCREEN,
  CHAT_SESSION_SURFACE_PANEL,
  clearChatSession,
} from "../lib/chatSessionStore";

export interface AuthUser {
  id: string;
  email: string;
  role: "super_admin" | "client_admin" | "anonymous";
  tenantId: string | null;
  tenantName: string | null;
}

// LP(r2c.biz)料金表のプラン。backendのplanValues(src/api/admin/tenants/routes.ts)と一致させること。
// free_ad は starter よりさらに下の最下段(広告原資の無料プラン)。
// standard は starter と growth の間(既定アバターの利用可・自社カスタム作成は不可)。
// この型は admin-ui/src/lib/planFeatures.ts の PLAN_RANK と
// admin-ui/src/pages/admin/tenants/types.ts の TenantPlan/PLAN_OPTIONS からも
// 独立に定義されており(既知の三重化)、プラン段を増やす際は3箇所とも直すこと。
export type TenantPlan = "free_ad" | "starter" | "standard" | "growth" | "enterprise";

// Asana 1217040702572796(P6): オンボーディング4段階。単一の情報源は
// src/api/admin/agent/onboardingStage.ts(バックエンド)。admin-ui とは別パッケージ
// (別ビルドルート)のため import できず、GET /v1/admin/my-tenant の応答形をそのまま
// ここで受ける(4個の boolean のみの薄い型。copilot-preview/index.tsx にも同じ型がある)。
export interface OnboardingStageFlags {
  industryAnswered: boolean;
  knowledgePublished: boolean;
  widgetInstalled: boolean;
  firstConversation: boolean;
  /** オンボ 是正A-2: 段階ではなくヒント。stage2の案内文の出し分けにのみ使う。 */
  hasDraftFaq: boolean;
}

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  isSuperAdmin: boolean;
  isClientAdmin: boolean;
  logout: () => Promise<void>;
  previewMode: boolean;
  previewTenantId: string | null;
  previewTenantName: string | null;
  enterPreview: (tenantId: string, tenantName: string) => void;
  exitPreview: () => void;
  /**
   * 表示対象テナントの現在のプラン。
   * - client_admin(プレビュー含む): 自テナント/プレビュー先テナントのプラン
   * - super_adminの集約ビュー(プレビュー無し): 特定テナントに紐付かないため null
   * - 未取得時は null（機能表示側はnullを「制限あり(未確認)」として扱うこと）
   */
  tenantPlan: TenantPlan | null;
  /**
   * 自テナント(previewMode時は対象外)のオンボーディング4段階。
   * - client_admin(previewMode時を除く)のみ取得する。それ以外は常に null。
   * - 未取得時は null（着地判定側は onboardingStageResolved で「まだ取得できていない」
   *   ことと区別すること。null を「新規テナントではない」と早合点しない）。
   */
  onboardingStage: OnboardingStageFlags | null;
  /** onboardingStage の取得が完了した(成功/失敗/対象外いずれも含む)かどうか。 */
  onboardingStageResolved: boolean;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  isLoading: true,
  isSuperAdmin: false,
  isClientAdmin: false,
  logout: async () => {},
  previewMode: false,
  previewTenantId: null,
  previewTenantName: null,
  enterPreview: () => {},
  exitPreview: () => {},
  tenantPlan: null,
  onboardingStage: null,
  onboardingStageResolved: false,
});

function parseRole(meta: Record<string, unknown>): AuthUser["role"] {
  const r = meta?.role;
  if (r === "super_admin") return "super_admin";
  if (r === "client_admin") return "client_admin";
  return "anonymous";
}

// previewMode/previewTenantId は元々メモリ上のReact stateのみで管理していたため、
// ページの再読み込みや直接URL入力(フルページ遷移)のたびにリセットされていた
// (例: /copilot-previewはブックマーク/URL直打ちで開く前提のページのため、テナント
// 詳細画面でプレビューに入ってもそこへ移動すると毎回プレビューが外れてしまっていた)。
// sessionStorageに永続化することで、同一ブラウザタブのセッション内は再読み込みしても
// 保持されるようにする(タブを閉じれば消える点はlocalStorageと差別化)。
const PREVIEW_STORAGE_KEY = "r2c_admin_preview_tenant";

interface StoredPreview {
  tenantId: string;
  tenantName: string;
}

function loadStoredPreview(): StoredPreview | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.sessionStorage.getItem(PREVIEW_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPreview>;
    if (typeof parsed.tenantId !== "string" || typeof parsed.tenantName !== "string") return null;
    return { tenantId: parsed.tenantId, tenantName: parsed.tenantName };
  } catch {
    return null;
  }
}

function saveStoredPreview(preview: StoredPreview | null): void {
  try {
    if (typeof window === "undefined") return;
    if (preview) window.sessionStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(preview));
    else window.sessionStorage.removeItem(PREVIEW_STORAGE_KEY);
  } catch {
    // sessionStorage無効環境(プライベートブラウズ等)では静かに無視
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const storedPreview = loadStoredPreview();
  const [previewMode, setPreviewMode] = useState(storedPreview !== null);
  const [previewTenantId, setPreviewTenantId] = useState<string | null>(storedPreview?.tenantId ?? null);
  const [previewTenantName, setPreviewTenantName] = useState<string | null>(storedPreview?.tenantName ?? null);
  const [tenantPlan, setTenantPlan] = useState<TenantPlan | null>(null);
  const [onboardingStage, setOnboardingStage] = useState<OnboardingStageFlags | null>(null);
  const [onboardingStageResolved, setOnboardingStageResolved] = useState(false);

  const loadUser = useCallback(async () => {
    setIsLoading(true);
    try {
      const { data } = await supabase.auth.getSession();
      const session = data.session;
      if (!session) {
        setUser(null);
        return;
      }

      // TODO: Replace with GET /v1/auth/me when Stream A API is available
      const supaUser = session.user;
      const appMeta = (supaUser.app_metadata ?? {}) as Record<string, unknown>;
      const userMeta = (supaUser.user_metadata ?? {}) as Record<string, unknown>;
      const role = parseRole(appMeta);
      const tenantId =
        (appMeta.tenant_id as string | undefined) ??
        (userMeta.tenant_id as string | undefined) ??
        null;
      const tenantName =
        (appMeta.tenant_name as string | undefined) ??
        (userMeta.tenant_name as string | undefined) ??
        null;

      setUser({
        id: supaUser.id,
        email: supaUser.email ?? "",
        role,
        tenantId,
        tenantName,
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUser();

    const { data: listener } = supabase.auth.onAuthStateChange(() => {
      void loadUser();
    });

    return () => {
      listener.subscription.unsubscribe();
    };
  }, [loadUser]);

  // 表示対象テナントのプランを取得する。プレビュー中はプレビュー先テナント、
  // 通常のclient_adminは自テナント、それ以外(super_adminの集約ビュー)はnullのまま。
  //
  // Asana 1217040702572796(P6): 同じ my-tenant 呼び出しに、着地判定用の
  // オンボーディング段階(onboardingStage)を相乗りさせる。新規 fetch は作らない。
  // previewMode(super_adminのクライアントビュー)は対象外 — 決定Aは「テナント本人の
  // 初回ログイン」の話であり、super_adminの一時的なプレビュー閲覧を新規テナント扱いに
  // してはならない。
  useEffect(() => {
    let cancelled = false;

    async function loadTenantPlan() {
      try {
        if (previewMode && previewTenantId) {
          const res = await authFetch(`${API_BASE}/v1/admin/tenants/${previewTenantId}`);
          if (!res.ok) {
            if (!cancelled) { setTenantPlan(null); setOnboardingStage(null); setOnboardingStageResolved(true); }
            return;
          }
          const data = (await res.json()) as { plan?: TenantPlan };
          if (!cancelled) { setTenantPlan(data.plan ?? "free_ad"); setOnboardingStage(null); setOnboardingStageResolved(true); }
          return;
        }
        if (!previewMode && user?.role === "client_admin") {
          const res = await authFetch(`${API_BASE}/v1/admin/my-tenant`);
          if (!res.ok) {
            if (!cancelled) { setTenantPlan(null); setOnboardingStage(null); setOnboardingStageResolved(true); }
            return;
          }
          const data = (await res.json()) as { plan?: TenantPlan; onboarding_stage?: OnboardingStageFlags };
          if (!cancelled) {
            setTenantPlan(data.plan ?? "free_ad");
            setOnboardingStage(data.onboarding_stage ?? null);
            setOnboardingStageResolved(true);
          }
          return;
        }
        if (!cancelled) { setTenantPlan(null); setOnboardingStage(null); setOnboardingStageResolved(true); }
      } catch {
        if (!cancelled) { setTenantPlan(null); setOnboardingStage(null); setOnboardingStageResolved(true); }
      }
    }

    void loadTenantPlan();
    return () => { cancelled = true; };
  }, [user, previewMode, previewTenantId]);

  const logout = useCallback(async () => {
    // 会話には顧客名・電話番号などの個人情報が載りうる。共有端末で次の利用者に残さないため、
    // ネットワーク越しのサインアウト(遅延・失敗しうる)より先にローカルの会話を消す。
    clearChatSession(CHAT_SESSION_SURFACE_FULLSCREEN);
    clearChatSession(CHAT_SESSION_SURFACE_PANEL);
    await supabase.auth.signOut();
    setUser(null);
    setPreviewMode(false);
    setPreviewTenantId(null);
    setPreviewTenantName(null);
    saveStoredPreview(null);
  }, []);

  const enterPreview = useCallback((tenantId: string, tenantName: string) => {
    setPreviewMode(true);
    setPreviewTenantId(tenantId);
    setPreviewTenantName(tenantName);
    saveStoredPreview({ tenantId, tenantName });
  }, []);

  const exitPreview = useCallback(() => {
    setPreviewMode(false);
    setPreviewTenantId(null);
    setPreviewTenantName(null);
    saveStoredPreview(null);
  }, []);

  const effectiveRole = previewMode ? "client_admin" : (user?.role ?? "anonymous");
  const isSuperAdmin = effectiveRole === "super_admin";
  const isClientAdmin = effectiveRole === "client_admin";

  return (
    <AuthContext.Provider value={{
      user,
      isLoading,
      isSuperAdmin,
      isClientAdmin,
      logout,
      previewMode,
      previewTenantId,
      previewTenantName,
      enterPreview,
      exitPreview,
      tenantPlan,
      onboardingStage,
      onboardingStageResolved,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
