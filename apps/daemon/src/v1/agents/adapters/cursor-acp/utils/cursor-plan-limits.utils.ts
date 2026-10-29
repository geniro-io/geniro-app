import { asNumber, asRecord, asString } from '../../../utils/json-util';
import {
  type AgentPlanLimits,
  type AgentPlanWindow,
  NO_PLAN_LIMITS,
} from '../../adapter.types';

/**
 * The plan limits of a cursor account, read the way the CLI's own `/usage`
 * builds them (2026.10.22-27dcf5f): `GetCurrentPeriodUsage.planUsage` for the
 * figures, `GetPlanInfo.planInfo.planName` for the plan's name.
 *
 * An account whose period carries no `planUsage` (a spend-based Enterprise
 * seat) answered and has no windows, which is {@link NO_PLAN_LIMITS}; a reply
 * that is not an object at all is null.
 */
export function readCursorPlanLimits(
  periodUsage: unknown,
  planInfo: unknown,
): AgentPlanLimits | typeof NO_PLAN_LIMITS | null {
  const period = asRecord(periodUsage);
  if (period === null) {
    return null;
  }
  const usage = asRecord(period['planUsage']);
  if (usage === null) {
    return NO_PLAN_LIMITS;
  }
  const info = asRecord(asRecord(planInfo)?.['planInfo']);
  const planName = asString(info?.['planName'])?.trim() ?? '';
  const periodEnd = epochMs(period['billingCycleEnd']);
  const resetsAtMs =
    periodEnd !== null && periodEnd > 0
      ? periodEnd
      : epochMs(info?.['billingCycleEnd']);
  const resetsAt =
    resetsAtMs !== null && resetsAtMs > 0
      ? new Date(resetsAtMs).toISOString()
      : null;
  const window = (
    key: string,
    label: string,
    percent: number,
  ): AgentPlanWindow => ({
    key,
    label,
    percent: Math.max(0, Math.min(100, percent)),
    resetsAt,
  });
  return {
    plan: planName === '' ? null : planName,
    windows: [
      window('included', 'Included', includedPercent(usage)),
      window('auto', 'Auto', asNumber(usage['autoPercentUsed']) ?? 0),
      window('api', 'API', asNumber(usage['apiPercentUsed']) ?? 0),
    ],
    estimated: false,
  };
}

function includedPercent(usage: Record<string, unknown>): number {
  const reported = asNumber(usage['totalPercentUsed']);
  if (reported !== null) {
    return reported;
  }
  const limit = asNumber(usage['limit']) ?? 0;
  return limit > 0
    ? ((asNumber(usage['includedSpend']) ?? 0) / limit) * 100
    : 0;
}

/** An int64 rides this wire as a decimal string. */
function epochMs(value: unknown): number | null {
  const raw = asString(value);
  const parsed = raw === null ? asNumber(value) : Number(raw);
  return parsed !== null && Number.isFinite(parsed) ? parsed : null;
}
