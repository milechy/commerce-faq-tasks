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
