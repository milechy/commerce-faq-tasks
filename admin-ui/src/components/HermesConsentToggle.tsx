// admin-ui/src/components/HermesConsentToggle.tsx
// Phase75 → GID 1216978677372391(PR-16, D1): 外部Hermes VPSへの生データ提供同意 ON/OFF トグル
// （Client Adminのみ、自己完結型。ExcludeSearchToggleの楽観的更新+ロールバックパターンを踏襲）
//
// D1: データ利用同意は2階層。
//   ①自テナント内学習(learned_memory等) = 常時ON・同意不要(このトグルの対象外)
//   ②社外Hermes VPSへの生データ提供 = 明示同意必須(このトグルが操作するのはこちらのみ)
//
// [H-4]: 元は /admin/avatar 最下部に配置していたが、アバターはStandard以上限定機能のため
// 未契約テナントがこのページを開く動機が無く、51晩連続で同意ゼロという結果を招いた
// (docs/LEARNING_LOOP_REQUIREMENTS.md:497)。プランゲートが無く全プランから到達できる
// /admin/tuning(AIへの指示ルール画面)へ移設した。
// 旧UI閉鎖(docs/LEGACY_UI_SUNSET.md)後は copilot-preview の set_hermes_consent ツールが
// 唯一の操作経路になる予定。
//
// S5(共有学習プールの参加モデル・決定案「D1・D5決定案」): features.learning.{learn,share}
// の2軸に対応。このトグルは share のみを操作する(learnは常時true・非表示のまま)。
// free_adプランではshareが強制ONになるため、その場合はトグルを操作不能にして理由を表示する
// (押しても何も起きないUIにしない。バックエンド側でも
// PATCH /v1/admin/my-tenant・/v1/admin/tenants/:id の両方に同じ強制判定を入れている)。
// 後方互換: features.learning が未設定のテナントは features.hermes_raw_data_consent を読む
// (src/lib/hermesConsent.ts の resolveLearningConsent と同じ優先順位)。
//
// [A2A-0h]: 文言を admin-ui/src/i18n/{ja,en}.ts の hermes_consent.* に抽出(旧: 日本語ハードコード)。
// 説明文は give-to-get(提供すると他社の学習成果=グローバルルールを受け取れる。OFFなら
// 提供もしないが受け取りもしない)の相互性が伝わるよう書き直した。同意の判定ロジック
// (resolveShare・fail-safeの既定値)自体は変更していない。
// overrideTenantId は元々「super_adminのプレビュー中テナントID」用だったが、
// /admin/tenants/:id(SettingsTab)からの直接操作でも同じPATCH /v1/admin/tenants/:id を
// 再利用するために転用している(下記コメント参照)。

import { useEffect, useState } from "react";
import { authFetch, API_BASE } from "../lib/api";
import { useLang } from "../i18n/LangContext";

interface LearningConsent {
  learn: boolean;
  share: boolean;
}

interface TenantFeatures {
  avatar: boolean;
  voice: boolean;
  rag: boolean;
  deep_research?: boolean;
  pre_dispatch?: boolean;
  hermes_raw_data_consent?: boolean;
  learning?: LearningConsent;
}

type Plan = "free_ad" | "starter" | "standard" | "growth" | "enterprise" | null;

/** features.learning があればそちらを優先し、無ければ旧フラグから解決する(後方互換)。 */
function resolveShare(features: TenantFeatures | null): boolean {
  if (!features) return false;
  if (features.learning) return features.learning.share;
  return features.hermes_raw_data_consent === true;
}

interface HermesConsentToggleProps {
  // super_adminの「クライアントビューで見る」プレビュー中のテナントID。
  // 指定時は自テナント専用の /my-tenant ではなく super_admin用の /tenants/:id を使う。
  overrideTenantId?: string;
}

