export type WeeklyRecurrence = {
  frequency: "weekly";
  intervalCount: number;
  dayOfWeek: number;
};

export type MonthlyRecurrence = {
  frequency: "monthly";
  intervalCount: number;
  dayOfMonth: number;
};

export type RecurrencePattern = WeeklyRecurrence | MonthlyRecurrence;

export type RecurrenceCursor = RecurrencePattern & {
  nextOccurrenceOn: string;
  endsOn: string | null;
};

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

function parseIsoDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    throw new Error(`Invalid ISO date: ${value}`);
  }
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  if (formatIsoDate(date) !== value) {
    throw new Error(`Invalid ISO date: ${value}`);
  }
  return date;
}

function formatIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function monthlyOccurrence(
  year: number,
  monthIndex: number,
  dayOfMonth: number,
): string {
  const normalized = new Date(Date.UTC(year, monthIndex, 1));
  const day = Math.min(
    dayOfMonth,
    daysInUtcMonth(normalized.getUTCFullYear(), normalized.getUTCMonth()),
  );
  return formatIsoDate(
    new Date(Date.UTC(normalized.getUTCFullYear(), normalized.getUTCMonth(), day)),
  );
}

export function firstOccurrenceOnOrAfter(
  startsOn: string,
  pattern: RecurrencePattern,
): string {
  const start = parseIsoDate(startsOn);
  if (pattern.frequency === "weekly") {
    const offset = (pattern.dayOfWeek - start.getUTCDay() + 7) % 7;
    return formatIsoDate(new Date(start.getTime() + offset * DAY_MILLISECONDS));
  }

  let candidate = monthlyOccurrence(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    pattern.dayOfMonth,
  );
  if (candidate < startsOn) {
    candidate = monthlyOccurrence(
      start.getUTCFullYear(),
      start.getUTCMonth() + pattern.intervalCount,
      pattern.dayOfMonth,
    );
  }
  return candidate;
}

export function nextOccurrenceAfter(
  occurrenceOn: string,
  pattern: RecurrencePattern,
): string {
  const current = parseIsoDate(occurrenceOn);
  if (pattern.frequency === "weekly") {
    return formatIsoDate(
      new Date(
        current.getTime() + pattern.intervalCount * 7 * DAY_MILLISECONDS,
      ),
    );
  }
  return monthlyOccurrence(
    current.getUTCFullYear(),
    current.getUTCMonth() + pattern.intervalCount,
    pattern.dayOfMonth,
  );
}

export function enumerateOccurrences(
  cursor: RecurrenceCursor,
  throughDate: string,
  limit = 100,
): {
  dates: string[];
  nextOccurrenceOn: string;
  exhausted: boolean;
} {
  parseIsoDate(throughDate);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("The generation limit must be a positive integer.");
  }

  const dates: string[] = [];
  let candidate = cursor.nextOccurrenceOn;
  while (
    candidate <= throughDate &&
    (cursor.endsOn === null || candidate <= cursor.endsOn)
  ) {
    if (dates.length >= limit) {
      throw new Error(`Recurring task generation exceeded the limit of ${limit}.`);
    }
    dates.push(candidate);
    candidate = nextOccurrenceAfter(candidate, cursor);
  }

  return {
    dates,
    nextOccurrenceOn: candidate,
    exhausted: cursor.endsOn !== null && candidate > cursor.endsOn,
  };
}
