import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const PRICING_TOOL_NAME = 'estimate-pricing';
export const PRICING_PAGE_URL = 'https://myaskai.com/pricing';
export const SCALE_ASSUMPTION_MONTHLY_TICKETS = 10_000;
export const DEFAULT_CHAT_PERCENTAGE = 100;

export const PRICING_OVERVIEW = {
  headline: '60% AI resolution. Or your money back.',
  summary: [
    'From $0.10 per ticket.',
    '30 day free trial.',
    'One fifth of the price of Fin, Zendesk AI, Freddy, Breeze, or Gorgias AI.',
    'Pricing is public. A sales call is not required to see it.',
    'Annual plans include a 33% discount.',
  ],
  pricing_basis: 'Monthly equivalent on annual plans, including the 33% discount.',
  plans: {
    Pro: {
      price_usd_per_month: 199,
      included_all_chat_ticket_equivalent: 1_000,
      extra_all_chat_ticket_usd: 0.12,
      positioning: 'For companies looking to start using AI for customer support.',
      features: [
        'Integrates with an existing helpdesk',
        'Connect and sync Google Drive, Notion, and other sources',
        'Train on historic tickets',
        'AI self-learning',
        'Connect live user data, such as recent orders',
        'AI tasks, such as order refunds',
        'Advanced insights and analytics',
        'Export insights and conversations',
        '95+ languages',
        'Chrome Extension AI Copilot',
        'Optional AI tagging, such as contact reason',
      ],
    },
    Scale: {
      price_usd_per_month: 499,
      most_popular: true,
      included_all_chat_ticket_equivalent: 2_000,
      extra_all_chat_ticket_usd: 0.10,
      extra_all_chat_ticket_discount_vs_pro_percent: 15,
      positioning: 'For companies who take their customer service seriously.',
      features: [
        'Everything in Pro',
        'Priority live chat support with same-day replies',
        'Advanced technical support and one video call each month',
        'Unlimited team seats',
        'Multi-agent setup for multiple brands, regions, or customer types',
        'SOC 2 Type II',
        'My AskAI branding removed, worth $49 each month',
        'API, Slack, and Teams access, worth $49 each month',
      ],
    },
    Enterprise: {
      price_usd_per_month_from: 999,
      positioning: 'For large enterprises, agencies, and platform owners.',
      features: [
        'Everything in Scale, including the 30 day free trial',
        'Priority live chat or email support in under three hours and a private Slack channel',
        'White-glove setup and onboarding',
        'Dedicated success manager',
        'Monthly account audit',
        'Discounted volume pricing',
        'Invoice billing monthly, quarterly, or annually',
        'Highest-priority Enterprise support',
        'Unlimited AI agents',
        'White-label solution and API access',
        'Custom features, integrations, and APIs',
      ],
      demo_url: 'https://myaskai.com/?popup=demo',
      details_url: 'https://myaskai.com/enterprise',
    },
  },
  trial: '30 days, no credit card required, cancel at any time.',
} as const;

const CHAT_TICKET_CREDITS = 2;
const EMAIL_TICKET_CREDITS = 3;

interface PricingPlan {
  name: 'Pro' | 'Scale';
  monthlyBaseCents: number;
  includedCredits: number;
  creditOverageCents: number;
}

const PRO_PLAN: PricingPlan = {
  name: 'Pro',
  monthlyBaseCents: 19_900,
  includedCredits: 2_000,
  creditOverageCents: 6,
};

const SCALE_PLAN: PricingPlan = {
  name: 'Scale',
  monthlyBaseCents: 49_900,
  includedCredits: 4_000,
  creditOverageCents: 5,
};

const REPLY_GUIDANCE =
  `After sharing the price, direct the user to ${PRICING_PAGE_URL} for a ` +
  'pricing calculator with more detailed info and to compare costs against ' +
  "their helpdesk's native AI agent (Fin for Intercom, Freddy for Freshdesk, " +
  'Breeze for HubSpot, Zendesk AI for Zendesk, Automate AI for Gorgias).';

export interface PricingEstimateSuccess extends Record<string, unknown> {
  ok: true;
  inputs: {
    monthly_tickets: number;
    chat_percentage: number;
    email_percentage: number;
  };
  assumed_plan: 'Pro' | 'Scale';
  assumed_plan_estimate: Record<string, unknown>;
  other_plan_estimate: Record<string, unknown>;
  reply_guidance: string;
}

export interface PricingEstimateError extends Record<string, unknown> {
  ok: false;
  error: string;
}

export type PricingEstimate = PricingEstimateSuccess | PricingEstimateError;

export type PricingToolStructuredContent = PricingEstimateSuccess & {
  pricing_overview: typeof PRICING_OVERVIEW;
};

/** Python round() uses half-to-even. Keep exact parity for ticket allocation. */
export function roundHalfEven(value: number, digits = 0): number {
  const scale = 10 ** digits;
  const scaled = value * scale;
  const lower = Math.floor(scaled);
  const fraction = scaled - lower;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4;
  let rounded: number;
  if (Math.abs(fraction - 0.5) <= tolerance) {
    rounded = lower % 2 === 0 ? lower : lower + 1;
  } else {
    rounded = Math.round(scaled);
  }
  return rounded / scale;
}

