import parityFixture from './fixtures/pricing-parity.json';
import { describe, expect, it } from 'vitest';

import {
  estimateMonthlyPricing,
  pricingOverviewMarkdown,
  pricingToolResult,
  PRICING_OVERVIEW,
  roundHalfEven,
} from '../src/tools/pricing.ts';

function plan(
  result: ReturnType<typeof estimateMonthlyPricing>,
  name: 'Pro' | 'Scale',
): Record<string, unknown> {
  if (!result.ok) throw new Error(result.error);
  return [result.assumed_plan_estimate, result.other_plan_estimate]
    .find((entry) => entry.plan === name) as Record<string, unknown>;
}

describe('pricing parity with the mono-agent Python implementation', () => {
  it.each(parityFixture)('matches $input', (fixture) => {
    const tickets = fixture.input[0]!;
    const chatPercentage = fixture.input[1]!;
    const result = estimateMonthlyPricing(tickets, chatPercentage);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assumed_plan).toBe(fixture.assumed_plan);
    expect(result.inputs.email_percentage).toBe(fixture.email_percentage);
    expect(result.assumed_plan_estimate.billable_credits).toBe(
      fixture.billable_credits,
    );
    expect(plan(result, 'Pro').estimated_monthly_total_usd).toBe(fixture.pro_total);
    expect(plan(result, 'Scale').estimated_monthly_total_usd).toBe(fixture.scale_total);
  });

  it('keeps the subscription base as the minimum price', () => {
    const result = estimateMonthlyPricing(500, 80);
    expect(plan(result, 'Pro').overage_credits).toBe(0);
    expect(plan(result, 'Pro').estimated_monthly_total_usd).toBe(199);
    expect(plan(result, 'Scale').estimated_monthly_total_usd).toBe(499);
  });

  it('uses three credits for email and two for chat', () => {
    expect(plan(estimateMonthlyPricing(1000, 100), 'Pro').billable_credits).toBe(2000);
    expect(plan(estimateMonthlyPricing(1000, 0), 'Pro').billable_credits).toBe(3000);
  });

  it('reports the current per-ticket overage rates', () => {
    const result = estimateMonthlyPricing(5000, 80);
    expect(plan(result, 'Pro')).toMatchObject({
      overage_rate_per_extra_chat_ticket_usd: 0.12,
      overage_rate_per_extra_email_ticket_usd: 0.18,
      overage_cost_usd: 540,
      estimated_monthly_total_usd: 739,
    });
    expect(plan(result, 'Scale')).toMatchObject({
      overage_rate_per_extra_chat_ticket_usd: 0.1,
      overage_rate_per_extra_email_ticket_usd: 0.15,
      estimated_monthly_total_usd: 849,
    });
  });

  it('changes the assumed plan at exactly 10,000 tickets', () => {
    expect(estimateMonthlyPricing(9999, 80)).toMatchObject({ assumed_plan: 'Pro' });
    expect(estimateMonthlyPricing(10000, 80)).toMatchObject({ assumed_plan: 'Scale' });
  });

  it('returns the exact existing validation errors', () => {
    expect(estimateMonthlyPricing(-1, 80)).toEqual({
      ok: false,
      error: 'monthly_tickets must be zero or more',
    });
    expect(estimateMonthlyPricing(100, -5)).toEqual({
      ok: false,
      error: 'chat_percentage must be between 0 and 100',
    });
    expect(estimateMonthlyPricing(100, 101)).toEqual({
      ok: false,
      error: 'chat_percentage must be between 0 and 100',
    });
  });

  it('keeps the pricing reply guidance', () => {
    const result = estimateMonthlyPricing(500, 80);
    expect(result.ok && result.reply_guidance).toContain('https://myaskai.com/pricing');
  });

  it('uses Python-compatible half-even rounding', () => {
    expect(roundHalfEven(0.5)).toBe(0);
    expect(roundHalfEven(1.5)).toBe(2);
    expect(roundHalfEven(2.5)).toBe(2);
    expect(roundHalfEven(3.5)).toBe(4);
    expect(roundHalfEven(99.995, 2)).toBe(100);
  });

  it('adds the plan overview as structured data and Markdown', () => {
    const result = pricingToolResult(2000, 80);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      pricing_overview: PRICING_OVERVIEW,
    });
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toMatchObject({ type: 'text' });
    expect(pricingOverviewMarkdown()).toContain('| Pro | $199/mo |');
    expect(pricingOverviewMarkdown()).toContain('| Scale (most popular) | $499/mo |');
    expect(pricingOverviewMarkdown()).toContain('Enterprise');
  });

  it('defaults a missing tool chat percentage to 100', () => {
    const result = pricingToolResult(2000);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      inputs: { chat_percentage: 100, email_percentage: 0 },
    });
  });

  it('does not add a quote overview to invalid input', () => {
    const result = pricingToolResult(-1, 80);
    expect(result.structuredContent).toEqual({
      ok: false,
      error: 'monthly_tickets must be zero or more',
    });
    expect(result.content).toHaveLength(1);
  });
});
