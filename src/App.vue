<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref } from 'vue';
import {
  addFocusSession,
  getFocusSessions,
  getTaskList,
  subscribeDataChanges,
} from './api';
import type { FocusSession, TaskItem } from './api/types';
import CheckInCard from './components/CheckInCard.vue';
import TaskList from './components/TaskList.vue';
import TimerDisplay from './components/TimerDisplay.vue';
import WhiteNoisePlayer from './components/WhiteNoisePlayer.vue';
import type { TimerCompletion } from './utils/useTimer';

const StatsDashboard = defineAsyncComponent(() => import('./components/StatsDashboard.vue'));

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const storedTheme = (() => {
  try { return localStorage.getItem('focusly_theme'); } catch { return null; }
})();
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
const isDark = ref(storedTheme ? storedTheme === 'dark' : prefersDark);
const activeTask = ref<TaskItem | null>(null);
const tasks = ref<TaskItem[]>([]);
const sessions = ref<FocusSession[]>([]);
const installPrompt = ref<BeforeInstallPromptEvent | null>(null);
const toast = ref('');
const toastKind = ref<'success' | 'info' | 'error'>('info');
let toastTimer: number | null = null;
let unsubscribeData: (() => void) | null = null;

document.documentElement.dataset.theme = isDark.value ? 'dark' : 'light';

const localDateKey = (value = new Date()) => {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};

