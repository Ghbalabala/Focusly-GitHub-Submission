import type { AxiosRequestConfig } from 'axios';
import { tryRemoteRequest } from '../utils/request';
import {
  STORAGE_KEYS,
  readJson,
  writeJson,
} from '../utils/storage';
import type {
  ClockRecord,
  FocusSession,
  StatData,
  TaskItem,
  TaskStatus,
  TimerConfig,
} from './types';

export { STORAGE_KEYS, subscribeDataChanges } from '../utils/storage';
export type {
  DataChangeEvent,
  DataChangeHandler,
  DataChangeSource,
  StorageKey,
} from '../utils/storage';
export type { ClockRecord, FocusSession, StatData, TaskItem, TaskStatus, TimerConfig } from './types';

const DEFAULT_TIMER_CONFIG: TimerConfig = {
  studyDuration: 25,
  restDuration: 5,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isNonNegativeNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isPositiveNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

const isTaskStatus = (value: unknown): value is TaskStatus => value === 0 || value === 1;

const normalizeTags = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isNonEmptyString).map((tag) => tag.trim()))];
};

const isDateKey = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const toDateKey = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const recentDateKeys = (days: number): string[] => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (days - index - 1));
    return toDateKey(date);
  });
};

const createId = (prefix: string): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const normalizeTimerConfig = (value: unknown): TimerConfig | null => {
  if (!isRecord(value)) return null;
  const { studyDuration, restDuration } = value;
  if (!isPositiveNumber(studyDuration) || !isPositiveNumber(restDuration)) return null;
  return { studyDuration, restDuration };
};

const normalizeTask = (value: unknown): TaskItem | null => {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isNonEmptyString(value.content)) {
    return null;
  }

  return {
    id: value.id,
    content: value.content.trim(),
    description: typeof value.description === 'string' ? value.description.trim() : '',
    status: isTaskStatus(value.status) ? value.status : 0,
    createTime: isNonEmptyString(value.createTime) ? value.createTime : new Date().toISOString(),
    tags: normalizeTags(value.tags),
  };
};

const normalizeTaskList = (value: unknown): TaskItem[] | null => {
  if (!Array.isArray(value)) return null;
  const tasks = value.map(normalizeTask).filter((task): task is TaskItem => task !== null);
  const seen = new Set<string>();
  return tasks.filter((task) => {
    if (seen.has(task.id)) return false;
    seen.add(task.id);
    return true;
  });
};

const normalizeClockRecord = (value: unknown): ClockRecord | null => {
  if (!isRecord(value) || !isDateKey(value.date) || !isNonNegativeNumber(value.studyTime)) {
    return null;
  }

  return {
    date: value.date,
    studyTime: value.studyTime,
    createTime: isNonEmptyString(value.createTime) ? value.createTime : new Date().toISOString(),
  };
};

const normalizeClockList = (value: unknown): ClockRecord[] | null => {
  if (!Array.isArray(value)) return null;
  const records = value
    .map(normalizeClockRecord)
    .filter((record): record is ClockRecord => record !== null)
    .sort((left, right) => right.date.localeCompare(left.date));
  const seen = new Set<string>();
  return records.filter((record) => {
    if (seen.has(record.date)) return false;
    seen.add(record.date);
    return true;
  });
};

const normalizeIsoTime = (value: unknown): string | null => {
  if (!isNonEmptyString(value) || Number.isNaN(Date.parse(value))) return null;
  return value;
};

const normalizeFocusSession = (value: unknown): FocusSession | null => {
  if (!isRecord(value) || !isNonEmptyString(value.id)) return null;

  const legacyDuration = isNonNegativeNumber(value.duration) ? value.duration * 60 : null;
  const durationSeconds = isNonNegativeNumber(value.durationSeconds)
    ? value.durationSeconds
    : legacyDuration;
  if (durationSeconds === null || durationSeconds <= 0) return null;

  const explicitStartedAt = normalizeIsoTime(value.startedAt) ?? normalizeIsoTime(value.startTime);
  const explicitCompletedAt = normalizeIsoTime(value.completedAt) ?? normalizeIsoTime(value.endTime);
  let startedAt = explicitStartedAt;
  let completedAt = explicitCompletedAt;

  if (!startedAt && completedAt) {
    startedAt = new Date(Date.parse(completedAt) - durationSeconds * 1000).toISOString();
  }
  if (!completedAt && startedAt) {
    completedAt = new Date(Date.parse(startedAt) + durationSeconds * 1000).toISOString();
  }
  if (!startedAt || !completedAt) return null;
  if (Date.parse(completedAt) < Date.parse(startedAt)) return null;

  const date = isDateKey(value.date) ? value.date : toDateKey(new Date(completedAt));
  if (!isDateKey(date)) return null;

  return {
    id: value.id,
    ...(isNonEmptyString(value.taskId) ? { taskId: value.taskId } : {}),
    ...(isNonEmptyString(value.taskContent) ? { taskContent: value.taskContent.trim() } : {}),
    tags: normalizeTags(value.tags),
    durationSeconds,
    startedAt,
    completedAt,
    date,
  };
};

