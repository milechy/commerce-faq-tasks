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
});
