<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { TaskItem } from '../api/types';
import { useTimer, type TimerCompletion } from '../utils/useTimer';
import { validateDurationMinutes, type TimerMode } from '../utils/timerMath';

const props = withDefaults(defineProps<{
  activeTask?: TaskItem | null;
}>(), {
  activeTask: null,
});

const emit = defineEmits<{
  finish: [completion: TimerCompletion];
}>();

type NotificationState = NotificationPermission | 'unsupported';
type AudioContextConstructor = typeof AudioContext;

const settingsOpen = ref(false);
const studyInput = ref('25');
const restInput = ref('5');
const configError = ref('');
const savingConfig = ref(false);
const notificationState = ref<NotificationState>('unsupported');
const chimeEnabled = ref(true);
let chimeContext: AudioContext | null = null;

const playChime = async (completion: TimerCompletion) => {
  if (!chimeEnabled.value || completion.cause !== 'live') return;

  try {
    const AudioContextClass = window.AudioContext
      ?? (window as Window & { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
    if (!AudioContextClass) return;
    chimeContext ??= new AudioContextClass();
    if (chimeContext.state === 'suspended') await chimeContext.resume();

    const now = chimeContext.currentTime;
    const notes = completion.mode === 'study' ? [659.25, 783.99] : [523.25];
    notes.forEach((frequency, index) => {
      const oscillator = chimeContext!.createOscillator();
      const gain = chimeContext!.createGain();
      const startAt = now + index * 0.18;
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.14, startAt + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.38);
      oscillator.connect(gain).connect(chimeContext!.destination);
      oscillator.start(startAt);
      oscillator.stop(startAt + 0.4);
    });
  } catch {
    // Audio is an enhancement; a blocked audio context must never block completion.
  }
};

const notifyCompletion = (completion: TimerCompletion) => {
  if (
    completion.cause !== 'live'
    || notificationState.value !== 'granted'
    || document.visibilityState === 'visible'
    || !('Notification' in window)
  ) return;

  const title = completion.mode === 'study' ? '专注完成 🍅' : '休息结束';
  const body = completion.mode === 'study'
    ? '很棒，起身活动一下，然后进入休息。'
    : '状态已充满，回来开始新一轮专注吧。';

  try {
    new Notification(title, { body, icon: '/favicon.svg', tag: 'focusly-timer' });
  } catch {
    // The in-page aria-live message remains available as the reliable fallback.
  }
};

const {
  config,
  mode,
  status,
  remainingSeconds,
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
} = useTimer({
  onComplete: async (completion) => {
    await playChime(completion);
    notifyCompletion(completion);
    emit('finish', completion);
  },
});

const circumference = 2 * Math.PI * 108;
const ringOffset = computed(() => circumference * (1 - progress.value));
const isoDuration = computed(() => `PT${remainingSeconds.value}S`);
const modeLabel = computed(() => (mode.value === 'study' ? '专注' : '休息'));
const primaryActionLabel = computed(() => {
  if (isRunning.value) return '暂停';
  if (isPaused.value) return '继续';
  return mode.value === 'study' ? '开始专注' : '开始休息';
});
const notificationLabel = computed(() => {
  if (notificationState.value === 'unsupported') return '当前浏览器不支持系统通知';
  if (notificationState.value === 'granted') return '系统通知已开启';
  if (notificationState.value === 'denied') return '系统通知已被禁止';
  return '开启系统通知';
});

watch(config, (value) => {
  studyInput.value = String(value.studyDuration);
  restInput.value = String(value.restDuration);
}, { deep: true, immediate: true });

watch(chimeEnabled, (value) => {
  try {
    localStorage.setItem('focusly_chime_enabled', String(value));
  } catch {
    // Keep the current in-memory preference when storage is unavailable.
  }
});

const toggleTimer = async () => {
  if (isRunning.value) {
    pause();
    return;
  }

  try {
    if (chimeContext?.state === 'suspended') await chimeContext.resume();
  } catch {
    // Starting the timer remains available without sound.
  }
  start();
};

const chooseMode = (nextMode: TimerMode) => {
  if (!isRunning.value) switchMode(nextMode);
};

const handleSaveConfig = async () => {
  configError.value = '';
  const study = validateDurationMinutes(studyInput.value, 180);
  const rest = validateDurationMinutes(restInput.value, 60);

  if (!study.valid) {
    configError.value = `专注时长：${study.message}`;
    return;
  }
  if (!rest.valid) {
    configError.value = `休息时长：${rest.message}`;
    return;
  }

  savingConfig.value = true;
  try {
    await saveConfig({ studyDuration: study.value, restDuration: rest.value });
    settingsOpen.value = false;
  } catch {
    configError.value = '保存失败，请检查浏览器存储设置后重试。';
  } finally {
    savingConfig.value = false;
  }
};

const requestNotifications = async () => {
  if (!('Notification' in window) || !window.isSecureContext) {
    notificationState.value = 'unsupported';
    return;
  }
  if (Notification.permission !== 'default') {
    notificationState.value = Notification.permission;
    return;
  }

  try {
    notificationState.value = await Notification.requestPermission();
  } catch {
    notificationState.value = 'denied';
  }
};

const handleShortcut = (event: KeyboardEvent) => {
  const target = event.target as HTMLElement | null;
  if (
    event.code !== 'Space'
    || event.metaKey
    || event.ctrlKey
    || event.altKey
    || target?.matches('input, textarea, select, button, [contenteditable="true"]')
  ) return;

  event.preventDefault();
  void toggleTimer();
};

onMounted(() => {
  notificationState.value = 'Notification' in window && window.isSecureContext
    ? Notification.permission
    : 'unsupported';
  try {
    chimeEnabled.value = localStorage.getItem('focusly_chime_enabled') !== 'false';
  } catch {
    chimeEnabled.value = true;
  }
  window.addEventListener('keydown', handleShortcut);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleShortcut);
  void chimeContext?.close();
});
</script>

