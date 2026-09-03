// admin-ui/src/components/admin/AIReportTab.test.tsx
//
// ★このテストが守っているもの（D8-2）★
// Hermes は営業提案(proposal_type='upsell')も FAQ チューニング提案と同じ
// tuning_rules に投稿する。この一覧に混ざると:
//   1. 営業提案が「トリガー / 提案返答」という FAQ のラベルで描画される
//   2. 同じ承認ボタンから承認すると is_active を立てようとして
//      DB の CHECK 制約(tuning_rules_upsell_never_active_check)に当たり 500 になる
//
// サーバ側 listRules も既定で behavior に絞っているが、この面が
// 「応答方針の提案だけを扱う」ことは呼び出し側でも明示しておく
// (既定が将来変わってもここは壊れない)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import AIReportTab from "./AIReportTab";
import { useAuth } from "../../auth/useAuth";
import { authFetch } from "../../lib/api";

vi.mock("../../auth/useAuth", () => ({ useAuth: vi.fn() }));
vi.mock("../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
  authFetch: vi.fn(),
}));

const ok = (data: unknown) =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(data) } as Response);

/** authFetch に渡った URL のうち tuning-rules を叩いたものを返す。 */
function tuningRuleUrls(): string[] {
  return vi.mocked(authFetch).mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.includes("/v1/admin/tuning-rules"));
}

beforeEach(() => {
  vi.mocked(authFetch).mockReset().mockImplementation(() => ok({ rules: [] }));
});

describe("AIReportTab — 提案一覧の取得", () => {
  it("★fetch に proposal_type=behavior が入る（営業提案を混ぜない）★", async () => {
    vi.mocked(useAuth).mockReturnValue({ isSuperAdmin: true } as ReturnType<typeof useAuth>);
    render(<AIReportTab tenantId="tenant-a" />);

    await waitFor(() => expect(tuningRuleUrls().length).toBeGreaterThan(0));
    expect(tuningRuleUrls()[0]).toContain("proposal_type=behavior");
  });

  it("従来の絞り込み(source=judge,hermes / status=pending)は維持する", async () => {
    vi.mocked(useAuth).mockReturnValue({ isSuperAdmin: true } as ReturnType<typeof useAuth>);
    render(<AIReportTab tenantId="tenant-a" />);

    await waitFor(() => expect(tuningRuleUrls().length).toBeGreaterThan(0));
    const url = tuningRuleUrls()[0]!;
    expect(url).toContain("source=judge,hermes");
    expect(url).toContain("status=pending");
    expect(url).toContain("tenant=tenant-a");
  });

  it("★client_admin では提案を取得しない（このガードを緩めない）★", async () => {
    // AIReportTab は SuperAdminRoute 配下にしかマウントされないため、
    // ここを緩めても client_admin は到達できない。緩めると FAQ 提案の
    // evidence(心理原則・評価ID)まで開示することになるので維持する。
    vi.mocked(useAuth).mockReturnValue({ isSuperAdmin: false } as ReturnType<typeof useAuth>);
    render(<AIReportTab tenantId="tenant-a" />);

    await waitFor(() => expect(vi.mocked(authFetch).mock.calls.length).toBeGreaterThan(0));
    expect(tuningRuleUrls()).toHaveLength(0);
  });
});
