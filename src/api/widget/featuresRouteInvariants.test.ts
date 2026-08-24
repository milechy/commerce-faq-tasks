// src/api/widget/featuresRouteInvariants.test.ts
// GET /api/widget/features は src/index.ts に直接書かれておりHTTP経路のユニットテストが
// 無い(index.ts に supertest を通す既存慣習が無い)。widgetSourceInvariants.test.ts と同じ
// 流儀で、ソーステキストに対する不変条件を機械的にロックする。
//
// answer_feedback(要件Rj/決定D1)は event_tracking と極性が逆(未設定=有効)。
// この逆転が誤って揃えられると、テナントの意図しない機能OFFが広範囲に起きる。

import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.resolve(__dirname, '../../index.ts'), 'utf8');

function extractRouteBody(): string {
  const start = SRC.indexOf("app.get('/api/widget/features'");
  expect(start).toBeGreaterThan(-1);
  // 次のルート登録までを本体とみなす(十分な余白)
  return SRC.slice(start, start + 1500);
}

describe('GET /api/widget/features ソース不変条件', () => {
  it('answer_feedback を返している', () => {
    const body = extractRouteBody();
    expect(body).toMatch(/answer_feedback/);
  });

  it('event_tracking(未設定=無効)と極性が逆(未設定=有効)であることが明示されている', () => {
    const body = extractRouteBody();
    // event_tracking 側: truthy 変換(未設定=false)
    expect(body).toMatch(/event_tracking:\s*!!features\.event_tracking/);
    // answer_feedback 側: 明示 false のときだけ無効(未設定=true)
    expect(body).toMatch(/answer_feedback:\s*features\.answer_feedback !== false/);
  });

  it('DB接続なし・テナント不明のフォールバックでも answer_feedback は false を返さない', () => {
    const body = extractRouteBody();
    const fallback = body.match(/if \(!db \|\| !tenantId\) \{[\s\S]{0,120}\}/);
    expect(fallback).not.toBeNull();
    // このフォールバックには answer_feedback を含めない(=フロント側の既定trueに委ねる)。
    // 誤って answer_feedback: false を書き足すと全テナントで機能が消える。
    expect(fallback![0]).not.toMatch(/answer_feedback:\s*false/);
  });

  it('DBクエリ失敗時(catch節)も既定ONを維持する', () => {
    const body = extractRouteBody();
    const catchBlock = body.match(/\} catch \{[\s\S]{0,260}\}/);
    expect(catchBlock).not.toBeNull();
    expect(catchBlock![0]).toMatch(/answer_feedback:\s*true/);
  });

  it('S5a: data_shared_externally を全ての応答経路(正常系/フォールバック2箇所)で返している', () => {
    const body = extractRouteBody();
    // 正常系: resolveLearningConsentFromFeatures の share をそのまま使う
    expect(body).toMatch(/data_shared_externally:\s*resolveLearningConsentFromFeatures\(features,\s*\{\s*tenantId\s*\}\)\.share/);
    // db/tenantId不明フォールバック
    const fallback = body.match(/if \(!db \|\| !tenantId\) \{[\s\S]{0,120}\}/);
    expect(fallback).not.toBeNull();
    expect(fallback![0]).toMatch(/data_shared_externally:\s*false/);
    // catch節フォールバック。falseで固定(fail-safe: DB障害時に「外に出ている」と誤表示しない)。
    const catchBlock = body.match(/\} catch \{[\s\S]{0,260}\}/);
    expect(catchBlock).not.toBeNull();
    expect(catchBlock![0]).toMatch(/data_shared_externally:\s*false/);
  });
});
