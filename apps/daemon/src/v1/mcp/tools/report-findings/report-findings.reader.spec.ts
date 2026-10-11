import { describe, expect, it } from 'vitest';

import {
  MAX_FINDING_SHORT_SUMMARY_LENGTH,
  MAX_HOST_FINDINGS,
} from '../../../agents/chat.types';
import {
  hostFindingsResultText,
  readHostFindingsReport,
} from './report-findings.reader';

function finding(overrides: Record<string, unknown> = {}) {
  return {
    file: 'src/queue/processor.ts',
    line: 402,
    summary: 'finalizeCompleted no longer checks generation',
    short_summary: 'CAS guard weakened',
    failure_scenario: 'A superseded worker finishes late and wins the write.',
    category: 'correctness',
    verdict: 'CONFIRMED',
    ...overrides,
  };
}

describe('readHostFindingsReport', () => {
  it('reads a well-formed call, crossing the snake_case seam', () => {
    expect(
      readHostFindingsReport({ level: 'high', findings: [finding()] }),
    ).toEqual({
      level: 'high',
      findings: [
        {
          file: 'src/queue/processor.ts',
          line: 402,
          summary: 'finalizeCompleted no longer checks generation',
          shortSummary: 'CAS guard weakened',
          failureScenario:
            'A superseded worker finishes late and wins the write.',
          category: 'correctness',
          verdict: 'CONFIRMED',
        },
      ],
    });
  });

  it('returns an empty report when findings is not an array', () => {
    expect(readHostFindingsReport({ findings: 'lots' })).toEqual({
      findings: [],
    });
  });

  it('returns an empty report when the call carries nothing at all', () => {
    expect(readHostFindingsReport({})).toEqual({ findings: [] });
  });

  it('drops a finding with no file — a row with no location is not a row', () => {
    const report = readHostFindingsReport({
      findings: [finding({ file: undefined }), finding()],
    });
    expect(report.findings).toHaveLength(1);
  });

  it('drops a finding with no summary', () => {
    const report = readHostFindingsReport({
      findings: [finding({ summary: '   ' }), finding()],
    });
    expect(report.findings).toHaveLength(1);
  });

  it('KEEPS a finding with no failure_scenario, minus that one field', () => {
    const [kept] = readHostFindingsReport({
      findings: [finding({ failure_scenario: undefined })],
    }).findings;
    expect(kept).toBeDefined();
    expect(kept).not.toHaveProperty('failureScenario');
    expect(kept?.summary).toBe('finalizeCompleted no longer checks generation');
  });

  it('truncates rather than refusing when a model sends too many findings', () => {
    const report = readHostFindingsReport({
      findings: Array.from({ length: MAX_HOST_FINDINGS + 5 }, () => finding()),
    });
    expect(report.findings).toHaveLength(MAX_HOST_FINDINGS);
  });

  it('truncates an over-long short_summary to its cap', () => {
    const [kept] = readHostFindingsReport({
      findings: [finding({ short_summary: 'x'.repeat(200) })],
    }).findings;
    expect(kept?.shortSummary).toHaveLength(MAX_FINDING_SHORT_SUMMARY_LENGTH);
  });

  it('drops a verdict outside the known vocabulary', () => {
    const [kept] = readHostFindingsReport({
      findings: [finding({ verdict: 'PROBABLY' })],
    }).findings;
    expect(kept).not.toHaveProperty('verdict');
  });

  it('drops an outcome outside the known vocabulary', () => {
    const [kept] = readHostFindingsReport({
      findings: [finding({ outcome: 'half-fixed' })],
    }).findings;
    expect(kept).not.toHaveProperty('outcome');
  });

  it('keeps a known outcome, which is what a re-report carries', () => {
    const [kept] = readHostFindingsReport({
      findings: [finding({ outcome: 'no_change_needed' })],
    }).findings;
    expect(kept?.outcome).toBe('no_change_needed');
  });

  it.each([[0], [-3], [1.5], ['402']])(
    'drops the line number %p rather than pointing confidently at the wrong place',
    (line) => {
      const [kept] = readHostFindingsReport({
        findings: [finding({ line })],
      }).findings;
      expect(kept).not.toHaveProperty('line');
      expect(kept?.file).toBe('src/queue/processor.ts');
    },
  );

  it('drops an unknown level while keeping the findings under it', () => {
    const report = readHostFindingsReport({
      level: 'extreme',
      findings: [finding()],
    });
    expect(report).not.toHaveProperty('level');
    expect(report.findings).toHaveLength(1);
  });

  it('skips a non-object entry without losing its neighbours', () => {
    const report = readHostFindingsReport({
      findings: [null, 'a finding', finding()],
    });
    expect(report.findings).toHaveLength(1);
  });
});

describe('hostFindingsResultText', () => {
  it('is a receipt, never the findings themselves', () => {
    // The card is the delivery mechanism; echoing the findings here would put
    // every one of them into the model's window a second time.
    const text = hostFindingsResultText({ status: 'recorded', count: 10 });
    expect(text).toBe('10 findings recorded and shown to the user.');
    expect(text).not.toContain('finalizeCompleted');
  });

  it('says one finding in the singular', () => {
    expect(hostFindingsResultText({ status: 'recorded', count: 1 })).toBe(
      '1 finding recorded and shown to the user.',
    );
  });

  it('reports an empty report as empty rather than as a success count', () => {
    expect(hostFindingsResultText({ status: 'recorded', count: 0 })).toBe(
      'No findings recorded.',
    );
  });

  it('names the reason when the report could not be recorded', () => {
    const text = hostFindingsResultText({
      status: 'unavailable',
      reason: 'no turn is running that could record them',
    });
    expect(text).toContain('no turn is running that could record them');
    expect(text).toContain('in your reply');
  });
});
