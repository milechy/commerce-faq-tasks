// admin-ui/src/pages/admin/avatar/wizard.tsx
// Phase64 タスク4: アバター生成ウィザードページ

import { useNavigate } from "react-router-dom";
import { useAuth } from "../../../auth/useAuth";
import { AvatarWizard } from "../../../components/avatar-wizard/AvatarWizard";

export default function AvatarWizardPage() {
  const navigate = useNavigate();
  // 修正前は user?.app_metadata?.tenant_id を見ていたが、useAuth() の user は
  // 正規化済みの { tenantId, ... } 形であり app_metadata を持たないため、
  // client_adminも含め常に空文字になっていた(#P1-B)。previewMode中の
  // super_adminはpreviewTenantIdを使う(copilot-preview/index.tsxのscopedTenantId
  // と同じパターン)。
  const { user, isSuperAdmin, previewMode, previewTenantId } = useAuth();
  const tenantId: string = previewMode ? (previewTenantId ?? "") : (user?.tenantId ?? "");

  function handleComplete(imageUrl: string) {
    // 生成完了後はスタジオ新規作成ページへ遷移（URLにimage_urlを渡す）
    navigate(`/admin/avatar/studio?generated_image=${encodeURIComponent(imageUrl)}`);
  }

  function handleCancel() {
    navigate("/admin/avatar");
  }

  return (
    <AvatarWizard
      tenantId={tenantId}
      isSuperAdmin={isSuperAdmin}
      onComplete={handleComplete}
      onCancel={handleCancel}
    />
  );
}
