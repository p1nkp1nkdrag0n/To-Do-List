export function pad(value) {
  return String(value).padStart(2, "0");
}

export function todayDate() {
  return formatDate(new Date());
}

export function parseDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addDays(dateValue, amount) {
  const date = typeof dateValue === "string" ? parseDate(dateValue) : new Date(dateValue);
  date.setDate(date.getDate() + amount);
  return formatDate(date);
}

export function addMonths(dateValue, amount) {
  const date = typeof dateValue === "string" ? parseDate(dateValue) : new Date(dateValue);
  date.setMonth(date.getMonth() + amount);
  return formatDate(date);
}

export function addYears(dateValue, amount) {
  const date = typeof dateValue === "string" ? parseDate(dateValue) : new Date(dateValue);
  date.setFullYear(date.getFullYear() + amount);
  return formatDate(date);
}

export function daysBetween(start, end) {
  const a = parseDate(start);
  const b = parseDate(end);
  return Math.round((b - a) / 86400000);
}

export function monthName(date) {
  return `${date.getMonth() + 1}月`;
}

export function getPeriod(scale, selectedDate) {
  const selected = parseDate(selectedDate);
  if (scale === "week") {
    const day = selected.getDay() || 7;
    const start = new Date(selected);
    start.setDate(selected.getDate() - day + 1);
    const startDate = formatDate(start);
    return {
      scale,
      start: startDate,
      endExclusive: addDays(startDate, 7),
      cells: Array.from({ length: 7 }, (_, index) => {
        const date = addDays(startDate, index);
        return { key: date, label: `${parseDate(date).getDate()}日`, subLabel: weekLabel(parseDate(date)), start: date, endExclusive: addDays(date, 1), days: 1 };
      })
    };
  }
  if (scale === "month") {
    const start = new Date(selected.getFullYear(), selected.getMonth(), 1);
    const end = new Date(selected.getFullYear(), selected.getMonth() + 1, 1);
    const startDate = formatDate(start);
    const endDate = formatDate(end);
    const total = daysBetween(startDate, endDate);
    return {
      scale,
      start: startDate,
      endExclusive: endDate,
      cells: Array.from({ length: total }, (_, index) => {
        const date = addDays(startDate, index);
        const parsed = parseDate(date);
        return { key: date, label: String(parsed.getDate()), subLabel: weekLabel(parsed), start: date, endExclusive: addDays(date, 1), days: 1 };
      })
    };
  }
  const start = `${selected.getFullYear()}-01-01`;
  const endExclusive = `${selected.getFullYear() + 1}-01-01`;
  return {
    scale,
    start,
    endExclusive,
    cells: Array.from({ length: 12 }, (_, index) => {
      const monthStart = formatDate(new Date(selected.getFullYear(), index, 1));
      const monthEnd = formatDate(new Date(selected.getFullYear(), index + 1, 1));
      return { key: monthStart, label: monthName(parseDate(monthStart)), subLabel: "", start: monthStart, endExclusive: monthEnd, days: daysBetween(monthStart, monthEnd) };
    })
  };
}

export function shiftSelectedDate(scale, selectedDate, amount) {
  if (scale === "week") {
    return addDays(selectedDate, amount * 7);
  }
  if (scale === "month") {
    return addMonths(selectedDate, amount);
  }
  if (scale === "year") {
    return addYears(selectedDate, amount);
  }
  return addDays(selectedDate, amount);
}

export function rangePosition(startDate, endDate, period) {
  const visibleStart = startDate < period.start ? period.start : startDate;
  const endExclusive = addDays(endDate, 1);
  const visibleEnd = endExclusive > period.endExclusive ? period.endExclusive : endExclusive;
  const total = daysBetween(period.start, period.endExclusive);
  const widthDays = daysBetween(visibleStart, visibleEnd);
  if (widthDays <= 0) {
    return null;
  }
  return {
    left: `${(daysBetween(period.start, visibleStart) / total) * 100}%`,
    width: `${(widthDays / total) * 100}%`
  };
}

export function weekLabel(date) {
  return ["日", "一", "二", "三", "四", "五", "六"][date.getDay()];
}

export function dateTimeLocal(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function minutesFromDateTime(value) {
  const [, time = "00:00"] = value.split("T");
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

export function setMinutesOnDate(dateValue, minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${dateValue}T${pad(hours)}:${pad(mins)}`;
}

export function eventDate(value) {
  return value.slice(0, 10);
}
