export interface WeeklySlot {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
}

export function toggleHalfHourSlot(
  slots: readonly WeeklySlot[],
  dayOfWeek: number,
  startMinute: number,
): WeeklySlot[] {
  const endMinute = startMinute + 30;
  const selected = slots.some(
    (slot) =>
      slot.dayOfWeek === dayOfWeek &&
      slot.startMinute <= startMinute &&
      slot.endMinute >= endMinute,
  );

  const cells = new Set<string>();
  for (const slot of slots) {
    for (let minute = slot.startMinute; minute < slot.endMinute; minute += 30) {
      cells.add(`${slot.dayOfWeek}:${minute}`);
    }
  }
  const key = `${dayOfWeek}:${startMinute}`;
  if (selected) cells.delete(key);
  else cells.add(key);

  const ordered: WeeklySlot[] = [...cells]
    .map((cell) => {
      const [day, minute] = cell.split(":").map(Number);
      return { dayOfWeek: day!, startMinute: minute!, endMinute: minute! + 30 };
    })
    .sort((left, right) =>
      left.dayOfWeek === right.dayOfWeek
        ? left.startMinute - right.startMinute
        : left.dayOfWeek - right.dayOfWeek,
    );

  return ordered.reduce<WeeklySlot[]>((merged, cell) => {
    const previous = merged.at(-1);
    if (
      previous !== undefined &&
      previous.dayOfWeek === cell.dayOfWeek &&
      previous.endMinute === cell.startMinute
    ) {
      previous.endMinute = cell.endMinute;
    } else {
      merged.push({ ...cell });
    }
    return merged;
  }, []);
}

export function slotContains(
  slots: readonly WeeklySlot[],
  dayOfWeek: number,
  minute: number,
): boolean {
  return slots.some(
    (slot) =>
      slot.dayOfWeek === dayOfWeek &&
      slot.startMinute <= minute &&
      slot.endMinute > minute,
  );
}

export function setHalfHourSlot(
  slots: readonly WeeklySlot[],
  dayOfWeek: number,
  startMinute: number,
  available: boolean,
): WeeklySlot[] {
  return slotContains(slots, dayOfWeek, startMinute) === available
    ? slots.map((slot) => ({ ...slot }))
    : toggleHalfHourSlot(slots, dayOfWeek, startMinute);
}
