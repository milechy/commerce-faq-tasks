// src/api/admin/tuning/triggerMatching.test.ts

import { matchesTriggerPattern, getMatchingKeywords, splitTriggerKeywords } from './triggerMatching';

describe('splitTriggerKeywords — 区切り文字', () => {
  it('半角カンマで分割する', () => {
    expect(splitTriggerKeywords('保証,返品')).toEqual(['保証', '返品']);
  });

  it('全角カンマで分割する(D1: 以前は1個のキーワード扱いで永久に不一致だった)', () => {
    expect(splitTriggerKeywords('保証，返品')).toEqual(['保証', '返品']);
  });

  it('読点(、)で分割する(D1: 日本語として最も自然な区切り)', () => {
    expect(splitTriggerKeywords('保証、返品')).toEqual(['保証', '返品']);
  });

  it('区切り文字が混在していても分割する', () => {
    expect(splitTriggerKeywords('保証、返品,送料')).toEqual(['保証', '返品', '送料']);
  });

  it('前後の空白を除去する', () => {
    expect(splitTriggerKeywords(' 保証 、 返品 ')).toEqual(['保証', '返品']);
  });

  it('空要素は除去する(連続区切り・先頭末尾の区切り)', () => {
    expect(splitTriggerKeywords('保証、、返品、')).toEqual(['保証', '返品']);
  });

  it('空文字列は空配列を返す', () => {
    expect(splitTriggerKeywords('')).toEqual([]);
  });

  it('区切り文字を含まない単一キーワードはそのまま1件になる', () => {
    expect(splitTriggerKeywords('保証')).toEqual(['保証']);
  });

  // 壊れやすいポイント: 区切り文字だけ・空白だけの入力で例外を投げたり
  // 意図しない挙動(空文字列がキーワードとして残る等)にならないこと。
  it('区切り文字と空白だけの入力は空配列になる(例外を投げない)', () => {
    expect(splitTriggerKeywords('、,　、 , ')).toEqual([]);
  });

  it('全角スペースのみのキーワードは除去される', () => {
    expect(splitTriggerKeywords('保証、　、返品')).toEqual(['保証', '返品']);
  });
});

describe('matchesTriggerPattern — 表記ゆれ吸収(D2)', () => {
  it('完全一致する', () => {
    expect(matchesTriggerPattern('保証について教えて', '保証')).toBe(true);
  });

  it('全角カンマ区切りのキーワードが質問文にあれば発火する(D1の回帰)', () => {
    expect(matchesTriggerPattern('保証について教えて', '保証，返品')).toBe(true);
    expect(matchesTriggerPattern('返品したいです', '保証，返品')).toBe(true);
  });

  it('読点区切りのキーワードが質問文にあれば発火する(D1の回帰)', () => {
    expect(matchesTriggerPattern('保証について教えて', '保証、返品')).toBe(true);
  });

  it('ひらがな⇔カタカナの表記ゆれで一致する', () => {
    expect(matchesTriggerPattern('ホショウについて教えて', '保証')).toBe(false); // 漢字とカタカナは別表記なので不一致(想定どおり)
    expect(matchesTriggerPattern('ほしょうについて教えて', 'ホショウ')).toBe(true); // かな⇔カナは一致
    expect(matchesTriggerPattern('ホショウについて教えて', 'ほしょう')).toBe(true);
  });

  it('全角英数字と半角英数字の表記ゆれで一致する', () => {
    expect(matchesTriggerPattern('ＳＮＳ運用について', 'SNS')).toBe(true);
    expect(matchesTriggerPattern('SNS運用について', 'ＳＮＳ')).toBe(true);
  });

  it('大文字小文字の表記ゆれで一致する', () => {
    expect(matchesTriggerPattern('ABCで困っています', 'abc')).toBe(true);
  });

  it('質問文にキーワードが含まれなければ不一致', () => {
    expect(matchesTriggerPattern('営業時間を教えて', '保証、返品')).toBe(false);
  });

  it('空のtrigger_patternは常に不一致(既存仕様どおり)', () => {
    expect(matchesTriggerPattern('保証について教えて', '')).toBe(false);
  });

  it('「（常時適用）」は特別扱いせず、文字列として不一致になる(D4はsave側で防ぐ別スコープ)', () => {
    expect(matchesTriggerPattern('保証について教えて', '（常時適用）')).toBe(false);
  });

  // 壊れやすいポイント: 濁点・半濁点が分解済み(結合文字)で入力された場合。
  // 一部のIME・コピー元テキストでは「カ」+結合濁点(U+3099)のように分解された
  // 形で渡ってくることがあり、合成済みの「ガ」と見た目は同じでも文字列としては
  // 別物になる。NFKCで正規化されず取りこぼすと「表記ゆれで発火しない」バグの
  // 再発になる。
  it('濁点が分解済み(結合文字)でも合成済みの表記と一致する', () => {
    const decomposed = 'カ' + '゙'; // 結合濁点
    expect(matchesTriggerPattern(`${decomposed}ラス代を教えて`, 'ガラス')).toBe(true);
  });

  // 壊れやすいポイント: 1文字キーワードは質問文のほぼ何にでも部分一致してしまう
  // (「の」「に」等の助詞1文字を誤ってトリガーに登録すると常時発火に近くなる)。
  // これはバグではなく仕様上の限界だが、想定どおりの挙動であることを固定し、
  // 将来UI側で「1文字トリガーは警告する」等の対策を検討する際の基準にする。
  it('1文字キーワードは無関係な質問文にも部分一致する(過剰マッチのリスクを明示)', () => {
    expect(matchesTriggerPattern('今日の営業時間を教えてください', '日')).toBe(true);
  });

  // 壊れやすいポイント: 同じキーワードが区切り文字で重複登録された場合
  // (例: 「保証,保証」)、判定自体はboolean一つなので壊れないが、
  // getMatchingKeywords が可視化用に重複したまま返すと下書きカードの表示が
  // 「保証・保証」のように重複して見える。現状の実装(フィルタなし)を固定する。
  it('trigger_patternにキーワードが重複していても判定は壊れない', () => {
    expect(matchesTriggerPattern('保証について教えて', '保証,保証')).toBe(true);
  });
});

describe('getMatchingKeywords — 可視化用の発火キーワード抽出', () => {
  it('発火したキーワードのみを返す', () => {
    expect(getMatchingKeywords('保証について教えて', '保証、返品、送料')).toEqual(['保証']);
  });

  it('複数のキーワードが同時に発火する場合は全件返す', () => {
    expect(getMatchingKeywords('保証と返品について教えて', '保証、返品')).toEqual(['保証', '返品']);
  });

  it('発火しない場合は空配列を返す', () => {
    expect(getMatchingKeywords('営業時間を教えて', '保証、返品')).toEqual([]);
  });

  // 現状の実装は重複除去をしていない。将来この関数を下書きカードの
  // 「発火する聞かれ方の例」表示に使う場合、呼び出し側で重複表示に
  // ならないようにする必要があることをテストで明示しておく。
  it('trigger_patternにキーワードが重複していると重複したまま返る(重複除去はしない仕様)', () => {
    expect(getMatchingKeywords('保証について教えて', '保証,保証')).toEqual(['保証', '保証']);
  });
});
