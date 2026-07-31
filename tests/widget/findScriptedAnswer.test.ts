// tests/widget/findScriptedAnswer.test.ts
// widget.js の findScriptedAnswer() — data-scripted-responses によるキーワードマッチ定型応答
// (LLM呼び出しコストをゼロにする仕組み) のユニットテスト。
//
// 方針: 他の tests/widget/*.test.ts と同様、実際の widget.js を eval せず、
// 同一ロジックを抽出して検証する（public/widget.js:2306-2322 と完全同一に保つこと）。
// ロジックの乖離を防ぐため、tests/widget/widgetSourceInvariants.test.ts で
// 実ファイル側の実装がこの契約から外れていないかを別途チェックしている。

type ScriptedResponse = { keywords?: unknown; answer: string };

function findScriptedAnswer(userText: string, responses: unknown): string | null {
  if (!responses || !Array.isArray(responses)) return null;
  const normalized = userText.toLowerCase().replace(/[？?！!。、\s]/g, '');
  for (let i = 0; i < responses.length; i++) {
    const item = responses[i] as ScriptedResponse;
    const kws = (item.keywords as string[]) || [];
    if (kws.indexOf('*') !== -1) continue; // wildcard/fallback handled last
    for (let j = 0; j < kws.length; j++) {
      const kw = String(kws[j] || '').toLowerCase().replace(/[？?！!。、\s]/g, '');
      if (!kw) continue; // 空文字キーワードは無条件マッチの罠になるため除外
      if (normalized.indexOf(kw) !== -1) return item.answer;
    }
  }
  let fallback: string | null = null;
  for (let k = 0; k < responses.length; k++) {
    const item = responses[k] as ScriptedResponse;
    if (item.keywords && (item.keywords as string[]).indexOf('*') !== -1) {
      fallback = item.answer;
      break;
    }
  }
  return fallback;
}

