import { computed, onMounted, onUnmounted, ref } from 'vue';
import { getTimerConfig, updateTimerConfig } from '../api';
import type { TimerConfig } from '../api/types';
import {
  clampRemainingSeconds,
  formatDuration,
  timerProgress,
  type TimerMode,
  type TimerStatus,
} from './timerMath';

const RUNTIME_KEY = 'focusly_timer_runtime_v1';
const TIMER_CHANNEL = 'focusly_timer_channel_v1';
const DEFAULT_CONFIG: TimerConfig = { studyDuration: 25, restDuration: 5 };

interface TimerRuntimeSnapshot {
  version: 1;
  revision: number;
  sourceId: string;
  updatedAt: number;
  mode: TimerMode;
  status: TimerStatus;
  remainingSeconds: number;
  totalSeconds: number;
  deadline: number | null;
  sessionId: string | null;
  startedAt: string | null;
  lastCompletedSessionId: string | null;
}

interface TimerWorkerMessage {
  type: 'tick' | 'elapsed';
  sessionId: string;
  remainingMs?: number;
}

interface TimerChannelMessage {
  type: 'state';
  snapshot: TimerRuntimeSnapshot;
}

export interface TimerCompletion {
  sessionId: string;
  mode: TimerMode;
  durationSeconds: number;
  startedAt: string;
  completedAt: string;
  cause: 'live' | 'restore';
}

interface UseTimerOptions {
  onComplete?: (completion: TimerCompletion) => void | Promise<void>;
}

interface LockManagerLike {
  request: <T>(name: string, callback: () => T | Promise<T>) => Promise<T>;
}

const makeId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const isMode = (value: unknown): value is TimerMode => value === 'study' || value === 'rest';
const isStatus = (value: unknown): value is TimerStatus =>
  value === 'idle' || value === 'running' || value === 'paused';

const parseSnapshot = (raw: string | null): TimerRuntimeSnapshot | null => {
  if (!raw) return null;

  try {
    const value = JSON.parse(raw) as Partial<TimerRuntimeSnapshot>;
    if (
      value.version !== 1 ||
      !isMode(value.mode) ||
      !isStatus(value.status) ||
      !Number.isFinite(value.revision) ||
      !Number.isFinite(value.updatedAt) ||
      !Number.isFinite(value.remainingSeconds) ||
      !Number.isFinite(value.totalSeconds) ||
      typeof value.sourceId !== 'string'
    ) {
      return null;
    }

    const deadline = typeof value.deadline === 'number' && Number.isFinite(value.deadline)
      ? value.deadline
      : null;

    return {
      version: 1,
      revision: Math.max(0, Math.floor(value.revision ?? 0)),
      sourceId: value.sourceId,
      updatedAt: value.updatedAt ?? Date.now(),
      mode: value.mode,
      status: value.status,
      remainingSeconds: Math.max(0, Math.ceil(value.remainingSeconds ?? 0)),
      totalSeconds: Math.max(1, Math.ceil(value.totalSeconds ?? 1)),
      deadline,
      sessionId: typeof value.sessionId === 'string' ? value.sessionId : null,
      startedAt: typeof value.startedAt === 'string' ? value.startedAt : null,
      lastCompletedSessionId:
        typeof value.lastCompletedSessionId === 'string' ? value.lastCompletedSessionId : null,
    };
  } catch {
    return null;
  }
};

const sanitizeConfig = (value: TimerConfig): TimerConfig => ({
  studyDuration:
    Number.isInteger(value.studyDuration) && value.studyDuration >= 1 && value.studyDuration <= 180
      ? value.studyDuration
      : DEFAULT_CONFIG.studyDuration,
  restDuration:
    Number.isInteger(value.restDuration) && value.restDuration >= 1 && value.restDuration <= 60
      ? value.restDuration
      : DEFAULT_CONFIG.restDuration,
});

