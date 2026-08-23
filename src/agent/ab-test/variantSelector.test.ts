// src/agent/ab-test/variantSelector.test.ts

import { randomUUID } from 'node:crypto';
import { selectVariant } from './variantSelector';
import type { PromptVariant } from './variantSelector';

const variantA: PromptVariant = { id: 'variant_a', name: '標準版', prompt: 'プロンプトA', weight: 70 };
const variantB: PromptVariant = { id: 'variant_b', name: '積極版', prompt: 'プロンプトB', weight: 30 };

describe('selectVariant', () => {
  it('weight [70, 30] → 統計的に70%の確率でvariant_a（1000回実行で60-80%の範囲）', () => {
    const counts: Record<string, number> = { variant_a: 0, variant_b: 0 };
    for (let i = 0; i < 1000; i++) {
      const result = selectVariant([variantA, variantB], 'fallback');
      if (result.variantId) {
        counts[result.variantId] = (counts[result.variantId] ?? 0) + 1;
      }
    }
    const ratioA = counts['variant_a']! / 1000;
    expect(ratioA).toBeGreaterThan(0.60);
    expect(ratioA).toBeLessThan(0.80);
  });

  it('variantsが空配列 → fallbackPromptを返す、variantId=null', () => {
    const result = selectVariant([], 'fallback-prompt');
    expect(result.prompt).toBe('fallback-prompt');
    expect(result.variantId).toBeNull();
    expect(result.variantName).toBeNull();
  });

  it('variantsが1つ → そのvariantを常に返す、variantId=variant_idの値', () => {
    const single: PromptVariant = { id: 'only_variant', name: '唯一版', prompt: '唯一プロンプト', weight: 100 };
    for (let i = 0; i < 10; i++) {
      const result = selectVariant([single], 'fallback');
      expect(result.prompt).toBe('唯一プロンプト');
      expect(result.variantId).toBe('only_variant');
      expect(result.variantName).toBe('唯一版');
    }
  });

  it('weight合計が100でない（[60, 20]）→ 正規化して動作（合計80のうちの比率）', () => {
    const vA: PromptVariant = { id: 'variant_a', name: 'A', prompt: 'A', weight: 60 };
    const vB: PromptVariant = { id: 'variant_b', name: 'B', prompt: 'B', weight: 20 };
    const counts: Record<string, number> = { variant_a: 0, variant_b: 0 };
    for (let i = 0; i < 1000; i++) {
      const result = selectVariant([vA, vB], 'fallback');
      if (result.variantId) {
        counts[result.variantId] = (counts[result.variantId] ?? 0) + 1;
      }
    }
    // 期待: variant_a が 60/80 = 75%, variant_b が 20/80 = 25%
    const ratioA = counts['variant_a']! / 1000;
    expect(ratioA).toBeGreaterThan(0.65);
    expect(ratioA).toBeLessThan(0.85);
  });

  it('chat_sessionsへのvariant_id/variant_name記録のためのヘルパー動作確認', () => {
    const result = selectVariant([variantA, variantB], 'fallback');
    // variantId と variantName が文字列であること（DBカラムに記録できる型）
    expect(typeof result.variantId).toBe('string');
    expect(typeof result.variantName).toBe('string');
    expect(typeof result.prompt).toBe('string');
    // variantId が variants のいずれかの id と一致すること
    const validIds = [variantA.id, variantB.id];
    expect(validIds).toContain(result.variantId);
  });

  // GID 1216978855735482: sticky assignment（同一セッション内でvariantが揺れないこと）
  describe('stickyKey指定時のsticky assignment', () => {
    it('同一のstickyKeyは常に同じvariantを返す（100回連続呼び出しでも一致）', () => {
      const sessionId = 'session-sticky-001';
      const first = selectVariant([variantA, variantB], 'fallback', sessionId);
      for (let i = 0; i < 100; i++) {
        const result = selectVariant([variantA, variantB], 'fallback', sessionId);
        expect(result.variantId).toBe(first.variantId);
      }
    });

    it('異なるstickyKeyであれば分布として両方のvariantが選ばれ得る（統計的検証、実運用同様UUID形式のセッションIDを使用）', () => {
      // "session-0", "session-1"... のような連番に近い文字列は先頭が共通し
      // ハッシュ分布が偏るため、実運用のsession_idに近いUUID形式で検証する。
      const counts: Record<string, number> = { variant_a: 0, variant_b: 0 };
      for (let i = 0; i < 500; i++) {
        const result = selectVariant([variantA, variantB], 'fallback', randomUUID());
        if (result.variantId) counts[result.variantId] = (counts[result.variantId] ?? 0) + 1;
      }
      // weight[70,30]の分布に統計的に近いこと（ハッシュ由来なので緩めの範囲で確認）
      const ratioA = counts['variant_a']! / 500;
      expect(ratioA).toBeGreaterThan(0.5);
      expect(ratioA).toBeLessThan(0.9);
      expect(counts['variant_b']).toBeGreaterThan(0);
    });

    it('stickyKey省略時は従来どおりMath.random()ベースの後方互換動作のまま（既存呼び出し元を壊さない）', () => {
      // stickyKeyを渡さない呼び出しが既存テスト(このファイル冒頭)と同じ統計的挙動を保つことを再確認
      const counts: Record<string, number> = { variant_a: 0, variant_b: 0 };
      for (let i = 0; i < 1000; i++) {
        const result = selectVariant([variantA, variantB], 'fallback');
        if (result.variantId) counts[result.variantId] = (counts[result.variantId] ?? 0) + 1;
      }
      const ratioA = counts['variant_a']! / 1000;
      expect(ratioA).toBeGreaterThan(0.60);
      expect(ratioA).toBeLessThan(0.80);
    });

    it('variantsが1つだけの場合はstickyKeyの有無に関わらず常にそのvariantを返す', () => {
      const single: PromptVariant = { id: 'only_variant', name: '唯一版', prompt: '唯一プロンプト', weight: 100 };
      const result = selectVariant([single], 'fallback', 'any-session-id');
      expect(result.variantId).toBe('only_variant');
    });
  });
});