const normalizeFocusSessionList = (value: unknown): FocusSession[] | null => {
  if (!Array.isArray(value)) return null;
  const sessions = value
    .map(normalizeFocusSession)
    .filter((session): session is FocusSession => session !== null)
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt));
  const seen = new Set<string>();
  return sessions.filter((session) => {
    if (seen.has(session.id)) return false;
    seen.add(session.id);
    return true;
  });
};

const normalizeStat = (value: unknown): StatData | null => {
  if (!isRecord(value) || !isDateKey(value.date) || !isNonNegativeNumber(value.duration)) {
    return null;
  }
  return { date: value.date, duration: value.duration };
};

const normalizeStatList = (value: unknown): StatData[] | null => {
  if (!Array.isArray(value)) return null;
  return value.map(normalizeStat).filter((stat): stat is StatData => stat !== null);
};

const readLocalTasks = (): TaskItem[] =>
  normalizeTaskList(readJson<unknown>(STORAGE_KEYS.TASKS, [])) ?? [];

const readLocalClocks = (): ClockRecord[] =>
  normalizeClockList(readJson<unknown>(STORAGE_KEYS.CLOCK_RECORDS, [])) ?? [];

const readLocalSessions = (): FocusSession[] =>
  normalizeFocusSessionList(readJson<unknown>(STORAGE_KEYS.FOCUS_SESSIONS, [])) ?? [];

const syncMutation = async (config: AxiosRequestConfig): Promise<void> => {
  await tryRemoteRequest<unknown>(config);
};

const getRemoteList = async <T>(
  config: AxiosRequestConfig,
  normalize: (value: unknown) => T[] | null,
): Promise<T[] | null> => {
  const remote = await tryRemoteRequest<unknown>(config);
  return remote === undefined ? null : normalize(remote);
};

// Timer configuration
export async function getTimerConfig(): Promise<TimerConfig> {
  const local =
    normalizeTimerConfig(readJson<unknown>(STORAGE_KEYS.TIMER_CONFIG, DEFAULT_TIMER_CONFIG)) ??
    DEFAULT_TIMER_CONFIG;
  const remote = await tryRemoteRequest<unknown>({ url: '/timer/config', method: 'GET' });
  const normalizedRemote = normalizeTimerConfig(remote);
  if (!normalizedRemote) return local;

  writeJson(STORAGE_KEYS.TIMER_CONFIG, normalizedRemote);
  return normalizedRemote;
}

export async function updateTimerConfig(data: TimerConfig): Promise<TimerConfig> {
  const config = normalizeTimerConfig(data);
  if (!config) throw new TypeError('Study and rest durations must be positive numbers.');

  writeJson(STORAGE_KEYS.TIMER_CONFIG, config);
  await syncMutation({ url: '/timer/config', method: 'PUT', data: config });
  return config;
}

// Tasks
export async function getTaskList(): Promise<TaskItem[]> {
  const local = readLocalTasks();
  const remote = await getRemoteList(
    { url: '/task/list', method: 'GET' },
    normalizeTaskList,
  );
  if (!remote) return local;

  writeJson(STORAGE_KEYS.TASKS, remote);
  return remote;
}

export async function addTask(data: Partial<TaskItem>): Promise<TaskItem> {
  if (!isNonEmptyString(data.content)) throw new TypeError('Task content cannot be empty.');

  const tasks = readLocalTasks();
  const requestedId = isNonEmptyString(data.id) ? data.id : createId('task');
  const id = tasks.some((task) => task.id === requestedId) ? createId('task') : requestedId;
  const task: TaskItem = {
    id,
    content: data.content.trim(),
    description: typeof data.description === 'string' ? data.description.trim() : '',
    status: isTaskStatus(data.status) ? data.status : 0,
    createTime: isNonEmptyString(data.createTime) ? data.createTime : new Date().toISOString(),
    tags: normalizeTags(data.tags),
  };

  writeJson(STORAGE_KEYS.TASKS, [task, ...tasks]);
  await syncMutation({ url: '/task/add', method: 'POST', data: task });
  return task;
}

export async function updateTask(data: TaskItem): Promise<TaskItem> {
  const task = normalizeTask(data);
  if (!task) throw new TypeError('The task is invalid.');

  const tasks = readLocalTasks();
  const index = tasks.findIndex((item) => item.id === task.id);
  if (index < 0) throw new Error(`Task ${task.id} does not exist.`);

  tasks[index] = task;
  writeJson(STORAGE_KEYS.TASKS, tasks);
  await syncMutation({ url: '/task/update', method: 'PUT', data: task });
  return task;
}

