// GID 1217040818410419: 「書籍/PDF取り込みはR2C運用限定」の回帰テスト。
// 旧UI([tenantId].tsx)のタブ可視性がこの方針を守れているかをここで固定する。
// - client_admin にはPDFタブのボタン自体が出ない
// - super_admin には従来通り出る
// - previewMode中(通常のisSuperAdminがclient_admin相当に落ちる)のsuper_adminでも出る
//   (useAuth.tsx:213-214の罠。isSuperAdminではなく生の user.role で判定していることの確認)
// - ?tab=pdf への直リンクは、権限が無ければ list タブへフォールバックする(白画面にしない)
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import TenantKnowledgePage from "./[tenantId]";
import { useAuth } from "../../../auth/useAuth";
import { fetchWithAuth } from "../../../components/knowledge/shared";

vi.mock("../../../auth/useAuth", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../../../i18n/LangContext", () => ({
  useLang: () => ({ t: (k: string) => k, lang: "ja" }),
}));

vi.mock("../../../components/LangSwitcher", () => ({
  default: () => <div data-testid="lang-switcher-stub" />,
}));

// トークン取得は常に成功させる(空だと /login へリダイレクトされてページ自体が消える)。
// tenants一覧(super_admin専用)は空配列で素通りさせる。
vi.mock("../../../components/knowledge/shared", () => ({
  getAccessToken: vi.fn(() => Promise.resolve("test-token")),
  fetchWithAuth: vi.fn(() =>
    Promise.resolve({ json: () => Promise.resolve({ tenants: [] }) } as Response),
  ),
}));

// 各タブの内部実装(それぞれ独自のfetch/依存を持つ)は、このテストの関心事(タブの
// 出し分け)には不要なため、存在確認用の最小スタブに置き換える。
vi.mock("../../../components/knowledge/KnowledgeAttributionTab", () => ({
  default: () => <div data-testid="attribution-tab-stub" />,
}));
vi.mock("../../../components/knowledge/KnowledgeListTab", () => ({
  default: () => <div data-testid="list-tab-stub" />,
}));
vi.mock("../../../components/knowledge/TextInputTab", () => ({
  default: () => <div data-testid="text-tab-stub" />,
}));
vi.mock("../../../components/knowledge/UrlScrapeTab", () => ({
  default: () => <div data-testid="scrape-tab-stub" />,
}));
vi.mock("../../../components/knowledge/PdfUploadTab", () => ({
  default: () => <div data-testid="pdf-tab-stub" />,
  BookUploadsSection: () => <div data-testid="book-uploads-section-stub" />,
}));

// このページが参照するのは定数のみ。実体(index.tsx)はsupabaseクライアント等
// 別の依存を持つため、モジュールごとスタブ化して切り離す。
vi.mock("./index", () => ({
  KNOWLEDGE_TENANT_STORAGE_KEY: "knowledge_last_tenant",
}));

function baseAuth(overrides: Partial<ReturnType<typeof useAuth>> = {}) {
  return {
    user: { id: "1", email: "a@example.com", role: "client_admin", tenantId: "tenant-a", tenantName: "Tenant A" },
    isLoading: false,
    isSuperAdmin: false,
    isClientAdmin: true,
    logout: vi.fn(),
    previewMode: false,
    previewTenantId: null,
    previewTenantName: null,
    enterPreview: vi.fn(),
    exitPreview: vi.fn(),
    tenantPlan: null,
    ...overrides,
  } as ReturnType<typeof useAuth>;
}

function renderPage(path: string, overrides: Partial<ReturnType<typeof useAuth>> = {}) {
  vi.mocked(useAuth).mockReturnValue(baseAuth(overrides));
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/knowledge/:tenantId" element={<TenantKnowledgePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

// この環境(happy-dom)はwindow.localStorageを提供しないため、Mapベースの最小実装で補う
// (super_adminの場合にページが localStorage.setItem を呼ぶため未設定だと例外で落ちる)。
function installFakeLocalStorage() {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => void store.clear(),
    },
  });
}