describe('widget.js findScriptedAnswer', () => {
  // ===== 1. 正常系 =====
  describe('正常系: 基本のキーワードマッチ', () => {
    const responses = [
      { keywords: ['料金', '値段', 'いくら'], answer: 'PRICING' },
      { keywords: ['導入', '期間'], answer: 'ONBOARDING' },
      { keywords: ['*'], answer: 'FALLBACK' },
    ];

    it('キーワードを含むメッセージで対応する回答を返す', () => {
      expect(findScriptedAnswer('料金を教えて', responses)).toBe('PRICING');
    });

    it('同義キーワードのどれでもマッチする', () => {
      expect(findScriptedAnswer('いくらですか', responses)).toBe('PRICING');
    });

    it('該当キーワードが無ければ * のフォールバック回答を返す', () => {
      expect(findScriptedAnswer('こんにちは', responses)).toBe('FALLBACK');
    });

    it('質問符・感嘆符・句読点・空白を含んでいても正規化してマッチする', () => {
      expect(findScriptedAnswer('料金　って　結局 いくら？！', responses)).toBe('PRICING');
    });

    it('大文字小文字を区別しない（英字キーワードの場合）', () => {
      const r = [{ keywords: ['FAQ'], answer: 'FAQ_ANS' }, { keywords: ['*'], answer: 'FB' }];
      expect(findScriptedAnswer('faqについて教えて', r)).toBe('FAQ_ANS');
      expect(findScriptedAnswer('FAQについて教えて', r)).toBe('FAQ_ANS');
    });

    it('部分一致（サブストリング）で十分にマッチする', () => {
      expect(findScriptedAnswer('料金体系が知りたいです', responses)).toBe('PRICING');
    });
  });

  // ===== 2. 境界値・異常系 =====
  describe('境界値・異常系', () => {
    it('responses が null なら null を返す（LLM経路へフォールバックすべき）', () => {
      expect(findScriptedAnswer('料金', null)).toBeNull();
    });

    it('responses が undefined なら null を返す', () => {
      expect(findScriptedAnswer('料金', undefined)).toBeNull();
    });

    it('responses が配列でない（オブジェクト等）なら null を返す', () => {
      expect(findScriptedAnswer('料金', { keywords: ['*'], answer: 'X' })).toBeNull();
    });

    it('responses が空配列なら null を返す（フォールバックも無い）', () => {
      expect(findScriptedAnswer('料金', [])).toBeNull();
    });

    it('ユーザー入力が空文字でもエラーにならず、フォールバックへ流れる', () => {
      const responses = [{ keywords: ['料金'], answer: 'PRICING' }, { keywords: ['*'], answer: 'FB' }];
      expect(findScriptedAnswer('', responses)).toBe('FB');
    });

    it('* フォールバックが定義されていない場合、未マッチ時は null（＝LLMへフォールバック）', () => {
      const responses = [{ keywords: ['料金'], answer: 'PRICING' }];
      expect(findScriptedAnswer('こんにちは', responses)).toBeNull();
    });

    it('keywords が未定義の要素があっても例外を投げない', () => {
      const responses = [{ answer: 'NO_KEYWORDS' } as ScriptedResponse, { keywords: ['*'], answer: 'FB' }];
      expect(() => findScriptedAnswer('何か聞きたい', responses)).not.toThrow();
      expect(findScriptedAnswer('何か聞きたい', responses)).toBe('FB');
    });

    it('非常に長い入力でもクラッシュ・ハングしない', () => {
      const longText = '料金'.repeat(10000);
      const responses = [{ keywords: ['料金'], answer: 'PRICING' }, { keywords: ['*'], answer: 'FB' }];
      expect(findScriptedAnswer(longText, responses)).toBe('PRICING');
    });

    it('【回帰】空文字キーワードが無条件マッチの罠にならない', () => {
      // このケースはコンテンツ編集ミス（配列末尾のカンマ等）で "" が keywords に
      // 混入した場合の防御。修正前は毎回このエントリが先勝ちし、以降のキーワードが
      // 一切マッチしなくなる致命的なリグレッションだった。
      const responses = [
        { keywords: ['', '料金'], answer: 'BROKEN_IF_EMPTY_MATCHES' },
        { keywords: ['セキュリティ'], answer: 'SECURITY' },
        { keywords: ['*'], answer: 'FB' },
      ];
      // "料金" は空文字キーワードより先に判定されるべきではなく、
      // このメッセージ自体は "料金" にマッチしてよい（同エントリ内の実キーワード）
      expect(findScriptedAnswer('料金について', responses)).toBe('BROKEN_IF_EMPTY_MATCHES');
      // しかし全く無関係なメッセージが空文字キーワードにマッチしてはいけない
      expect(findScriptedAnswer('セキュリティが心配', responses)).toBe('SECURITY');
      expect(findScriptedAnswer('こんにちは', responses)).toBe('FB');
    });
  });

  // ===== 3. ユーザーがやりそうなイレギュラーな操作 =====
  describe('イレギュラーなユーザー操作', () => {
    const responses = [
      { keywords: ['料金', '値段'], answer: 'PRICING' },
      { keywords: ['セキュリティ', '個人情報'], answer: 'SECURITY' },
      { keywords: ['*'], answer: 'FB' },
    ];

    it('複数の話題キーワードを同時に含む文では配列の先頭エントリが優先される', () => {
      // コンテンツ設定者が意図せぬ優先順位に依存しがちな箇所なので、挙動を明文化する
      expect(findScriptedAnswer('料金とセキュリティを教えて', responses)).toBe('PRICING');
    });

    it('HTML/スクリプトのような文字列を送ってもマッチ判定自体はクラッシュしない（レンダリング側の安全性は別途担保）', () => {
      expect(() =>
        findScriptedAnswer('<script>alert(1)</script>料金', responses)
      ).not.toThrow();
      expect(findScriptedAnswer('<script>alert(1)</script>料金', responses)).toBe('PRICING');
    });

    it('絵文字や記号だけのメッセージはフォールバックに落ちる', () => {
      expect(findScriptedAnswer('😀😀😀', responses)).toBe('FB');
    });

    it('全角/半角の違いは正規化されないため意図的にマッチしない（既知の制約）', () => {
      // カタカナ半角「ﾘｮｳｷﾝ」等はキーワード側と表記ゆれし、一致しない。
      // これは NFKC 正規化を実装していないための既知のカバレッジギャップであり、
      // フォールバックの汎用案内文に落ちる（致命的な機能停止ではない）ことを保証する。
      expect(findScriptedAnswer('ﾘｮｳｷﾝ', responses)).toBe('FB');
    });

    it('連打（同一入力の連続送信）でも都度同じ結果を安定して返す（副作用なし・純粋関数）', () => {
      const results = Array.from({ length: 5 }, () => findScriptedAnswer('料金', responses));
      expect(new Set(results).size).toBe(1);
      expect(results[0]).toBe('PRICING');
    });

    it('複数の * ワイルドカードが定義されていても最初の1つだけが使われる', () => {
      const multi = [
        { keywords: ['*'], answer: 'FIRST_FALLBACK' },
        { keywords: ['*'], answer: 'SECOND_FALLBACK' },
      ];
      expect(findScriptedAnswer('無関係な質問', multi)).toBe('FIRST_FALLBACK');
    });

    it('ワイルドカードと実キーワードが同じエントリに混在すると、そのエントリの実キーワードは絶対にマッチしない（既知の仕様）', () => {
      // findScriptedAnswer は `kws.indexOf('*') !== -1` の場合、メインループで
      // そのエントリ自体を丸ごと continue するため、"hello" は決してヒットしない。
      // コンテンツ設定者がこの組み合わせを書いても静かに無視されるだけなので、
      // 挙動として固定化しておく（設定ミス検知は静的テスト側で別途行う）。
      const mixed = [
        { keywords: ['*', 'hello'], answer: 'NEVER_VIA_KEYWORD' },
        { keywords: [], answer: 'UNREACHABLE_NO_KEYWORDS' },
      ];
      expect(findScriptedAnswer('hello', mixed)).toBe('NEVER_VIA_KEYWORD'); // ワイルドカードとして拾われる
      expect(findScriptedAnswer('hello', mixed)).not.toBe('UNREACHABLE_VIA_KEYWORD_MATCH');
    });
  });
});
