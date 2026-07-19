// src/api/admin/agent/industryFaqTemplates.ts
// admin-ui/src/components/onboarding/industryFaqTemplates.ts のバックエンド版。
// admin-uiとbackendは別TSプロジェクトのため直接import共有できず、同一内容をここに複製している。
// 内容を変更する場合は両ファイルを同時に更新すること。
// GID 1216274591838389: 初回ログインオンボーディングで提案する業種別FAQテンプレート

export type OnboardingIndustry = 'auto' | 'beauty' | 'food' | 'realestate' | 'retail' | 'other';

export const ONBOARDING_INDUSTRY_VALUES: readonly OnboardingIndustry[] = [
  'auto', 'beauty', 'food', 'realestate', 'retail', 'other',
];

export const ONBOARDING_INDUSTRY_LABELS: Record<OnboardingIndustry, string> = {
  auto: '自動車販売・整備',
  beauty: '美容・サロン',
  food: '飲食',
  realestate: '不動産',
  retail: '小売・EC',
  other: 'その他',
};

export interface IndustryFaqTemplate {
  question: string;
  answer: string;
  category?: string;
}

export const INDUSTRY_FAQ_TEMPLATES: Record<OnboardingIndustry, IndustryFaqTemplate[]> = {
  auto: [
    { question: '営業時間を教えてください', answer: '営業時間は平日・土日ともに10:00〜19:00です。定休日は水曜日です。', category: 'store_info' },
    { question: '車検の費用はいくらですか？', answer: '車種により異なりますが、目安は5万円〜です。事前にお見積もりも可能です。', category: 'inventory' },
    { question: '試乗はできますか？', answer: 'はい、事前にご連絡いただければ試乗車をご用意いたします。', category: 'inventory' },
    { question: '下取り・買取もお願いできますか？', answer: 'はい、査定を無料で承っております。お車の情報をお伝えください。', category: 'inventory' },
    { question: 'ローンでの購入はできますか？', answer: 'はい、各種オートローンに対応しております。お気軽にご相談ください。', category: 'inventory' },
  ],
  beauty: [
    { question: '営業時間を教えてください', answer: '営業時間は10:00〜20:00です。最終受付は19:00となります。', category: 'store_info' },
    { question: '予約は必要ですか？', answer: 'はい、ご来店前のご予約をお願いしております。当日予約も空きがあれば承れます。', category: 'store_info' },
    { question: '初めてでも大丈夫ですか？', answer: 'はい、初めてのお客様も安心してご利用いただけます。カウンセリングから丁寧にご案内します。', category: 'coupon' },
    { question: 'クーポンや割引はありますか？', answer: '初回限定クーポンをご用意しております。詳しくは店舗までお問い合わせください。', category: 'coupon' },
    { question: '駐車場はありますか？', answer: '近隣に提携駐車場がございます。ご来店の際はスタッフにお申し付けください。', category: 'store_info' },
  ],
  food: [
    { question: '営業時間を教えてください', answer: 'ランチ11:00〜15:00、ディナー17:00〜23:00で営業しております。', category: 'store_info' },
    { question: '予約はできますか？', answer: 'はい、お電話またはWebから予約を承っております。', category: 'store_info' },
    { question: '個室はありますか？', answer: 'はい、少人数〜大人数まで対応できる個室をご用意しております。', category: 'store_info' },
    { question: 'アレルギー対応はしていますか？', answer: 'はい、アレルギー品目に応じてメニューを調整いたします。ご予約時にお申し付けください。', category: 'product_info' },
    { question: 'テイクアウトはできますか？', answer: 'はい、一部メニューでテイクアウトに対応しております。', category: 'product_info' },
  ],
  realestate: [
    { question: '営業時間を教えてください', answer: '営業時間は9:30〜18:30です。定休日は火曜日です。', category: 'store_info' },
    { question: '内見は無料ですか？', answer: 'はい、内見は無料でご案内しております。事前予約をお願いします。', category: 'store_info' },
    { question: '仲介手数料はいくらですか？', answer: '原則として賃料の1ヶ月分(税別)を上限としております。詳細は物件ごとにご案内します。', category: 'pricing' },
    { question: 'ペット可の物件はありますか？', answer: 'はい、ペット可物件も多数取り扱っております。条件はお気軽にご相談ください。', category: 'inventory' },
    { question: 'オンラインでの内見は可能ですか？', answer: 'はい、ビデオ通話でのオンライン内見にも対応しております。', category: 'store_info' },
  ],
  retail: [
    { question: '営業時間を教えてください', answer: '営業時間は10:00〜20:00です。年中無休で営業しております。', category: 'store_info' },
    { question: '送料はいくらですか？', answer: '5,000円以上のご購入で送料無料です。それ未満は一律600円です。', category: 'pricing' },
    { question: '返品・交換はできますか？', answer: '商品到着後7日以内であれば、未使用品に限り返品・交換を承ります。', category: 'product_info' },
    { question: '在庫はどのくらいありますか？', answer: '商品ページに在庫状況を掲載しております。お問い合わせいただければ最新状況もご案内します。', category: 'inventory' },
    { question: 'クーポンや割引はありますか？', answer: '会員登録で使える初回クーポンをご用意しております。', category: 'coupon' },
  ],
  other: [
    { question: '営業時間を教えてください', answer: '営業時間は平日10:00〜18:00です。土日祝はお休みをいただいております。', category: 'store_info' },
    { question: '料金はいくらですか？', answer: '内容により異なります。お気軽にお問い合わせください。', category: 'pricing' },
    { question: '予約は必要ですか？', answer: 'はい、事前のご予約をお願いしております。', category: 'store_info' },
    { question: '対応エリアを教えてください', answer: '対応エリアの詳細はお問い合わせください。', category: 'store_info' },
    { question: '問い合わせ方法を教えてください', answer: 'お電話またはお問い合わせフォームからご連絡ください。', category: 'store_info' },
  ],
};

export function isOnboardingIndustry(value: unknown): value is OnboardingIndustry {
  return typeof value === 'string' && (ONBOARDING_INDUSTRY_VALUES as readonly string[]).includes(value);
}
