// admin-ui/src/pages/admin/avatar/HermesConsentToggle.tsx
// Phase75 → GID 1216978677372391(PR-16, D1): 外部Hermes VPSへの生データ提供同意 ON/OFF トグル
// （Client Adminのみ、自己完結型。ExcludeSearchToggleの楽観的更新+ロールバックパターンを踏襲）
//
// D1: データ利用同意は2階層。
//   ①自テナント内学習(learned_memory等) = 常時ON・同意不要(このトグルの対象外)
//   ②社外Hermes VPSへの生データ提供 = 明示同意必須(このトグルが操作するのはこちらのみ)
// このページ(/admin/avatar)は2026-10-13まで閉鎖観察中(docs/LEGACY_UI_SUNSET.md)。
// 閉鎖後は copilot-preview の set_hermes_consent ツールが唯一の操作経路になる。
//
// S5(共有学習プールの参加モデル・決定案「D1・D5決定案」): features.learning.{learn,share}
// の2軸に対応。このトグルは share のみを操作する(learnは常時true・非表示のまま)。
// free_adプランではshareが強制ONになるため、その場合はトグルを操作不能にして理由を表示する
// (押しても何も起きないUIにしない。バックエンド側でも
// PATCH /v1/admin/my-tenant・/v1/admin/tenants/:id の両方に同じ強制判定を入れている)。
// 後方互換: features.learning が未設定のテナントは features.hermes_raw_data_consent を読む
// (src/lib/hermesConsent.ts の resolveLearningConsent と同じ優先順位)。

import { useEffect, useState } from "react";
import { authFetch, API_BASE } from "../../../lib/api";

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
        showToast(`❌ ${body?.message ?? "保存に失敗しました。もう一度お試しください。"}`);
        return;
      }

      const updated = (await res.json()) as { features?: TenantFeatures };
      setFeatures({ ...prev, ...updated.features });
      showToast(
        next
          ? "✅ Hermesへのデータ提供に同意しました"
          : "✅ 同意を取り消しました",
      );
    } catch {
      setFeatures(prev); // ロールバック
      showToast("❌ 保存に失敗しました。もう一度お試しください。");
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
            🧠 外部(Hermes)へのデータ提供同意
          </h2>
          <p style={{ fontSize: 14, color: "var(--muted-foreground)", margin: "6px 0 0", maxWidth: 480 }}>
            これは社外の分析エージェント(Hermes)へ会話ログ生データを提供するための同意です。
            R2C社内での学習(FAQ改善・回答の自動学習)は、この同意の有無に関わらず常に行われます。
            ONにすると、貴社の過去分を含む会話ログ(QA AI・アバターの応答)に加え、その会話に至るまでの
            ページ閲覧履歴・流入元(URLのパス部分、検索語や会員IDなどのクエリ文字列は除く)がHermesでの
            分析対象になります。OFFにすると以降の新規データ提供は停止しますが、それまでに提供済みの
            データへの反映は取り消せません。
          </p>
          {forcedByPlan && (
            <p style={{ fontSize: 13, color: "#f0b429", margin: "8px 0 0", maxWidth: 480 }}>
              ⚠️ 現在のプラン(広告プラン)では、無料でのご提供の対価としてデータ提供が必須です。
              停止するには有料プランへの変更が必要です。
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
              ? "広告プランのためデータ提供は必須です(変更不可)"
              : consentGranted
                ? "Hermesへのデータ提供同意を取り消す"
                : "Hermesへのデータ提供に同意する"
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
            ? "保存中..."
            : forcedByPlan
              ? "🔒 必須(広告プラン)"
              : consentGranted
                ? "✅ 同意済み"
                : "⏸️ 未同意"}
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
