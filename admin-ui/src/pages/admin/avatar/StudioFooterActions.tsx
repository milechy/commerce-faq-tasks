// admin-ui/src/pages/admin/avatar/StudioFooterActions.tsx
// studio.tsx から抽出 — 保存 / キャンセル / デフォルトに戻すボタン行（機能変更なし）

import { useNavigate } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import { BTN_PRIMARY, BTN_SECONDARY } from "./types";

export function StudioFooterActions({
  isEdit,
  isDefault,
  resetting,
  handleResetToDefault,
  saving,
  name,
  handleSave,
}: {
  isEdit: boolean;
  isDefault: boolean;
  resetting: boolean;
  handleResetToDefault: () => Promise<void>;
  saving: boolean;
  name: string;
  handleSave: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const { lang } = useLang();

  return (
    <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", marginTop: 8, flexWrap: "wrap" }}>
      {isEdit && isDefault && (
        <button
          onClick={() => void handleResetToDefault()}
          disabled={resetting}
          style={{
            ...BTN_SECONDARY,
            opacity: resetting ? 0.6 : 1,
            cursor: resetting ? "not-allowed" : "pointer",
            marginRight: "auto",
          }}
        >
          {resetting
            ? (lang === "ja" ? "リセット中..." : "Resetting...")
            : (lang === "ja" ? "デフォルトに戻す" : "Reset to Default")}
        </button>
      )}
      <button
        onClick={() => navigate("/admin/avatar")}
        style={BTN_SECONDARY}
      >
        {lang === "ja" ? "キャンセル" : "Cancel"}
      </button>
      <button
        onClick={() => void handleSave()}
        disabled={saving || !name.trim()}
        style={{
          ...BTN_PRIMARY,
          minWidth: 120,
          opacity: saving || !name.trim() ? 0.5 : 1,
          cursor: saving || !name.trim() ? "not-allowed" : "pointer",
        }}
      >
        {saving
          ? (lang === "ja" ? "保存中..." : "Saving...")
          : (lang === "ja" ? "保存する" : "Save")}
      </button>
    </div>
  );
}
