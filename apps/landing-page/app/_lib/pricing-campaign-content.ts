import type { LandingLocaleCode } from '../i18n';

export interface PricingCampaignContent {
  badge: string;
  headline: string;
  body: string;
  windowLabel: string;
  dayUnit: string;
  modelBenefit: string;
  paidBenefitNote: string;
  teamBenefitNote: string;
  disclaimer: string;
}

export const PRICING_CAMPAIGN_CONTENT_BY_LOCALE = {
  en: {
    badge: 'Unlimited',
    headline: 'Stop rationing. Use DeepSeek V4 Flash without limits.',
    body: 'FREE all week, Aug 6—Aug 13',
    windowLabel: 'Campaign countdown',
    dayUnit: 'd',
    modelBenefit: 'Unlimited DeepSeek V4 Flash',
    paidBenefitNote: 'Aug 6—Aug 13 · FREE all week',
    teamBenefitNote: 'Aug 6—Aug 13 · FREE all week',
    disclaimer: 'Unlimited model quota and free generations included in a plan are available only in Open Design; they cannot be used through MCP/CLI/API or in other scenarios. The organizer reserves the right of final interpretation.',
  },
  zh: {
    badge: '无限使用',
    headline: '这次，别省着用。DeepSeek V4 Flash 无限用。',
    body: '8月6日—8月13日，一周免费用',
    windowLabel: '活动倒计时',
    dayUnit: '天',
    modelBenefit: 'DeepSeek V4 Flash 无限使用',
    paidBenefitNote: '8月6日—8月13日 · 一周免费用',
    teamBenefitNote: '8月6日—8月13日 · 一周免费用',
    disclaimer: '套餐内的无限制模型额度与免费生成次数，仅可通过Open Design使用；无法在MCP/CLI/API及其他场景使用。解释权归官方所有。',
  },
  ja: {
    badge: '無制限',
    headline: 'もう節約不要。DeepSeek V4 Flashを無制限で使おう。',
    body: '8月6日〜8月13日、1週間無料',
    windowLabel: 'キャンペーン終了まで',
    dayUnit: '日',
    modelBenefit: 'DeepSeek V4 Flashを無制限で利用',
    paidBenefitNote: '8月6日〜8月13日 · 1週間無料',
    teamBenefitNote: '8月6日〜8月13日 · 1週間無料',
    disclaimer: 'プランに含まれる無制限のモデル枠と無料生成回数は、Open Design内でのみ利用できます。MCP/CLI/APIなど、その他の環境では利用できません。最終的な解釈権は運営者に帰属します。',
  },
  ko: {
    badge: '무제한 사용',
    headline: '아껴 쓰지 마세요. DeepSeek V4 Flash를 무제한으로 사용하세요.',
    body: '8월 6일—8월 13일, 일주일 무료',
    windowLabel: '이벤트 남은 시간',
    dayUnit: '일',
    modelBenefit: 'DeepSeek V4 Flash 무제한 사용',
    paidBenefitNote: '8월 6일—8월 13일 · 일주일 무료',
    teamBenefitNote: '8월 6일—8월 13일 · 일주일 무료',
    disclaimer: '플랜에 포함된 무제한 모델 한도와 무료 생성 횟수는 Open Design에서만 사용할 수 있으며 MCP/CLI/API 또는 기타 환경에서는 사용할 수 없습니다. 최종 해석 권한은 운영사에 있습니다.',
  },
  de: {
    badge: 'Unbegrenzt',
    headline: 'Nicht länger sparen. DeepSeek V4 Flash unbegrenzt nutzen.',
    body: '6.—13. August · eine Woche kostenlos',
    windowLabel: 'Aktions-Countdown',
    dayUnit: 'T',
    modelBenefit: 'DeepSeek V4 Flash unbegrenzt nutzen',
    paidBenefitNote: '6.—13. August · eine Woche kostenlos',
    teamBenefitNote: '6.—13. August · eine Woche kostenlos',
    disclaimer: 'Das im Tarif enthaltene unbegrenzte Modellkontingent und die kostenlosen Generierungen können nur in Open Design genutzt werden, nicht über MCP/CLI/API oder in anderen Umgebungen. Der Veranstalter behält sich die endgültige Auslegung vor.',
  },
  fr: {
    badge: 'Illimité',
    headline: 'Ne vous limitez plus. Utilisez DeepSeek V4 Flash sans limites.',
    body: 'Du 6 au 13 août · gratuit toute la semaine',
    windowLabel: 'Compte à rebours',
    dayUnit: 'j',
    modelBenefit: 'DeepSeek V4 Flash en illimité',
    paidBenefitNote: 'Du 6 au 13 août · gratuit toute la semaine',
    teamBenefitNote: 'Du 6 au 13 août · gratuit toute la semaine',
    disclaimer: 'Le quota de modèles illimité et les générations gratuites inclus dans le forfait sont utilisables uniquement dans Open Design, et non via MCP/CLI/API ni dans d’autres contextes. L’organisateur se réserve le droit d’interprétation finale.',
  },
  ru: {
    badge: 'Без ограничений',
    headline: 'Больше не экономьте. Пользуйтесь DeepSeek V4 Flash без ограничений.',
    body: '6—13 августа · бесплатно всю неделю',
    windowLabel: 'До конца акции',
    dayUnit: 'д',
    modelBenefit: 'DeepSeek V4 Flash без ограничений',
    paidBenefitNote: '6—13 августа · бесплатно всю неделю',
    teamBenefitNote: '6—13 августа · бесплатно всю неделю',
    disclaimer: 'Безлимитная квота моделей и бесплатные генерации, включённые в тариф, доступны только в Open Design и недоступны через MCP/CLI/API или в других сценариях. Организатор оставляет за собой право окончательного толкования.',
  },
  es: {
    badge: 'Uso ilimitado',
    headline: 'Deja de limitarte. Usa DeepSeek V4 Flash sin límites.',
    body: 'Del 6 al 13 de agosto · gratis toda la semana',
    windowLabel: 'Cuenta atrás de la promoción',
    dayUnit: 'd',
    modelBenefit: 'Uso ilimitado de DeepSeek V4 Flash',
    paidBenefitNote: 'Del 6 al 13 de agosto · gratis toda la semana',
    teamBenefitNote: 'Del 6 al 13 de agosto · gratis toda la semana',
    disclaimer: 'La cuota ilimitada de modelos y las generaciones gratuitas incluidas en el plan solo pueden utilizarse en Open Design, no mediante MCP/CLI/API ni en otros entornos. El organizador se reserva el derecho de interpretación final.',
  },
  'pt-br': {
    badge: 'Uso ilimitado',
    headline: 'Não economize. Use o DeepSeek V4 Flash sem limites.',
    body: '6 a 13 de agosto · grátis a semana toda',
    windowLabel: 'Contagem regressiva',
    dayUnit: 'd',
    modelBenefit: 'Uso ilimitado do DeepSeek V4 Flash',
    paidBenefitNote: '6 a 13 de agosto · grátis a semana toda',
    teamBenefitNote: '6 a 13 de agosto · grátis a semana toda',
    disclaimer: 'A cota ilimitada de modelos e as gerações gratuitas incluídas no plano só podem ser usadas no Open Design, e não via MCP/CLI/API nem em outros cenários. O organizador se reserva o direito de interpretação final.',
  },
  it: {
    badge: 'Uso illimitato',
    headline: 'Non risparmiarti. Usa DeepSeek V4 Flash senza limiti.',
    body: '6—13 agosto · gratis per tutta la settimana',
    windowLabel: 'Conto alla rovescia',
    dayUnit: 'g',
    modelBenefit: 'DeepSeek V4 Flash senza limiti',
    paidBenefitNote: '6—13 agosto · gratis per tutta la settimana',
    teamBenefitNote: '6—13 agosto · gratis per tutta la settimana',
    disclaimer: 'La quota modelli illimitata e le generazioni gratuite incluse nel piano sono utilizzabili solo in Open Design, non tramite MCP/CLI/API né in altri contesti. L’organizzatore si riserva il diritto di interpretazione finale.',
  },
  tr: {
    badge: 'Sınırsız kullanım',
    headline: 'Artık tasarruf etmeyin. DeepSeek V4 Flash’i sınırsız kullanın.',
    body: '6—13 Ağustos · bir hafta ücretsiz',
    windowLabel: 'Kampanya geri sayımı',
    dayUnit: 'g',
    modelBenefit: 'DeepSeek V4 Flash sınırsız kullanım',
    paidBenefitNote: '6—13 Ağustos · bir hafta ücretsiz',
    teamBenefitNote: '6—13 Ağustos · bir hafta ücretsiz',
    disclaimer: 'Paket kapsamındaki sınırsız model kotası ve ücretsiz üretim hakları yalnızca Open Design içinde kullanılabilir; MCP/CLI/API veya diğer senaryolarda kullanılamaz. Nihai yorum hakkı organizatöre aittir.',
  },
} satisfies Partial<Record<LandingLocaleCode, PricingCampaignContent>>;

export function getPricingCampaignContent(
  locale: LandingLocaleCode,
): PricingCampaignContent {
  return PRICING_CAMPAIGN_CONTENT_BY_LOCALE[locale as keyof typeof PRICING_CAMPAIGN_CONTENT_BY_LOCALE]
    ?? PRICING_CAMPAIGN_CONTENT_BY_LOCALE.en;
}