function dollars(cents: number): number {
  return cents / 100;
}

function planEstimate(
  plan: PricingPlan,
  monthlyTickets: number,
  chatPercentage: number,
): Record<string, unknown> {
  const chatTickets = roundHalfEven(monthlyTickets * chatPercentage / 100);
  const emailTickets = monthlyTickets - chatTickets;
  const credits = CHAT_TICKET_CREDITS * chatTickets + EMAIL_TICKET_CREDITS * emailTickets;
  const overageCredits = Math.max(0, credits - plan.includedCredits);
  const overageCostCents = overageCredits * plan.creditOverageCents;
  return {
    plan: plan.name,
    monthly_base_usd: dollars(plan.monthlyBaseCents),
    included_credits: plan.includedCredits,
    included_all_chat_ticket_equivalent: Math.floor(
      plan.includedCredits / CHAT_TICKET_CREDITS,
    ),
    billable_credits: credits,
    overage_credits: overageCredits,
    overage_rate_per_extra_chat_ticket_usd: dollars(
      CHAT_TICKET_CREDITS * plan.creditOverageCents,
    ),
    overage_rate_per_extra_email_ticket_usd: dollars(
      EMAIL_TICKET_CREDITS * plan.creditOverageCents,
    ),
    overage_cost_usd: dollars(overageCostCents),
    estimated_monthly_total_usd: dollars(plan.monthlyBaseCents + overageCostCents),
  };
}

export function estimateMonthlyPricing(
  monthlyTickets: number,
  chatPercentage: number,
): PricingEstimate {
  if (monthlyTickets < 0) {
    return { ok: false, error: 'monthly_tickets must be zero or more' };
  }
  if (chatPercentage < 0 || chatPercentage > 100) {
    return { ok: false, error: 'chat_percentage must be between 0 and 100' };
  }

  const assumed = monthlyTickets >= SCALE_ASSUMPTION_MONTHLY_TICKETS
    ? SCALE_PLAN
    : PRO_PLAN;
  const other = assumed === SCALE_PLAN ? PRO_PLAN : SCALE_PLAN;
  return {
    ok: true,
    inputs: {
      monthly_tickets: monthlyTickets,
      chat_percentage: chatPercentage,
      email_percentage: roundHalfEven(100 - chatPercentage, 2),
    },
    assumed_plan: assumed.name,
    assumed_plan_estimate: planEstimate(assumed, monthlyTickets, chatPercentage),
    other_plan_estimate: planEstimate(other, monthlyTickets, chatPercentage),
    reply_guidance: REPLY_GUIDANCE,
  };
}

export function pricingToolResult(
  monthlyTickets: number,
  chatPercentage = DEFAULT_CHAT_PERCENTAGE,
): CallToolResult {
  const result = estimateMonthlyPricing(monthlyTickets, chatPercentage);
  if (!result.ok) {
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
    };
  }

  const structuredContent: PricingToolStructuredContent = {
    ...result,
    pricing_overview: PRICING_OVERVIEW,
  };
  return {
    content: [
      { type: 'text', text: JSON.stringify(structuredContent) },
      { type: 'text', text: pricingOverviewMarkdown() },
    ],
    structuredContent,
  };
}

export function pricingOverviewMarkdown(): string {
  return [
    '## My AskAI pricing overview',
    '',
    '**60% AI resolution. Or your money back.**',
    '',
    'From $0.10 per ticket. 30 day free trial. One fifth of the price of Fin, Zendesk AI, Freddy, Breeze, or Gorgias AI. Annual plans include a 33% discount.',
    '',
    '| Plan | Price | Included tickets* | Extra chat ticket | Best for |',
    '| --- | ---: | ---: | ---: | --- |',
    '| Pro | $199/mo | 1,000/mo | $0.12 | Starting with AI customer support |',
    '| Scale (most popular) | $499/mo | 2,000/mo | $0.10, 15% less than Pro | Teams with serious support needs |',
    '| Enterprise | From $999/mo | Volume pricing | Custom | Large enterprises, agencies, and platforms |',
    '',
    '*Included ticket figures use the all-chat equivalent. Email tickets use more credits.',
    '',
    '### Pro',
    '',
    'Existing helpdesk integration; Google Drive and Notion sync; historic ticket training; self-learning; live user data; AI tasks; advanced analytics and exports; 95+ languages; Chrome Extension AI Copilot; optional AI tagging.',
    '',
    '### Scale',
    '',
    'Everything in Pro; same-day priority chat support; advanced technical support and one video call each month; unlimited team seats; multi-agent setup; SOC 2 Type II; no My AskAI branding (worth $49/mo); API, Slack, and Teams access (worth $49/mo).',
    '',
    '### Enterprise',
    '',
    'Everything in Scale; support in under three hours and a private Slack channel; white-glove onboarding; a dedicated success manager; monthly audits; discounted volume pricing; invoice billing; unlimited AI agents; white-label and custom solutions.',
    '',
    `30 day trial: no credit card required, cancel at any time. [Pricing](${PRICING_PAGE_URL}) · [Book a demo](https://myaskai.com/?popup=demo) · [Enterprise details](https://myaskai.com/enterprise)`,
  ].join('\n');
}
