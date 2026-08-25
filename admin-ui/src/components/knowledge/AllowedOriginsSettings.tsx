// admin-ui/src/components/knowledge/AllowedOriginsSettings.tsx
// LAUNCH: client_adminが自分でWidget許可ドメイン(allowed_origins)を追加・削除できる自己設定パネル
// (FaqHintSettingsのfetch/toastパターンを踏襲。super_adminは/admin/tenants/:idのSettingsTab
// （ワイルドカード対応）を使うため、こちらはclient_admin専用でPATCH /v1/admin/my-tenant固定)

import { useEffect, useState } from "react";
import { authFetch, API_BASE } from "../../lib/api";
import { useLang } from "../../i18n/LangContext";

interface TenantOrigins {
  allowed_origins?: string[] | null;
}

interface AllowedOriginsSettingsProps {
  tenantId: string;
}

export default function AllowedOriginsSettings({ tenantId }: AllowedOriginsSettingsProps) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [origins, setOrigins] = useState<string[]>([]);
  const [newOrigin, setNewOrigin] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const endpoint = `${API_BASE}/v1/admin/my-tenant`;

  useEffect(() => {
    if (!tenantId || tenantId === "global") return;
    authFetch(endpoint)
      .then((r) => r.json())
      .then((data: TenantOrigins) => {
        setOrigins(data.allowed_origins ?? []);
        setLoaded(true);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, tenantId]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const persist = async (nextOrigins: string[]) => {
    const prev = origins;
    setOrigins(nextOrigins);
    setSaving(true);
    try {
      const res = await authFetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowed_origins: nextOrigins }),
      });
      if (!res.ok) {
        setOrigins(prev);
        showToast(t("knowledge.allowed_origins_save_error"));
        return;
      }
      const updated = (await res.json()) as TenantOrigins;
      setOrigins(updated.allowed_origins ?? nextOrigins);
      showToast(t("knowledge.allowed_origins_saved"));
    } catch {
      setOrigins(prev);
      showToast(t("knowledge.allowed_origins_save_error"));
    } finally {
      setSaving(false);
    }
  };

  // Origin ヘッダーにパスや末尾スラッシュは載らないため、末尾スラッシュ付きの値を
  // そのまま保存すると照合(originCheck.ts)に一致せず、登録したのに弾かれる事故になる。
  // 見た目は同じでも危険な値を保存前に取り除く。
  const normalizeOrigin = (value: string): string => value.trim().replace(/\/+$/, "");

  const handleAdd = () => {
    const raw = newOrigin.trim();
    if (!raw) return;
    const candidate = normalizeOrigin(raw);
    if (!candidate.startsWith("https://")) {
      setInputError(t("knowledge.allowed_origins_invalid_https"));
      return;
    }
    // ワイルドカードは super_admin のテナント設定画面(SettingsTab)専用の機能とし、
    // テナント自己申告のこのフォームでは一律拒否する（バックエンドは
    // https://*.example.com の形なら受け付けるが、UIとしてはより厳しい側に倒す）。
    if (candidate.includes("*")) {
      setInputError(t("knowledge.allowed_origins_invalid_wildcard"));
      return;
    }
    if (origins.includes(candidate)) {
      setInputError(t("knowledge.allowed_origins_duplicate"));
      return;
    }

    // 初回登録＝fail-open(全許可)からfail-closed相当に切り替わる操作(R3)。
    // 「ここに無いドメインは以後弾かれる」ことと正規化後の値を保存前に確認する。
    if (origins.length === 0) {
      const confirmed = window.confirm(
        t("knowledge.allowed_origins_first_add_confirm", { origin: candidate })
      );
      if (!confirmed) return;
    }

    setInputError(null);
    setNewOrigin("");
    void persist([...origins, candidate]);
  };

  const handleRemove = (origin: string) => {
    const next = origins.filter((o) => o !== origin);
    // 最後の1件を消す操作＝fail-open(全許可)に戻る操作(R3)。画面上は何も壊れず
    // 気づけないため、無言で保護が外れないよう確認する。
    if (next.length === 0 && origins.length > 0) {
      const confirmed = window.confirm(t("knowledge.allowed_origins_remove_last_confirm"));
      if (!confirmed) return;
    }
    void persist(next);
  };

  if (!tenantId || tenantId === "global") return null;

  return (
    <div
      style={{
        marginBottom: 16,
        borderRadius: 14,
        border: "1px solid #374151",
        background: "rgba(15,23,42,0.4)",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          padding: "14px 18px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          color: "#d1d5db",
          fontSize: 14,
          fontWeight: 600,
        }}
      >
        <span>🔒 {t("knowledge.allowed_origins_settings_title")}</span>
        <span style={{ color: "#6b7280", fontSize: 12 }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div style={{ padding: "0 18px 18px" }}>
          <p style={{ fontSize: 13, color: "#6b7280", margin: "0 0 14px", lineHeight: 1.6 }}>
            {t("knowledge.allowed_origins_settings_desc")}
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
            {!loaded ? null : origins.length === 0 ? (
              // 空配列=fail-open(全ドメイン許可)。「未設定」の中立な空状態(グレー・低彩度)ではなく
              // 「保護なし」の警告状態として視覚的に区別する(空欄と保護なしを同じ見た目にしない)。
              <div
                role="status"
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid rgba(245,158,11,0.4)",
                  background: "rgba(245,158,11,0.1)",
                }}
              >
                <p style={{ fontSize: 13, color: "#fbbf24", fontWeight: 600, margin: "0 0 4px" }}>
                  {t("knowledge.allowed_origins_empty")}
                </p>
                <p style={{ fontSize: 12, color: "#9ca3af", margin: 0, lineHeight: 1.5 }}>
                  {t("knowledge.allowed_origins_empty_desc")}
                </p>
              </div>
            ) : (
              origins.map((origin) => (
                <div
                  key={origin}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "8px 12px",
                    borderRadius: 8,
                    border: "1px solid #374151",
                    background: "rgba(15,23,42,0.8)",
                  }}
                >
                  <span style={{ fontSize: 13, color: "#e5e7eb", wordBreak: "break-all" }}>{origin}</span>
                  <button
                    type="button"
                    onClick={() => handleRemove(origin)}
                    disabled={saving}
                    aria-label={`remove ${origin}`}
                    style={{
                      marginLeft: 12,
                      padding: "4px 10px",
                      borderRadius: 6,
                      border: "1px solid rgba(248,113,113,0.4)",
                      background: "rgba(239,68,68,0.12)",
                      color: "#fca5a5",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: saving ? "not-allowed" : "pointer",
                      opacity: saving ? 0.6 : 1,
                      flexShrink: 0,
                    }}
                  >
                    ×
                  </button>
                </div>
              ))
            )}
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: inputError ? 8 : 0 }}>
            <input
              type="text"
              value={newOrigin}
              onChange={(e) => { setNewOrigin(e.target.value); setInputError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAdd(); } }}
              disabled={!loaded || saving}
              placeholder={t("knowledge.allowed_origins_input_placeholder")}
              style={{
                flex: 1,
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid #374151",
                background: "rgba(15,23,42,0.8)",
                color: "#e5e7eb",
                fontSize: 14,
                boxSizing: "border-box",
              }}
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={!loaded || saving || !newOrigin.trim()}
              style={{
                padding: "10px 18px",
                minHeight: 40,
                borderRadius: 10,
                border: "1px solid rgba(59,130,246,0.4)",
                background: "rgba(59,130,246,0.18)",
                color: "#93c5fd",
                fontSize: 14,
                fontWeight: 600,
                cursor: !loaded || saving || !newOrigin.trim() ? "not-allowed" : "pointer",
                opacity: !loaded || saving || !newOrigin.trim() ? 0.6 : 1,
                flexShrink: 0,
              }}
            >
              {t("knowledge.allowed_origins_add")}
            </button>
          </div>
          {inputError && (
            <p style={{ fontSize: 12, color: "#fca5a5", margin: "0 0 0" }}>{inputError}</p>
          )}

          {toast && (
            <div
              style={{
                marginTop: 12,
                padding: "8px 12px",
                borderRadius: 8,
                background: toast.startsWith("❌") ? "rgba(239,68,68,0.12)" : "rgba(34,197,94,0.12)",
                color: toast.startsWith("❌") ? "#fca5a5" : "#86efac",
                fontSize: 13,
              }}
            >
              {toast}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
