import rrule from 'rrule';

const { RRule, rrulestr } = rrule;

const cronFieldCount = 5;
const minuteMs = 60_000;
const maxCronSearchMinutes = 366 * 24 * 60;
const isoUtcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|\+00:00|\+0000|\+00)$/u;

interface CronFields {
  minute: CronFieldMatcher;
  hour: CronFieldMatcher;
  dayOfMonth: CronFieldMatcher;
  month: CronFieldMatcher;
  dayOfWeek: CronFieldMatcher;
}

interface CronFieldMatcher {
  allowsAll: boolean;
  matches(value: number): boolean;
}

interface TimeZoneDateParts {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
}

interface TimeZoneDateTimeParts extends TimeZoneDateParts {
  year: number;
  second: number;
}

const rruleDateFormatterCache = new Map<string, Intl.DateTimeFormat>();

export function validateScheduleInput(input: {
  kind: 'once' | 'cron' | 'rrule';
  onceAt?: string;
  cronExpr?: string;
  rruleExpr?: string;
  timezone: string;
}): void {
  assertValidTimeZone(input.timezone);

  if (input.kind === 'once') {
    if (!input.onceAt) {
      throw new Error('once schedule requires once_at');
    }

    if (!normalizeIsoUtcTimestamp(input.onceAt)) {
      throw new Error('once_at must be a valid ISO-8601 UTC timestamp');
    }

    return;
  }

  if (input.kind === 'cron') {
    if (!input.cronExpr) {
      throw new Error('cron schedule requires cron expression');
    }

    parseCronExpression(input.cronExpr);
    return;
  }

  if (!input.rruleExpr) {
    throw new Error('rrule schedule requires rrule expression');
  }

  parseRRuleExpression(input.rruleExpr, input.timezone);
}

export function computeInitialNextRunAt(input: {
  kind: 'once' | 'cron' | 'rrule';
  onceAt?: string;
  cronExpr?: string;
  rruleExpr?: string;
  timezone: string;
  now: Date;
}): string {
  validateScheduleInput(input);

  if (input.kind === 'once') {
    if (!input.onceAt) {
      throw new Error('once schedule requires once_at');
    }

    const normalized = normalizeIsoUtcTimestamp(input.onceAt);
    if (!normalized) {
      throw new Error('once_at must be a valid ISO-8601 UTC timestamp');
    }

    return normalized;
  }

  if (input.kind === 'cron') {
    if (!input.cronExpr) {
      throw new Error('cron schedule requires cron expression');
    }

    return computeNextCronOccurrence(input.cronExpr, input.timezone, input.now);
  }

  if (!input.rruleExpr) {
    throw new Error('rrule schedule requires rrule expression');
  }

  return computeNextRRuleOccurrence(input.rruleExpr, input.timezone, input.now);
}

export function computeNextRunAfterOccurrence(input: {
  kind: 'once' | 'cron' | 'rrule';
  cronExpr?: string;
  rruleExpr?: string;
  timezone: string;
  now: Date;
}): {
  enabled: boolean;
  nextRunAt: string | null;
} {
  if (input.kind === 'once') {
    return {
      enabled: false,
      nextRunAt: null,
    };
  }

  if (input.kind === 'cron') {
    if (!input.cronExpr) {
      throw new Error('cron schedule requires cron expression');
    }

    return {
      enabled: true,
      nextRunAt: computeNextCronOccurrence(input.cronExpr, input.timezone, input.now),
    };
  }

  if (!input.rruleExpr) {
    throw new Error('rrule schedule requires rrule expression');
  }

  return {
    enabled: true,
    nextRunAt: computeNextRRuleOccurrence(input.rruleExpr, input.timezone, input.now),
  };
}

export function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    throw new Error(`invalid timezone '${timeZone}'`);
  }
}

export function normalizeIsoUtcTimestamp(value: string): string | null {
  if (!isoUtcTimestampPattern.test(value)) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

export function isIsoTimestamp(value: string): boolean {
  return normalizeIsoUtcTimestamp(value) !== null;
}

export function normalizeRRuleExpression(value: string, timezone: string, anchor: Date): string {
  const lines = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    throw new Error('rrule expression must be non-empty');
  }

  const hasRawSingleRule = lines.length === 1 && !lines[0]?.includes(':');
  if (!hasRawSingleRule) {
    const unsupportedLine = lines.find((line) => {
      const upper = line.toUpperCase();
      return !upper.startsWith('RRULE:') && !upper.startsWith('DTSTART');
    });

    if (unsupportedLine) {
      throw new Error(`rrule expression contains unsupported line '${unsupportedLine}'`);
    }
  }

  const rruleLine = hasRawSingleRule
    ? `RRULE:${lines[0]}`
    : lines.find((line) => line.toUpperCase().startsWith('RRULE:'));

  if (!rruleLine) {
    throw new Error('rrule expression must include RRULE or a raw FREQ=... rule');
  }

  const dtstartLine =
    lines.find((line) => line.toUpperCase().startsWith('DTSTART')) ??
    `DTSTART;TZID=${timezone}:${formatRRuleDateTimeInTimeZone(anchor, timezone)}`;

  const normalized = `${dtstartLine}\n${rruleLine}`;
  parseRRuleExpression(normalized, timezone);
  return normalized;
}

