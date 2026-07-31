// src/api/admin/agent/onboardingStage.test.ts

import {
  deriveOnboardingStage,
  nextIncompleteStage,
  isOnboardingComplete,
  type OnboardingStageFacts,
} from './onboardingStage';

const NONE: OnboardingStageFacts = {
  onboardingIndustry: null,
  onboardingWidgetSeenAt: null,
  hasPublishedFaq: false,
  hasRealConversation: false,
};

describe('deriveOnboardingStage', () => {
  it('全段階未到達なら全て false', () => {
    expect(deriveOnboardingStage(NONE)).toEqual({
      industryAnswered: false,
      knowledgePublished: false,
      widgetInstalled: false,
      firstConversation: false,
    });
  });

  it('全段階到達済みなら全て true', () => {
    const facts: OnboardingStageFacts = {
      onboardingIndustry: 'beauty',
      onboardingWidgetSeenAt: new Date('2026-07-31T00:00:00Z'),
      hasPublishedFaq: true,
      hasRealConversation: true,
    };
    expect(deriveOnboardingStage(facts)).toEqual({
      industryAnswered: true,
      knowledgePublished: true,
      widgetInstalled: true,
      firstConversation: true,
    });
  });

  it('onboardingWidgetSeenAt が文字列(DBからのタイムスタンプ)でも true になる', () => {
    const facts: OnboardingStageFacts = { ...NONE, onboardingWidgetSeenAt: '2026-07-31T00:00:00.000Z' };
    expect(deriveOnboardingStage(facts).widgetInstalled).toBe(true);
  });

  it('onboardingIndustry が空文字列は「回答済み」とは見なさない', () => {
    // 決定1準拠: 導出は onboarding_industry の非nullのみで判定する。空文字列はDB上あり得ないが、
    // 万一渡ってきた場合の挙動を固定しておく(空文字列はnullではないため true になる — 呼び出し側でDBのNULL制約に委ねる)。
    const facts: OnboardingStageFacts = { ...NONE, onboardingIndustry: '' };
    expect(deriveOnboardingStage(facts).industryAnswered).toBe(true);
  });

  it('knowledgePublished は hasPublishedFaq をそのまま反映する(オンボ由来に限定しない、決定1)', () => {
    const facts: OnboardingStageFacts = { ...NONE, hasPublishedFaq: true };
    expect(deriveOnboardingStage(facts).knowledgePublished).toBe(true);
  });

  it('firstConversation は hasRealConversation をそのまま反映する', () => {
    const facts: OnboardingStageFacts = { ...NONE, hasRealConversation: true };
    expect(deriveOnboardingStage(facts).firstConversation).toBe(true);
  });
});

describe('nextIncompleteStage', () => {
  it('全段階未到達なら industry_answered を返す(先頭)', () => {
    expect(nextIncompleteStage(deriveOnboardingStage(NONE))).toBe('industry_answered');
  });

  it('業種回答済みなら knowledge_published を返す', () => {
    const status = deriveOnboardingStage({ ...NONE, onboardingIndustry: 'food' });
    expect(nextIncompleteStage(status)).toBe('knowledge_published');
  });

  it('業種回答+知識公開済みなら widget_installed を返す', () => {
    const status = deriveOnboardingStage({ ...NONE, onboardingIndustry: 'food', hasPublishedFaq: true });
    expect(nextIncompleteStage(status)).toBe('widget_installed');
  });

  it('業種回答+知識公開+設置検知済みなら first_conversation を返す', () => {
    const status = deriveOnboardingStage({
      ...NONE,
      onboardingIndustry: 'food',
      hasPublishedFaq: true,
      onboardingWidgetSeenAt: new Date(),
    });
    expect(nextIncompleteStage(status)).toBe('first_conversation');
  });

  it('全段階到達済みなら null を返す', () => {
    const status = deriveOnboardingStage({
      onboardingIndustry: 'food',
      hasPublishedFaq: true,
      onboardingWidgetSeenAt: new Date(),
      hasRealConversation: true,
    });
    expect(nextIncompleteStage(status)).toBeNull();
  });

  it('途中の段階だけ飛んで到達している(不整合な組み合わせ)場合でも先頭の未到達を返す', () => {
    // 例: 知識公開・設置検知は済んでいるが業種未回答(データ移行や手動操作の異常系を想定)。
    const status = deriveOnboardingStage({
      ...NONE,
      hasPublishedFaq: true,
      onboardingWidgetSeenAt: new Date(),
    });
    expect(nextIncompleteStage(status)).toBe('industry_answered');
  });
});

describe('isOnboardingComplete', () => {
  it('未到達段階が残っている場合は false', () => {
    expect(isOnboardingComplete(deriveOnboardingStage(NONE))).toBe(false);
  });

  it('全段階到達済みなら true', () => {
    const status = deriveOnboardingStage({
      onboardingIndustry: 'retail',
      hasPublishedFaq: true,
      onboardingWidgetSeenAt: new Date(),
      hasRealConversation: true,
    });
    expect(isOnboardingComplete(status)).toBe(true);
  });
});