export function HermesConsentToggle({ overrideTenantId }: HermesConsentToggleProps = {}) {
  const { t } = useLang();
  const [features, setFeatures] = useState<TenantFeatures | null>(null);
  const [plan, setPlan] = useState<Plan>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const endpoint = overrideTenantId
    ? `${API_BASE}/v1/admin/tenants/${overrideTenantId}`
    : `${API_BASE}/v1/admin/my-tenant`;

  useEffect(() => {
    authFetch(endpoint)
      .then((r) => r.json())
      .then((data: { features?: TenantFeatures; plan?: Plan }) => {
        setFeatures({
          avatar: data.features?.avatar ?? false,
          voice: data.features?.voice ?? false,
          rag: data.features?.rag ?? true,
          deep_research: data.features?.deep_research,
          pre_dispatch: data.features?.pre_dispatch,
          hermes_raw_data_consent: data.features?.hermes_raw_data_consent,
          learning: data.features?.learning,
        });
        setPlan(data.plan ?? null);
      })
      .catch(() => {});
  }, [endpoint]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const consentGranted = resolveShare(features);
  // S5: free_adはshareが強制ON。押しても何も起きないUIにせず、操作不能な理由を明示する
  // (バックエンド側の判定 resolveShareForPlan と同じ: free_adと確実に判明した場合のみ強制)。
  const forcedByPlan = plan === "free_ad";

  const handleToggle = async () => {
    if (!features || saving || forcedByPlan) return;
    const next = !consentGranted;
    const prev = features;
    const nextFeatures: TenantFeatures = {
      ...features,
      learning: { learn: features.learning?.learn ?? true, share: next },
    };

    // 楽観的更新
    setFeatures(nextFeatures);
    setSaving(true);

    try {
      const res = await authFetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ features: nextFeatures }),
      });

      if (!res.ok) {
        setFeatures(prev); // ロールバック
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        showToast(`❌ ${body?.message ?? t("hermes_consent.toast_error_default")}`);
        return;
      }

      const updated = (await res.json()) as { features?: TenantFeatures };
      setFeatures({ ...prev, ...updated.features });
      showToast(
        next
          ? t("hermes_consent.toast_joined")
          : t("hermes_consent.toast_left"),
      );
    } catch {
      setFeatures(prev); // ロールバック
      showToast(`❌ ${t("hermes_consent.toast_error_default")}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        marginBottom: 24,
        padding: "20px 24px",
        borderRadius: 14,
        border: consentGranted
          ? "1px solid rgba(74,222,128,0.35)"
          : "1px solid rgba(107,114,128,0.3)",
        background: consentGranted
          ? "rgba(34,197,94,0.07)"
          : "rgba(255,255,255,0.03)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: "var(--foreground)" }}>
            {t("hermes_consent.title")}
          </h2>
          <p style={{ fontSize: 14, color: "var(--muted-foreground)", margin: "6px 0 0", maxWidth: 480 }}>
            {t("hermes_consent.description_main")}
          </p>
          <p style={{ fontSize: 14, color: "var(--muted-foreground)", margin: "8px 0 0", maxWidth: 480 }}>
            {t("hermes_consent.description_internal")}
          </p>
          {forcedByPlan && (
            <p style={{ fontSize: 13, color: "#f0b429", margin: "8px 0 0", maxWidth: 480 }}>
              {t("hermes_consent.forced_notice")}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => void handleToggle()}
          disabled={saving || features === null || forcedByPlan}
          aria-pressed={consentGranted}
          aria-label={
            forcedByPlan
              ? t("hermes_consent.aria_forced")
              : consentGranted
                ? t("hermes_consent.aria_revoke")
                : t("hermes_consent.aria_join")
          }
          style={{
            padding: "12px 28px",
            minHeight: 48,
            minWidth: 120,
            borderRadius: 10,
            border: consentGranted
              ? "1px solid rgba(74,222,128,0.5)"
              : "1px solid rgba(107,114,128,0.4)",
            background: consentGranted
              ? "rgba(34,197,94,0.22)"
              : "rgba(107,114,128,0.18)",
            color: consentGranted ? "#4ade80" : "#9ca3af",
            fontSize: 16,
            fontWeight: 700,
            cursor: saving || features === null || forcedByPlan ? "not-allowed" : "pointer",
            opacity: saving || features === null || forcedByPlan ? 0.6 : 1,
            transition: "all 0.15s",
          }}
        >
          {saving
            ? t("hermes_consent.btn_saving")
            : forcedByPlan
              ? t("hermes_consent.btn_forced")
              : consentGranted
                ? t("hermes_consent.btn_active")
                : t("hermes_consent.btn_inactive")}
        </button>
      </div>
      {toast && (
        <div
          style={{
            marginTop: 12,
            padding: "10px 14px",
            borderRadius: 8,
            background: toast.startsWith("❌")
              ? "rgba(239,68,68,0.12)"
              : "rgba(34,197,94,0.12)",
            color: toast.startsWith("❌") ? "#fca5a5" : "#86efac",
            fontSize: 14,
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
