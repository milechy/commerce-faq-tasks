// tests/e2e/tenantIdConsistency.test.ts

import { readFileSync } from 'fs';
import { join } from 'path';

// Asana 1217080885072052 の是正で、qa-irregular-3roles.spec.ts の B-IRR-3 が使う
// OTHER_TENANT_IDS の 'r2c_default' 分は同ファイルの FOREIGN_TENANT 定数参照に
// 是正済みだが、'lp-demo' 分は spec 間でテナントID定数を共有する仕組みが無いため
// qa-preview-scope-leak.spec.ts の PREVIEW_TENANT_2 の値を手で複製したままである。
// この複製は、PREVIEW_TENANT_2 が変わってもコンパイルエラーにもテスト失敗にも
// ならず気づかれずに乖離する(=B-IRR-3が越境を検知できなくなる)という壊れやすい
// ポイントであるため、乖離をここで検知する(confirmPolicy.test.ts / agentChatMock.test.ts
// と同じ、readFileSyncで実ソースを読んで検査するパターン)。
describe('B-IRR-3 OTHER_TENANT_IDS と他specの実テナントIDとの整合', () => {
  const IRREGULAR_SPEC_PATH = join(__dirname, 'qa-irregular-3roles.spec.ts');
  const SCOPE_LEAK_SPEC_PATH = join(__dirname, 'qa-preview-scope-leak.spec.ts');

  it('OTHER_TENANT_IDSがFOREIGN_TENANT参照のまま(r2c_defaultの直書きへ後退していない)', () => {
    const source = readFileSync(IRREGULAR_SPEC_PATH, 'utf8');
    const match = source.match(/const OTHER_TENANT_IDS = \[FOREIGN_TENANT,\s*['"]([^'"]+)['"]\]/);
    expect(match).not.toBeNull();
  });

  it('OTHER_TENANT_IDSのlp-demo相当分が qa-preview-scope-leak.spec.ts の PREVIEW_TENANT_2 と一致する', () => {
    const irregularSource = readFileSync(IRREGULAR_SPEC_PATH, 'utf8');
    const otherTenantMatch = irregularSource.match(
      /const OTHER_TENANT_IDS = \[FOREIGN_TENANT,\s*['"]([^'"]+)['"]\]/,
    );
    expect(otherTenantMatch).not.toBeNull();
    const duplicatedTenantId = otherTenantMatch![1];

    const scopeLeakSource = readFileSync(SCOPE_LEAK_SPEC_PATH, 'utf8');
    const previewTenant2Match = scopeLeakSource.match(/const PREVIEW_TENANT_2 = ['"]([^'"]+)['"]/);
    expect(previewTenant2Match).not.toBeNull();
    const previewTenant2Value = previewTenant2Match![1];

    expect(duplicatedTenantId).toBe(previewTenant2Value);
  });
});
