// admin-ui/src/pages/admin/billing/margin/UpsellProposalsSection.tsx
//
// Hermes が投稿した営業提案(粗利付き)を運営が採否する面。
// /admin/billing/margin(super_admin専用)の表の上に置く。
//
// ★AIReportTab には相乗りしない★
// AIReportTab は1テナント固定・FAQチューニングの文脈。アップセルは
// 「全テナントを横に並べてどこに営業するか」の判断で、粗利の数字と
// 隣り合っていないと意味をなさない。また承認ボタンの意味が違う
// (FAQ側は is_active=true でルールが実際に効く。こちらは営業案の記録のみ)。
import { useCallback, useEffect, useState } from "react";
import { API_BASE, authFetch } from "../../../../lib/api";
import { CARD } from "../utils";
import { parseUpsellProposalsResponse } from "./upsellProposals.schema";
import type { UpsellProposal } from "./upsellProposals.schema";

export function UpsellProposalsSection() {
  const [proposals, setProposals] = useState<UpsellProposal[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [status, setStatus] = useState<"loading" | "error" | "ready">("loading");
  const [actingId, setActingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/upsell-proposals`);
      if (!res.ok) {
        setStatus("error");
        return;
      }
      const parsed = parseUpsellProposalsResponse(await res.json());
      setProposals(parsed.proposals);
      setTruncated(parsed.truncated);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const act = async (proposalId: string, action: "adopt" | "dismiss") => {
    setActingId(proposalId);
    try {
      const res = await authFetch(
        `${API_BASE}/v1/admin/upsell-proposals/${proposalId}/${action}`,
        { method: "PUT" },
      );
      if (res.ok) {
        setProposals((prev) => prev.filter((p) => p.proposal_id !== proposalId));
        setToast(action === "adopt" ? "営業案として記録しました(AIの応答は変わりません)" : "見送りました");
      } else {
        setToast("操作に失敗しました。もう一度お試しください。");
      }
    } catch {
      setToast("操作に失敗しました。もう一度お試しください。");
    } finally {
      setActingId(null);
      setTimeout(() => setToast(null), 4000);
    }
  };

  if (status === "loading") return null;
  if (status === "error") return null; // このセクションは無くても粗利表は成立する(fail-silent)
  if (proposals.length === 0) return null;

  return (
    <section style={{ ...CARD, marginBottom: 24 }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 4px" }}>
        💴 アップセル提案
      </h2>
      <p style={{ margin: "0 0 16px", fontSize: 12, color: "var(--muted-foreground)" }}>
        Hermes が利用状況から検出した営業候補です。採否は下の粗利表と合わせて判断してください。
      </p>

      {truncated && (
        // 黙って切らない。上限に当たったことを画面に出す(marginダッシュボードの truncated 表示と同じ作法)。
        <p role="status" style={{ margin: "0 0 16px", fontSize: 12, color: "var(--muted-foreground)" }}>
          ※ 表示件数が上限に達しています。一部の提案は表示されていません。
        </p>
      )}

      {proposals.map((p) => (
        <div
          key={p.proposal_id}
          style={{
            padding: "14px 16px", marginBottom: 12, borderRadius: 10,
            border: "1px solid var(--border)", background: "rgba(34,197,94,0.06)",
          }}
        >
          {p.renderable ? (
            <>
              <p style={{ margin: "0 0 6px", fontWeight: 600, fontSize: 14 }}>{p.headline}</p>
              {p.lines.map((line, i) => (
                <p key={i} style={{ margin: "2px 0", fontSize: 13, color: "var(--foreground)" }}>{line}</p>
              ))}
            </>
          ) : (
            <p style={{ margin: 0, fontSize: 13, color: "var(--muted-foreground)" }}>
              テナント {p.tenant_id} の提案（現在算出できません。再読み込みしてください）
            </p>
          )}

          <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
            <button
              onClick={() => void act(p.proposal_id, "adopt")}
              disabled={actingId === p.proposal_id}
              style={{
                padding: "8px 14px", minHeight: 36, borderRadius: 8, border: "1px solid var(--border)",
                background: "#16a34a", color: "#fff", fontWeight: 600, fontSize: 13,
                cursor: actingId === p.proposal_id ? "not-allowed" : "pointer",
                opacity: actingId === p.proposal_id ? 0.6 : 1,
              }}
            >
              営業案として採用
            </button>
            <button
              onClick={() => void act(p.proposal_id, "dismiss")}
              disabled={actingId === p.proposal_id}
              style={{
                padding: "8px 14px", minHeight: 36, borderRadius: 8, border: "1px solid var(--border)",
                background: "transparent", color: "var(--foreground)", fontSize: 13,
                cursor: actingId === p.proposal_id ? "not-allowed" : "pointer",
                opacity: actingId === p.proposal_id ? 0.6 : 1,
              }}
            >
              見送り
            </button>
          </div>
          {/* ★常時表示。この操作の意味を毎回明示する★ */}
          <p style={{ margin: "8px 0 0", fontSize: 11, color: "var(--muted-foreground)" }}>
            ※ この操作で AI の応答ルールは変わりません。営業提案の採否を記録するだけです。
          </p>
        </div>
      ))}

      {toast && (
        <div role="status" style={{ fontSize: 13, color: "var(--muted-foreground)" }}>{toast}</div>
      )}
    </section>
  );
}
