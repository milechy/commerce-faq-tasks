// src/search/globalKnowledgeFlag.ts
// P1: global / r2c_docs 知識のテナント別オプトイン制御
//
// 背景:
//   tenant_id='global'(書籍抜粋等) と tenant_id='r2c_docs'(R2C 社内ドキュメント) の知識が、
//   フラグ・env・テナント別設定を一切介さずに全テナントの回答検索へ無条件で引かれていた。
//   書籍ライセンス/社内運用情報が匿名訪問者向け回答の材料になり、外部露出につながる(P1)。
//
//   本モジュールは「回答検索に global / r2c_docs を混ぜてよいか」をテナント単位で判定する
//   唯一の入口。回答経路の全ての SQL/ES クエリ(pgvectorSearch / pgvector / hybrid /
//   principleSearch)がこの判定を共有する(第2の解釈を書かない)。
//
//   global(書籍)と r2c_docs(社内ドキュメント)は機微度が異なるため独立に制御する。
//
// == 既定は後方互換(=引く) ==
//   *_ENFORCE_OPTIN が未設定(!== "true")なら、従来どおり全テナントで引く。現状 global を
//   前提に運用しているテナント(例: Accept 検証テナントの★書籍は tenant_id='global' のまま)を
//   壊さないため。運用者が opt-in を有効化するまで挙動は一切変わらない。
//
// == opt-in の有効化(無条件混入の解消) ==
//   GLOBAL_KNOWLEDGE_ENFORCE_OPTIN=true   global をオプトイン制へ切替
//   GLOBAL_KNOWLEDGE_TENANTS=accept,foo   引けるテナント(カンマ区切り, '*'=全許可, 空=全拒否)
//   R2C_DOCS_ENFORCE_OPTIN=true           r2c_docs をオプトイン制へ切替
//   R2C_DOCS_TENANTS=                     引けるテナント(空 = どのテナントも引かない)
//
//   ENFORCE_OPTIN を true にすると、対応する allowlist に載らないテナントの回答から
//   global / r2c_docs が消える。allowlist を空にすれば、その知識を誰にも引かせない
//   (r2c_docs のような社内ドキュメントを全面的に閉じる用途)。
//
// featureFlag.ts / openclaw/featureFlag.ts と同じく process.env を直接読む
// (env.ts の zod スキーマは未知キーを素通しにするだけで検証の主体ではない)。

function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function tenantAllowed(raw: string | undefined, tenantId: string): boolean {
  const allowed = parseAllowlist(raw);
  if (allowed.includes("*")) return true;
  return allowed.includes(tenantId);
}

/**
 * 回答検索に共有の 'global' 知識(書籍抜粋・心理学原則等)を含めてよいか。
 * ENFORCE 未設定なら true(後方互換)。有効時は GLOBAL_KNOWLEDGE_TENANTS で判定。
 */
export function shouldIncludeGlobalKnowledge(tenantId: string): boolean {
  if (process.env.GLOBAL_KNOWLEDGE_ENFORCE_OPTIN !== "true") return true;
  return tenantAllowed(process.env.GLOBAL_KNOWLEDGE_TENANTS, tenantId);
}

/**
 * 回答検索に 'r2c_docs'(R2C 社内ドキュメント)を含めてよいか。
 * ENFORCE 未設定なら true(後方互換)。有効時は R2C_DOCS_TENANTS で判定。
 * global より機微度が高い想定のため独立に制御する。
 */
export function shouldIncludeR2cDocs(tenantId: string): boolean {
  if (process.env.R2C_DOCS_ENFORCE_OPTIN !== "true") return true;
  return tenantAllowed(process.env.R2C_DOCS_TENANTS, tenantId);
}