export function computeNextCronOccurrence(cronExpr: string, timezone: string, from: Date): string {
  const fields = parseCronExpression(cronExpr);
  assertValidTimeZone(timezone);

  const startMs = alignToMinute(from.getTime()) + minuteMs;

  for (let index = 0; index < maxCronSearchMinutes; index += 1) {
    const candidate = new Date(startMs + index * minuteMs);
    if (!matchesCron(fields, getTimeZoneDateParts(candidate, timezone))) {
      continue;
    }

    return candidate.toISOString();
  }

  throw new Error(`could not compute a matching occurrence for cron '${cronExpr}' in timezone '${timezone}'`);
}

export function computeNextRRuleOccurrence(rruleExpr: string, timezone: string, from: Date): string {
  const rule = parseRRuleExpression(rruleExpr, timezone);
  const nextOccurrence = rule.after(from, false);

  if (!nextOccurrence) {
    throw new Error(`could not compute a matching occurrence for rrule in timezone '${timezone}'`);
  }

  return nextOccurrence.toISOString();
}

function parseRRuleExpression(expression: string, timezone: string): InstanceType<typeof RRule> {
  const parsed = rrulestr(expression, {
    forceset: false,
  });

  if (!(parsed instanceof RRule)) {
    throw new Error('rrule expression must define a single RRULE (RRuleSet is not supported)');
  }

  const options = parsed.origOptions;
  if (options.tzid && options.tzid !== timezone) {
    throw new Error(`rrule DTSTART timezone '${options.tzid}' must match schedule timezone '${timezone}'`);
  }

  return parsed;
}

function parseCronExpression(expression: string): CronFields {
  const parts = expression
    .trim()
    .split(/\s+/u)
    .filter((part) => part.length > 0);

  if (parts.length !== cronFieldCount) {
    throw new Error('cron expression must contain 5 fields: minute hour day-of-month month day-of-week');
  }

  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = parts;
  if (!minuteField || !hourField || !dayOfMonthField || !monthField || !dayOfWeekField) {
    throw new Error('cron expression contains empty fields');
  }

  return {
    minute: parseCronField(minuteField, { min: 0, max: 59 }),
    hour: parseCronField(hourField, { min: 0, max: 23 }),
    dayOfMonth: parseCronField(dayOfMonthField, { min: 1, max: 31 }),
    month: parseCronField(monthField, { min: 1, max: 12 }),
    dayOfWeek: parseCronField(dayOfWeekField, { min: 0, max: 7, normalizeDayOfWeek: true }),
  };
}

function parseCronField(
  field: string,
  options: { min: number; max: number; normalizeDayOfWeek?: boolean },
): CronFieldMatcher {
  if (field === '*') {
    return {
      allowsAll: true,
      matches: () => true,
    };
  }

  const values = new Set<number>();
  const segments = field.split(',');

  for (const segment of segments) {
    addCronSegmentValues(values, segment.trim(), options);
  }

  if (values.size === 0) {
    throw new Error(`cron field '${field}' does not include any values`);
  }

  return {
    allowsAll: false,
    matches: (value: number) => values.has(value),
  };
}

function addCronSegmentValues(
  values: Set<number>,
  rawSegment: string,
  options: { min: number; max: number; normalizeDayOfWeek?: boolean },
): void {
  if (rawSegment.length === 0) {
    throw new Error('cron field contains an empty segment');
  }

  const [rangePartRaw, stepPart] = rawSegment.split('/');
  const rangePart = rangePartRaw ?? '';
  const step = stepPart === undefined ? 1 : parsePositiveInteger(stepPart, rawSegment);

  if (rangePart === '*') {
    addRangeValues(values, options.min, options.max, step, options);
    return;
  }

  const [rangeStartPartRaw, rangeEndPart] = rangePart.split('-');
  const rangeStartPart = rangeStartPartRaw ?? '';
  const start = parseBoundedCronValue(rangeStartPart, options, rawSegment);
  const end = rangeEndPart === undefined ? start : parseBoundedCronValue(rangeEndPart, options, rawSegment);

  if (end < start) {
    throw new Error(`cron range '${rawSegment}' is invalid (end < start)`);
  }

  addRangeValues(values, start, end, step, options);
}

function addRangeValues(
  values: Set<number>,
  start: number,
  end: number,
  step: number,
  options: { normalizeDayOfWeek?: boolean },
): void {
  for (let value = start; value <= end; value += step) {
    values.add(normalizeCronValue(value, options));
  }
}

