<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { addClock, getClockList, getFocusSessions, subscribeDataChanges } from '../api';
import type { ClockRecord, FocusSession } from '../api/types';
import {
  getSessionMinutesForDate,
  parseLocalDateKey,
  toLocalDateKey,
} from '../utils/statistics';

type FeedbackKind = 'success' | 'warning' | 'error' | 'info';

interface Feedback {
  kind: FeedbackKind;
  message: string;
}

const clockRecords = ref<ClockRecord[]>([]);
const focusSessions = ref<FocusSession[]>([]);
const todayDateKey = ref(toLocalDateKey());
const isLoading = ref(true);
const isCheckingIn = ref(false);
const loadError = ref('');
const feedback = ref<Feedback | null>(null);

let refreshRequestId = 0;
let refreshTimerId: number | null = null;
let stopDataSubscription: (() => void) | null = null;

const todayMinutes = computed(() => {
  const sessionMinutes = getSessionMinutesForDate(
    focusSessions.value,
    todayDateKey.value,
  );
  const checkedMinutes = clockRecords.value.find(
    (record) => record.date === todayDateKey.value,
  )?.studyTime ?? 0;
  return Math.max(sessionMinutes, checkedMinutes);
});

const hasCheckedInToday = computed(() => (
  clockRecords.value.some((record) => record.date === todayDateKey.value)
));

const recentRecords = computed(() => {
  const seenDates = new Set<string>();
  return [...clockRecords.value]
    .filter((record) => parseLocalDateKey(record.date) !== null)
    .sort((left, right) => (
      right.date.localeCompare(left.date)
      || right.createTime.localeCompare(left.createTime)
    ))
    .filter((record) => {
      if (seenDates.has(record.date)) return false;
      seenDates.add(record.date);
      return true;
    })
    .slice(0, 7);
});

const formatMinutes = (minutes: number): string => (
  new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(minutes)
);

const formatRecordDate = (dateKey: string): string => {
  const date = parseLocalDateKey(dateKey);
  if (!date) return dateKey;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    weekday: 'short',
  }).format(date);
};

const getReadableError = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) return error.message;
  return '暂时无法读取打卡数据，请稍后重试。';
};

const refreshData = async (showLoading = false): Promise<void> => {
  const requestId = ++refreshRequestId;
  if (showLoading) isLoading.value = true;
  todayDateKey.value = toLocalDateKey();

  try {
    const [records, sessions] = await Promise.all([
      getClockList(),
      getFocusSessions(),
    ]);
    if (requestId !== refreshRequestId) return;

    clockRecords.value = records;
    focusSessions.value = sessions;
    loadError.value = '';
  } catch (error) {
    if (requestId !== refreshRequestId) return;
    loadError.value = getReadableError(error);
  } finally {
    if (requestId === refreshRequestId) isLoading.value = false;
  }
};

const scheduleRefresh = (): void => {
  if (refreshTimerId !== null) window.clearTimeout(refreshTimerId);
  refreshTimerId = window.setTimeout(() => {
    refreshTimerId = null;
    void refreshData();
  }, 80);
};

const handleCheckIn = async (): Promise<void> => {
  if (isCheckingIn.value) return;
  isCheckingIn.value = true;
  feedback.value = null;

  try {
    // Refresh immediately so a check-in created in another tab is caught
    // before attempting this mutation. The repository remains the final guard.
    await refreshData();

    if (hasCheckedInToday.value) {
      feedback.value = {
        kind: 'warning',
        message: '今天已经打过卡了，明天再来继续连击吧。',
      };
      return;
    }

    const now = new Date();
    const record: ClockRecord = {
      date: toLocalDateKey(now),
      studyTime: todayMinutes.value,
      createTime: now.toISOString(),
    };
    const savedRecord = await addClock(record);

    clockRecords.value = [
      savedRecord,
      ...clockRecords.value.filter((item) => item.date !== savedRecord.date),
    ];
    feedback.value = {
      kind: 'success',
      message: `打卡成功！今日已累计专注 ${formatMinutes(savedRecord.studyTime)} 分钟。`,
    };
  } catch (error) {
    const message = getReadableError(error);
    const isDuplicate = /重复|已打卡|duplicate|already exists/i.test(message);
    feedback.value = {
      kind: isDuplicate ? 'warning' : 'error',
      message: isDuplicate
        ? '今天已经打过卡了，无需重复提交。'
        : `打卡失败：${message}`,
    };
  } finally {
    isCheckingIn.value = false;
  }
};

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || Boolean(target.closest(
    'input, textarea, select, [contenteditable="true"], [role="textbox"]',
  ));
};