<template>
  <section class="timer-card" aria-labelledby="timer-title">
    <div class="timer-heading">
      <div>
        <p class="eyebrow">POMODORO TIMER</p>
        <h2 id="timer-title">留给当下一段完整时间</h2>
      </div>
      <button
        class="icon-button"
        type="button"
        :aria-expanded="settingsOpen"
        aria-controls="timer-settings"
        aria-label="设置专注与休息时长"
        @click="settingsOpen = !settingsOpen"
      >⚙</button>
    </div>

    <div v-if="settingsOpen" id="timer-settings" class="settings-panel">
      <label>
        <span>专注时长 <small>1–180 分钟</small></span>
        <input v-model="studyInput" type="number" min="1" max="180" step="1" inputmode="numeric" />
      </label>
      <label>
        <span>休息时长 <small>1–60 分钟</small></span>
        <input v-model="restInput" type="number" min="1" max="60" step="1" inputmode="numeric" />
      </label>
      <p v-if="configError" class="field-error" role="alert">{{ configError }}</p>
      <div class="settings-actions">
        <button class="text-button" type="button" @click="settingsOpen = false">取消</button>
        <button class="compact-primary" type="button" :disabled="savingConfig" @click="handleSaveConfig">
          {{ savingConfig ? '保存中…' : '保存时长' }}
        </button>
      </div>
    </div>

    <div class="mode-tabs" aria-label="计时模式">
      <button
        type="button"
        :class="{ active: mode === 'study' }"
        :aria-pressed="mode === 'study'"
        :disabled="isRunning"
        @click="chooseMode('study')"
      >专注</button>
      <button
        type="button"
        :class="{ active: mode === 'rest' }"
        :aria-pressed="mode === 'rest'"
        :disabled="isRunning"
        @click="chooseMode('rest')"
      >休息</button>
    </div>

    <div class="timer-display" :class="[`mode-${mode}`, `status-${status}`]">
      <svg class="progress-ring" viewBox="0 0 240 240" aria-hidden="true">
        <circle class="ring-track" cx="120" cy="120" r="108" />
        <circle
          class="ring-value"
          cx="120"
          cy="120"
          r="108"
          :style="{ strokeDasharray: circumference, strokeDashoffset: ringOffset }"
        />
      </svg>
      <div class="time-content">
        <span class="mode-label">{{ modeLabel }}</span>
        <time class="time-text" :datetime="isoDuration">{{ formattedTime }}</time>
        <span class="timer-state">{{ isRunning ? '进行中' : isPaused ? '已暂停' : '就绪' }}</span>
      </div>
    </div>

    <div class="active-task" :class="{ empty: !activeTask }">
      <span class="task-dot" aria-hidden="true"></span>
      <div>
        <small>本轮专注任务</small>
        <strong>{{ activeTask?.content ?? '尚未选择，也可以直接开始' }}</strong>
      </div>
    </div>

    <div class="controls">
      <button class="primary-control" type="button" :disabled="!ready" @click="toggleTimer">
        <span aria-hidden="true">{{ isRunning ? 'Ⅱ' : '▶' }}</span>
        {{ ready ? primaryActionLabel : '正在恢复…' }}
      </button>
      <button class="secondary-control" type="button" :disabled="!ready" @click="reset">
        重置
      </button>
    </div>

    <p class="timer-notice" aria-live="polite">{{ notice }}</p>
    <p v-if="storageWarning" class="storage-warning" role="status">{{ storageWarning }}</p>

    <div class="reminder-options">
      <button
        class="reminder-button"
        type="button"
        :disabled="notificationState === 'granted' || notificationState === 'denied' || notificationState === 'unsupported'"
        @click="requestNotifications"
      >
        <span aria-hidden="true">🔔</span>{{ notificationLabel }}
      </button>
      <label class="chime-toggle">
        <input v-model="chimeEnabled" type="checkbox" />
        <span>完成提示音</span>
      </label>
    </div>
    <p class="shortcut-hint"><kbd>Space</kbd> 开始 / 暂停</p>
  </section>