const todayMinutes = computed(() => Math.round(
  sessions.value
    .filter((session) => session.date === localDateKey())
    .reduce((sum, session) => sum + session.durationSeconds, 0) / 60,
));
const completedTasks = computed(() => tasks.value.filter((task) => task.status === 1).length);
const focusRounds = computed(() => sessions.value.length);
const streakDays = computed(() => {
  const dates = new Set(sessions.value.map((session) => session.date));
  let cursor = new Date();
  if (!dates.has(localDateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let count = 0;
  while (dates.has(localDateKey(cursor))) {
    count += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return count;
});

const showToast = (message: string, kind: 'success' | 'info' | 'error' = 'info') => {
  toast.value = message;
  toastKind.value = kind;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.value = ''; }, 3600);
};

const toggleTheme = () => {
  isDark.value = !isDark.value;
  document.documentElement.dataset.theme = isDark.value ? 'dark' : 'light';
  try { localStorage.setItem('focusly_theme', isDark.value ? 'dark' : 'light'); } catch { /* optional */ }
  window.dispatchEvent(new CustomEvent('focusly-theme-change'));
};

const refreshOverview = async () => {
  const [nextTasks, nextSessions] = await Promise.all([
    getTaskList().catch(() => [] as TaskItem[]),
    getFocusSessions().catch(() => [] as FocusSession[]),
  ]);
  tasks.value = nextTasks;
  sessions.value = nextSessions;

  let savedTaskId: string | null = null;
  try { savedTaskId = localStorage.getItem('focusly_active_task_id'); } catch { /* optional */ }
  const selectedId = activeTask.value?.id ?? savedTaskId;
  activeTask.value = nextTasks.find((task) => task.id === selectedId) ?? null;
};

const handleTaskSelect = (task: TaskItem | null) => {
  activeTask.value = task;
  try {
    if (task) localStorage.setItem('focusly_active_task_id', task.id);
    else localStorage.removeItem('focusly_active_task_id');
  } catch {
    // Selection still works for the current page when storage is unavailable.
  }
  if (task) showToast(`已选择「${task.content}」作为本轮任务`);
};

const handleTasksChange = (nextTasks: TaskItem[]) => {
  tasks.value = nextTasks;
  if (activeTask.value) {
    activeTask.value = nextTasks.find((task) => task.id === activeTask.value?.id) ?? null;
  }
};

const handleTimerFinish = async (completion: TimerCompletion) => {
  if (completion.mode === 'rest') {
    showToast('休息结束，下一轮也要稳稳地来。', 'info');
    return;
  }

  const task = activeTask.value;
  const session: FocusSession = {
    id: completion.sessionId,
    taskId: task?.id,
    taskContent: task?.content ?? '自由专注',
    tags: task?.tags ?? [],
    durationSeconds: completion.durationSeconds,
    startedAt: completion.startedAt,
    completedAt: completion.completedAt,
    date: localDateKey(new Date(completion.completedAt)),
  };

  try {
    await addFocusSession(session);
    await refreshOverview();
    showToast(`完成 ${Math.round(completion.durationSeconds / 60)} 分钟专注，已记入统计。`, 'success');
  } catch {
    showToast('专注已完成，但记录保存失败，请检查浏览器存储设置。', 'error');
  }
};

const handleInstallPrompt = (event: Event) => {
  event.preventDefault();
  installPrompt.value = event as BeforeInstallPromptEvent;
};

const installApp = async () => {
  if (!installPrompt.value) return;
  await installPrompt.value.prompt();
  const choice = await installPrompt.value.userChoice;
  if (choice.outcome === 'accepted') showToast('Focusly 已添加到你的设备。', 'success');
  installPrompt.value = null;
};

onMounted(() => {
  window.addEventListener('beforeinstallprompt', handleInstallPrompt);
  unsubscribeData = subscribeDataChanges(() => { void refreshOverview(); });
  void refreshOverview();
});

onUnmounted(() => {
  window.removeEventListener('beforeinstallprompt', handleInstallPrompt);
  unsubscribeData?.();
  if (toastTimer !== null) window.clearTimeout(toastTimer);
});
</script>

<template>
  <div class="app-shell">
    <header class="site-header">
      <div class="container header-content">
        <a class="brand" href="#top" aria-label="Focusly 首页">
          <span class="brand-mark" aria-hidden="true">🍅</span>
          <span>
            <strong>Focusly</strong>
            <small>专注、记录、看见成长</small>
          </span>
        </a>
        <div class="header-actions">
          <WhiteNoisePlayer />
          <button v-if="installPrompt" class="install-button" type="button" @click="installApp">
            <span aria-hidden="true">↓</span> 安装应用
          </button>
          <button
            class="theme-toggle"
            type="button"
            :aria-label="isDark ? '切换到亮色模式' : '切换到深色模式'"
            @click="toggleTheme"
          >
            <span aria-hidden="true">{{ isDark ? '☀' : '☾' }}</span>
          </button>
        </div>
      </div>
    </header>

    <main id="top" class="container main-content">
      <section class="welcome-panel" aria-labelledby="welcome-title">
        <div class="welcome-copy">
          <p class="eyebrow">TODAY'S FOCUS</p>
          <h1 id="welcome-title">
            <span class="headline-line">把大目标，放进一个个</span>
            <span class="headline-line headline-accent">可完成的番茄钟里。</span>
          </h1>
          <p>不追求一次做完所有事；只要在当下这一段时间里，专心做一件事。</p>
        </div>
        <dl class="today-summary">
          <div>
            <dt>今日专注</dt>
            <dd>{{ todayMinutes }}<small> 分钟</small></dd>
          </div>
          <div>
            <dt>完成任务</dt>
            <dd>{{ completedTasks }}<small> 项</small></dd>
          </div>
          <div>
            <dt>累计番茄</dt>
            <dd>{{ focusRounds }}<small> 个</small></dd>
          </div>
          <div>
            <dt>连续专注</dt>
            <dd>{{ streakDays }}<small> 天</small></dd>
          </div>
        </dl>
      </section>

      <div class="workspace-grid">
        <TimerDisplay :active-task="activeTask" @finish="handleTimerFinish" />
        <TaskList
          :active-task-id="activeTask?.id ?? null"
          @select="handleTaskSelect"
          @change="handleTasksChange"
        />
      </div>

      <section class="reflection-grid" aria-label="学习记录与复盘">
        <CheckInCard />
        <StatsDashboard />
      </section>
    </main>

    <footer class="site-footer">
      <div class="container">
        <span>🍅 Focusly</span>
        <p>数据优先保存在你的浏览器中。不上传，不打扰。</p>
      </div>
    </footer>

    <Transition name="toast">
      <div v-if="toast" class="toast" :class="`toast-${toastKind}`" role="status" aria-live="polite">
        <span aria-hidden="true">{{ toastKind === 'success' ? '✓' : toastKind === 'error' ? '!' : '·' }}</span>
        {{ toast }}
      </div>
    </Transition>
  </div>
</template>

<style scoped lang="scss">
.app-shell { min-height: 100vh; }

.site-header {
  position: sticky;
  top: 0;
  z-index: 50;
  height: var(--header-height);
  display: flex;
  align-items: center;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 75%, transparent);
  background: color-mix(in srgb, var(--bg-color) 86%, transparent);
  backdrop-filter: blur(18px);
}

