// admin-ui/src/lib/hermesShare.ts
//
// features.learning.share の解決ロジックの唯一の実装。
// HermesConsentToggle.tsx と HermesConsentUpsellNotice.tsx / copilot-preview の
// 同意勧誘チップが同じ判定を別々に持つと、片方だけ後方互換フラグの読み方が
// ズレて「トグルはOFF表示なのに勧誘は出ない(またはその逆)」という食い違いが
// 起きうる(サーバ側 src/lib/hermesConsent.ts の resolveLearningConsentFromFeatures
// と同じ理由で、実装は1箇所に集約する)。

export interface LearningConsent {
  learn: boolean;
  share: boolean;
}

export interface TenantFeaturesLike {
  learning?: LearningConsent;
  hermes_raw_data_consent?: boolean;
}

/** features.learning があればそちらを優先し、無ければ旧フラグから解決する(後方互換)。 */
export function resolveShare(features: TenantFeaturesLike | null | undefined): boolean {
  if (!features) return false;
  if (features.learning) return features.learning.share;
  return features.hermes_raw_data_consent === true;
}