const handleGlobalKeydown = (event: KeyboardEvent): void => {
  if (
    event.key.toLowerCase() !== 'd'
    || (!event.ctrlKey && !event.metaKey)
    || event.altKey
    || event.shiftKey
    || isEditableTarget(event.target)
  ) {
    return;
  }

  event.preventDefault();
  void handleCheckIn();
};

const handleVisibilityChange = (): void => {
  if (document.visibilityState === 'visible') scheduleRefresh();
};

onMounted(() => {
  window.addEventListener('keydown', handleGlobalKeydown);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  stopDataSubscription = subscribeDataChanges(() => scheduleRefresh());
  void refreshData(true);
});

onUnmounted(() => {
  refreshRequestId += 1;
  window.removeEventListener('keydown', handleGlobalKeydown);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  stopDataSubscription?.();
  if (refreshTimerId !== null) window.clearTimeout(refreshTimerId);
});
</script>

<template>
  <section class="check-in-card" aria-labelledby="check-in-heading">
    <header class="card-heading">
      <div>
        <p class="eyebrow">每日记录</p>
        <h2 id="check-in-heading">学习打卡</h2>
      </div>
      <span class="today-label">{{ formatRecordDate(todayDateKey) }}</span>
    </header>

    <div class="today-summary" aria-live="polite">
      <span class="summary-icon" aria-hidden="true">⏱️</span>
      <div>
        <span class="summary-label">今日累计专注</span>
        <strong>{{ formatMinutes(todayMinutes) }} <small>分钟</small></strong>
      </div>
    </div>

    <button
      class="check-in-button"
      type="button"
      :class="{ checked: hasCheckedInToday }"
      :disabled="isLoading || isCheckingIn || hasCheckedInToday"
      aria-keyshortcuts="Control+D Meta+D"
      aria-describedby="check-in-shortcut"
      @click="handleCheckIn"
    >
      <span aria-hidden="true">{{ hasCheckedInToday ? '✓' : '🍅' }}</span>
      {{
        isCheckingIn
          ? '正在打卡…'
          : hasCheckedInToday
            ? '今日已打卡'
            : '立即打卡'
      }}
    </button>
    <p id="check-in-shortcut" class="shortcut-hint">
      快捷键 <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>D</kbd>
    </p>

    <p
      v-if="feedback"
      class="feedback"
      :class="`feedback-${feedback.kind}`"
      role="status"
      aria-live="polite"
    >
      {{ feedback.message }}
    </p>
    <p v-else-if="loadError" class="feedback feedback-error" role="alert">
      {{ loadError }}
    </p>

    <div class="recent-section">
      <h3>最近打卡</h3>
      <p v-if="isLoading" class="empty-records" role="status">正在加载记录…</p>
      <p v-else-if="recentRecords.length === 0" class="empty-records">
        还没有打卡记录，从今天开始吧。
      </p>
      <ul v-else class="record-list" aria-label="最近七次打卡记录">
        <li v-for="record in recentRecords" :key="record.date">
          <span class="record-mark" aria-hidden="true">✓</span>
          <time :datetime="record.date">{{ formatRecordDate(record.date) }}</time>
          <strong>{{ formatMinutes(record.studyTime) }} 分钟</strong>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped lang="scss">
.check-in-card {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  width: 100%;
  padding: 1.75rem;
  color: var(--text-color);
  background: var(--card-bg);
  border: 1px solid var(--border-color);
  border-radius: 1.75rem;
  box-shadow: var(--shadow);
}

.card-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;

  h2 {
    font-size: 1.35rem;
    line-height: 1.25;
  }
}

