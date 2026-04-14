// admin-ui/src/pages/admin/options/index.tsx
// Phase63: オプション代行管理ページ（super_admin専用）

import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { authFetch, API_BASE } from "../../../lib/api";
import { useAuth } from "../../../auth/useAuth";

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

interface OptionOrder {
  id: string;
  tenant_id: string;
  chat_session_id: string | null;
  description: string;
  llm_estimate_amount: number | null;
  final_amount: number | null;
  status: "pending" | "in_progress" | "completed";
  stripe_usage_recorded: boolean;
  ordered_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

type StatusFilter = "" | "pending" | "in_progress" | "completed";

// ---------------------------------------------------------------------------
// ステータスバッジ
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: OptionOrder["status"] }) {
  const cfg = {
    pending: { bg: "rgba(251,191,36,0.15)", border: "rgba(251,191,36,0.3)", color: "#fbbf24", label: "未対応" },
    in_progress: { bg: "rgba(96,165,250,0.15)", border: "rgba(96,165,250,0.3)", color: "#60a5fa", label: "対応中" },
    completed: { bg: "rgba(34,197,94,0.15)", border: "rgba(34,197,94,0.3)", color: "#4ade80", label: "完了" },
  }[status];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", padding: "3px 10px",
      borderRadius: 999, fontSize: 11, fontWeight: 700,
      background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color,
      whiteSpace: "nowrap",
    }}>
      {cfg.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 金額フォーマット
// ---------------------------------------------------------------------------

function fmtAmount(v: number | null): string {
  if (v == null) return "—";
  return `¥${v.toLocaleString("ja-JP")}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ja-JP", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// メインページ
// ---------------------------------------------------------------------------

export default function OptionManagementPage() {
  const navigate = useNavigate();
  const { isSuperAdmin, isLoading } = useAuth();

  const [items, setItems] = useState<OptionOrder[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<OptionOrder | null>(null);

  const LIMIT = 20;

  // RBAC: super_admin 以外はリダイレクト
  useEffect(() => {
    if (!isLoading && !isSuperAdmin) navigate("/admin", { replace: true });
  }, [isLoading, isSuperAdmin, navigate]);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(LIMIT), offset: String(offset) });
      if (statusFilter) params.set("status", statusFilter);
      const res = await authFetch(`${API_BASE}/v1/admin/options?${params.toString()}`);
      if (!res.ok) return;
      const data = await res.json() as { items: OptionOrder[]; total: number };
      setItems(data.items ?? []);
      setTotal(data.total ?? 0);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [offset, statusFilter]);

  useEffect(() => { void fetchItems(); }, [fetchItems]);

  // フィルター変更時はページをリセット
  const handleFilterChange = (f: StatusFilter) => {
    setStatusFilter(f);
    setOffset(0);
  };

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));
  const currentPage = Math.floor(offset / LIMIT) + 1;

  const PAGE_BG = "#0f172a";
  const CARD_BG = "rgba(255,255,255,0.03)";
  const BORDER = "#1f2937";
  const TEXT_MAIN = "#f9fafb";
  const TEXT_SUB = "#9ca3af";

  const FILTER_TABS: { label: string; value: StatusFilter }[] = [
    { label: "すべて", value: "" },
    { label: "未対応", value: "pending" },
    { label: "対応中", value: "in_progress" },
    { label: "完了", value: "completed" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: PAGE_BG, color: TEXT_MAIN, fontFamily: "system-ui, -apple-system, sans-serif", padding: "24px 16px" }}>
      {/* ヘッダー */}
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>💼 オプション代行管理</h1>
        <p style={{ fontSize: 13, color: TEXT_SUB, marginBottom: 20 }}>テナントから依頼された代行作業の管理・金額確定・完了処理を行います</p>

        {/* フィルタータブ */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          {FILTER_TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => handleFilterChange(tab.value)}
              style={{
                padding: "6px 16px", borderRadius: 999, fontSize: 13, fontWeight: 600,
                border: "1px solid",
                borderColor: statusFilter === tab.value ? "#60a5fa" : BORDER,
                background: statusFilter === tab.value ? "rgba(96,165,250,0.15)" : "transparent",
                color: statusFilter === tab.value ? "#60a5fa" : TEXT_SUB,
                cursor: "pointer", minHeight: 36,
              }}
            >
              {tab.label}
            </button>
          ))}
          <span style={{ marginLeft: "auto", fontSize: 12, color: TEXT_SUB, alignSelf: "center" }}>
            {total} 件
          </span>
        </div>

        {/* テーブル */}
        <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${BORDER}`, background: "rgba(255,255,255,0.02)" }}>
                {["テナント", "作業内容", "LLM見積", "確定金額", "ステータス", "発注日時"].map((h) => (
                  <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontSize: 11, fontWeight: 600, color: TEXT_SUB, whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} style={{ padding: 32, textAlign: "center", color: TEXT_SUB }}>読み込み中...</td></tr>
              ) : items.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: 32, textAlign: "center", color: TEXT_SUB }}>該当する発注はありません</td></tr>
              ) : items.map((item) => (
                <tr
                  key={item.id}
                  onClick={() => setSelected(item)}
                  style={{
                    borderBottom: `1px solid ${BORDER}`, cursor: "pointer",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.04)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <td style={{ padding: "10px 14px", color: TEXT_MAIN, fontFamily: "monospace", fontSize: 11 }}>
                    {item.tenant_id}
                  </td>
                  <td style={{ padding: "10px 14px", color: TEXT_MAIN, maxWidth: 280 }}>
                    <span title={item.description}>
                      {item.description.length > 40 ? item.description.slice(0, 40) + "…" : item.description}
                    </span>
                  </td>
                  <td style={{ padding: "10px 14px", color: TEXT_SUB, whiteSpace: "nowrap" }}>{fmtAmount(item.llm_estimate_amount)}</td>
                  <td style={{ padding: "10px 14px", color: TEXT_MAIN, fontWeight: 600, whiteSpace: "nowrap" }}>{fmtAmount(item.final_amount)}</td>
                  <td style={{ padding: "10px 14px" }}><StatusBadge status={item.status} /></td>
                  <td style={{ padding: "10px 14px", color: TEXT_SUB, whiteSpace: "nowrap", fontSize: 11 }}>{fmtDate(item.ordered_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ページネーション */}
        {totalPages > 1 && (
          <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 16 }}>
            <button
              onClick={() => setOffset(Math.max(0, offset - LIMIT))}
              disabled={currentPage === 1}
              style={{ padding: "6px 14px", borderRadius: 6, border: `1px solid ${BORDER}`, background: "transparent", color: TEXT_SUB, cursor: currentPage === 1 ? "not-allowed" : "pointer", opacity: currentPage === 1 ? 0.4 : 1, minHeight: 36 }}
            >← 前へ</button>
            <span style={{ padding: "6px 12px", color: TEXT_SUB, fontSize: 13, alignSelf: "center" }}>
              {currentPage} / {totalPages}
            </span>
            <button
              onClick={() => setOffset(offset + LIMIT)}
              disabled={currentPage >= totalPages}
              style={{ padding: "6px 14px", borderRadius: 6, border: `1px solid ${BORDER}`, background: "transparent", color: TEXT_SUB, cursor: currentPage >= totalPages ? "not-allowed" : "pointer", opacity: currentPage >= totalPages ? 0.4 : 1, minHeight: 36 }}
            >次へ →</button>
          </div>
        )}
      </div>

      {/* 詳細モーダル */}
      {selected && (
        <OrderDetailModal
          order={selected}
          onClose={() => setSelected(null)}
          onRefresh={() => { setSelected(null); void fetchItems(); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 詳細モーダル（タスク2 + タスク3b を含む）
// ---------------------------------------------------------------------------

function OrderDetailModal({
  order,
  onClose,
  onRefresh,
}: {
  order: OptionOrder;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [editedAmount, setEditedAmount] = useState<string>(
    order.final_amount != null ? String(order.final_amount) : "",
  );
  const [editedStatus, setEditedStatus] = useState<OptionOrder["status"]>(order.status);
  const [saving, setSaving] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  // お知らせ送信フォーム表示状態
  const [showNotifyForm, setShowNotifyForm] = useState(false);
  const [notifyDate, setNotifyDate] = useState("");
  const [notifyMsg, setNotifyMsg] = useState("");
  const [notifySending, setNotifySending] = useState(false);
  const [notifyMsg2, setNotifyMsg2] = useState<string | null>(null);

  const BORDER = "#1f2937";
  const TEXT_MAIN = "#f9fafb";
  const TEXT_SUB = "#9ca3af";

  // お知らせフォームを開いたときにデフォルトメッセージを生成
  const handleOpenNotify = () => {
    const amountStr = order.final_amount != null
      ? `¥${order.final_amount.toLocaleString("ja-JP")}`
      : order.llm_estimate_amount != null
      ? `¥${order.llm_estimate_amount.toLocaleString("ja-JP")}（見積）`
      : "別途ご連絡";
    setNotifyMsg(`${order.description}の作業について、{日時}に実施予定です。確定金額: ${amountStr}`);
    setShowNotifyForm(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const body: Record<string, unknown> = { status: editedStatus };
      const parsedAmount = parseInt(editedAmount, 10);
      if (!isNaN(parsedAmount) && parsedAmount > 0) body["final_amount"] = parsedAmount;
      const res = await authFetch(`${API_BASE}/v1/admin/options/${order.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setSaveMsg("保存しました");
        setTimeout(() => onRefresh(), 800);
      } else {
        setSaveMsg("保存に失敗しました");
      }
    } catch {
      setSaveMsg("エラーが発生しました");
    } finally {
      setSaving(false);
    }
  };

  const handleComplete = async () => {
    if (!confirm("この発注を完了としてマークしますか？\nテナントに完了通知が送信され、Stripe請求に加算されます。")) return;
    setCompleting(true);
    setSaveMsg(null);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/options/${order.id}/complete`, {
        method: "PUT",
      });
      if (res.ok) {
        setSaveMsg("完了処理が完了しました");
        setTimeout(() => onRefresh(), 800);
      } else {
        setSaveMsg("完了処理に失敗しました");
      }
    } catch {
      setSaveMsg("エラーが発生しました");
    } finally {
      setCompleting(false);
    }
  };

  const handleSendNotify = async () => {
    setNotifySending(true);
    setNotifyMsg2(null);
    try {
      // {日時} プレースホルダーを実際の日時で置換
      const resolvedMsg = notifyDate
        ? notifyMsg.replace("{日時}", new Date(notifyDate).toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }))
        : notifyMsg.replace("{日時}", "後日ご連絡");

      const res = await authFetch(`${API_BASE}/v1/admin/notifications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient_tenant_id: order.tenant_id,
          type: "option_scheduled",
          title: "代行作業のスケジュールについて",
          message: resolvedMsg,
          link: "/admin/options",
        }),
      });
      if (res.ok) {
        setNotifyMsg2("送信しました");
        setShowNotifyForm(false);
      } else {
        setNotifyMsg2("送信に失敗しました");
      }
    } catch {
      setNotifyMsg2("エラーが発生しました");
    } finally {
      setNotifySending(false);
    }
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: "#111827", border: `1px solid ${BORDER}`, borderRadius: 12,
        width: "100%", maxWidth: 560, maxHeight: "90vh", overflowY: "auto", padding: 24,
      }}>
        {/* ヘッダー */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: TEXT_MAIN, margin: 0 }}>発注詳細</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", color: TEXT_SUB, fontSize: 20, cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>

        {/* 詳細情報 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
          {[
            ["テナントID", order.tenant_id],
            ["発注日時", fmtDate(order.ordered_at)],
            ["完了日時", fmtDate(order.completed_at)],
            ["LLM見積額", fmtAmount(order.llm_estimate_amount)],
          ].map(([label, value]) => (
            <div key={label} style={{ display: "flex", gap: 12, fontSize: 13 }}>
              <span style={{ color: TEXT_SUB, width: 100, flexShrink: 0 }}>{label}</span>
              <span style={{ color: TEXT_MAIN, fontFamily: label === "テナントID" ? "monospace" : undefined }}>{value}</span>
            </div>
          ))}

          {/* 作業内容（全文） */}
          <div style={{ fontSize: 13 }}>
            <span style={{ color: TEXT_SUB, display: "block", marginBottom: 6 }}>作業内容</span>
            <div style={{ color: TEXT_MAIN, background: "rgba(255,255,255,0.04)", border: `1px solid ${BORDER}`, borderRadius: 8, padding: "10px 12px", lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {order.description}
            </div>
          </div>
        </div>

        <hr style={{ border: "none", borderTop: `1px solid ${BORDER}`, margin: "16px 0" }} />

        {/* 編集フォーム */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 20 }}>
          {/* 確定金額 */}
          <div style={{ fontSize: 13 }}>
            <label style={{ color: TEXT_SUB, display: "block", marginBottom: 6 }}>確定金額（円・税別）</label>
            <input
              type="number"
              min={0}
              value={editedAmount}
              onChange={(e) => setEditedAmount(e.target.value)}
              placeholder="例: 8000"
              style={{
                width: "100%", padding: "8px 12px", borderRadius: 8, border: `1px solid ${BORDER}`,
                background: "rgba(255,255,255,0.05)", color: TEXT_MAIN, fontSize: 14,
                boxSizing: "border-box",
              }}
            />
          </div>

          {/* ステータス変更 */}
          <div style={{ fontSize: 13 }}>
            <label style={{ color: TEXT_SUB, display: "block", marginBottom: 6 }}>ステータス</label>
            <select
              value={editedStatus}
              onChange={(e) => setEditedStatus(e.target.value as OptionOrder["status"])}
              style={{
                width: "100%", padding: "8px 12px", borderRadius: 8, border: `1px solid ${BORDER}`,
                background: "#1f2937", color: TEXT_MAIN, fontSize: 14,
              }}
            >
              <option value="pending">未対応 (pending)</option>
              <option value="in_progress">対応中 (in_progress)</option>
              <option value="completed">完了 (completed)</option>
            </select>
          </div>
        </div>

        {/* アクションボタン群 */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {/* 保存 */}
          <button
            onClick={() => void handleSave()}
            disabled={saving}
            style={{
              flex: 1, padding: "9px 16px", borderRadius: 8, border: "none",
              background: "#3b82f6", color: "#fff", fontSize: 14, fontWeight: 600,
              cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.7 : 1, minHeight: 44,
            }}
          >
            {saving ? "保存中..." : "💾 保存"}
          </button>

          {/* 完了マーク（completed でない場合のみ） */}
          {order.status !== "completed" && (
            <button
              onClick={() => void handleComplete()}
              disabled={completing}
              style={{
                flex: 1, padding: "9px 16px", borderRadius: 8, border: "none",
                background: "#059669", color: "#fff", fontSize: 14, fontWeight: 600,
                cursor: completing ? "not-allowed" : "pointer", opacity: completing ? 0.7 : 1, minHeight: 44,
              }}
            >
              {completing ? "処理中..." : "✅ 完了マーク"}
            </button>
          )}

          {/* お知らせ送信 */}
          <button
            onClick={handleOpenNotify}
            style={{
              flex: 1, padding: "9px 16px", borderRadius: 8, border: `1px solid ${BORDER}`,
              background: "transparent", color: TEXT_SUB, fontSize: 14, fontWeight: 600,
              cursor: "pointer", minHeight: 44,
            }}
          >
            📅 お知らせ送信
          </button>
        </div>

        {saveMsg && (
          <p style={{ fontSize: 12, color: saveMsg.includes("失敗") || saveMsg.includes("エラー") ? "#f87171" : "#4ade80", textAlign: "center", margin: "4px 0" }}>
            {saveMsg}
          </p>
        )}

        {/* お知らせ送信フォーム */}
        {showNotifyForm && (
          <div style={{ marginTop: 16, padding: 16, background: "rgba(255,255,255,0.03)", border: `1px solid ${BORDER}`, borderRadius: 10 }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: TEXT_MAIN, marginBottom: 12 }}>テナントへのお知らせ送信</p>

            <div style={{ marginBottom: 12, fontSize: 13 }}>
              <label style={{ color: TEXT_SUB, display: "block", marginBottom: 6 }}>実施日時（任意）</label>
              <input
                type="datetime-local"
                value={notifyDate}
                onChange={(e) => setNotifyDate(e.target.value)}
                style={{
                  width: "100%", padding: "8px 12px", borderRadius: 8, border: `1px solid ${BORDER}`,
                  background: "rgba(255,255,255,0.05)", color: TEXT_MAIN, fontSize: 13,
                  boxSizing: "border-box",
                }}
              />
            </div>

            <div style={{ marginBottom: 12, fontSize: 13 }}>
              <label style={{ color: TEXT_SUB, display: "block", marginBottom: 6 }}>メッセージ本文</label>
              <textarea
                value={notifyMsg}
                onChange={(e) => setNotifyMsg(e.target.value)}
                rows={4}
                style={{
                  width: "100%", padding: "8px 12px", borderRadius: 8, border: `1px solid ${BORDER}`,
                  background: "rgba(255,255,255,0.05)", color: TEXT_MAIN, fontSize: 13,
                  resize: "vertical", boxSizing: "border-box", lineHeight: 1.6,
                }}
              />
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => void handleSendNotify()}
                disabled={notifySending || !notifyMsg.trim()}
                style={{
                  flex: 1, padding: "8px 16px", borderRadius: 8, border: "none",
                  background: "#6366f1", color: "#fff", fontSize: 13, fontWeight: 600,
                  cursor: notifySending ? "not-allowed" : "pointer", opacity: notifySending ? 0.7 : 1, minHeight: 40,
                }}
              >
                {notifySending ? "送信中..." : "📨 送信する"}
              </button>
              <button
                onClick={() => setShowNotifyForm(false)}
                style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${BORDER}`, background: "transparent", color: TEXT_SUB, fontSize: 13, cursor: "pointer", minHeight: 40 }}
              >
                キャンセル
              </button>
            </div>

            {notifyMsg2 && (
              <p style={{ fontSize: 12, color: notifyMsg2.includes("失敗") || notifyMsg2.includes("エラー") ? "#f87171" : "#4ade80", textAlign: "center", marginTop: 8 }}>
                {notifyMsg2}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
