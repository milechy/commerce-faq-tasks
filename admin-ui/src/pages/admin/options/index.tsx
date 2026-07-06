// admin-ui/src/pages/admin/options/index.tsx
// Phase63: オプション代行管理ページ（super_admin専用）

import { useState, useEffect, useCallback, useRef } from "react";
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

interface SaiTaskStep {
  step: number;
  action: string;
  reflection?: string;
  error?: string;
}

interface SaiTask {
  status: "queued" | "running" | "complete";
  steps: number;
  max_steps: number;
  description: string;
  last_action?: string;
  outcome?: "agent_reported_done" | "agent_reported_fail" | "step_limit_reached" | "error" | "unknown";
  steps_log?: SaiTaskStep[];
  final_screenshot_base64?: string;
}

interface SaiTaskRule {
  id: number;
  tenant_id: string;
  trigger_pattern: string;
  expected_behavior: string;
  priority: number;
  is_active: boolean;
  status: string;
  source: string;
  evidence: { taskIds?: string[]; orderIds?: string[]; outcome?: string; note?: string } | null;
  created_at: string;
}

const SAI_OUTCOME_LABEL: Record<string, string> = {
  agent_reported_done: "Saiが完了を報告",
  agent_reported_fail: "Saiが失敗を報告",
  step_limit_reached: "ステップ上限に到達",
  error: "エラーで停止",
  unknown: "不明",
};

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

  const PAGE_BG = "var(--background)";
  const CARD_BG = "var(--card)";
  const BORDER = "var(--border)";
  const TEXT_MAIN = "var(--foreground)";
  const TEXT_SUB = "var(--muted-foreground)";

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
        <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>💼 代行作業の依頼・管理</h1>
        <p style={{ fontSize: 13, color: TEXT_SUB, marginBottom: 20 }}>テナントから依頼された代行作業の管理・金額確定・完了処理を行います</p>

        <SaiRulesPanel />

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
                {["テナント", "作業内容", "AI処理コスト見積", "確定金額", "ステータス", "発注日時"].map((h) => (
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

  const BORDER = "var(--border)";
  const TEXT_MAIN = "var(--foreground)";
  const TEXT_SUB = "var(--muted-foreground)";

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
        background: "var(--card)", border: `1px solid ${BORDER}`, borderRadius: 12,
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
            <div style={{ color: TEXT_MAIN, background: "var(--muted)", border: `1px solid ${BORDER}`, borderRadius: 8, padding: "10px 12px", lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
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
                background: "var(--input)", color: TEXT_MAIN, fontSize: 14,
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
                background: "var(--input)", color: TEXT_MAIN, fontSize: 14,
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

        {/* Sai(Agent S)セクション */}
        {order.status !== "completed" && (
          <>
            <hr style={{ border: "none", borderTop: `1px solid ${BORDER}`, margin: "16px 0" }} />
            <SaiSection orderId={order.id} />
          </>
        )}

        {/* お知らせ送信フォーム */}
        {showNotifyForm && (
          <div style={{ marginTop: 16, padding: 16, background: "var(--muted)", border: `1px solid ${BORDER}`, borderRadius: 10 }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: TEXT_MAIN, marginBottom: 12 }}>テナントへのお知らせ送信</p>

            <div style={{ marginBottom: 12, fontSize: 13 }}>
              <label style={{ color: TEXT_SUB, display: "block", marginBottom: 6 }}>実施日時（任意）</label>
              <input
                type="datetime-local"
                value={notifyDate}
                onChange={(e) => setNotifyDate(e.target.value)}
                style={{
                  width: "100%", padding: "8px 12px", borderRadius: 8, border: `1px solid ${BORDER}`,
                  background: "var(--input)", color: TEXT_MAIN, fontSize: 13,
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
                  background: "var(--input)", color: TEXT_MAIN, fontSize: 13,
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

// ---------------------------------------------------------------------------
// Sai(Agent S)セクション — GUI自動化エージェントへの試行・結果レビュー
//
// 重要: Saiの自己申告(outcome)は成否の確定情報ではない。最終スクリーンショットを
// 人間(super_admin)が目視確認した上で、上の「完了マーク」ボタンで完了させる運用。
// ここでは status/final_amount 等を一切自動更新しない。
// ---------------------------------------------------------------------------

function SaiSection({ orderId }: { orderId: string }) {
  const BORDER = "var(--border)";
  const TEXT_MAIN = "var(--foreground)";
  const TEXT_SUB = "var(--muted-foreground)";

  const [task, setTask] = useState<SaiTask | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPoll = useCallback(() => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const fetchTask = useCallback(async (schedule: boolean) => {
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/options/${orderId}/sai-task`);
      if (res.status === 404) return; // 未試行
      if (!res.ok) {
        setError("Sai実行結果の取得に失敗しました");
        return;
      }
      const data = await res.json() as { task: SaiTask };
      setTask(data.task);
      if (schedule && data.task.status !== "complete") {
        pollTimer.current = setTimeout(() => { void fetchTask(true); }, 3000);
      }
    } catch {
      setError("Sai実行結果の取得に失敗しました");
    }
  }, [orderId]);

  // マウント時: 既に試行済みなら状態を復元してポーリング再開
  useEffect(() => {
    void fetchTask(true);
    return () => clearPoll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  const handleTrySai = async () => {
    if (!confirm("Saiエージェントにこの作業を試行させますか？\n実際にブラウザ操作等を行い、API利用コストが発生します。")) return;
    setStarting(true);
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/options/${orderId}/try-sai`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((body as { error?: string }).error ?? "Saiへの依頼に失敗しました");
        return;
      }
      clearPoll();
      void fetchTask(true);
    } catch {
      setError("Saiへの依頼に失敗しました");
    } finally {
      setStarting(false);
    }
  };

  const isRunning = task && task.status !== "complete";

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: TEXT_MAIN, margin: 0 }}>🤖 Sai(Agent S)による代行試行</p>
        <button
          onClick={() => void handleTrySai()}
          disabled={starting || !!isRunning}
          style={{
            padding: "6px 14px", borderRadius: 8, border: "none",
            background: "#7c3aed", color: "#fff", fontSize: 12, fontWeight: 600,
            cursor: starting || isRunning ? "not-allowed" : "pointer",
            opacity: starting || isRunning ? 0.6 : 1, minHeight: 32,
          }}
        >
          {starting ? "依頼中..." : task ? "🔁 再試行" : "▶ Saiに依頼する"}
        </button>
      </div>

      {error && <p style={{ fontSize: 12, color: "#f87171", margin: "0 0 8px" }}>{error}</p>}

      {task && (
        <div style={{ background: "rgba(124,58,237,0.08)", border: "1px solid rgba(124,58,237,0.25)", borderRadius: 10, padding: 12 }}>
          <div style={{ display: "flex", gap: 12, fontSize: 12, color: TEXT_SUB, marginBottom: 8, flexWrap: "wrap" }}>
            <span>状態: <strong style={{ color: TEXT_MAIN }}>
              {task.status === "queued" ? "待機中" : task.status === "running" ? "実行中" : "完了"}
            </strong></span>
            <span>ステップ: <strong style={{ color: TEXT_MAIN }}>{task.steps} / {task.max_steps}</strong></span>
            {task.outcome && (
              <span>自己申告: <strong style={{ color: TEXT_MAIN }}>{SAI_OUTCOME_LABEL[task.outcome] ?? task.outcome}</strong></span>
            )}
          </div>

          {isRunning && task.last_action && (
            <p style={{ fontSize: 11, color: TEXT_SUB, fontFamily: "monospace", margin: "0 0 8px", wordBreak: "break-all" }}>
              直近の操作: {task.last_action}
            </p>
          )}

          {task.status === "complete" && (
            <>
              <p style={{ fontSize: 11, color: "#fbbf24", margin: "0 0 8px" }}>
                ⚠️ 上記は Sai の自己申告です。実際の成否は下のスクリーンショットを目視確認してから「完了マーク」で確定してください。
              </p>
              {task.final_screenshot_base64 && (
                <img
                  src={`data:image/png;base64,${task.final_screenshot_base64}`}
                  alt="Sai実行後の最終スクリーンショット"
                  style={{ width: "100%", borderRadius: 8, border: `1px solid ${BORDER}`, marginBottom: 8 }}
                />
              )}
              {task.steps_log && task.steps_log.length > 0 && (
                <>
                  <button
                    onClick={() => setShowLog((v) => !v)}
                    style={{ background: "none", border: "none", color: "#a78bfa", fontSize: 11, cursor: "pointer", padding: 0 }}
                  >
                    {showLog ? "▲ 操作ログを隠す" : "▼ 操作ログを見る"}
                  </button>
                  {showLog && (
                    <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                      {task.steps_log.map((s) => (
                        <div key={s.step} style={{ fontSize: 11, color: TEXT_SUB, fontFamily: "monospace", wordBreak: "break-all" }}>
                          #{s.step} {s.error ? `error: ${s.error}` : s.action}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase6 (Sai Judge学習ループ): 提案ルールの承認キュー
//
// 現時点ではルールを自動提案するSai Judge本体は未実装(実行ログが十分に蓄積
// してから着手予定)のため、通常は「提案されたルールはありません」の空状態になる。
// 承認・却下の配線と注入経路(saiClient呼び出し前のtry-saiハンドラ)だけを
// 先行して用意しておく。
// ---------------------------------------------------------------------------

function SaiRulesPanel() {
  const BORDER = "var(--border)";
  const TEXT_MAIN = "var(--foreground)";
  const TEXT_SUB = "var(--muted-foreground)";

  const [rules, setRules] = useState<SaiTaskRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [processingId, setProcessingId] = useState<number | null>(null);

  const fetchRules = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/sai-rules?status=pending`);
      if (!res.ok) return;
      const data = await res.json() as { items: SaiTaskRule[] };
      setRules(data.items ?? []);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchRules(); }, [fetchRules]);

  const handleDecision = async (id: number, action: "approve" | "reject") => {
    setProcessingId(id);
    try {
      await authFetch(`${API_BASE}/v1/admin/sai-rules/${id}/${action}`, { method: "PUT" });
      setRules((prev) => prev.filter((r) => r.id !== id));
    } catch {
      // silent
    } finally {
      setProcessingId(null);
    }
  };

  if (loading || rules.length === 0) return null; // 空状態はページを圧迫しないよう非表示

  return (
    <div style={{ marginBottom: 20, border: `1px solid ${BORDER}`, borderRadius: 10, overflow: "hidden" }}>
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 16px", background: "transparent", border: "none", cursor: "pointer",
          color: TEXT_MAIN, fontSize: 14, fontWeight: 600,
        }}
      >
        <span>🧠 Sai提案ルール — 承認待ち {rules.length}件</span>
        <span style={{ color: TEXT_SUB, fontSize: 12 }}>{expanded ? "▲ 閉じる" : "▼ 開く"}</span>
      </button>
      {expanded && (
        <div style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
          {rules.map((rule) => (
            <div key={rule.id} style={{ border: `1px solid ${BORDER}`, borderRadius: 8, padding: 12 }}>
              <p style={{ fontSize: 12, color: TEXT_SUB, margin: "0 0 4px" }}>トリガー</p>
              <p style={{ fontSize: 13, color: TEXT_MAIN, margin: "0 0 8px" }}>「{rule.trigger_pattern}」</p>
              <p style={{ fontSize: 12, color: TEXT_SUB, margin: "0 0 4px" }}>提案内容</p>
              <p style={{ fontSize: 13, color: TEXT_MAIN, margin: "0 0 10px", lineHeight: 1.6 }}>{rule.expected_behavior}</p>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => void handleDecision(rule.id, "approve")}
                  disabled={processingId === rule.id}
                  style={{
                    flex: 1, padding: "8px 14px", borderRadius: 8, border: "1px solid rgba(74,222,128,0.4)",
                    background: "rgba(34,197,94,0.15)", color: "#4ade80", fontSize: 13, fontWeight: 600,
                    cursor: processingId === rule.id ? "not-allowed" : "pointer", opacity: processingId === rule.id ? 0.6 : 1, minHeight: 36,
                  }}
                >
                  ✅ 承認
                </button>
                <button
                  onClick={() => void handleDecision(rule.id, "reject")}
                  disabled={processingId === rule.id}
                  style={{
                    flex: 1, padding: "8px 14px", borderRadius: 8, border: "1px solid rgba(248,113,113,0.4)",
                    background: "rgba(239,68,68,0.15)", color: "#f87171", fontSize: 13, fontWeight: 600,
                    cursor: processingId === rule.id ? "not-allowed" : "pointer", opacity: processingId === rule.id ? 0.6 : 1, minHeight: 36,
                  }}
                >
                  ❌ 却下
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
