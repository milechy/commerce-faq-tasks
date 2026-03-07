import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "../../lib/api";

interface TuningSettings {
  responseStyle: "friendly" | "formal" | "concise";
  language: "ja" | "en" | "auto";
  fallbackMessage: string;
  maxAnswerLength: "short" | "medium" | "long";
  enableFollowUp: boolean;
}

type SaveState = "idle" | "saving" | "success" | "error";

const DEFAULT_SETTINGS: TuningSettings = {
  responseStyle: "friendly",
  language: "ja",
  fallbackMessage: "申し訳ありません。うまく答えられませんでした。もう少し詳しく教えていただけますか？",
  maxAnswerLength: "medium",
  enableFollowUp: true,
};

interface TuningPanelProps {
  tenantId?: string;
}

function getAccessToken(): string | null {
  const raw = localStorage.getItem("supabaseSession");
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as { access_token?: string })?.access_token ?? null;
  } catch {
    return null;
  }
}

export default function TuningPanel({ tenantId = "demo" }: TuningPanelProps) {
  const [settings, setSettings] = useState<TuningSettings>(DEFAULT_SETTINGS);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;

    fetch(`${API_BASE}/admin/tuning?tenantId=${encodeURIComponent(tenantId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as Partial<TuningSettings>;
        setSettings((prev) => ({ ...prev, ...data }));
      })
      .catch(() => {
        /* 初回ロード失敗はサイレント: デフォルト設定を使用 */
      });
  }, [tenantId]);

  const handleChange = useCallback(<K extends keyof TuningSettings>(
    key: K,
    value: TuningSettings[K],
  ) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setIsDirty(true);
    setSaveState("idle");
    setSaveError(null);
  }, []);

  const handleSave = useCallback(async () => {
    const token = getAccessToken();
    if (!token) {
      setSaveError("ログインの有効期限が切れました。再度ログインしてください。");
      setSaveState("error");
      return;
    }

    setSaveState("saving");
    setSaveError(null);

    try {
      const res = await fetch(
        `${API_BASE}/admin/tuning?tenantId=${encodeURIComponent(tenantId)}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(settings),
        },
      );

      if (res.status === 401 || res.status === 403) {
        throw new Error("ログインの有効期限が切れました。再度ログインしてください。");
      }
      if (!res.ok) {
        throw new Error("少し問題が起きました。もう一度試してみてください 🙏");
      }

      setSaveState("success");
      setIsDirty(false);
      setTimeout(() => setSaveState("idle"), 3000);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "少し問題が起きました。もう一度試してみてください 🙏";
      setSaveError(message);
      setSaveState("error");
    }
  }, [settings, tenantId]);

  const fieldStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 14,
    fontWeight: 600,
    color: "#d1d5db",
  };

  const selectStyle: React.CSSProperties = {
    padding: "12px 14px",
    borderRadius: 10,
    border: "1px solid #374151",
    background: "rgba(15,23,42,0.9)",
    color: "#e5e7eb",
    fontSize: 16,
    minHeight: 44,
    outline: "none",
    cursor: "pointer",
    width: "100%",
  };

  const descStyle: React.CSSProperties = {
    fontSize: 12,
    color: "#6b7280",
    marginTop: 2,
  };

  return (
    <div
      style={{
        borderRadius: 16,
        border: "1px solid #1f2937",
        background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
        padding: "24px",
        display: "flex",
        flexDirection: "column",
        gap: 24,
      }}
    >
      <div>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: "#f9fafb", margin: 0 }}>
          AIの返答スタイル設定
        </h2>
        <p style={{ fontSize: 14, color: "#6b7280", marginTop: 4, marginBottom: 0 }}>
          お客様へのAI回答のトーンや形式をカスタマイズできます
        </p>
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor="responseStyle">
          返答のトーン
        </label>
        <select
          id="responseStyle"
          value={settings.responseStyle}
          onChange={(e) =>
            handleChange("responseStyle", e.target.value as TuningSettings["responseStyle"])
          }
          style={selectStyle}
        >
          <option value="friendly">🤝 親しみやすい（おすすめ）</option>
          <option value="formal">📋 丁寧・フォーマル</option>
          <option value="concise">⚡ 簡潔・短め</option>
        </select>
        <p style={descStyle}>お客様への返答をどのようなトーンにするかを選べます</p>
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor="language">
          対応言語
        </label>
        <select
          id="language"
          value={settings.language}
          onChange={(e) =>
            handleChange("language", e.target.value as TuningSettings["language"])
          }
          style={selectStyle}
        >
          <option value="ja">🇯🇵 日本語</option>
          <option value="en">🇺🇸 English</option>
          <option value="auto">🌍 自動判定（お客様の言語に合わせる）</option>
        </select>
        <p style={descStyle}>AIがお客様に返答する言語を設定します</p>
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor="maxAnswerLength">
          返答の長さ
        </label>
        <select
          id="maxAnswerLength"
          value={settings.maxAnswerLength}
          onChange={(e) =>
            handleChange("maxAnswerLength", e.target.value as TuningSettings["maxAnswerLength"])
          }
          style={selectStyle}
        >
          <option value="short">短め（要点のみ）</option>
          <option value="medium">標準（おすすめ）</option>
          <option value="long">詳しく（丁寧な説明）</option>
        </select>
        <p style={descStyle}>AIの回答をどのくらいの長さにするか設定します</p>
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor="fallbackMessage">
          答えられなかったときのメッセージ
        </label>
        <textarea
          id="fallbackMessage"
          value={settings.fallbackMessage}
          onChange={(e) => handleChange("fallbackMessage", e.target.value)}
          rows={3}
          style={{
            ...selectStyle,
            resize: "vertical",
            minHeight: 80,
            lineHeight: 1.5,
            fontFamily: "inherit",
          }}
          placeholder="AIが答えられなかった場合に表示するメッセージ"
        />
        <p style={descStyle}>AIがうまく回答できなかった場合にお客様に伝えるメッセージです</p>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "14px 16px",
          borderRadius: 10,
          border: "1px solid #374151",
          background: "rgba(15,23,42,0.5)",
          cursor: "pointer",
          minHeight: 44,
        }}
        onClick={() => handleChange("enableFollowUp", !settings.enableFollowUp)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ")
            handleChange("enableFollowUp", !settings.enableFollowUp);
        }}
        aria-pressed={settings.enableFollowUp}
        aria-label="追加質問の提案を有効にする"
      >
        <div
          style={{
            width: 44,
            height: 26,
            borderRadius: 999,
            background: settings.enableFollowUp ? "#22c55e" : "#374151",
            position: "relative",
            transition: "background 0.2s ease",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              position: "absolute",
              top: 3,
              left: settings.enableFollowUp ? 21 : 3,
              width: 20,
              height: 20,
              borderRadius: "50%",
              background: "#fff",
              transition: "left 0.2s ease",
              boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
            }}
          />
        </div>
        <div>
          <p style={{ fontSize: 15, fontWeight: 600, color: "#e5e7eb", margin: 0 }}>
            関連する質問を提案する
          </p>
          <p style={{ fontSize: 12, color: "#6b7280", margin: 0, marginTop: 2 }}>
            回答後にお客様が続けて質問しやすくなります
          </p>
        </div>
      </div>

      {saveState === "error" && saveError && (
        <div
          style={{
            padding: "12px 16px",
            borderRadius: 10,
            background: "rgba(127,29,29,0.4)",
            border: "1px solid rgba(248,113,113,0.3)",
            color: "#fca5a5",
            fontSize: 15,
          }}
        >
          {saveError}
        </div>
      )}

      <button
        onClick={handleSave}
        disabled={saveState === "saving" || !isDirty}
        style={{
          padding: "16px 24px",
          minHeight: 56,
          borderRadius: 12,
          border: "none",
          background:
            saveState === "success"
              ? "linear-gradient(135deg, #15803d, #22c55e)"
              : saveState === "saving" || !isDirty
                ? "rgba(55,65,81,0.6)"
                : "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)",
          color: saveState === "saving" || !isDirty ? "#6b7280" : "#022c22",
          fontWeight: 700,
          fontSize: 16,
          cursor: saveState === "saving" || !isDirty ? "not-allowed" : "pointer",
          transition: "all 0.2s ease",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          boxShadow:
            saveState === "success" || (!isDirty && saveState === "idle")
              ? "none"
              : isDirty
                ? "0 8px 25px rgba(34,197,94,0.3)"
                : "none",
        }}
      >
        {saveState === "saving" && (
          <>
            <span
              style={{
                width: 16,
                height: 16,
                borderRadius: "50%",
                border: "2px solid #4b5563",
                borderTopColor: "#9ca3af",
                animation: "spin 0.8s linear infinite",
                display: "inline-block",
              }}
            />
            保存中...
          </>
        )}
        {saveState === "success" && <>✅ 保存しました！</>}
        {(saveState === "idle" || saveState === "error") && (
          <>{isDirty ? "設定を保存する" : "変更はありません"}</>
        )}
      </button>

      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
