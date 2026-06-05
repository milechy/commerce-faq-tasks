import { useState, useEffect } from "react";
import { authFetch, API_BASE } from "../../../lib/api";

type Ga4Status = "not_configured" | "pending" | "connected" | "error" | "timeout" | "permission_revoked";

interface Ga4StatusData {
  ga4_property_id: string | null;
  ga4_status: Ga4Status;
  ga4_connected_at: string | null;
  ga4_last_sync_at: string | null;
  ga4_error_message: string | null;
  tenant_contact_email: string | null;
  recent_tests: { test_type: string; success: boolean; error_message: string | null; tested_at: string }[];
}

export default function Ga4IntegrationTab({ tenantId }: { tenantId: string }) {
  const [statusData, setStatusData] = useState<Ga4StatusData | null>(null);
  const [serviceAccountEmail, setServiceAccountEmail] = useState<string | null>(null);
  const [propertyId, setPropertyId] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; result: { status: string; errorMessage?: string } } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [copied, setCopied] = useState(false);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  useEffect(() => {
    void loadData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  async function loadData() {
    setLoading(true);
    try {
      const [statusRes, saRes] = await Promise.all([
        authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/ga4/status`),
        authFetch(`${API_BASE}/v1/admin/ga4/service-account-info`),
      ]);
      if (statusRes.ok) {
        const data = await statusRes.json() as Ga4StatusData;
        setStatusData(data);
        setPropertyId(data.ga4_property_id ?? "");
        setContactEmail(data.tenant_contact_email ?? "");
      }
      if (saRes.ok) {
        const sa = await saRes.json() as { configured: boolean; client_email: string | null };
        setServiceAccountEmail(sa.client_email);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }

  async function handleConnect() {
    if (!propertyId.trim()) return;
    setSaving(true);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/ga4/connect`, {
        method: "POST",
        body: JSON.stringify({ property_id: propertyId.trim(), contact_email: contactEmail || undefined }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast("✅ GA4の識別番号を保存しました");
      await loadData();
    } catch {
      showToast("❌ 保存に失敗しました。もう一度お試しください");
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/ga4/test`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { ok: boolean; result: { status: string; errorMessage?: string } };
      setTestResult(data);
      if (data.ok) {
        showToast("✅ GA4への接続に成功しました！");
        await loadData();
      }
    } catch {
      showToast("❌ 接続テストに失敗しました");
    } finally {
      setTesting(false);
    }
  }

  async function handleDisconnect() {
    setShowDisconnectConfirm(false);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/ga4/disconnect`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error();
      showToast("GA4連携を解除しました");
      setTestResult(null);
      await loadData();
    } catch {
      showToast("❌ 解除に失敗しました");
    }
  }

  function copyEmail() {
    if (!serviceAccountEmail) return;
    navigator.clipboard.writeText(serviceAccountEmail).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => undefined);
  }

  const currentStatus: Ga4Status = statusData?.ga4_status ?? "not_configured";
  const isConnected = currentStatus === "connected";
  const hasPropertyId = (statusData?.ga4_property_id ?? "").length > 0;

  const CARD: React.CSSProperties = {
    background: "rgba(15,23,42,0.7)",
    border: "1px solid #1f2937",
    borderRadius: 14,
    padding: "24px 28px",
    marginBottom: 20,
  };

  const BTN_PRIMARY: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "12px 24px",
    minHeight: 48,
    borderRadius: 10,
    border: "none",
    background: "linear-gradient(135deg,#16a34a,#22c55e)",
    color: "#fff",
    fontSize: 15,
    fontWeight: 700,
    cursor: "pointer",
    transition: "opacity .15s",
  };

  const BTN_SECONDARY: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 20px",
    minHeight: 44,
    borderRadius: 10,
    border: "1px solid #374151",
    background: "transparent",
    color: "#9ca3af",
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
  };

  function StatusBadge({ status }: { status: Ga4Status }) {
    const map: Record<Ga4Status, { label: string; color: string; bg: string }> = {
      not_configured: { label: "未設定", color: "#9ca3af", bg: "rgba(156,163,175,0.1)" },
      pending: { label: "設定中", color: "#fbbf24", bg: "rgba(251,191,36,0.1)" },
      connected: { label: "✅ 連携中", color: "#4ade80", bg: "rgba(74,222,128,0.1)" },
      error: { label: "❌ エラー", color: "#f87171", bg: "rgba(248,113,113,0.1)" },
      timeout: { label: "⏱ タイムアウト", color: "#fb923c", bg: "rgba(251,146,60,0.1)" },
      permission_revoked: { label: "🔒 権限なし", color: "#a78bfa", bg: "rgba(167,139,250,0.1)" },
    };
    const s = map[status];
    return (
      <span style={{ padding: "4px 12px", borderRadius: 999, fontSize: 13, fontWeight: 700, color: s.color, background: s.bg, border: `1px solid ${s.color}33` }}>
        {s.label}
      </span>
    );
  }

  function ErrorGuide({ status, message }: { status: Ga4Status; message?: string | null }) {
    const guides: Partial<Record<Ga4Status, string>> = {
      error: message?.includes("permission") || message === "permission_denied"
        ? "サービスアカウントに閲覧権限がありません。手順をもう一度確認してください。"
        : message === "property_not_found"
        ? "GA4の識別番号が見つかりません。GA4管理画面でご確認ください。"
        : "エラーが発生しました。サポートにお問い合わせください。",
      timeout: "GA4への接続に時間がかかっています。しばらく待ってからもう一度お試しください。",
      permission_revoked: "閲覧権限が取り消されました。GA4管理画面でサービスアカウントに再度権限を付与してください。",
    };
    const guide = guides[status];
    if (!guide) return null;
    return (
      <div style={{ padding: "14px 18px", borderRadius: 10, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)", color: "#fca5a5", fontSize: 14, lineHeight: 1.7, marginTop: 12 }}>
        ⚠️ {guide}
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>
        ⏳ 読み込み中...
      </div>
    );
  }

  return (
    <div style={{ paddingTop: 4 }}>
      {/* トースト */}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", padding: "14px 24px", borderRadius: 12, background: "rgba(15,23,42,0.98)", border: "1px solid #22c55e", color: "#4ade80", fontSize: 15, fontWeight: 600, zIndex: 3000, whiteSpace: "nowrap" }}>
          {toast}
        </div>
      )}

      {/* 確認モーダル */}
      {showDisconnectConfirm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#0f172a", border: "1px solid #374151", borderRadius: 16, padding: 32, maxWidth: 400, width: "90%", textAlign: "center" }}>
            <div style={{ fontSize: 36, marginBottom: 16 }}>⚠️</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#f1f5f9", marginBottom: 8 }}>GA4連携を解除しますか？</div>
            <div style={{ color: "#9ca3af", fontSize: 14, marginBottom: 28 }}>設定した識別番号と連携情報が削除されます。</div>
            <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
              <button style={{ ...BTN_SECONDARY }} onClick={() => setShowDisconnectConfirm(false)}>キャンセル</button>
              <button style={{ ...BTN_PRIMARY, background: "linear-gradient(135deg,#dc2626,#ef4444)" }} onClick={() => void handleDisconnect()}>解除する</button>
            </div>
          </div>
        </div>
      )}

      {/* ヘッダー: 現在のステータス */}
      <div style={{ ...CARD, display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: "#f1f5f9", margin: "0 0 8px" }}>📊 Google Analytics 4 連携</h2>
          <div style={{ color: "#9ca3af", fontSize: 14 }}>
            GA4のデータをR2Cに連携することで、成果（コンバージョン）の計測精度が上がります。
          </div>
        </div>
        <StatusBadge status={currentStatus} />
      </div>

      {/* ステップ1: サービスアカウント案内 */}
      <div style={CARD}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: "#d1d5db", margin: "0 0 16px" }}>
          ステップ 1 — R2Cのメールアドレスに閲覧権限を付与する
        </h3>
        <div style={{ color: "#9ca3af", fontSize: 14, lineHeight: 1.8, marginBottom: 16 }}>
          GA4の管理画面で、以下のメールアドレスに <strong style={{ color: "#e5e7eb" }}>「閲覧者」</strong> 権限を付与してください。
        </div>
        {serviceAccountEmail ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 200, padding: "12px 16px", borderRadius: 8, background: "rgba(74,222,128,0.06)", border: "1px solid rgba(74,222,128,0.2)", fontFamily: "monospace", fontSize: 14, color: "#4ade80", wordBreak: "break-all" }}>
              {serviceAccountEmail}
            </div>
            <button style={{ ...BTN_SECONDARY, minWidth: 80 }} onClick={copyEmail}>
              {copied ? "✅ コピー済み" : "📋 コピー"}
            </button>
          </div>
        ) : (
          <div style={{ padding: "12px 16px", borderRadius: 8, background: "rgba(251,191,36,0.06)", border: "1px solid rgba(251,191,36,0.2)", color: "#fbbf24", fontSize: 14 }}>
            ⚙️ サービスアカウントがまだ設定されていません。担当者にお問い合わせください。
          </div>
        )}
        <details style={{ marginTop: 16 }}>
          <summary style={{ cursor: "pointer", color: "#60a5fa", fontSize: 13, userSelect: "none" }}>
            📖 GA4での権限付与手順を見る
          </summary>
          <ol style={{ color: "#9ca3af", fontSize: 13, lineHeight: 2, marginTop: 10, paddingLeft: 20 }}>
            <li>GA4管理画面（analytics.google.com）にログイン</li>
            <li>左下の「管理」→「アカウントのアクセス管理」をクリック</li>
            <li>右上の「＋」ボタン →「ユーザーを追加」</li>
            <li>上記のメールアドレスを入力</li>
            <li>役割: 「閲覧者」を選択 → 「追加」</li>
          </ol>
        </details>
      </div>

      {/* ステップ2: Property ID入力 */}
      <div style={CARD}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: "#d1d5db", margin: "0 0 16px" }}>
          ステップ 2 — GA4の識別番号を入力する
        </h3>
        <div style={{ color: "#9ca3af", fontSize: 14, marginBottom: 16 }}>
          GA4管理画面の「プロパティ詳細」ページに表示されている数字（例: <code style={{ color: "#a5b4fc" }}>123456789</code>）を入力してください。
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <label style={{ display: "block", fontSize: 13, color: "#9ca3af", marginBottom: 6 }}>GA4識別番号 (数字のみ)</label>
            <input
              type="text"
              inputMode="numeric"
              placeholder="例: 123456789"
              value={propertyId}
              onChange={(e) => setPropertyId(e.target.value.replace(/\D/g, ""))}
              style={{ width: "100%", padding: "12px 14px", borderRadius: 8, border: "1px solid #374151", background: "#0f172a", color: "#f1f5f9", fontSize: 15, boxSizing: "border-box" }}
            />
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <label style={{ display: "block", fontSize: 13, color: "#9ca3af", marginBottom: 6 }}>連絡先メールアドレス (任意)</label>
            <input
              type="email"
              placeholder="例: partner@example.com"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              style={{ width: "100%", padding: "12px 14px", borderRadius: 8, border: "1px solid #374151", background: "#0f172a", color: "#f1f5f9", fontSize: 15, boxSizing: "border-box" }}
            />
          </div>
        </div>
        <div style={{ marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            style={{ ...BTN_PRIMARY, opacity: saving || !propertyId.trim() ? 0.6 : 1 }}
            disabled={saving || !propertyId.trim()}
            onClick={() => void handleConnect()}
          >
            {saving ? "⏳ 保存中..." : "💾 識別番号を保存"}
          </button>
        </div>
      </div>

      {/* ステップ3: 接続テスト */}
      {hasPropertyId && (
        <div style={CARD}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: "#d1d5db", margin: "0 0 16px" }}>
            ステップ 3 — 接続テスト
          </h3>
          <div style={{ color: "#9ca3af", fontSize: 14, marginBottom: 16 }}>
            識別番号: <code style={{ color: "#a5b4fc", fontSize: 14 }}>{statusData?.ga4_property_id}</code>
          </div>
          <button
            style={{ ...BTN_PRIMARY, opacity: testing ? 0.6 : 1 }}
            disabled={testing}
            onClick={() => void handleTest()}
          >
            {testing ? "⏳ テスト中..." : "🔗 GA4に接続テスト"}
          </button>

          {/* テスト結果 */}
          {testResult && (
            <div style={{ marginTop: 16, padding: "16px 20px", borderRadius: 10, background: testResult.ok ? "rgba(74,222,128,0.06)" : "rgba(239,68,68,0.06)", border: `1px solid ${testResult.ok ? "rgba(74,222,128,0.3)" : "rgba(239,68,68,0.3)"}` }}>
              {testResult.ok ? (
                <div style={{ color: "#4ade80", fontWeight: 700, fontSize: 15 }}>
                  ✅ 接続に成功しました！GA4のデータが取得できます。
                </div>
              ) : (
                <>
                  <div style={{ color: "#f87171", fontWeight: 700, fontSize: 15 }}>❌ 接続に失敗しました</div>
                  <ErrorGuide status={testResult.result.status as Ga4Status} message={testResult.result.errorMessage} />
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* 連携済みステータス詳細 */}
      {isConnected && (
        <div style={CARD}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: "#d1d5db", margin: 0 }}>🔗 連携情報</h3>
            <button style={{ ...BTN_SECONDARY, color: "#f87171", borderColor: "#f8717133" }} onClick={() => setShowDisconnectConfirm(true)}>
              🔌 連携を解除
            </button>
          </div>
          <div style={{ marginTop: 14, display: "grid", gap: 8 }}>
            {statusData?.ga4_connected_at && (
              <div style={{ fontSize: 13, color: "#9ca3af" }}>
                ✅ 接続日時: <span style={{ color: "#d1d5db" }}>{new Date(statusData.ga4_connected_at).toLocaleString("ja-JP")}</span>
              </div>
            )}
            {statusData?.ga4_last_sync_at && (
              <div style={{ fontSize: 13, color: "#9ca3af" }}>
                🔄 最終同期: <span style={{ color: "#d1d5db" }}>{new Date(statusData.ga4_last_sync_at).toLocaleString("ja-JP")}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* エラー時のガイド */}
      {(currentStatus === "error" || currentStatus === "timeout" || currentStatus === "permission_revoked") && (
        <div style={CARD}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: "#d1d5db", margin: "0 0 4px" }}>⚠️ 接続エラー</h3>
          <ErrorGuide status={currentStatus} message={statusData?.ga4_error_message} />
        </div>
      )}

      {/* テスト履歴 */}
      {(statusData?.recent_tests ?? []).length > 0 && (
        <div style={CARD}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "#9ca3af", margin: "0 0 12px" }}>接続テスト履歴</h3>
          <div style={{ display: "grid", gap: 6 }}>
            {statusData!.recent_tests.map((t, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid #1f2937", fontSize: 13 }}>
                <span style={{ color: t.success ? "#4ade80" : "#f87171" }}>{t.success ? "✅" : "❌"} {t.success ? "成功" : (t.error_message ?? "失敗")}</span>
                <span style={{ color: "#6b7280" }}>{new Date(t.tested_at).toLocaleString("ja-JP")}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