.eyebrow {
  margin-bottom: 0.25rem;
  color: var(--primary-color);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.today-label {
  flex: none;
  padding: 0.35rem 0.65rem;
  color: var(--text-color);
  background: var(--bg-color);
  border: 1px solid var(--border-color);
  border-radius: 999px;
  font-size: 0.8rem;
  opacity: 0.75;
}

.today-summary {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1.2rem;
  background: color-mix(in srgb, var(--primary-color) 9%, var(--card-bg));
  border: 1px solid color-mix(in srgb, var(--primary-color) 24%, transparent);
  border-radius: 1.25rem;

  .summary-icon {
    display: grid;
    place-items: center;
    width: 2.8rem;
    height: 2.8rem;
    background: var(--card-bg);
    border-radius: 0.9rem;
    font-size: 1.35rem;
  }

  .summary-label {
    display: block;
    margin-bottom: 0.15rem;
    font-size: 0.82rem;
    opacity: 0.65;
  }

  strong {
    color: var(--primary-color);
    font-size: 1.65rem;
    line-height: 1;
    font-variant-numeric: tabular-nums;

    small {
      font-size: 0.8rem;
      font-weight: 600;
    }
  }
}

.check-in-button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.55rem;
  min-height: 3.1rem;
  padding: 0.85rem 1rem;
  color: #fff;
  background: var(--primary-color);
  border-radius: 1rem;
  font-size: 1rem;
  font-weight: 700;

  &:hover:not(:disabled) {
    background: var(--primary-light);
    transform: translateY(-1px);
  }

  &:focus-visible {
    outline: 3px solid color-mix(in srgb, var(--primary-color) 35%, transparent);
    outline-offset: 3px;
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.62;
  }

  &.checked {
    color: var(--text-color);
    background: color-mix(in srgb, var(--secondary-color) 20%, var(--card-bg));
    border: 1px solid color-mix(in srgb, var(--secondary-color) 45%, transparent);
  }
}

.shortcut-hint {
  margin-top: -0.75rem;
  text-align: center;
  font-size: 0.75rem;
  opacity: 0.55;

  kbd {
    padding: 0.1rem 0.3rem;
    background: var(--bg-color);
    border: 1px solid var(--border-color);
    border-radius: 0.3rem;
    box-shadow: 0 1px 0 var(--border-color);
    font-family: inherit;
  }
}

.feedback {
  padding: 0.75rem 0.9rem;
  border: 1px solid var(--border-color);
  border-radius: 0.85rem;
  font-size: 0.85rem;
  line-height: 1.5;
}

.feedback-success {
  background: color-mix(in srgb, var(--secondary-color) 13%, var(--card-bg));
  border-color: color-mix(in srgb, var(--secondary-color) 38%, transparent);
}

.feedback-warning,
.feedback-info {
  background: var(--bg-color);
}

.feedback-error {
  color: var(--primary-color);
  background: color-mix(in srgb, var(--primary-color) 8%, var(--card-bg));
  border-color: color-mix(in srgb, var(--primary-color) 30%, transparent);
}

.recent-section {
  padding-top: 0.15rem;

  h3 {
    margin-bottom: 0.7rem;
    font-size: 0.92rem;
  }
}

.empty-records {
  padding: 1rem;
  text-align: center;
  background: var(--bg-color);
  border-radius: 0.9rem;
  font-size: 0.82rem;
  opacity: 0.6;
}

.record-list {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  list-style: none;

  li {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 0.65rem;
    min-height: 2.55rem;
    padding: 0.6rem 0.75rem;
    background: var(--bg-color);
    border-radius: 0.8rem;
    font-size: 0.82rem;
  }

  time {
    opacity: 0.72;
  }

  strong {
    font-size: 0.82rem;
    font-variant-numeric: tabular-nums;
  }
}

.record-mark {
  display: grid;
  place-items: center;
  width: 1.45rem;
  height: 1.45rem;
  color: #fff;
  background: var(--secondary-color);
  border-radius: 50%;
  font-size: 0.7rem;
  font-weight: 800;
}

@media (max-width: 480px) {
  .check-in-card {
    padding: 1.25rem;
    border-radius: 1.35rem;
  }

  .today-label {
    display: none;
  }
}
</style>
