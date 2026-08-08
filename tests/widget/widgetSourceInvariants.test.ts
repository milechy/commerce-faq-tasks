// tests/widget/widgetSourceInvariants.test.ts
//
// findScriptedAnswer.test.ts / animatedAvatarMode.test.ts は widget.js のロジックを
// "同一実装として抽出" してテストする方針（このリポジトリの既存 tests/widget/*.test.ts
// と同じ慣習）を取っているため、実ファイル側だけがリファクタで変わり、テスト側の
// コピーが古いまま緑になり続ける"ドリフト"を検知できない弱点がある。
//
// このファイルは実際に配布される public/widget.js のソーステキストを直接読み込み、
// コスト制御上・後方互換性上、絶対に壊れてはいけない不変条件を機械的にロックする。
// ロジックの中身までは検証しない（それは上記2ファイルの役目）が、
// 「該当コードが跡形もなく消えている／ガード条件が外されている」ような
// 破壊的な取り違えは確実に検知する。

import fs from 'fs';
import path from 'path';

const WIDGET_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../public/widget.js'),
  'utf8'
);

describe('public/widget.js ソース不変条件', () => {
  it('data-scripted-responses 属性を読み取っている', () => {
    expect(WIDGET_SRC).toMatch(/getAttribute\(\s*['"]data-scripted-responses['"]\s*\)/);
  });

  it('data-avatar-mode 属性を読み取っている', () => {
    expect(WIDGET_SRC).toMatch(/getAttribute\(\s*['"]data-avatar-mode['"]\s*\)/);
  });

  it('data-avatar-image-url 属性を読み取っている', () => {
    expect(WIDGET_SRC).toMatch(/getAttribute\(\s*['"]data-avatar-image-url['"]\s*\)/);
  });

  it('data-scripted-responses の JSON.parse は例外を握りつぶす（不正JSONでウィジェット全体を落とさない）', () => {
    expect(WIDGET_SRC).toMatch(/try\s*\{\s*scriptedResponses\s*=\s*JSON\.parse/);
  });

  it('findScriptedAnswer に空文字キーワードのガード（match-everythingリグレッション対策）が残っている', () => {
    expect(WIDGET_SRC).toMatch(/if\s*\(\s*!kw\s*\)\s*continue;/);
  });

  it('findScriptedAnswer に answer 未設定エントリのガード（undefinedバブル表示対策）が残っている', () => {
    expect(WIDGET_SRC).toMatch(/if\s*\(\s*!item\.answer\s*\)\s*continue;/);
  });

  it('cleanupLiveKit() が animated モード用の avatarPlaceholderImg もリセットする（destroy()後の状態残留対策）', () => {
    const m = WIDGET_SRC.match(/function cleanupLiveKit\(\) \{[\s\S]*?\n  \}/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain('removeAvatarPlaceholder();');
  });

  it('findScriptedAnswer はワイルドカード "*" 自体を優先度スキャン対象から除外している', () => {
    expect(WIDGET_SRC).toMatch(/kws\.indexOf\('\*'\)\s*!==\s*-1\)\s*continue;/);
  });

  it('avatarMode==="animated" のとき、事前フェッチ (トップレベル初期化) で fetchAvatarConfig を呼ばない分岐がある', () => {
    // if (avatarMode === 'animated') { showAnimatedAvatarPlaceholder(); } else if (apiKey) { fetchAvatarConfig(); }
    expect(WIDGET_SRC).toMatch(
      /avatarMode === 'animated'\s*\)\s*\{\s*showAnimatedAvatarPlaceholder\(\);\s*\}\s*\n\s*else if \(apiKey\) \{ fetchAvatarConfig\(\); \}/
    );
  });

  it('avatarMode==="animated" のとき、openPanel() 内でも fetchAvatarConfig を呼ばない分岐がある', () => {
    expect(WIDGET_SRC).toMatch(
      /if \(avatarMode === 'animated'\) \{[\s\S]{0,120}?showAnimatedAvatarPlaceholder\(\);/
    );
  });

  it('avatar-animated / avatar-animated-img-wrap / avatar-animated-ring の CSS クラスが定義されている', () => {
    expect(WIDGET_SRC).toContain("'.avatar-animated {'");
    expect(WIDGET_SRC).toContain("'.avatar-animated-img-wrap {'");
    expect(WIDGET_SRC).toContain("'.avatar-animated-ring {'");
  });

  it('セキュリティ原則: innerHTML を使用していない（アバター/定型応答レンダリングも含め textContent/createElement のみ）', () => {
    expect(WIDGET_SRC).not.toMatch(/\.innerHTML\s*=/);
  });

  it('LiveKit SDK の CDN 読み込み自体は温存されている（animatedモード非対応の既存顧客が壊れていないことの間接確認）', () => {
    expect(WIDGET_SRC).toContain('LIVEKIT_SDK_URL');
  });
});

// 設置位置（data-position / data-offset-x / data-offset-y）
//
// FAB は z-index に int 最大値を使うため、テナントサイト側の「トップへ戻る」ボタン等が
// 右下にあると、見えなくなるだけでなくクリック不能になる（=こちらが相手のサイトを壊す）。
// その唯一の逃げ道がこの属性なので、読み取り・丸め・CSSへの反映が消えていないことを固定する。
describe('public/widget.js 設置位置の不変条件', () => {
  it('data-position / data-offset-x / data-offset-y を読み取っている', () => {
    expect(WIDGET_SRC).toMatch(/getAttribute\(\s*['"]data-position['"]\s*\)/);
    expect(WIDGET_SRC).toMatch(/getAttribute\(\s*['"]data-offset-x['"]\s*\)/);
    expect(WIDGET_SRC).toMatch(/getAttribute\(\s*['"]data-offset-y['"]\s*\)/);
  });

  it('余白を 0〜320px に丸めている（画面外へ押し出してウィジェットを不可視にしない）', () => {
    expect(WIDGET_SRC).toMatch(/Math\.max\(\s*0\s*,\s*Math\.min\(\s*320\s*,\s*n\s*\)\s*\)/);
  });

  it('不正な data-position は既定の right にフォールバックする', () => {
    expect(WIDGET_SRC).toMatch(/===\s*'bottom-left'\s*\?\s*'left'\s*:\s*'right'/);
  });

  it('角と余白がハードコードに戻っていない（FAB・パネル・バブルの3要素すべて）', () => {
    // 3要素は position:fixed で画面の角に貼り付く唯一の要素。ここが定数に戻ると設定が効かなくなる。
    expect(WIDGET_SRC).not.toMatch(/'\s*(bottom|right):\s*24px;'/);
    expect(WIDGET_SRC).not.toMatch(/'\s*bottom:\s*(132|152)px;'/);
    expect(WIDGET_SRC).toContain('--offset-x');
    expect(WIDGET_SRC).toContain('--offset-y');
    // バブル・パネルは FAB(120px) を基準にした相対配置を保つ
    expect(WIDGET_SRC).toContain('calc(var(--offset-y) + 128px)');
    expect(WIDGET_SRC).toContain('calc(var(--offset-y) + 108px)');
  });

  it('パネル高さが offset-y に追随する（定数に戻すと offset を上げた分だけ画面上端からはみ出す）', () => {
    expect(WIDGET_SRC).toContain('calc(100vh - var(--offset-y) - 124px)');
    expect(WIDGET_SRC).not.toContain('calc(100vh - 120px)');
  });

  it('モバイル全画面表示が left / right の両方を打ち消している（bottom-left 時に画面外へはみ出さない）', () => {
    expect(WIDGET_SRC).toMatch(/left:\s*0\s*!important;\s*right:\s*0\s*!important;/);
  });
});

describe('public/widget.min.js が壊れたビルド成果物になっていない', () => {
  // 当初は「特定の文字列(data-scripted-responses 等)が難読化後も残っているか」で
  // ビルド忘れを検知しようとしたが、javascript-obfuscator の文字列配列抽出は実行の
  // たびに異なる分割をするため、同じ入力でも生存する部分文字列が毎回変わる
  // （実測: 同一 widget.js を3回連続ビルドしても "data-scripted-responses" の
  // 生存/消失が 1回目:生存, 2回目:消失, 3回目:消失 とばらついた）。
  // これはビルド忘れの検知ではなくobfuscatorの乱数を検証してしまう偽陽性の温床だったため撤去し、
  // 代わりに「ビルド成果物が構文的に壊れていないか」という決定的な性質だけを検証する。
  const minSrc = fs.readFileSync(
    path.resolve(__dirname, '../../public/widget.min.js'),
    'utf8'
  );

  it('widget.min.js が空でない', () => {
    expect(minSrc.length).toBeGreaterThan(1000);
  });

  it('widget.min.js が構文的に有効なJavaScriptである（実行はしない — document等が無いnode環境のため）', () => {
    const vm = require('vm');
    expect(() => new vm.Script(minSrc)).not.toThrow();
  });
});