</template>

<style scoped lang="scss">
.timer-card {
  background: var(--card-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg);
  padding: clamp(1.25rem, 3vw, 2rem);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.25rem;
  position: relative;
  overflow: hidden;
}

.timer-card::before {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 4px;
  background: linear-gradient(90deg, var(--primary-color), var(--accent-color));
}

.timer-heading {
  width: 100%;
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: flex-start;
}

.eyebrow {
  color: var(--primary-color);
  font-size: 0.7rem;
  font-weight: 800;
  letter-spacing: 0.16em;
  margin-bottom: 0.3rem;
}

h2 {
  font-size: clamp(1.15rem, 2vw, 1.45rem);
  letter-spacing: -0.02em;
}

.icon-button {
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 50%;
  background: var(--surface-muted);
  color: var(--text-secondary);
  font-size: 1.1rem;
}

.icon-button:hover { color: var(--primary-color); transform: rotate(22deg); }

.settings-panel {
  width: 100%;
  padding: 1rem;
  border-radius: var(--radius-md);
  background: var(--surface-muted);
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
  animation: reveal 180ms ease-out;
}

.settings-panel label { display: grid; gap: 0.35rem; font-weight: 700; font-size: 0.85rem; }
.settings-panel small { color: var(--text-muted); font-weight: 500; }
.settings-panel input {
  width: 100%;
  border: 1px solid var(--border-color);
  border-radius: 0.75rem;
  padding: 0.65rem 0.75rem;
  background: var(--card-bg);
  color: var(--text-color);
}

.field-error, .storage-warning { color: var(--danger-color); font-size: 0.8rem; }
.field-error { grid-column: 1 / -1; }
.settings-actions { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 0.5rem; }
.text-button, .compact-primary { padding: 0.55rem 0.8rem; border-radius: 0.7rem; font-weight: 700; }
.text-button { background: transparent; color: var(--text-secondary); }
.compact-primary { background: var(--primary-color); color: #fff; }

.mode-tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  background: var(--surface-muted);
  padding: 0.3rem;
  border-radius: 999px;
  min-width: 13rem;
}

.mode-tabs button {
  padding: 0.55rem 1rem;
  border-radius: 999px;
  background: transparent;
  color: var(--text-secondary);
  font-weight: 700;
}

