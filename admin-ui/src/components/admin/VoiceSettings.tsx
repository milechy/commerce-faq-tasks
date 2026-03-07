import { useCallback, useMemo, useState } from "react";
import { API_BASE } from "../../lib/api";

type VoiceType = "male" | "female" | "neutral";

interface VoiceSettingsValue {
  voiceType: VoiceType;
  speakingRate: number;
  pitch: number;
}

interface VoiceSettingsProps {
  saveEndpoint?: string;
  initialValue?: VoiceSettingsValue;
}

type SaveState = "idle" | "saving" | "success" | "error";

const DEFAULT_VALUE: VoiceSettingsValue = {
  voiceType: "neutral",
  speakingRate: 1.0,
  pitch: 0,
};

function getAccessToken(): string | null {
  const raw = localStorage.getItem("supabaseSession");
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as { access_token?: string }).access_token ?? null;
  } catch {
    return null;
  }
}

export default function VoiceSettings({
  saveEndpoint = "/admin/avatar/voice-settings",
  initialValue = DEFAULT_VALUE,
}: VoiceSettingsProps) {
  const [value, setValue] = useState<VoiceSettingsValue>(initialValue);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const update = useCallback((partial: Partial<VoiceSettingsValue>) => {
    setValue((prev) => ({ ...prev, ...partial }));
    setSaveState("idle");
    setErrorMessage(null);
  }, []);

  const voiceLabel = useMemo(() => {
    if (value.voiceType === "male") return "男性";
    if (value.voiceType === "female") return "女性";
    return "ニュートラル";
  }, [value.voiceType]);

  const handleSave = useCallback(async () => {
    const token = getAccessToken();
    if (!token) {
      setSaveState("error");
      setErrorMessage("ログインの有効期限が切れました。再度ログインしてください。");
      return;
    }

    setSaveState("saving");
    setErrorMessage(null);
    try {
      const res = await fetch(`${API_BASE}${saveEndpoint}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(value),
      });

      if (res.status === 401 || res.status === 403) {
        throw new Error("ログインの有効期限が切れました。再度ログインしてください。");
      }
      if (!res.ok) {
        throw new Error("保存に失敗しました。時間をおいて再度お試しください。");
      }

      setSaveState("success");
      setTimeout(() => setSaveState("idle"), 2500);
    } catch (err: unknown) {
      setSaveState("error");
      setErrorMessage(
        err instanceof Error ? err.message : "少し問題が起きました。もう一度試してみてください 🙏"
      );
    }
  }, [saveEndpoint, value]);

  const buttonLabel =
    saveState === "saving"
      ? "保存中..."
      : saveState === "success"
        ? "✅ 保存しました"
        : "設定を保存する";

  return (
    <section
      style={{
        borderRadius: 16,
        border: "1px solid #1f2937",
        background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
        padding: 20,
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      <h3 style={{ margin: 0, color: "#f9fafb", fontSize: 18 }}>話し方の設定</h3>
      <p style={{ margin: 0, color: "#9ca3af", fontSize: 14 }}>
        声の雰囲気や話す速さを調整できます。実際の会話に近い設定を選んでください。
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {(["male", "female", "neutral"] as VoiceType[]).map((type) => {
          const selected = value.voiceType === type;
          const label = type === "male" ? "男性" : type === "female" ? "女性" : "ニュートラル";
          return (
            <button
              key={type}
              type="button"
              onClick={() => update({ voiceType: type })}
              aria-pressed={selected}
              style={{
                minHeight: 56,
                minWidth: 120,
                padding: "12px 16px",
                borderRadius: 12,
                border: selected ? "1px solid #4ade80" : "1px solid #374151",
                background: selected ? "rgba(34,197,94,0.15)" : "rgba(2,6,23,0.45)",
                color: selected ? "#86efac" : "#d1d5db",
                fontSize: 16,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div
        style={{
          border: "1px solid #1f2937",
          borderRadius: 12,
          padding: "14px 12px",
          background: "rgba(2,6,23,0.35)",
        }}
      >
        <label htmlFor="speakingRate" style={{ display: "block", fontSize: 14, color: "#d1d5db" }}>
          話す速さ: {value.speakingRate.toFixed(2)}x
        </label>
        <input
          id="speakingRate"
          type="range"
          min={0.7}
          max={1.3}
          step={0.05}
          value={value.speakingRate}
          onChange={(event) => update({ speakingRate: Number(event.target.value) })}
          style={{ width: "100%", minHeight: 44, cursor: "pointer", marginTop: 8 }}
        />
      </div>

      <div
        style={{
          border: "1px solid #1f2937",
          borderRadius: 12,
          padding: "14px 12px",
          background: "rgba(2,6,23,0.35)",
        }}
      >
        <label htmlFor="pitch" style={{ display: "block", fontSize: 14, color: "#d1d5db" }}>
          声の高さ: {value.pitch >= 0 ? `+${value.pitch}` : value.pitch}
        </label>
        <input
          id="pitch"
          type="range"
          min={-6}
          max={6}
          step={0.5}
          value={value.pitch}
          onChange={(event) => update({ pitch: Number(event.target.value) })}
          style={{ width: "100%", minHeight: 44, cursor: "pointer", marginTop: 8 }}
        />
      </div>

      <div
        style={{
          minHeight: 44,
          borderRadius: 10,
          border:
            saveState === "error"
              ? "1px solid rgba(248,113,113,0.3)"
              : "1px solid rgba(31,41,55,0.8)",
          background:
            saveState === "error"
              ? "rgba(127,29,29,0.35)"
              : saveState === "success"
                ? "rgba(21,128,61,0.25)"
                : "rgba(2,6,23,0.35)",
          color:
            saveState === "error"
              ? "#fca5a5"
              : saveState === "success"
                ? "#86efac"
                : "#9ca3af",
          display: "flex",
          alignItems: "center",
          padding: "10px 12px",
          fontSize: 14,
        }}
      >
        {saveState === "error" && errorMessage
          ? errorMessage
          : `現在の設定: ${voiceLabel} / 速さ ${value.speakingRate.toFixed(
              2
            )}x / 高さ ${value.pitch >= 0 ? `+${value.pitch}` : value.pitch}`}
      </div>

      <button
        type="button"
        onClick={() => {
          void handleSave();
        }}
        disabled={saveState === "saving"}
        style={{
          minHeight: 56,
          minWidth: 44,
          borderRadius: 12,
          border: "none",
          background:
            saveState === "saving"
              ? "rgba(55,65,81,0.8)"
              : "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)",
          color: saveState === "saving" ? "#9ca3af" : "#022c22",
          fontSize: 16,
          fontWeight: 700,
          cursor: saveState === "saving" ? "not-allowed" : "pointer",
          padding: "14px 20px",
        }}
      >
        {buttonLabel}
      </button>
    </section>
  );
}