// ---------------------------------------------------------------------------
// GID 1216978855735482 (PR-13) 補強: 壊れやすい箇所を突く
//
// 既存の分布テストは許容幅が広く(70/30に対し 0.5〜0.9)、ハッシュ関数が劣化して
// 55/45 や 88/12 になっても検出できない。A/Bの結論そのものが歪むため、
// 実運用に近い条件で許容幅を絞った検証を置く。
// ---------------------------------------------------------------------------

describe('selectVariant — sticky割当の分布品質', () => {
  const variantA: PromptVariant = { id: 'variant_a', name: 'A', prompt: 'pa', weight: 70 };
  const variantB: PromptVariant = { id: 'variant_b', name: 'B', prompt: 'pb', weight: 30 };

  /** UUID形式のstickyKeyでN回引いたときの variantId 別件数。 */
  function distribution(variants: PromptVariant[], n: number): Record<string, number> {
    const counts: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      const id = selectVariant(variants, 'fallback', randomUUID()).variantId;
      if (id) counts[id] = (counts[id] ?? 0) + 1;
    }
    return counts;
  }

  it('70/30の設定に対し、sticky割当の実測比率が±8pt以内に収まる(ハッシュ偏りの検出)', () => {
    const N = 4000;
    const counts = distribution([variantA, variantB], N);
    const ratioA = (counts['variant_a'] ?? 0) / N;
    // 二項分布の標準偏差 sqrt(0.7*0.3/4000) ≈ 0.0072 なので ±8pt は約11σ。
    // 正常なハッシュならまず落ちず、分布が壊れたときだけ落ちる幅。
    expect(ratioA).toBeGreaterThan(0.62);
    expect(ratioA).toBeLessThan(0.78);
  });

  it('3variant(50/30/20)でも各variantが設定比率±8pt以内に収まる', () => {
    const vs: PromptVariant[] = [
      { id: 'v1', name: 'v1', prompt: 'p1', weight: 50 },
      { id: 'v2', name: 'v2', prompt: 'p2', weight: 30 },
      { id: 'v3', name: 'v3', prompt: 'p3', weight: 20 },
    ];
    const N = 4000;
    const counts = distribution(vs, N);

    expect((counts['v1'] ?? 0) / N).toBeGreaterThan(0.42);
    expect((counts['v1'] ?? 0) / N).toBeLessThan(0.58);
    expect((counts['v2'] ?? 0) / N).toBeGreaterThan(0.22);
    expect((counts['v2'] ?? 0) / N).toBeLessThan(0.38);
    expect((counts['v3'] ?? 0) / N).toBeGreaterThan(0.12);
    expect((counts['v3'] ?? 0) / N).toBeLessThan(0.28);
  });

  it('weight=0 のvariantは一度も選ばれない(露出0のはずが混ざると実験が汚れる)', () => {
    const vs: PromptVariant[] = [
      { id: 'live', name: 'live', prompt: 'p', weight: 100 },
      { id: 'paused', name: 'paused', prompt: 'p', weight: 0 },
    ];
    const counts = distribution(vs, 1000);

    expect(counts['paused']).toBeUndefined();
    expect(counts['live']).toBe(1000);
  });
});