.header-content { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.brand { display: inline-flex; align-items: center; gap: 0.7rem; }
.brand-mark { width: 2.55rem; height: 2.55rem; display: grid; place-items: center; border-radius: 0.85rem; background: var(--primary-soft); font-size: 1.4rem; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary-color) 16%, transparent); }
.brand strong, .brand small { display: block; }
.brand strong { font-size: 1.18rem; letter-spacing: -0.02em; }
.brand small { color: var(--text-muted); font-size: 0.68rem; }
.header-actions { display: flex; align-items: center; gap: 0.55rem; }
.install-button, .theme-toggle { height: 2.55rem; border-radius: 999px; border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-secondary); box-shadow: var(--shadow-sm); font-weight: 700; }
.install-button { padding: 0 0.9rem; }
.theme-toggle { width: 2.55rem; font-size: 1.1rem; }
.install-button:hover, .theme-toggle:hover { color: var(--primary-color); transform: translateY(-1px); }

.main-content { padding-top: clamp(1.5rem, 4vw, 3.5rem); padding-bottom: 4rem; }
.welcome-panel { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(22rem, 0.75fr); gap: clamp(2rem, 5vw, 5rem); align-items: end; margin-bottom: 2rem; }
.eyebrow { color: var(--primary-color); font-weight: 800; font-size: 0.72rem; letter-spacing: 0.18em; margin-bottom: 0.6rem; }
.welcome-copy h1 { font-size: clamp(2rem, 4.3vw, 3.5rem); line-height: 1.08; letter-spacing: -0.055em; }
.headline-line { display: block; }
.headline-accent { color: var(--primary-color); }
.welcome-copy > p:last-child { color: var(--text-secondary); margin-top: 1rem; max-width: 37rem; }
.today-summary { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.7rem; }
.today-summary div { min-height: 5.8rem; padding: 1rem; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); }
.today-summary dt { color: var(--text-muted); font-size: 0.75rem; font-weight: 700; }
.today-summary dd { margin-top: 0.3rem; font-size: 1.65rem; font-weight: 800; color: var(--text-color); font-variant-numeric: tabular-nums; }
.today-summary dd small { font-size: 0.72rem; color: var(--text-muted); font-weight: 600; }

.workspace-grid { display: grid; grid-template-columns: minmax(20rem, 0.9fr) minmax(24rem, 1.1fr); gap: 1.25rem; align-items: stretch; }
.reflection-grid { display: grid; grid-template-columns: minmax(17rem, 0.65fr) minmax(0, 1.35fr); gap: 1.25rem; margin-top: 1.25rem; align-items: stretch; }

.site-footer { border-top: 1px solid var(--border-color); background: var(--card-bg); }
.site-footer .container { min-height: 5rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; color: var(--text-muted); font-size: 0.78rem; }
.site-footer span { color: var(--text-color); font-weight: 800; }

.toast { position: fixed; left: 50%; bottom: 1.5rem; transform: translateX(-50%); z-index: 100; max-width: min(90vw, 34rem); padding: 0.8rem 1rem; border-radius: 999px; color: var(--text-color); background: var(--card-bg); border: 1px solid var(--border-color); box-shadow: var(--shadow-lg); display: flex; align-items: center; gap: 0.55rem; font-size: 0.86rem; }
.toast > span { width: 1.4rem; height: 1.4rem; border-radius: 50%; display: grid; place-items: center; color: #fff; background: var(--accent-color); font-weight: 900; }
.toast-success > span { background: var(--success-color); }
.toast-error > span { background: var(--danger-color); }
.toast-enter-active, .toast-leave-active { transition: opacity 180ms ease, transform 180ms ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translate(-50%, 0.6rem); }

@media (max-width: 980px) {
  .welcome-panel { grid-template-columns: 1fr; gap: 1.5rem; }
  .welcome-copy h1 { max-width: 17ch; }
  .today-summary { grid-template-columns: repeat(4, 1fr); }
  .workspace-grid, .reflection-grid { grid-template-columns: 1fr; }
}

@media (max-width: 720px) {
  .site-header { height: auto; min-height: var(--header-height); padding: 0.55rem 0; }
  .brand small, .install-button { display: none; }
  .header-actions { gap: 0.35rem; }
  .today-summary { grid-template-columns: repeat(2, 1fr); }
  .site-footer .container { flex-direction: column; align-items: flex-start; justify-content: center; padding-top: 1rem; padding-bottom: 1rem; }
}

@media (max-width: 420px) {
  .brand strong { font-size: 1rem; }
  .brand-mark { width: 2.25rem; height: 2.25rem; }
  .theme-toggle { width: 2.3rem; height: 2.3rem; }
  .workspace-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
