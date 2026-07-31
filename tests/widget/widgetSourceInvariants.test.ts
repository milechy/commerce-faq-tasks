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

describe('public/widget.min.js がソース変更に追随してビルドされている', () => {
  // mtime 比較は git checkout/clone 直後に全ファイルの時刻が揃ってしまい CI では
  // 意味をなさないため使わない。代わりに、difuscator(javascript-obfuscator) を通しても
  // 実際に生き残ることを確認済みの識別子が widget.min.js に含まれているかで
  // 「widget.js を編集した後に build-widget.sh を実行し忘れた」を検知する。
  // 注意: javascript-obfuscator は文字列を配列抽出・分割することがあり、
  // 生存する文字列は保証されない（"data-avatar-mode" は分断されて消える一方、
  // "data-scripted-responses" や "avatar-animated" はまとまって残ることを実測確認済み）。
  // 新しい識別子を追加する場合は widget.min.js を実際に grep して生存確認すること。
  const minSrc = fs.readFileSync(
    path.resolve(__dirname, '../../public/widget.min.js'),
    'utf8'
  );

  it('data-scripted-responses 相当の文字列が難読化後も残っている', () => {
    expect(minSrc).toContain('data-scripted-responses');
  });

  it('avatar-animated（アニメアバターCSSクラス）相当の文字列が難読化後も残っている', () => {
    expect(minSrc).toContain('avatar-animated');
  });
});