function parsePositiveInteger(rawValue: string, fieldSegment: string): number {
  if (!/^\d+$/u.test(rawValue)) {
    throw new Error(`invalid cron step '${rawValue}' in '${fieldSegment}'`);
  }

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid cron step '${rawValue}' in '${fieldSegment}'`);
  }

  return value;
}

function parseBoundedCronValue(
  rawValue: string,
  options: { min: number; max: number; normalizeDayOfWeek?: boolean },
  fieldSegment: string,
): number {
  if (!/^\d+$/u.test(rawValue)) {
    throw new Error(`invalid cron value '${rawValue}' in '${fieldSegment}'`);
  }

  const value = Number(rawValue);
  if (!Number.isInteger(value)) {
    throw new Error(`invalid cron value '${rawValue}' in '${fieldSegment}'`);
  }

  if (value < options.min || value > options.max) {
    throw new Error(
      `cron value '${rawValue}' in '${fieldSegment}' is outside allowed range ${options.min}-${options.max}`,
    );
  }

  return value;
}

function normalizeCronValue(value: number, options: { normalizeDayOfWeek?: boolean }): number {
  if (options.normalizeDayOfWeek && value === 7) {
    return 0;
  }

  return value;
}

function matchesCron(fields: CronFields, parts: TimeZoneDateParts): boolean {
  if (!fields.minute.matches(parts.minute)) {
    return false;
  }

  if (!fields.hour.matches(parts.hour)) {
    return false;
  }

  if (!fields.month.matches(parts.month)) {
    return false;
  }

  const dayOfMonthMatches = fields.dayOfMonth.matches(parts.dayOfMonth);
  const dayOfWeekMatches = fields.dayOfWeek.matches(parts.dayOfWeek);

  if (fields.dayOfMonth.allowsAll && fields.dayOfWeek.allowsAll) {
    return dayOfMonthMatches && dayOfWeekMatches;
  }

  if (fields.dayOfMonth.allowsAll) {
    return dayOfWeekMatches;
  }

  if (fields.dayOfWeek.allowsAll) {
    return dayOfMonthMatches;
  }

  return dayOfMonthMatches || dayOfWeekMatches;
}

function getTimeZoneDateParts(date: Date, timeZone: string): TimeZoneDateParts {
  const dateTimeParts = getTimeZoneDateTimeParts(date, timeZone);

  return {
    minute: dateTimeParts.minute,
    hour: dateTimeParts.hour,
    dayOfMonth: dateTimeParts.dayOfMonth,
    month: dateTimeParts.month,
    dayOfWeek: dateTimeParts.dayOfWeek,
  };
}

function formatRRuleDateTimeInTimeZone(date: Date, timeZone: string): string {
  const parts = getTimeZoneDateTimeParts(date, timeZone);

  return `${parts.year.toString().padStart(4, '0')}${parts.month.toString().padStart(2, '0')}${parts.dayOfMonth
    .toString()
    .padStart(
      2,
      '0',
    )}T${parts.hour.toString().padStart(2, '0')}${parts.minute.toString().padStart(2, '0')}${parts.second
    .toString()
    .padStart(2, '0')}`;
}

function getTimeZoneDateTimeParts(date: Date, timeZone: string): TimeZoneDateTimeParts {
  const formatter = getRRuleDateFormatter(timeZone);
  const parts = formatter.formatToParts(date);

  let year: number | null = null;
  let minute: number | null = null;
  let second: number | null = null;
  let hour: number | null = null;
  let dayOfMonth: number | null = null;
  let month: number | null = null;
  let dayOfWeek: number | null = null;

  for (const part of parts) {
    switch (part.type) {
      case 'year': {
        year = Number(part.value);
        break;
      }
      case 'minute': {
        minute = Number(part.value);
        break;
      }
      case 'second': {
        second = Number(part.value);
        break;
      }
      case 'hour': {
        hour = Number(part.value);
        break;
      }
      case 'day': {
        dayOfMonth = Number(part.value);
        break;
      }
      case 'month': {
        month = Number(part.value);
        break;
      }
      case 'weekday': {
        dayOfWeek = weekdayToIndex(part.value);
        break;
      }
    }
  }

  if (
    year === null ||
    minute === null ||
    second === null ||
    hour === null ||
    dayOfMonth === null ||
    month === null ||
    dayOfWeek === null
  ) {
    throw new Error(`failed to extract timezone date/time parts for '${timeZone}'`);
  }

  return {
    year,
    minute,
    second,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
  };
}

function getRRuleDateFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = rruleDateFormatterCache.get(timeZone);
  if (cached) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });

  rruleDateFormatterCache.set(timeZone, formatter);
  return formatter;
}

function weekdayToIndex(value: string): number {
  switch (value.toLowerCase()) {
    case 'sun':
      return 0;
    case 'mon':
      return 1;
    case 'tue':
      return 2;
    case 'wed':
      return 3;
    case 'thu':
      return 4;
    case 'fri':
      return 5;
    case 'sat':
      return 6;
    default:
      throw new Error(`unsupported weekday '${value}' in cron evaluation`);
  }
}

function alignToMinute(value: number): number {
  return Math.floor(value / minuteMs) * minuteMs;
}