export async function deleteTask(id: string): Promise<void> {
  if (!isNonEmptyString(id)) throw new TypeError('Task id cannot be empty.');

  const tasks = readLocalTasks().filter((task) => task.id !== id);
  writeJson(STORAGE_KEYS.TASKS, tasks);
  await syncMutation({ url: '/task/delete', method: 'DELETE', params: { id } });
}

export async function clearTasks(): Promise<void> {
  const existingTasks = readLocalTasks();
  writeJson(STORAGE_KEYS.TASKS, []);
  await Promise.all(existingTasks.map((task) => syncMutation({
    url: '/task/delete',
    method: 'DELETE',
    params: { id: task.id },
  })));
}

// Daily check-ins
export async function getClockList(): Promise<ClockRecord[]> {
  const local = readLocalClocks();
  const remote = await getRemoteList(
    { url: '/clock/list', method: 'GET' },
    normalizeClockList,
  );
  if (!remote) return local;

  writeJson(STORAGE_KEYS.CLOCK_RECORDS, remote);
  return remote;
}

export async function addClock(data: ClockRecord): Promise<ClockRecord> {
  const record = normalizeClockRecord(data);
  if (!record) throw new TypeError('The clock record is invalid.');

  const records = readLocalClocks();
  if (records.some((item) => item.date === record.date)) {
    throw new Error(`A clock record for ${record.date} already exists.`);
  }

  const nextRecords = [record, ...records].sort((left, right) =>
    right.date.localeCompare(left.date),
  );
  writeJson(STORAGE_KEYS.CLOCK_RECORDS, nextRecords);
  await syncMutation({ url: '/clock/add', method: 'POST', data: record });
  return record;
}

// Completed focus sessions
export async function getFocusSessions(): Promise<FocusSession[]> {
  const local = readLocalSessions();
  const remote = await getRemoteList(
    { url: '/focus/session/list', method: 'GET' },
    normalizeFocusSessionList,
  );
  if (!remote) return local;

  writeJson(STORAGE_KEYS.FOCUS_SESSIONS, remote);
  return remote;
}

export const getFocusSessionList = getFocusSessions;

export async function addFocusSession(data: FocusSession): Promise<FocusSession> {
  const session = normalizeFocusSession(data);
  if (!session) throw new TypeError('The focus session is invalid.');

  const sessions = readLocalSessions();
  const existing = sessions.find((item) => item.id === session.id);
  if (existing) return existing;

  const nextSessions = [session, ...sessions].sort((left, right) =>
    right.completedAt.localeCompare(left.completedAt),
  );
  writeJson(STORAGE_KEYS.FOCUS_SESSIONS, nextSessions);
  await syncMutation({ url: '/focus/session/add', method: 'POST', data: session });
  return session;
}

const buildStats = (days: number, storageKey: string): StatData[] => {
  const dates = recentDateKeys(days);
  const allowedDates = new Set(dates);
  const cached = normalizeStatList(readJson<unknown>(storageKey, [])) ?? [];
  const cachedByDate = new Map(cached.map((item) => [item.date, item.duration]));
  const sessionSecondsByDate = new Map<string, number>();

  for (const session of readLocalSessions()) {
    if (!allowedDates.has(session.date)) continue;
    sessionSecondsByDate.set(
      session.date,
      (sessionSecondsByDate.get(session.date) ?? 0) + session.durationSeconds,
    );
  }

  const clockMinutesByDate = new Map(
    readLocalClocks()
      .filter((record) => allowedDates.has(record.date))
      .map((record) => [record.date, record.studyTime]),
  );

  return dates.map((date) => {
    const sessionMinutes = (sessionSecondsByDate.get(date) ?? 0) / 60;
    const duration = Math.max(
      cachedByDate.get(date) ?? 0,
      clockMinutesByDate.get(date) ?? 0,
      sessionMinutes,
    );
    return { date, duration: Math.round(duration * 100) / 100 };
  });
};

const getStats = async (
  days: number,
  storageKey: string,
  url: string,
): Promise<StatData[]> => {
  const local = buildStats(days, storageKey);
  const remote = await getRemoteList({ url, method: 'GET' }, normalizeStatList);
  if (remote) {
    const remoteByDate = new Map(remote.map((item) => [item.date, item.duration]));
    const merged = local.map((item) => ({
      date: item.date,
      duration: Math.max(item.duration, remoteByDate.get(item.date) ?? 0),
    }));
    writeJson(storageKey, merged);
    return merged;
  }

  writeJson(storageKey, local);
  return local;
};

export const getWeekStats = (): Promise<StatData[]> =>
  getStats(7, STORAGE_KEYS.WEEK_STATS, '/stat/week');

export const getMonthStats = (): Promise<StatData[]> =>
  getStats(30, STORAGE_KEYS.MONTH_STATS, '/stat/month');