.mode-tabs button.active {
  color: var(--primary-color);
  background: var(--card-bg);
  box-shadow: var(--shadow-sm);
}

.mode-tabs button:disabled { cursor: not-allowed; }

.timer-display {
  position: relative;
  width: min(15rem, 76vw);
  aspect-ratio: 1;
  display: grid;
  place-items: center;
}

.progress-ring { position: absolute; inset: 0; width: 100%; height: 100%; transform: rotate(-90deg); }
.progress-ring circle { fill: none; stroke-width: 9; }
.ring-track { stroke: var(--surface-muted); }
.ring-value {
  stroke: var(--primary-color);
  stroke-linecap: round;
  transition: stroke-dashoffset 280ms linear, stroke 300ms ease;
  filter: drop-shadow(0 3px 5px color-mix(in srgb, var(--primary-color) 25%, transparent));
}
.mode-rest .ring-value { stroke: var(--accent-color); }
.status-running .ring-value { animation: ringGlow 2s ease-in-out infinite; }

.time-content { display: flex; flex-direction: column; align-items: center; z-index: 1; }
.mode-label, .timer-state { color: var(--text-muted); font-size: 0.78rem; font-weight: 700; }
.time-text {
  color: var(--text-color);
  font-size: clamp(3rem, 8vw, 4.2rem);
  line-height: 1.12;
  font-weight: 760;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.06em;
}

.active-task {
  width: 100%;
  display: flex;
  gap: 0.75rem;
  align-items: center;
  padding: 0.8rem 1rem;
  background: color-mix(in srgb, var(--primary-color) 8%, var(--card-bg));
  border-radius: var(--radius-md);
}
.active-task.empty { background: var(--surface-muted); }
.task-dot { width: 0.65rem; height: 0.65rem; border-radius: 50%; background: var(--primary-color); flex: 0 0 auto; }
.active-task small, .active-task strong { display: block; }
.active-task small { color: var(--text-muted); font-size: 0.72rem; }
.active-task strong { font-size: 0.9rem; overflow-wrap: anywhere; }

.controls { width: 100%; display: grid; grid-template-columns: minmax(0, 2fr) minmax(6rem, 1fr); gap: 0.75rem; }
.controls button { min-height: 3.1rem; border-radius: 1rem; font-weight: 800; font-size: 0.98rem; }
.primary-control { color: #fff; background: linear-gradient(135deg, var(--primary-color), var(--primary-dark)); box-shadow: 0 8px 20px var(--primary-shadow); }
.primary-control:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 11px 26px var(--primary-shadow); }
.secondary-control { color: var(--text-secondary); background: var(--surface-muted); border: 1px solid var(--border-color); }

.timer-notice { min-height: 1.5rem; color: var(--text-secondary); text-align: center; font-size: 0.86rem; }
.reminder-options { width: 100%; display: flex; align-items: center; justify-content: center; gap: 0.75rem; flex-wrap: wrap; }
.reminder-button { background: transparent; color: var(--text-muted); font-size: 0.77rem; }
.reminder-button:not(:disabled):hover { color: var(--primary-color); }
.chime-toggle { display: inline-flex; align-items: center; gap: 0.35rem; color: var(--text-muted); font-size: 0.77rem; cursor: pointer; }
.chime-toggle input { accent-color: var(--primary-color); }
.shortcut-hint { color: var(--text-muted); font-size: 0.72rem; }
kbd { border: 1px solid var(--border-color); background: var(--surface-muted); padding: 0.12rem 0.38rem; border-radius: 0.35rem; box-shadow: 0 1px 0 var(--border-color); }

@keyframes reveal { from { opacity: 0; transform: translateY(-5px); } }
@keyframes ringGlow { 50% { filter: drop-shadow(0 3px 9px color-mix(in srgb, var(--primary-color) 45%, transparent)); } }

@media (max-width: 480px) {
  .settings-panel { grid-template-columns: 1fr; }
  .settings-panel label, .field-error, .settings-actions { grid-column: 1; }
  .controls { grid-template-columns: 1fr; }
}

@media (prefers-reduced-motion: reduce) {
  .ring-value { animation: none !important; transition: none; }
}
</style>
