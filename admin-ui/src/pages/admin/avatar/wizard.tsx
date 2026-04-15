// admin-ui/src/pages/admin/avatar/wizard.tsx
// Phase64 タスク4: アバター生成ウィザードページ

import React from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../../auth/useAuth";
import { AvatarWizard } from "../../../components/avatar-wizard/AvatarWizard";

export default function AvatarWizardPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const tenantId: string = (user as any)?.app_metadata?.tenant_id ?? "";

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
      onComplete={handleComplete}
      onCancel={handleCancel}
    />
  );
}
