// tests/widget/lpScriptedResponsesConfig.test.ts
//
// public/lp/index.html に埋め込まれた data-scripted-responses / data-avatar-mode /
// data-avatar-image-url の"設定内容"そのものを検証する。
//
// widget.js のロジックがどれだけ正しくても、LP側のコンテンツ編集（マーケ文言の調整など、
// 非エンジニアが将来触る可能性が高い箇所）でこの JSON が壊れると、
// - HTML属性のクォート崩壊で埋め込みタグ自体が壊れる（サイレント障害）
// - 全メッセージが最初のエントリに吸われる／特定のQ&Aに永久に到達できない
// といった、ビルドエラーにも実行時エラーにもならない"静かな劣化"が起きる。
// このテストはその種のコンテンツ編集ミスを CI で機械的に捕捉する。

import fs from 'fs';
import path from 'path';

const LP_HTML = fs.readFileSync(
  path.resolve(__dirname, '../../public/lp/index.html'),
  'utf8'
);

type ScriptedResponse = { keywords?: string[]; answer: string };

// findScriptedAnswer と同一ロジック（findScriptedAnswer.test.ts と揃えること）
function findScriptedAnswer(userText: string, responses: ScriptedResponse[]): string | null {
  const normalized = userText.toLowerCase().replace(/[？?！!。、\s]/g, '');
  for (const item of responses) {
    if (!item.answer) continue;
    const kws = item.keywords || [];
    if (kws.indexOf('*') !== -1) continue;
    for (const raw of kws) {
      const kw = String(raw || '').toLowerCase().replace(/[？?！!。、\s]/g, '');
      if (!kw) continue;
      if (normalized.indexOf(kw) !== -1) return item.answer;
    }
  }
  const wildcard = responses.find((r) => !!r.answer && (r.keywords || []).indexOf('*') !== -1);
  return wildcard ? wildcard.answer : null;
}

function extractScriptedResponsesRaw(): string {
  const m = LP_HTML.match(/data-scripted-responses='([\s\S]*?)'/);
  if (!m) throw new Error('data-scripted-responses attribute not found in public/lp/index.html');
  return m[1];
}

describe('public/lp/index.html の data-scripted-responses 設定', () => {
  const raw = extractScriptedResponsesRaw();

  it('有効なJSONとしてパースできる', () => {
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  const responses: ScriptedResponse[] = JSON.parse(raw);

  it('配列であり、1件以上のエントリを持つ', () => {
    expect(Array.isArray(responses)).toBe(true);
    expect(responses.length).toBeGreaterThan(0);
  });

  it('全エントリが answer フィールド(空でない文字列)を持つ', () => {
    for (const r of responses) {
      expect(typeof r.answer).toBe('string');
      expect(r.answer.trim().length).toBeGreaterThan(0);
    }
  });

  it('* ワイルドカード（汎用フォールバック）がちょうど1件だけ定義されている', () => {
    const wildcardEntries = responses.filter((r) => (r.keywords || []).indexOf('*') !== -1);
    expect(wildcardEntries).toHaveLength(1);
  });

  it('ワイルドカード以外の全エントリは1件以上の空でないキーワードを持つ（到達不能なエントリが無い）', () => {
    for (const r of responses) {
      if ((r.keywords || []).indexOf('*') !== -1) continue;
      const validKeywords = (r.keywords || []).filter((k) => String(k || '').trim().length > 0);
      expect(validKeywords.length).toBeGreaterThan(0);
    }
  });

  it('HTML属性はシングルクォートで囲われているため、JSON文字列値の中にシングルクォートを含めてはいけない', () => {
    // 例えば回答文に「お客様の"声"」のような表現を含めるのは可（ダブルクォートはJSON側で
    // エスケープされ問題ない）が、アポストロフィ(')が answer/keywords に紛れ込むと
    // ブラウザのHTMLパース時点で data-scripted-responses 属性がそこで途切れ、
    // 以降の属性(defer 等)が丸ごと壊れる。ビルドは通り、実行時エラーも出ないため
    // 最も見つけにくい部類の静かな障害であり、これを機械的にロックする。
    expect(raw).not.toMatch(/'/);
  });

  it('各エントリのキーワードで実際に findScriptedAnswer を通すと、そのエントリ自身の answer が返る（他エントリに握りつぶされていない）', () => {
    for (const r of responses) {
      if ((r.keywords || []).indexOf('*') !== -1) continue;
      for (const kw of r.keywords || []) {
        if (!String(kw || '').trim()) continue;
        expect(findScriptedAnswer(kw, responses)).toBe(r.answer);
      }
    }
  });

  it('未知の話題を聞いた場合はワイルドカードの汎用案内文が返る', () => {
    expect(findScriptedAnswer('宇宙旅行の予約はできますか', responses)).toBe(
      responses.find((r) => (r.keywords || []).indexOf('*') !== -1)!.answer
    );
  });

  it('料金・導入・セキュリティ・音声・精度の主要トピックが最低限カバーされている（回帰防止）', () => {
    const allKeywords = responses.flatMap((r) => r.keywords || []).join(' ');
    for (const topic of ['料金', '導入', 'セキュリティ', '音声', '精度']) {
      expect(allKeywords).toContain(topic);
    }
  });
});

describe('public/lp/index.html の avatarMode 設定', () => {
  it('data-avatar-mode="animated" が設定されている（LiveKit接続なしのコスト0モード）', () => {
    expect(LP_HTML).toMatch(/data-avatar-mode="animated"/);
  });

  it('data-avatar-image-url が https:// で始まる有効な形式のURLになっている', () => {
    const m = LP_HTML.match(/data-avatar-image-url="([^"]*)"/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/^https:\/\//);
    expect(() => new URL(m![1])).not.toThrow();
  });
});
