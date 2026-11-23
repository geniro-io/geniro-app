function dayStamp(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(day: Date, now: Date): string {
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const stamp = dayStamp(day);
  if (stamp === dayStamp(now)) {
    return 'Today';
  }
  if (stamp === dayStamp(yesterday)) {
    return 'Yesterday';
  }
  return day.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(day.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

export interface TimelineDay<T> {
  key: string;
  label: string;
  events: T[];
}

export function groupTimelineDays<T extends { at: string }>(
  events: readonly T[],
  now: number,
): TimelineDay<T>[] {
  const nowDate = new Date(now);
  const days = new Map<string, TimelineDay<T>>();
  for (const event of events) {
    const at = new Date(event.at);
    const key = dayStamp(at);
    const day = days.get(key) ?? {
      key,
      label: dayLabel(at, nowDate),
      events: [],
    };
    day.events.push(event);
    days.set(key, day);
  }
  return [...days.values()];
}
