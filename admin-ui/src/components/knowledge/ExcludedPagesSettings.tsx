// admin-ui/src/components/knowledge/ExcludedPagesSettings.tsx
// 許可ドメイン内でも、カート/決済ページ等Widgetを出したくないページのパスを
// テナント自身が追加・削除できる自己設定パネル。AllowedOriginsSettings.tsx のfetch/toast/
// 楽観的更新パターンを踏襲するが、以下は意図的に違う:
// - 除外0件=「すべてのページで表示中」は正常な既定状態(許可ドメインの空欄=保護なしとは
//   意味が逆)なので、警告色にせず中立表示にする。fail-open/closedの境界が無いため
//   追加・削除時のwindow.confirmも出さない。
// - パス判定の実体(グロブマッチャー)はpublic/widget.jsのmatchPathnameGlob()のみに置き、
//   ここでは形式検証だけを行う(構文解釈が2箇所に割れて「保存できたが効かない」事故に
//   ならないようにするため)。

import { useEffect, useState } from "react";
import { authFetch, API_BASE } from "../../lib/api";
import { useLang } from "../../i18n/LangContext";

interface TenantExcludedPages {
  excluded_page_patterns?: string[] | null;
}

interface ExcludedPagesSettingsProps {
  tenantId: string;
}

export default function ExcludedPagesSettings({ tenantId }: ExcludedPagesSettingsProps) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [patterns, setPatterns] = useState<string[]>([]);
  const [newPattern, setNewPattern] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const endpoint = `${API_BASE}/v1/admin/my-tenant`;

  useEffect(() => {
    if (!tenantId || tenantId === "global") return;
    authFetch(endpoint)
      .then((r) => r.json())
      .then((data: TenantExcludedPages) => {
        setPatterns(data.excluded_page_patterns ?? []);
        setLoaded(true);
      })
      .catch(() => {});
  }, [endpoint, tenantId]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const persist = async (nextPatterns: string[]) => {
    const prev = patterns;
    setPatterns(nextPatterns);
    setSaving(true);
    try {
      const res = await authFetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excluded_page_patterns: nextPatterns }),
      });
      if (!res.ok) {
        setPatterns(prev);
        showToast(t("knowledge.excluded_pages_save_error"));
        return;
      }
      const updated = (await res.json()) as TenantExcludedPages;
      setPatterns(updated.excluded_page_patterns ?? nextPatterns);
      showToast(t("knowledge.excluded_pages_saved"));
    } catch {
      setPatterns(prev);
      showToast(t("knowledge.excluded_pages_save_error"));
    } finally {
      setSaving(false);
    }
  };

  // フルURLを貼られたらpathnameへ正規化する(ブラウザのアドレスバーからそのままコピー
  // してくる方が自然な操作のため、弾くより直す)。パースできない/相対パスならそのまま
  // trimして返す(先頭スラッシュの検証は呼び出し側で行う)。
  const normalizePattern = (value: string): string => {
    const trimmed = value.trim();
    try {
      const url = new URL(trimmed);
      return url.pathname || "/";
    } catch {
      return trimmed;
    }
  };

  const handleAdd = () => {
    const raw = newPattern.trim();
    if (!raw) return;
    const candidate = normalizePattern(raw);
    if (!candidate.startsWith("/")) {
      setInputError(t("knowledge.excluded_pages_invalid_leading_slash"));
      return;
    }
    if (candidate.includes("?") || candidate.includes("#")) {
      setInputError(t("knowledge.excluded_pages_invalid_query"));
      return;
    }
    if (patterns.includes(candidate)) {
      setInputError(t("knowledge.excluded_pages_duplicate"));
      return;
    }
    if (patterns.length >= 20) {
      setInputError(t("knowledge.excluded_pages_max_reached"));
      return;
    }

    setInputError(null);
    setNewPattern("");
    void persist([...patterns, candidate]);
  };

  const handleRemove = (pattern: string) => {
    void persist(patterns.filter((p) => p !== pattern));
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
        <span>🚫 {t("knowledge.excluded_pages_settings_title")}</span>
        <span style={{ color: "#6b7280", fontSize: 12 }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div style={{ padding: "0 18px 18px" }}>
          <p style={{ fontSize: 13, color: "#6b7280", margin: "0 0 14px", lineHeight: 1.6 }}>
            {t("knowledge.excluded_pages_settings_desc")}
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
            {!loaded ? null : patterns.length === 0 ? (
              // 除外0件=すべてのページで表示中は正常な既定状態。
              // AllowedOriginsSettingsの空状態(保護なし警告)とは意味が逆なので中立表示にする。
              <div
                role="status"
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid #374151",
                  background: "rgba(15,23,42,0.8)",
                }}
              >
                <p style={{ fontSize: 13, color: "#9ca3af", margin: "0 0 4px" }}>
                  {t("knowledge.excluded_pages_empty")}
                </p>
                <p style={{ fontSize: 12, color: "#6b7280", margin: 0, lineHeight: 1.5 }}>
                  {t("knowledge.excluded_pages_empty_desc")}
                </p>
              </div>
            ) : (
              patterns.map((pattern) => (
                <div
                  key={pattern}
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
                  <span style={{ fontSize: 13, color: "#e5e7eb", wordBreak: "break-all" }}>{pattern}</span>
                  <button
                    type="button"
                    onClick={() => handleRemove(pattern)}
                    disabled={saving}
                    aria-label={`remove ${pattern}`}
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
              value={newPattern}
              onChange={(e) => { setNewPattern(e.target.value); setInputError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAdd(); } }}
              disabled={!loaded || saving}
              placeholder={t("knowledge.excluded_pages_input_placeholder")}
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
              disabled={!loaded || saving || !newPattern.trim()}
              style={{
                padding: "10px 18px",
                minHeight: 40,
                borderRadius: 10,
                border: "1px solid rgba(59,130,246,0.4)",
                background: "rgba(59,130,246,0.18)",
                color: "#93c5fd",
                fontSize: 14,
                fontWeight: 600,
                cursor: !loaded || saving || !newPattern.trim() ? "not-allowed" : "pointer",
                opacity: !loaded || saving || !newPattern.trim() ? 0.6 : 1,
                flexShrink: 0,
              }}
            >
              {t("knowledge.excluded_pages_add")}
            </button>
          </div>
          {inputError && (
            <p style={{ fontSize: 12, color: "#fca5a5", margin: "0 0 0" }}>{inputError}</p>
          )}

          <p style={{ fontSize: 11, color: "#6b7280", margin: "12px 0 0", lineHeight: 1.6 }}>
            {t("knowledge.excluded_pages_reflect_note")}
            <br />
            {t("knowledge.excluded_pages_embed_note")}
          </p>

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
