import { describe, expect, test } from 'vitest';

import {
  computeInitialNextRunAt,
  computeNextCronOccurrence,
  computeNextRRuleOccurrence,
  normalizeIsoUtcTimestamp,
  normalizeRRuleExpression,
  validateScheduleInput,
} from '../src/server/scheduled-task-schedule.js';

describe('scheduled-task-schedule', () => {
  test('computeNextCronOccurrence handles midnight hour in UTC', () => {
    const next = computeNextCronOccurrence('0 0 * * *', 'UTC', new Date('2026-02-15T17:00:00.000Z'));
    expect(next).toBe('2026-02-16T00:00:00.000Z');
  });

  test('validateScheduleInput accepts UTC ISO strings without milliseconds', () => {
    expect(() =>
      validateScheduleInput({
        kind: 'once',
        onceAt: '2026-02-16T00:00:00Z',
        timezone: 'UTC',
      }),
    ).not.toThrow();
  });

  test('computeInitialNextRunAt canonicalizes UTC ISO timestamp for once schedules', () => {
    const next = computeInitialNextRunAt({
      kind: 'once',
      onceAt: '2026-02-16T00:00:00+00:00',
      timezone: 'UTC',
      now: new Date('2026-02-15T12:00:00.000Z'),
    });

    expect(next).toBe('2026-02-16T00:00:00.000Z');
    expect(normalizeIsoUtcTimestamp('2026-02-16T00:00:00+00:00')).toBe('2026-02-16T00:00:00.000Z');
  });

  test('normalizeRRuleExpression adds DTSTART and supports raw RRULE body', () => {
    const normalized = normalizeRRuleExpression(
      'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
      'UTC',
      new Date('2026-01-01T00:00:00.000Z'),
    );

    expect(normalized).toContain('DTSTART;TZID=UTC:20260101T000000');
    expect(normalized).toContain('RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1;BYHOUR=9;BYMINUTE=0;BYSECOND=0');
  });

  test('computeNextRRuleOccurrence supports first Monday of the month', () => {
    const next = computeNextRRuleOccurrence(
      'DTSTART;TZID=UTC:20260105T090000\nRRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
      'UTC',
      new Date('2026-02-10T00:00:00.000Z'),
    );

    expect(next).toBe('2026-03-02T09:00:00.000Z');
  });

  test('computeNextRRuleOccurrence supports every two weeks on Monday', () => {
    const next = computeNextRRuleOccurrence(
      'DTSTART;TZID=UTC:20260105T090000\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
      'UTC',
      new Date('2026-01-06T00:00:00.000Z'),
    );

    expect(next).toBe('2026-01-19T09:00:00.000Z');
  });
});