describe('selectVariant — 管理者のイレギュラーな設定操作', () => {
  it('負のweightを設定するとそのvariantは選ばれなくなる(入力ミスが無言で露出0になる)', () => {
    // 管理UIで 50 のつもりが -50 になった等。合計は正のままなので
    // 「weight合計<=0で先頭を返す」ガードにも掛からず、静かに露出0になる。
    const vs: PromptVariant[] = [
      { id: 'negative', name: 'neg', prompt: 'p', weight: -50 },
      { id: 'normal', name: 'norm', prompt: 'p', weight: 100 },
    ];
    const counts: Record<string, number> = {};
    for (let i = 0; i < 500; i++) {
      const id = selectVariant(vs, 'fallback', randomUUID()).variantId;
      if (id) counts[id] = (counts[id] ?? 0) + 1;
    }

    // 現状の仕様: 負weightのvariantは到達不能。例外も警告も出ない。
    expect(counts['negative']).toBeUndefined();
    expect(counts['normal']).toBe(500);
  });

  it('weightが全て0なら先頭variantにフォールバックする(無限ループや未定義を返さない)', () => {
    const vs: PromptVariant[] = [
      { id: 'first', name: 'f', prompt: 'pf', weight: 0 },
      { id: 'second', name: 's', prompt: 'ps', weight: 0 },
    ];
    const result = selectVariant(vs, 'fallback', 'any-session');

    expect(result.variantId).toBe('first');
    expect(result.prompt).toBe('pf');
  });

  it('既知の制約: variant配列を並び替えると同一セッションの割当が変わりうる', () => {
    // 累積walkは配列順に依存するため、内容が同じでも順序が変わると
    // 同じ stickyKey が別のvariantに落ちる。実験期間中に管理者が
    // variantの並びを入れ替えると、進行中セッションの割当が飛ぶ。
    // (variantの追加・削除では母集団自体が変わるため再シャッフルは不可避だが、
    //  「並び替えただけ」で飛ぶのは意図した挙動ではない。運用上の注意点として固定する)
    const A: PromptVariant = { id: 'a', name: 'A', prompt: 'pa', weight: 70 };
    const B: PromptVariant = { id: 'b', name: 'B', prompt: 'pb', weight: 30 };

    let flipped = 0;
    const sessions = Array.from({ length: 200 }, () => randomUUID());
    for (const s of sessions) {
      const before = selectVariant([A, B], 'fb', s).variantId;
      const after = selectVariant([B, A], 'fb', s).variantId;
      if (before !== after) flipped++;
    }

    // 並び替えは割当に影響する(0件ではない)。順序非依存にしたい場合は
    // selectVariant 側で id ソートしてから累積walkする必要がある。
    expect(flipped).toBeGreaterThan(0);
  });

  it('罠: stickyKeyが空文字だとstickyにならず乱数に落ちる(呼び出し元が空を渡してはいけない)', () => {
    // '' は falsy のため `stickyKey ? hash(...) : Math.random()` の else 側に落ちる。
    // つまり同一会話の中でメッセージ毎にvariantが振り直され、PR-13が塞いだはずの
    // CLAUDE.md 禁止36 が再発する。selectVariant 側では '' に意味のある固定値を
    // 与えられない(全セッションが同一variantに寄るだけ)ため、呼び出し元が '' を
    // 渡さないことが唯一の防御。src/api/chat/route.ts は trim() + || で '' を
    // 弾いており、その回帰テストは route.sessionId.test.ts にある。
    const seen = new Set<string | null>();
    for (let i = 0; i < 200; i++) {
      seen.add(selectVariant([variantA, variantB], 'fallback', '').variantId);
    }

    // sticky なら1種類に収まるはずだが、実際は両方出る = stickyでない
    expect(seen.size).toBeGreaterThan(1);
  });

  it('promptが空文字のvariantが選ばれてもfallbackで穴埋めせず、そのvariantを返す', () => {
    // 「空プロンプトのvariantを保存してしまった」ケース。ここで無言にfallbackへ
    // 差し替えると、variantIdは記録されるのに実際の応答は別プロンプト、という
    // 追跡不能な状態になる。variantIdと実プロンプトの対応は必ず保つ。
    const empty: PromptVariant = { id: 'empty', name: 'empty', prompt: '', weight: 100 };
    const result = selectVariant([empty], 'FALLBACK_PROMPT', 'sess');

    expect(result.variantId).toBe('empty');
    expect(result.prompt).toBe('');
  });
});
