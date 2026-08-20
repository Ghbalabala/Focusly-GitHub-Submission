import type { ClockRecord, FocusSession, StatData } from '../api/types';

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const UNCLASSIFIED_TAG = '未分类';

export interface TagStat {
  name: string;
  durationSeconds: number;
  durationMinutes: number;
}

/**
 * Formats a date with the browser's local calendar instead of UTC. Using
 * toISOString() here would move late-night records to a different day in
 * positive UTC offsets.
 */
export function toLocalDateKey(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseLocalDateKey(dateKey: string): Date | null {
  const match = DATE_KEY_PATTERN.exec(dateKey);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);

  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

/** Returns ascending local date keys ending at endDate (inclusive). */
export function createLocalDateSequence(
  length: number,
  endDate: Date = new Date(),
): string[] {
  const safeLength = Math.max(0, Math.trunc(length));
  const cursor = new Date(endDate);
  cursor.setHours(12, 0, 0, 0);

  return Array.from({ length: safeLength }, (_, index) => {
    const date = new Date(cursor);
    date.setDate(cursor.getDate() - (safeLength - index - 1));
    return toLocalDateKey(date);
  });
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function safeDurationSeconds(session: FocusSession): number {
  return Number.isFinite(session.durationSeconds)
    ? Math.max(0, session.durationSeconds)
    : 0;
}

/** Resolves legacy/malformed date fields without throwing. */
export function getSessionDateKey(session: FocusSession): string | null {
  if (parseLocalDateKey(session.date)) return session.date;

  const timestamp = session.completedAt || session.startedAt;
  if (!timestamp) return null;

  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : toLocalDateKey(date);
}

export function sumSessionDurationSeconds(
  sessions: readonly FocusSession[],
): number {
  return sessions.reduce(
    (total, session) => total + safeDurationSeconds(session),
    0,
  );
}

/**
 * Produces a history-wide total without double-counting a day's check-in
 * snapshot and its underlying sessions. This also preserves totals migrated
 * from older data that contains check-ins but no individual sessions.
 */
export function calculateTotalFocusSeconds(
  sessions: readonly FocusSession[],
  clockRecords: readonly ClockRecord[] = [],
): number {
  const secondsByDate = new Map<string, number>();

  sessions.forEach((session) => {
    const date = getSessionDateKey(session);
    if (!date) return;
    secondsByDate.set(
      date,
      (secondsByDate.get(date) ?? 0) + safeDurationSeconds(session),
    );
  });

  clockRecords.forEach((record) => {
    if (!parseLocalDateKey(record.date) || !Number.isFinite(record.studyTime)) return;
    secondsByDate.set(
      record.date,
      Math.max(secondsByDate.get(record.date) ?? 0, Math.max(0, record.studyTime) * 60),
    );
  });

  return Array.from(secondsByDate.values()).reduce((total, seconds) => total + seconds, 0);
}

export function getSessionMinutesForDate(
  sessions: readonly FocusSession[],
  dateKey: string,
): number {
  const seconds = sessions.reduce((total, session) => {
    return getSessionDateKey(session) === dateKey
      ? total + safeDurationSeconds(session)
      : total;
  }, 0);

  return round(seconds / 60);
}

/** Aggregates sessions into a complete, gap-free local-day series. */
export function aggregateSessionsByDate(
  sessions: readonly FocusSession[],
  length: number,
  endDate: Date = new Date(),
): StatData[] {
  const dates = createLocalDateSequence(length, endDate);
  const secondsByDate = new Map(dates.map((date) => [date, 0]));

  sessions.forEach((session) => {
    const date = getSessionDateKey(session);
    if (!date || !secondsByDate.has(date)) return;
    secondsByDate.set(
      date,
      (secondsByDate.get(date) ?? 0) + safeDurationSeconds(session),
    );
  });

  return dates.map((date) => ({
    date,
    duration: round((secondsByDate.get(date) ?? 0) / 60),
  }));
}

/** Fills missing API dates and combines accidental duplicate date rows. */
export function fillStatDateSequence(
  stats: readonly StatData[],
  length: number,
  endDate: Date = new Date(),
): StatData[] {
  const dates = createLocalDateSequence(length, endDate);
  const validDates = new Set(dates);
  const minutesByDate = new Map(dates.map((date) => [date, 0]));

  stats.forEach((item) => {
    if (!validDates.has(item.date) || !Number.isFinite(item.duration)) return;
    minutesByDate.set(
      item.date,
      (minutesByDate.get(item.date) ?? 0) + Math.max(0, item.duration),
    );
  });

  return dates.map((date) => ({
    date,
    duration: round(minutesByDate.get(date) ?? 0),
  }));
}

/**
 * Splits a multi-tag session evenly so a pie chart never double-counts the
 * same focused time. Sessions without tags are grouped as "未分类".
 */
export function aggregateSessionsByTag(
  sessions: readonly FocusSession[],
): TagStat[] {
  const secondsByTag = new Map<string, number>();

  sessions.forEach((session) => {
    const durationSeconds = safeDurationSeconds(session);
    if (durationSeconds <= 0) return;

    const uniqueTags = Array.from(new Set(
      session.tags.map((tag) => tag.trim()).filter(Boolean),
    ));
    const tags = uniqueTags.length > 0 ? uniqueTags : [UNCLASSIFIED_TAG];
    const secondsPerTag = durationSeconds / tags.length;

    tags.forEach((tag) => {
      secondsByTag.set(tag, (secondsByTag.get(tag) ?? 0) + secondsPerTag);
    });
  });

  return Array.from(secondsByTag, ([name, durationSeconds]) => ({
    name,
    durationSeconds: round(durationSeconds),
    durationMinutes: round(durationSeconds / 60),
  })).sort((left, right) => (
    right.durationSeconds - left.durationSeconds
    || left.name.localeCompare(right.name, 'zh-CN')
  ));
}

/**
 * Calculates the current local-day streak. Before today's check-in, a streak
 * ending yesterday is kept alive; once neither today nor yesterday exists the
 * current streak is zero.
 */
export function calculateCurrentStreak(
  dateKeys: readonly string[],
  today: Date = new Date(),
): number {
  const validDates = new Set(
    dateKeys.filter((dateKey) => parseLocalDateKey(dateKey) !== null),
  );
  const cursor = new Date(today);
  cursor.setHours(12, 0, 0, 0);

  if (!validDates.has(toLocalDateKey(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
  }

  let streak = 0;
  while (validDates.has(toLocalDateKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  return streak;
}
