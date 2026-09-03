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

// アバターセッションの keep-alive / 復活（2026-08-09）
//
// 33秒非アクティブ折りたたみタイマー(AVATAR_INACTIVITY_MS)は #424→#740→#742 と
// 3度の周辺修正でも再発し、PR #743 で機構ごと削除した(CLAUDE.md 禁止事項19)。
// 続くPRで「パネルを開いて見ている間に無操作が続くとLemonSlice側のidle_timeoutで
// セッションが切れ、メッセージを送っても音声・リップシンクが復活しない」症状に対応した。
// ここではその再発防止を機械的にロックする。
describe('public/widget.js アバターセッション keep-alive / 復活の不変条件', () => {
  it('33秒非アクティブ折りたたみタイマーが復活していない（禁止事項19の機械化）', () => {
    expect(WIDGET_SRC).not.toMatch(/AVATAR_INACTIVITY_MS/);
    expect(WIDGET_SRC).not.toMatch(/avatarInactivityTimer/);
    expect(WIDGET_SRC).not.toMatch(/resetAvatarInactivityTimer/);
  });

  it('パネル表示中ハートビートは document.hidden の間は送らない（タブを隠せば課金が止まる設計を保つ）', () => {
    const m = WIDGET_SRC.match(/function startVisibleHeartbeat\(\) \{[\s\S]*?\n  \}/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/if\s*\(\s*document\.hidden\s*\)\s*return;/);
  });

  it('openPanel/closePanel が表示中ハートビートの開始/停止を呼んでいる', () => {
    expect(WIDGET_SRC).toMatch(/startVisibleHeartbeat\(\);/);
    expect(WIDGET_SRC).toMatch(/stopVisibleHeartbeat\(\);/);
  });

  it('LemonSlice アバター離脱時に avatarSessionDead が立つ（TrackUnsubscribed video）', () => {
    const m = WIDGET_SRC.match(/RoomEvent\.TrackUnsubscribed[\s\S]*?if \(track\.kind === 'video'\) \{[\s\S]*?\n(?:.*\n)*?\s*\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/avatarSessionDead\s*=\s*true;/);
  });

  it('新しい映像到着時に avatarSessionDead が解除される（TrackSubscribed video）', () => {
    const m = WIDGET_SRC.match(/RoomEvent\.TrackSubscribed[\s\S]*?if \(track\.kind === 'video'\) \{[\s\S]*?\n(?:.*\n)*?\s*fabVideoEl = videoEl;/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/avatarSessionDead\s*=\s*false;/);
  });

  it('既存Room再利用の判定が avatarSessionDead を確認している（3箇所: connectLiveKit / cleanup後再開 / openPanel）', () => {
    const occurrences = WIDGET_SRC.match(/window\.__rajiuceRoom\.state === 'connected' && !avatarSessionDead/g) || [];
    expect(occurrences.length).toBeGreaterThanOrEqual(3);
  });

  it('sendMessage は avatarSessionDead のとき sendTTSRequest ではなく connectLiveKit で復活を試みる', () => {
    const m = WIDGET_SRC.match(/if \(avatarProvider === 'lemonslice' && lkRoom && lkRoom\.localParticipant && avatarSessionDead\) \{[\s\S]*?\n\s*\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain('connectLiveKit();');
    expect(m![0]).not.toContain('sendTTSRequest(');
  });

  it('ミュート解除は muted フラグの切替だけでなく startAudio() と play() 再試行で再生を復旧する', () => {
    // 音声トラックの play() はユーザー操作の文脈外（トラック到着時）で走るため
    // 自動再生ポリシーに拒否されて paused のまま止まることがある
    // （実測: muted=true, paused=true, readyState=4, advancing=false）。
    // muted 切替だけに戻すと「ミュート解除しても無音」が再発する。
    expect(WIDGET_SRC).toMatch(/if \(!avatarMuted\) \{[\s\S]*?startAudio[\s\S]*?\.paused[\s\S]*?\.play\(\)/);
  });

  it('自動再生ブロックの可観測性: AudioPlaybackStatusChanged を DIAG ログに出している', () => {
    expect(WIDGET_SRC).toMatch(/AudioPlaybackStatusChanged[\s\S]{0,300}?canPlaybackAudio/);
  });

  // G6: _tracker が未初期化(非同期初期化のレース)でも r2c_vid を直読みして
  // visitor_id を送る。this がフォールバックを持たないと初回1通の結合が
  // 常に欠落する(学習ループ要件定義 G6)。
  it('/api/chat 送信時、_tracker 未初期化なら localStorage の r2c_vid に直読みフォールバックする', () => {
    const m = WIDGET_SRC.match(/var chatVisitorId[\s\S]{0,500}?visitor_id: chatVisitorId,/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/localStorage\.getItem\(\s*['"]r2c_vid['"]\s*\)/);
  });
});

describe('public/widget.min.js は撤去済み（再発防止）', () => {
  // 2026-08-29発覚: widget.min.js(javascript-obfuscatorによる難読化ビルド)は
  // SCRIPTS/build-widget.sh を呼ぶ経路がどこにも無く、PR #871 以降誰も再ビルドしないまま
  // 本番で200を返し続けていた(#1039/#1060の変更も未反映)。難読化の狙いは同一ロジックが
  // /widget.js として平文で配信されているため元々無意味で、かつ obfuscator の出力は
  // ビルドごとに変わるため widget.js との一致を機械的に固定できない(このファイルが
  // 過去に試みて撤去した経緯は git log 参照)。よって復活させず、撤去されたままであることと
  // /widget.min.js が最新の /widget.js へリダイレクトされることをロックする。
  it('public/widget.min.js が存在しない', () => {
    const minPath = path.resolve(__dirname, '../../public/widget.min.js');
    expect(fs.existsSync(minPath)).toBe(false);
  });

  it('SCRIPTS/build-widget.sh が存在しない（呼び出し元の無い生成スクリプトを復活させない）', () => {
    const buildScriptPath = path.resolve(__dirname, '../../SCRIPTS/build-widget.sh');
    expect(fs.existsSync(buildScriptPath)).toBe(false);
  });

  it('/widget.min.js へのアクセスを /widget.js へ301リダイレクトする経路が src/index.ts にある', () => {
    const indexSrc = fs.readFileSync(path.resolve(__dirname, '../../src/index.ts'), 'utf8');
    expect(indexSrc).toMatch(
      /app\.get\(\s*['"]\/widget\.min\.js['"]\s*,\s*\(_req,\s*res\)\s*=>\s*res\.redirect\(\s*301\s*,\s*['"]\/widget\.js['"]\s*\)\s*\)/,
    );
  });
});

// PR-C: free_ad プランの月次上限(403 plan_upgrade_required)をエラー表示で
// 誤描画しない不変条件(CLAUDE.md 絶対にやってはいけないこと21・禁止11)。
describe('public/widget.js free_adプラン月次上限の不変条件', () => {
  it('plan_upgrade_required を通信エラー(showError/赤帯)とは別経路で扱っている', () => {
    expect(WIDGET_SRC).toMatch(/err\s*&&\s*err\.code\s*===\s*['"]plan_upgrade_required['"]/);
  });

  it('plan_upgrade_required の分岐は showError を呼ばずに return している（赤帯にしない）', () => {
    const match = WIDGET_SRC.match(
      /if\s*\(\s*err\s*&&\s*err\.code\s*===\s*['"]plan_upgrade_required['"]\s*\)\s*\{([\s\S]*?)\n\s{8}\}/
    );
    expect(match).not.toBeNull();
    const branchBody = match ? match[1] : '';
    expect(branchBody).not.toMatch(/showError\(/);
    expect(branchBody).toMatch(/return;/);
  });

  it('同一会話(ウィジェットインスタンス)につき1回だけ表示するフラグを持つ', () => {
    expect(WIDGET_SRC).toMatch(/var\s+freeAdQuotaMessageShown\s*=\s*false;/);
    expect(WIDGET_SRC).toMatch(/if\s*\(\s*!freeAdQuotaMessageShown\s*\)/);
    expect(WIDGET_SRC).toMatch(/freeAdQuotaMessageShown\s*=\s*true;/);
  });

  it('サーバのエラー本文(message)をアシスタント発言として表示する経路がある', () => {
    expect(WIDGET_SRC).toMatch(/err\.serverMessage/);
  });
});

// PR-B/PR-C: バッジ描画判定・上限メッセージ判定は tests/widget/freeAdBadgeLogic.test.ts で
// 抽出ロジックとして網羅的にテストしている。ここではその契約(=同一の条件式)が
// 実ファイル側から乖離していないことだけを固定する(findScriptedAnswer.test.ts と同じ二層構成)。
describe('public/widget.js バッジ描画条件 — 抽出ロジックとの契約(freeAdBadgeLogic.test.ts)', () => {
  it('バッジは showBrandingBadge && badgeUrl の両方が真のときだけ描画する', () => {
    expect(WIDGET_SRC).toMatch(/if\s*\(\s*showBrandingBadge\s*&&\s*badgeUrl\s*\)\s*\{/);
  });

  it('showBrandingBadge の既定値は fail-safe で true 側(!== false)に倒れる', () => {
    expect(WIDGET_SRC).toMatch(/showBrandingBadge\s*=\s*_rajiuceTenantCfg\.showBrandingBadge\s*!==\s*false;/);
  });

  it('badgeUrl 未注入(静的埋め込み等)では null になり、descriptionどおり描画されない', () => {
    expect(WIDGET_SRC).toMatch(/badgeUrl\s*=\s*_rajiuceTenantCfg\.badgeUrl\s*\|\|\s*null;/);
  });

  it('バッジのクリックは _tracker が未初期化(null)でも例外を投げないガードを持つ', () => {
    expect(WIDGET_SRC).toMatch(/if\s*\(\s*_tracker\s*\)\s*_tracker\.track\(\s*['"]branding_badge_click['"]/);
  });

  it('バッジリンクに rel="nofollow sponsored noopener" があり、noreferrer は含まない（link scheme対策・流入計測維持）', () => {
    const match = WIDGET_SRC.match(/rel:\s*['"]([^'"]+)['"]/);
    expect(match).not.toBeNull();
    const rel = match ? match[1] : '';
    expect(rel).toContain('nofollow');
    expect(rel).toContain('sponsored');
    expect(rel).toContain('noopener');
    expect(rel).not.toContain('noreferrer');
  });

  // AD-2: free_ad プラン限定の広告帯。バッジと排他で、広告帯が優先される。
  describe('R2C自身の広告帯(free_ad限定) — 抽出ロジックとの契約(freeAdBadgeLogic.test.ts)', () => {
    it('広告帯は showAdPromo && adPromoUrl の両方が真のときだけ描画し、バッジとは else if で排他になっている', () => {
      expect(WIDGET_SRC).toMatch(
        /if\s*\(\s*showAdPromo\s*&&\s*adPromoUrl\s*\)\s*\{[\s\S]*?\}\s*else if\s*\(\s*showBrandingBadge\s*&&\s*badgeUrl\s*\)\s*\{/
      );
    });

    it('showAdPromo の既定値は fail-safe で false 側(=== true)に倒れる(showBrandingBadgeと逆向き)', () => {
      expect(WIDGET_SRC).toMatch(/showAdPromo\s*=\s*_rajiuceTenantCfg\.showAdPromo\s*===\s*true;/);
    });

    it('adPromoUrl 未注入では null になり描画されない', () => {
      expect(WIDGET_SRC).toMatch(/adPromoUrl\s*=\s*_rajiuceTenantCfg\.adPromoUrl\s*\|\|\s*null;/);
    });

    it('widgetGeneratorの既定値は showBrandingBadge(true側)と逆で、false/nullに倒れる', () => {
      expect(WIDGET_SRC).not.toMatch(/adPromoUrl\s*=\s*_rajiuceTenantCfg\.adPromoUrl\s*\?\?\s*true/);
    });

    it('広告帯のクリックは _tracker が未初期化(null)でも例外を投げないガードを持つ', () => {
      expect(WIDGET_SRC).toMatch(/if\s*\(\s*_tracker\s*\)\s*_tracker\.track\(\s*['"]ad_promo_click['"]/);
    });

    // openPanel()はパネル開閉のたびに呼ばれるため、フラグ無しだと同一セッション内で
    // 開き直すたびにインプレッションが重複計上され、CTRの分母が歪む(AD-4の判断材料が歪む)。
    // _abExposureSentと同じ「送信済みフラグ」パターンで1セッション1回に絞る。
    it('広告帯インプレッションは1セッション1回に絞る送信済みフラグ(_adPromoImpressionSent)を持つ', () => {
      expect(WIDGET_SRC).toMatch(/var\s+_adPromoImpressionSent\s*=\s*false;/);
      expect(WIDGET_SRC).toMatch(
        /if\s*\(\s*!_adPromoImpressionSent\s*&&\s*showAdPromo\s*&&\s*adPromoUrl\s*&&\s*_tracker\s*\)\s*\{/
      );
      expect(WIDGET_SRC).toMatch(/_adPromoImpressionSent\s*=\s*true;/);
    });

    it('インプレッション送信条件に _tracker が含まれ、未初期化の間はフラグを立てずに次回開いたときへ持ち越す', () => {
      const idx = WIDGET_SRC.indexOf('_adPromoImpressionSent = true;');
      expect(idx).toBeGreaterThan(-1);
      const before = WIDGET_SRC.slice(Math.max(0, idx - 300), idx);
      // フラグを立てる直前のif条件に _tracker が入っている(未初期化=falsyならフラグを立てない)
      expect(before).toMatch(/&&\s*_tracker\s*\)\s*\{\s*$/);
    });

    it('広告帯リンクにも rel="nofollow sponsored noopener" が付与されている（link scheme対策）', () => {
      const matches = [...WIDGET_SRC.matchAll(/rel:\s*['"]([^'"]+)['"]/g)];
      expect(matches.length).toBeGreaterThanOrEqual(2);
      matches.forEach((m) => {
        expect(m[1]).toContain('nofollow');
        expect(m[1]).toContain('sponsored');
        expect(m[1]).toContain('noopener');
        expect(m[1]).not.toContain('noreferrer');
      });
    });

    it('広告帯とバッジの CSS が別クラス(.r2c-ad-promo / .r2c-badge)で定義され、min-height 44px のタップ領域を維持する', () => {
      expect(WIDGET_SRC).toMatch(/'\.r2c-ad-promo \{'/);
      expect(WIDGET_SRC).toMatch(/'\.r2c-ad-promo a \{'/);
      const idx = WIDGET_SRC.indexOf("'.r2c-ad-promo a {'");
      const block = WIDGET_SRC.slice(idx, idx + 400);
      expect(block).toMatch(/min-height:\s*44px/);
    });

    it('確定文言(見出し/CTA)が変わっていない', () => {
      expect(WIDGET_SRC).toContain('このAI接客は R2C で作れます');
      expect(WIDGET_SRC).toContain('無料で試す');
    });
  });

  // E3b: お客様の回答評価(👍👎)。要件Rj/F5。
  describe('answer_feedback (回答評価)', () => {
    it('event_tracking とは独立に判定している(event_trackingが無効でも動く)', () => {
      // answer_feedback の判定は event_tracking の早期returnより前にある
      const idx1 = WIDGET_SRC.indexOf("cfg.answer_feedback === false");
      const idx2 = WIDGET_SRC.indexOf('if (!cfg.event_tracking) return;');
      expect(idx1).toBeGreaterThan(-1);
      expect(idx2).toBeGreaterThan(-1);
      expect(idx1).toBeLessThan(idx2);
    });

    it('既定は有効(D1)。fetch失敗時に無効化するコードが無い', () => {
      // 唯一の無効化条件は明示 false のときだけ
      expect(WIDGET_SRC).toMatch(/if\s*\(cfg\.answer_feedback === false\)\s*_answerFeedbackEnabled = false;/);
      // 変数宣言時点の既定値
      expect(WIDGET_SRC).toMatch(/var _answerFeedbackEnabled = true;/);
    });

    it('AI回答テキストと構造的に分離したDOMに描画している(bubbleのtextContentに混ぜない)', () => {
      // buildFeedbackRow は bubble とは別要素として inner に append される。
      // 呼び出しの引数(msg.id / msg.messageId || msg.id 等)は実装都合で変わりうるため、
      // ここでは引数を固定せず「inner.appendChild(buildFeedbackRow(」という
      // 呼び出し構造そのものを検出する(是正4-2で msg.messageId || msg.id に変更されている)。
      const callMatch = WIDGET_SRC.match(/inner\.appendChild\(buildFeedbackRow\(/);
      expect(callMatch).not.toBeNull();
      const idx = callMatch ? (callMatch.index as number) : -1;
      expect(idx).toBeGreaterThan(-1);
      // 本体: bubble.textContent = msg.content; がこの呼び出しより前に存在すること
      // (= bubble のテキストは先に確定済みで、buildFeedbackRow の結果はそこに混ぜ込まれていない)
      const before = WIDGET_SRC.slice(Math.max(0, idx - 1400), idx);
      expect(before).toMatch(/bubble\.textContent = msg\.content;/);
      // 混入禁止: buildFeedbackRow の戻り値が bubble 自体に append/挿入されていないこと
      expect(WIDGET_SRC).not.toMatch(/bubble\.appendChild\(buildFeedbackRow\(/);
      expect(WIDGET_SRC).not.toMatch(/bubble\.textContent\s*[+]?=\s*buildFeedbackRow\(/);
    });

    it('system: true が付いた assistant メッセージ(通知・声がけ)には出さない', () => {
      expect(WIDGET_SRC).toMatch(/msg\.role === 'assistant' && !msg\.system && _answerFeedbackEnabled/);
    });

    it('送信は event_tracking の EventTracker に依存しない独立経路を使う(keepalive付き)', () => {
      const fnMatch = WIDGET_SRC.match(/function sendAnswerFeedback\(messageRef, rating\) \{[\s\S]{0,900}/);
      expect(fnMatch).not.toBeNull();
      const body = fnMatch ? fnMatch[0] : '';
      expect(body).toMatch(/event_type:\s*'answer_feedback'/);
      expect(body).toMatch(/rating:\s*rating/);
      expect(body).toMatch(/message_ref:\s*messageRef/);
      expect(body).toMatch(/keepalive:\s*true/);
    });

    it('連打しても同じ評価では再送信しない(最後の1つに収束)', () => {
      expect(WIDGET_SRC).toMatch(/if\s*\(_feedbackGiven\[messageRef\] === rating\)\s*return;/);
    });

    it('👎の後にエスカレーションの状態(escalated/pending)やボタン文言を変更しない', () => {
      const idx = WIDGET_SRC.indexOf("rating === 'down'");
      expect(idx).toBeGreaterThan(-1);
      const block = WIDGET_SRC.slice(idx, idx + 400);
      expect(block).not.toMatch(/setEscalateBtnState/);
      expect(block).toMatch(/feedback-hint/);
    });
  });
});

// S5a(「D1・D5決定案」): 消費者向けデータ共有開示バナー
describe('public/widget.js — S5a データ共有開示バナー', () => {
  it('consent-banner は非表示で作成される(displayをnoneで初期化)', () => {
    const idx = WIDGET_SRC.indexOf("className: 'consent-banner'");
    expect(idx).toBeGreaterThan(-1);
    const block = WIDGET_SRC.slice(idx, idx + 200);
    expect(block).toMatch(/consentBanner\.style\.display = 'none';/);
  });

  it('data_shared_externally かつ 未同意のときだけバナーを表示する(event_trackingとは独立)', () => {
    // answer_feedback と同じく event_tracking の早期returnより前で評価されていること
    // (event_tracking=falseのテナントでも開示が必要なため)。
    const earlyReturnIdx = WIDGET_SRC.indexOf('if (!cfg.event_tracking) return;');
    expect(earlyReturnIdx).toBeGreaterThan(-1);
    const before = WIDGET_SRC.slice(Math.max(0, earlyReturnIdx - 300), earlyReturnIdx);
    expect(before).toMatch(/cfg\.data_shared_externally\s*&&\s*!hasConsentAck\(\)/);
  });

  it('同意はテナントごとにlocalStorageへ記録し、以後は表示しない(hasConsentAck)', () => {
    expect(WIDGET_SRC).toMatch(/function hasConsentAck\(\)\s*\{[\s\S]{0,150}localStorage\.getItem\(consentAckKey\(\)\)/);
    expect(WIDGET_SRC).toMatch(/function consentAckKey\(\)\s*\{[\s\S]{0,80}tenantId/);
  });

  it('同意ボタンのクリックでバナーを閉じ、localStorageに記録する', () => {
    const idx = WIDGET_SRC.indexOf('consentAckBtn.addEventListener');
    expect(idx).toBeGreaterThan(-1);
    const block = WIDGET_SRC.slice(idx, idx + 250);
    expect(block).toMatch(/consentBanner\.style\.display = 'none';/);
    expect(block).toMatch(/localStorage\.setItem\(consentAckKey\(\), '1'\);/);
  });

  it('セキュリティ原則: 開示バナーもinnerHTMLを使わずel()/createElementで構築している', () => {
    const idx = WIDGET_SRC.indexOf("className: 'consent-banner'");
    expect(idx).toBeGreaterThan(-1);
    const block = WIDGET_SRC.slice(Math.max(0, idx - 500), idx + 100);
    expect(block).not.toMatch(/\.innerHTML\s*=/);
  });
});

// S6(共有学習プールの参加モデル・fail-open是正): /api/chatバックストップと
// サーバ解決済みtenantIdの反映が実ソースから消えていないことを機械的に検知する。
describe('public/widget.js — S6 開示バナーのfail-open是正', () => {
  it('/api/chat応答のdata_shared_externallyでもバナーを出す分岐がある(featuresの取得失敗をバックストップする)', () => {
    const idx = WIDGET_SRC.indexOf("_resolvedTenantId = json.data.tenantId");
    expect(idx).toBeGreaterThan(-1);
    const block = WIDGET_SRC.slice(idx, idx + 500);
    expect(block).toMatch(/json\.data\s*&&\s*json\.data\.data_shared_externally\s*&&\s*!hasConsentAck\(\)/);
  });

  it('/api/chat応答のtenantIdを_resolvedTenantIdへ反映する処理が、バックストップ判定より前にある', () => {
    const idx = WIDGET_SRC.indexOf("_resolvedTenantId = json.data.tenantId");
    expect(idx).toBeGreaterThan(-1);
    const block = WIDGET_SRC.slice(idx, idx + 500);
    const tenantIdIdx = block.indexOf('_resolvedTenantId = json.data.tenantId');
    const backstopIdx = block.indexOf('data_shared_externally && !hasConsentAck()');
    expect(tenantIdIdx).toBe(0);
    expect(backstopIdx).toBeGreaterThan(-1);
    expect(tenantIdIdx).toBeLessThan(backstopIdx);
  });

  it('/api/widget/features応答のtenant_idも_resolvedTenantIdへ反映し、hasConsentAck()の判定より前にある', () => {
    const idx = WIDGET_SRC.indexOf('_resolvedTenantId = cfg.tenant_id');
    expect(idx).toBeGreaterThan(-1);
    const block = WIDGET_SRC.slice(idx, idx + 500);
    const bannerIdx = block.indexOf('!hasConsentAck()');
    expect(bannerIdx).toBeGreaterThan(-1);
  });

  it('consentAckKey() は _resolvedTenantId(サーバ解決値) を data-tenant属性より優先する', () => {
    expect(WIDGET_SRC).toMatch(/function consentAckKey\(\)\s*\{[\s\S]{0,80}_resolvedTenantId \|\| tenantId \|\| 'unknown'/);
  });

  // 2026-08-29 の本番障害の再発防止。
  // #1039(free_ad広告帯)が `var _abExposureSent = false;` の行を差し替えで消し、
  // 参照(recordAbExposure内)だけが残った。結果 sendMessage() が ReferenceError で
  // 停止し、全テナントのチャットが「送信しても何も起きない」状態になった。
  // 静的な no-undef は pnpm lint:widget が担うが、宣言の消失は不変条件としても固定する。
  it('_abExposureSent は参照より前にモジュールスコープで宣言されている', () => {
    const declIdx = WIDGET_SRC.indexOf('var _abExposureSent = false;');
    expect(declIdx).toBeGreaterThan(-1);
    const refIdx = WIDGET_SRC.indexOf('if (_abExposureSent ||');
    expect(refIdx).toBeGreaterThan(declIdx);
  });

  it('sendMessage() からの recordAbExposure() 呼び出しは try/catch で握りつぶす(計測でチャットを止めない)', () => {
    expect(WIDGET_SRC).toMatch(/try\s*\{\s*recordAbExposure\(\);\s*\}\s*catch/);
  });

  // ページ除外設定(excluded_page_patterns)は、DOM構築・SDK読み込み・fetchより前に
  // 同期判定する必要がある(チラつきと除外ページでの不要通信を防ぐため)。
  it('ページ除外判定は data-tenant ガードの直後・PostHog SDK読み込みより前に存在する', () => {
    const guardIdx = WIDGET_SRC.indexOf("data-tenant 属性が必要です");
    const excludeIdx = WIDGET_SRC.indexOf('excludedPagePatterns[_excludeIdx]');
    const posthogIdx = WIDGET_SRC.indexOf("phScript.src = 'https://eu-assets.i.posthog.com");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(excludeIdx).toBeGreaterThan(guardIdx);
    expect(posthogIdx).toBeGreaterThan(excludeIdx);
  });

  // グロブ構文の実装が2箇所に割れると「保存できたが効かない」事故になる。
  // TriggerEngine._matchPathname はトップレベルの matchPathnameGlob() へ委譲しているだけで、
  // 正規表現の組み立てロジックを重複して持っていないことを固定する。
  it('TriggerEngine._matchPathname は matchPathnameGlob() へ委譲している(グロブ構文の二重実装防止)', () => {
    expect(WIDGET_SRC).toMatch(
      /TriggerEngine\.prototype\._matchPathname = function \(pathname, pattern\) \{\s*return matchPathnameGlob\(pathname, pattern\);\s*\};/
    );
  });
});
