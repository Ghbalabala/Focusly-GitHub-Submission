/** Timer durations are stored in minutes. */
export interface TimerConfig {
  studyDuration: number;
  restDuration: number;
}

export type TaskStatus = 0 | 1;

export interface TaskItem {
  id: string;
  content: string;
  description: string;
  status: TaskStatus;
  createTime: string;
  tags: string[];
}

/** A daily check-in. `studyTime` is the accumulated focus time in minutes. */
export interface ClockRecord {
  date: string;
  studyTime: number;
  createTime: string;
}

/** A completed focus interval. Durations are kept in seconds for accuracy. */
export interface FocusSession {
  id: string;
  taskId?: string;
  taskContent?: string;
  tags: string[];
  durationSeconds: number;
  startedAt: string;
  completedAt: string;
  date: string;
}

/** Aggregated focus duration for a calendar date, expressed in minutes. */
export interface StatData {
  date: string;
  duration: number;
}