export function useTimer(options: UseTimerOptions = {}) {
  const tabId = makeId();
  const config = ref<TimerConfig>({ ...DEFAULT_CONFIG });
  const mode = ref<TimerMode>('study');
  const status = ref<TimerStatus>('idle');
  const remainingSeconds = ref(DEFAULT_CONFIG.studyDuration * 60);
  const totalSeconds = ref(DEFAULT_CONFIG.studyDuration * 60);
  const deadline = ref<number | null>(null);
  const sessionId = ref<string | null>(null);
  const startedAt = ref<string | null>(null);
  const revision = ref(0);
  const lastCompletedSessionId = ref<string | null>(null);
  const ready = ref(false);
  const notice = ref('设置一个目标，开始今天的专注。');
  const storageWarning = ref('');

  let worker: Worker | null = null;
  let fallbackInterval: number | null = null;
  let channel: BroadcastChannel | null = null;
  let completionInFlight: string | null = null;

  const secondsForMode = (targetMode = mode.value) =>
    (targetMode === 'study' ? config.value.studyDuration : config.value.restDuration) * 60;

  const formattedTime = computed(() => formatDuration(remainingSeconds.value));
  const progress = computed(() => timerProgress(remainingSeconds.value, totalSeconds.value));
  const isRunning = computed(() => status.value === 'running');
  const isPaused = computed(() => status.value === 'paused');

  const updateTitle = () => {
    const modeLabel = mode.value === 'study' ? '专注' : '休息';
    const pauseLabel = status.value === 'paused' ? '已暂停 · ' : '';
    document.title = `${pauseLabel}${formattedTime.value} · ${modeLabel} | Focusly`;
  };

  const readStoredSnapshot = () => {
    try {
      return parseSnapshot(localStorage.getItem(RUNTIME_KEY));
    } catch {
      storageWarning.value = '浏览器禁止了本地存储，本次计时将无法在刷新后恢复。';
      return null;
    }
  };

  const currentSnapshot = (nextRevision: number): TimerRuntimeSnapshot => ({
    version: 1,
    revision: nextRevision,
    sourceId: tabId,
    updatedAt: Date.now(),
    mode: mode.value,
    status: status.value,
    remainingSeconds: remainingSeconds.value,
    totalSeconds: totalSeconds.value,
    deadline: deadline.value,
    sessionId: sessionId.value,
    startedAt: startedAt.value,
    lastCompletedSessionId: lastCompletedSessionId.value,
  });

  const writeSnapshot = (broadcast = true) => {
    const storedRevision = readStoredSnapshot()?.revision ?? 0;
    revision.value = Math.max(revision.value, storedRevision) + 1;
    const snapshot = currentSnapshot(revision.value);

    try {
      localStorage.setItem(RUNTIME_KEY, JSON.stringify(snapshot));
      storageWarning.value = '';
    } catch {
      storageWarning.value = '本地存储不可用，请不要在计时中刷新页面。';
    }

    if (broadcast) {
      channel?.postMessage({ type: 'state', snapshot } satisfies TimerChannelMessage);
    }
    updateTitle();
    return snapshot;
  };

  const stopFallback = () => {
    if (fallbackInterval !== null) {
      window.clearInterval(fallbackInterval);
      fallbackInterval = null;
    }
  };

  const handleElapsed = async (elapsedSessionId: string, cause: 'live' | 'restore') => {
    if (completionInFlight === elapsedSessionId) return;
    completionInFlight = elapsedSessionId;

    const finalize = async () => {
      const authoritative = readStoredSnapshot();
      if (
        authoritative &&
        (authoritative.sessionId !== elapsedSessionId || authoritative.status !== 'running')
      ) {
        completionInFlight = null;
        return;
      }
      if (sessionId.value !== elapsedSessionId || status.value !== 'running') {
        completionInFlight = null;
        return;
      }

      const completedMode = mode.value;
      const completion: TimerCompletion = {
        sessionId: elapsedSessionId,
        mode: completedMode,
        durationSeconds: totalSeconds.value,
        startedAt: startedAt.value ?? new Date(Date.now() - totalSeconds.value * 1000).toISOString(),
        completedAt: new Date().toISOString(),
        cause,
      };

      worker?.postMessage({ type: 'cancel', sessionId: elapsedSessionId });
      stopFallback();
      lastCompletedSessionId.value = elapsedSessionId;
      mode.value = completedMode === 'study' ? 'rest' : 'study';
      status.value = 'idle';
      deadline.value = null;
      sessionId.value = null;
      startedAt.value = null;
      totalSeconds.value = secondsForMode(mode.value);
      remainingSeconds.value = totalSeconds.value;
      notice.value = completedMode === 'study'
        ? '专注完成！起身活动一下，然后进入休息。'
        : '休息结束，准备好开始下一轮专注。';
      writeSnapshot();

      await options.onComplete?.(completion);
      completionInFlight = null;
    };

    const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks;
    if (locks) {
      await locks.request(`focusly-timer-complete-${elapsedSessionId}`, finalize);
    } else {
      await finalize();
    }
  };

  const reconcile = () => {
    if (status.value !== 'running' || !deadline.value || !sessionId.value) return;
    remainingSeconds.value = clampRemainingSeconds(deadline.value);
    updateTitle();
    if (remainingSeconds.value === 0) {
      void handleElapsed(sessionId.value, 'live');
    }
  };

  const startFallback = () => {
    stopFallback();
    fallbackInterval = window.setInterval(reconcile, 250);
    reconcile();
  };

  const scheduleCurrentTimer = () => {
    if (status.value !== 'running' || !sessionId.value || !deadline.value) return;
    if (worker) {
      worker.postMessage({
        type: 'schedule',
        sessionId: sessionId.value,
        deadline: deadline.value,
      });
    } else {
      startFallback();
    }
  };

  const applySnapshot = (snapshot: TimerRuntimeSnapshot, force = false) => {
    const isNewer =
      snapshot.revision > revision.value ||
      (snapshot.revision === revision.value && snapshot.sourceId.localeCompare(tabId) > 0);
    if (!force && !isNewer) return;

    const previousCompletion = lastCompletedSessionId.value;
    revision.value = snapshot.revision;
    mode.value = snapshot.mode;
    status.value = snapshot.status;
    remainingSeconds.value = snapshot.remainingSeconds;
    totalSeconds.value = snapshot.totalSeconds;
    deadline.value = snapshot.deadline;
    sessionId.value = snapshot.sessionId;
    startedAt.value = snapshot.startedAt;
    lastCompletedSessionId.value = snapshot.lastCompletedSessionId;

    if (status.value === 'running' && deadline.value && sessionId.value) {
      remainingSeconds.value = clampRemainingSeconds(deadline.value);
      scheduleCurrentTimer();
      if (remainingSeconds.value === 0) {
        void handleElapsed(sessionId.value, force ? 'restore' : 'live');
      }
    } else {
      worker?.postMessage({ type: 'cancel' });
      stopFallback();
    }

    if (
      !force &&
      snapshot.lastCompletedSessionId &&
      snapshot.lastCompletedSessionId !== previousCompletion
    ) {
      notice.value = snapshot.mode === 'rest'
        ? '专注完成！现在可以休息一下。'
        : '休息结束，可以开始下一轮专注。';
    }
    updateTitle();
  };

  const initWorker = () => {
    try {
      worker = new Worker(new URL('../workers/timer.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<TimerWorkerMessage>) => {
        const message = event.data;
        if (message.sessionId !== sessionId.value) return;

        if (message.type === 'tick' && typeof message.remainingMs === 'number') {
          remainingSeconds.value = Math.max(0, Math.ceil(message.remainingMs / 1000));
          updateTitle();
        } else if (message.type === 'elapsed') {
          void handleElapsed(message.sessionId, 'live');
        }
      };
      worker.onerror = () => {
        worker?.terminate();
        worker = null;
        if (status.value === 'running') startFallback();
      };
    } catch {
      worker = null;
    }
  };

  const initialize = async () => {
    initWorker();
    try {
      config.value = sanitizeConfig(await getTimerConfig());
    } catch {
      config.value = { ...DEFAULT_CONFIG };
    }

    const stored = readStoredSnapshot();
    if (stored) {
      applySnapshot(stored, true);
    } else {
      totalSeconds.value = secondsForMode('study');
      remainingSeconds.value = totalSeconds.value;
      writeSnapshot(false);
    }

    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel(TIMER_CHANNEL);
      channel.onmessage = (event: MessageEvent<TimerChannelMessage>) => {
        if (event.data?.type === 'state') applySnapshot(event.data.snapshot);
      };
    }

    ready.value = true;
    updateTitle();
  };

  const start = () => {
    if (!ready.value || status.value === 'running') return;

    const now = Date.now();
    if (status.value === 'idle' || remainingSeconds.value <= 0) {
      totalSeconds.value = secondsForMode();
      remainingSeconds.value = totalSeconds.value;
      sessionId.value = makeId();
      startedAt.value = new Date(now).toISOString();
    } else if (!sessionId.value) {
      sessionId.value = makeId();
      startedAt.value = new Date(now).toISOString();
    }

    deadline.value = now + remainingSeconds.value * 1000;
    status.value = 'running';
    notice.value = mode.value === 'study' ? '专注进行中，保持节奏。' : '休息进行中，放松一下。';
    writeSnapshot();
    scheduleCurrentTimer();
  };

  const pause = () => {
    if (status.value !== 'running' || !deadline.value) return;
    remainingSeconds.value = clampRemainingSeconds(deadline.value);
    status.value = 'paused';
    deadline.value = null;
    worker?.postMessage({ type: 'cancel', sessionId: sessionId.value ?? undefined });
    stopFallback();
    notice.value = '计时已暂停，准备好时可继续。';
    writeSnapshot();
  };

  const reset = () => {
    worker?.postMessage({ type: 'cancel', sessionId: sessionId.value ?? undefined });
    stopFallback();
    status.value = 'idle';
    deadline.value = null;
    sessionId.value = null;
    startedAt.value = null;
    totalSeconds.value = secondsForMode();
    remainingSeconds.value = totalSeconds.value;
    notice.value = '已重置当前计时。';
    writeSnapshot();
  };

  const switchMode = (nextMode: TimerMode) => {
    if (mode.value === nextMode && status.value === 'idle') return;
    worker?.postMessage({ type: 'cancel', sessionId: sessionId.value ?? undefined });
    stopFallback();
    mode.value = nextMode;
    status.value = 'idle';
    deadline.value = null;
    sessionId.value = null;
    startedAt.value = null;
    totalSeconds.value = secondsForMode(nextMode);
    remainingSeconds.value = totalSeconds.value;
    notice.value = nextMode === 'study' ? '已切换到专注模式。' : '已切换到休息模式。';
    writeSnapshot();
  };

  const saveConfig = async (nextConfig: TimerConfig) => {
    const validConfig = sanitizeConfig(nextConfig);
    config.value = sanitizeConfig(await updateTimerConfig(validConfig));
    if (status.value === 'idle') {
      totalSeconds.value = secondsForMode();
      remainingSeconds.value = totalSeconds.value;
    }
    notice.value = status.value === 'idle'
      ? '计时时长已保存。'
      : '新时长已保存，将从下一轮开始生效。';
    writeSnapshot();
    return config.value;
  };

  const handleStorage = (event: StorageEvent) => {
    if (event.key !== RUNTIME_KEY) return;
    const snapshot = parseSnapshot(event.newValue);
    if (snapshot) applySnapshot(snapshot);
  };

  const handleVisibility = () => {
    if (document.visibilityState === 'visible') reconcile();
  };

  onMounted(() => {
    window.addEventListener('storage', handleStorage);
    window.addEventListener('pageshow', reconcile);
    document.addEventListener('visibilitychange', handleVisibility);
    void initialize();
  });

  onUnmounted(() => {
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener('pageshow', reconcile);
    document.removeEventListener('visibilitychange', handleVisibility);
    worker?.postMessage({ type: 'dispose' });
    worker?.terminate();
    channel?.close();
    stopFallback();
    document.title = 'Focusly · 专注学习';
  });

  return {
    config,
    mode,
    status,
    remainingSeconds,
    totalSeconds,
    formattedTime,
    progress,
    isRunning,
    isPaused,
    ready,
    notice,
    storageWarning,
    start,
    pause,
    reset,
    switchMode,
    saveConfig,
  };
}