beforeEach(() => {
  installFakeLocalStorage();
  vi.mocked(fetchWithAuth).mockReset();
  vi.mocked(fetchWithAuth).mockResolvedValue(
    { json: () => Promise.resolve({ tenants: [] }) } as Response,
  );
});

describe("TenantKnowledgePage — PDFタブの可視性(R2C運用限定, GID 1217040818410419)", () => {
  it("client_adminにはPDFタブのボタンが出ない", async () => {
    renderPage("/admin/knowledge/tenant-a");

    await screen.findByTestId("list-tab-stub");
    expect(screen.queryByText("PDFアップロード")).toBeNull();
    // 他のタブ(削除・enum縮小していないことの間接確認)は引き続き出る
    expect(screen.getByText("成約への貢献度")).toBeTruthy();
  });

  it("super_adminにはPDFタブのボタンが出る", async () => {
    renderPage("/admin/knowledge/tenant-a", {
      isSuperAdmin: true,
      isClientAdmin: false,
      user: { id: "2", email: "admin@example.com", role: "super_admin", tenantId: null, tenantName: null },
    });

    await screen.findByTestId("list-tab-stub");
    expect(screen.getByText("PDFアップロード")).toBeTruthy();
  });

  // 最大の罠(Asanaタスク本文より): previewMode中は通常のisSuperAdminがclient_admin相当に
  // フォールバックする(useAuth.tsx:213-214)。isSuperAdminで出し分けると、この状態にある
  // super_admin自身からもPDFタブが消えてしまう。判定は生の user.role でなければならない。
  it("previewMode中のsuper_admin(isSuperAdminはfalseに落ちる)でもPDFタブは出る", async () => {
    renderPage("/admin/knowledge/tenant-preview", {
      isSuperAdmin: false,
      isClientAdmin: true,
      previewMode: true,
      previewTenantId: "tenant-preview",
      previewTenantName: "Preview Tenant",
      user: { id: "2", email: "admin@example.com", role: "super_admin", tenantId: null, tenantName: null },
    });

    await screen.findByTestId("list-tab-stub");
    expect(screen.getByText("PDFアップロード")).toBeTruthy();
  });

  // 上の2件(「PDFアップロード」ボタンが出る)はボタンの可視性しか検証していない。
  // canManageBookPdf を参照する箇所はタブ配列・フォールバックuseEffect・実描画条件の
  // 3箇所あり、将来どれか1つだけ更新されて分岐した場合、ボタンは出るのに中身(PdfUploadTab)
  // が描画されない、という壊れ方をボタン可視性テストだけでは検知できない。
  // 実際に ?tab=pdf へ遷移してタブ内容が描画されることまで固定する。
  it("super_adminは?tab=pdfへ実際に遷移でき、PdfUploadTab(pdf-tab-stub)が描画される", async () => {
    renderPage("/admin/knowledge/tenant-a?tab=pdf", {
      isSuperAdmin: true,
      isClientAdmin: false,
      user: { id: "2", email: "admin@example.com", role: "super_admin", tenantId: null, tenantName: null },
    });

    await screen.findByTestId("pdf-tab-stub");
    expect(screen.queryByTestId("list-tab-stub")).toBeNull();
  });

  it("client_adminが?tab=pdfへ直リンクしても、白画面にならずlistタブへフォールバックする", async () => {
    renderPage("/admin/knowledge/tenant-a?tab=pdf");

    // フォールバックはロード完了後のuseEffectで行われるため、listタブの描画を待つ
    await waitFor(() => expect(screen.getByTestId("list-tab-stub")).toBeTruthy());
    expect(screen.queryByTestId("pdf-tab-stub")).toBeNull();
    expect(screen.queryByText("PDFアップロード")).toBeNull();
  });
});
