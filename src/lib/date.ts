const DAY_MS = 86_400_000;

function parseDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function addDays(value: string, amount: number): string {
  return formatDate(new Date(parseDate(value).getTime() + amount * DAY_MS));
}

export function daysBetween(start: string, end: string): number {
  return Math.round((parseDate(end).getTime() - parseDate(start).getTime()) / DAY_MS);
}

export function inclusiveDays(start: string, end: string): string[] {
  const count = Math.max(0, daysBetween(start, end)) + 1;
  return Array.from({ length: count }, (_, index) => addDays(start, index));
}

export function projectDateRange(
  values: ReadonlyArray<string | null | undefined>,
  fallbackToday = todayIso(),
): { start: string; end: string } {
  const dates = values.filter((value): value is string => Boolean(value)).sort();
  if (dates.length === 0) {
    return { start: addDays(fallbackToday, -14), end: addDays(fallbackToday, 42) };
  }
  return {
    start: addDays(dates[0]!, -7),
    end: addDays(dates.at(-1)!, 7),
  };
}

export function formatMonthDay(value: string): string {
  const [, month, day] = value.split("-");
  return `${Number(month)}/${Number(day)}`;
}

export function formatDateChinese(value: string): string {
  const [year, month, day] = value.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}

export function weekdayChinese(value: string): string {
  return ["日", "一", "二", "三", "四", "五", "六"][parseDate(value).getUTCDay()]!;
}

export function minutesToTime(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function timeToMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour! * 60 + minute!;
}
