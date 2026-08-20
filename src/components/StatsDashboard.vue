<script setup lang="ts">
import { LineChart, PieChart } from 'echarts/charts';
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components';
import {
  graphic,
  init,
  use,
  type ECharts,
  type EChartsCoreOption,
} from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  watch,
} from 'vue';
import {
  getClockList,
  getFocusSessions,
  getMonthStats,
  getWeekStats,
  subscribeDataChanges,
} from '../api';
import type { ClockRecord, FocusSession, StatData } from '../api/types';
import {
  aggregateSessionsByDate,
  aggregateSessionsByTag,
  calculateTotalFocusSeconds,
  calculateCurrentStreak,
  fillStatDateSequence,
  parseLocalDateKey,
  toLocalDateKey,
} from '../utils/statistics';

use([
  LineChart,
  PieChart,
  AriaComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

type RangeDays = 7 | 30;

interface ExportFeedback {
  kind: 'success' | 'error';
  message: string;
}

const trendChartElement = ref<HTMLDivElement | null>(null);
const tagChartElement = ref<HTMLDivElement | null>(null);
const selectedRange = ref<RangeDays>(7);
const clockRecords = ref<ClockRecord[]>([]);
const focusSessions = ref<FocusSession[]>([]);
const weekStats = ref<StatData[]>([]);
const monthStats = ref<StatData[]>([]);
const hiddenTagNames = ref<Set<string>>(new Set());
const isLoading = ref(true);
const loadWarning = ref('');
const exportFeedback = ref<ExportFeedback | null>(null);

let trendChart: ECharts | null = null;
let tagChart: ECharts | null = null;
let resizeObserver: ResizeObserver | null = null;
let themeObserver: MutationObserver | null = null;
let stopDataSubscription: (() => void) | null = null;
let refreshTimerId: number | null = null;
let exportFeedbackTimerId: number | null = null;
let refreshRequestId = 0;
let isUsingWindowResizeFallback = false;

const positiveSessions = computed(() => focusSessions.value.filter((session) => (
  Number.isFinite(session.durationSeconds) && session.durationSeconds > 0
)));

const totalFocusSeconds = computed(() => calculateTotalFocusSeconds(
  positiveSessions.value,
  clockRecords.value,
));

const completedPomodoros = computed(() => positiveSessions.value.length);

const checkInDays = computed(() => new Set(
  clockRecords.value
    .map((record) => record.date)
    .filter((date) => parseLocalDateKey(date) !== null),
).size);

const currentStreak = computed(() => calculateCurrentStreak(
  clockRecords.value.map((record) => record.date),
));

const tagStats = computed(() => aggregateSessionsByTag(positiveSessions.value));
const totalTagSeconds = computed(() => tagStats.value.reduce(
  (total, item) => total + item.durationSeconds,
  0,
));
const visibleTagStats = computed(() => tagStats.value.filter(
  (item) => !hiddenTagNames.value.has(item.name),
));
const hasHiddenTags = computed(() => hiddenTagNames.value.size > 0);

const tagSwatches = [
  'var(--primary-color)',
  'var(--secondary-color)',
  '#7c83fd',
  '#f6bd60',
  '#84a59d',
  '#c77dff',
];

const currentTrend = computed(() => {
  const apiStats = selectedRange.value === 7 ? weekStats.value : monthStats.value;
  return apiStats.length > 0
    ? fillStatDateSequence(apiStats, selectedRange.value)
    : aggregateSessionsByDate(positiveSessions.value, selectedRange.value);
});

const hasTrendData = computed(() => (
  currentTrend.value.some((item) => item.duration > 0)
));

const hasTagData = computed(() => tagStats.value.length > 0);
const hasVisibleTagData = computed(() => visibleTagStats.value.length > 0);

const canExport = computed(() => (
  focusSessions.value.length > 0
  || clockRecords.value.length > 0
  || weekStats.value.some((item) => item.duration > 0)
  || monthStats.value.some((item) => item.duration > 0)
));

const rangeDescription = computed(() => (
  selectedRange.value === 7 ? '近 7 天' : '近 30 天'
));

const trendAriaLabel = computed(() => {
  if (!hasTrendData.value) return `${rangeDescription.value}暂无专注时长数据。`;
  const total = currentTrend.value.reduce((sum, item) => sum + item.duration, 0);
  return `${rangeDescription.value}专注趋势，累计 ${formatMinutes(total)} 分钟。`;
});

const tagAriaLabel = computed(() => {
  if (!hasTagData.value) return '暂无标签时长数据。';
  if (!hasVisibleTagData.value) return '所有标签占比均已隐藏，可从下方标签明细恢复显示。';
  const hiddenDescription = hasHiddenTags.value
    ? `，另有 ${hiddenTagNames.value.size} 个标签已隐藏`
    : '';
  return `当前显示的标签时长分布：${visibleTagStats.value
    .map((item) => `${item.name} ${formatMinutes(item.durationMinutes)} 分钟`)
    .join('，')}${hiddenDescription}。`;
});

function formatMinutes(minutes: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(minutes);
}

function formatTagPercentage(durationSeconds: number): string {
  if (totalTagSeconds.value <= 0) return '0%';
  const percentage = durationSeconds / totalTagSeconds.value * 100;
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(percentage)}%`;
}

function getTagSwatch(index: number): string {
  return tagSwatches[index % tagSwatches.length] ?? tagSwatches[0];
}

function isTagVisible(name: string): boolean {
  return !hiddenTagNames.value.has(name);
}

function toggleTagVisibility(name: string): void {
  const nextHiddenTags = new Set(hiddenTagNames.value);
  if (nextHiddenTags.has(name)) nextHiddenTags.delete(name);
  else nextHiddenTags.add(name);
  hiddenTagNames.value = nextHiddenTags;
  void nextTick(() => renderTagChart());
}

function showAllTags(): void {
  if (!hasHiddenTags.value) return;
  hiddenTagNames.value = new Set();
  void nextTick(() => renderTagChart());
}

function formatTotalDuration(seconds: number): string {
  const minutes = seconds / 60;
  if (minutes < 60) return `${formatMinutes(minutes)} 分钟`;
  return `${formatMinutes(minutes / 60)} 小时`;
}

function getCssColor(variableName: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(variableName)
    .trim();
  return value || fallback;
}

function ensureCharts(): void {
  if (trendChartElement.value && !trendChart) {
    trendChart = init(trendChartElement.value);
  }
  if (tagChartElement.value && !tagChart) {
    tagChart = init(tagChartElement.value);
  }
}

function renderTrendChart(): void {
  if (!trendChart) return;

  const primaryColor = getCssColor('--primary-color', '#ff6b6b');
  const textColor = getCssColor('--text-color', '#2d3436');
  const borderColor = getCssColor('--border-color', '#e9ecef');
  const cardColor = getCssColor('--card-bg', '#ffffff');
  const seriesData = currentTrend.value.map((item) => item.duration);

  const option: EChartsCoreOption = {
    animationDuration: 450,
    color: [primaryColor],
    textStyle: { color: textColor },
    aria: {
      enabled: true,
      description: trendAriaLabel.value,
      decal: { show: true },
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: cardColor,
      borderColor,
      textStyle: { color: textColor },
      valueFormatter: (value: unknown) => `${formatMinutes(Number(value))} 分钟`,
    },
    grid: {
      top: 24,
      right: 18,
      bottom: 34,
      left: 48,
      containLabel: false,
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: currentTrend.value.map((item) => item.date.slice(5)),
      axisLine: { lineStyle: { color: borderColor } },
      axisTick: { show: false },
      axisLabel: {
        color: textColor,
        hideOverlap: true,
        interval: selectedRange.value === 30 ? 4 : 0,
      },
    },
    yAxis: {
      type: 'value',
      min: 0,
      minInterval: 1,
      axisLabel: {
        color: textColor,
        formatter: '{value}m',
      },
      splitLine: { lineStyle: { color: borderColor, type: 'dashed' } },
    },
    series: [{
      name: '专注时长',
      type: 'line',
      data: seriesData,
      smooth: true,
      symbol: selectedRange.value === 7 ? 'circle' : 'none',
      symbolSize: 7,
      showSymbol: selectedRange.value === 7,
      lineStyle: { width: 3 },
      itemStyle: { borderWidth: 2, borderColor: cardColor },
      areaStyle: {
        color: new graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: `${primaryColor}55` },
          { offset: 1, color: `${primaryColor}05` },
        ]),
      },
    }],
  };

  trendChart.setOption(option, true);
}

function renderTagChart(): void {
  if (!tagChart) return;

  const textColor = getCssColor('--text-color', '#2d3436');
  const borderColor = getCssColor('--border-color', '#e9ecef');
  const cardColor = getCssColor('--card-bg', '#ffffff');
  const palette = [
    getCssColor('--primary-color', '#ff6b6b'),
    getCssColor('--secondary-color', '#4ecdc4'),
    '#7c83fd',
    '#f6bd60',
    '#84a59d',
    '#c77dff',
  ];

  const option: EChartsCoreOption = {
    animationDuration: 450,
    color: palette,
    textStyle: { color: textColor },
    aria: {
      enabled: true,
      description: tagAriaLabel.value,
      decal: { show: true },
    },
    tooltip: {
      trigger: 'item',
      formatter: '{b}<br/>{c} 分钟（{d}%）',
      backgroundColor: cardColor,
      borderColor,
      textStyle: { color: textColor },
    },
    legend: { show: false },
    series: [{
      name: '标签时长',
      type: 'pie',
      radius: ['48%', '78%'],
      center: ['50%', '50%'],
      minAngle: 3,
      minShowLabelAngle: 20,
      avoidLabelOverlap: true,
      itemStyle: {
        borderColor: cardColor,
        borderWidth: 3,
        borderRadius: 6,
      },
      label: {
        show: true,
        position: 'inside',
        color: '#fff',
        fontSize: 11,
        fontWeight: 750,
        formatter: '{d}%',
        textBorderColor: 'rgba(0, 0, 0, 0.28)',
        textBorderWidth: 2,
      },
      labelLine: { show: false },
      labelLayout: { hideOverlap: true },
      emphasis: {
        scaleSize: 6,
        label: { show: true, fontSize: 13, fontWeight: 800 },
      },
      data: tagStats.value.flatMap((item, index) => (
        isTagVisible(item.name)
          ? [{
            name: item.name,
            value: item.durationMinutes,
            itemStyle: { color: palette[index % palette.length] },
          }]
          : []
      )),
    }],
  };

  tagChart.setOption(option, true);
}

function renderCharts(): void {
  ensureCharts();
  renderTrendChart();
  renderTagChart();
}

function resizeCharts(): void {
  trendChart?.resize();
  tagChart?.resize();
}

function resultErrorMessage(reason: unknown): string {
  return reason instanceof Error && reason.message.trim()
    ? reason.message
    : '数据请求失败';
}

async function refreshData(showLoading = false): Promise<void> {
  const requestId = ++refreshRequestId;
  if (showLoading) isLoading.value = true;

  const results = await Promise.allSettled([
    getClockList(),
    getFocusSessions(),
    getWeekStats(),
    getMonthStats(),
  ] as const);
  if (requestId !== refreshRequestId) return;

  const failures: string[] = [];
  const [clockResult, sessionResult, weekResult, monthResult] = results;

  if (clockResult.status === 'fulfilled') clockRecords.value = clockResult.value;
  else failures.push(resultErrorMessage(clockResult.reason));

  if (sessionResult.status === 'fulfilled') focusSessions.value = sessionResult.value;
  else failures.push(resultErrorMessage(sessionResult.reason));

  if (weekResult.status === 'fulfilled') weekStats.value = weekResult.value;
  else failures.push(resultErrorMessage(weekResult.reason));

  if (monthResult.status === 'fulfilled') monthStats.value = monthResult.value;
  else failures.push(resultErrorMessage(monthResult.reason));

  loadWarning.value = failures.length > 0
    ? `部分数据暂未更新：${failures[0]}`
    : '';
  isLoading.value = false;

  await nextTick();
  renderCharts();
}

function scheduleRefresh(): void {
  if (refreshTimerId !== null) window.clearTimeout(refreshTimerId);
  refreshTimerId = window.setTimeout(() => {
    refreshTimerId = null;
    void refreshData();
  }, 100);
}

function selectRange(range: RangeDays): void {
  selectedRange.value = range;
}

function csvCell(value: unknown): string {
  let text = String(value ?? '');
  // Prevent spreadsheet applications from evaluating user-authored task text.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadFile(content: BlobPart, mimeType: string, filename: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function showExportFeedback(kind: ExportFeedback['kind'], message: string): void {
  exportFeedback.value = { kind, message };
  if (exportFeedbackTimerId !== null) window.clearTimeout(exportFeedbackTimerId);
  exportFeedbackTimerId = window.setTimeout(() => {
    exportFeedback.value = null;
    exportFeedbackTimerId = null;
  }, 3500);
}

function exportCsv(): void {
  try {
    const header = [
      '记录类型',
      '日期',
      '开始时间',
      '结束时间',
      '专注分钟',
      '任务',
      '标签',
    ];
    const sessionRows: Array<Array<string | number>> = focusSessions.value.map((session) => [
        '专注',
        session.date,
        session.startedAt,
        session.completedAt,
        Math.round((session.durationSeconds / 60) * 100) / 100,
        session.taskContent ?? '',
        session.tags.join(' | '),
      ]);
    const checkInRows: Array<Array<string | number>> = clockRecords.value.map((record) => [
      '打卡',
      record.date,
      '',
      record.createTime,
      record.studyTime,
      '',
      '',
    ]);
    const statisticRows: Array<Array<string | number>> = (
      sessionRows.length === 0 && checkInRows.length === 0
        ? fillStatDateSequence(monthStats.value, 30).filter((item) => item.duration > 0)
        : []
    ).map((item) => [
      '日统计',
      item.date,
      '',
      '',
      item.duration,
      '',
      '',
    ]);
    const rows = [...sessionRows, ...checkInRows, ...statisticRows]
      .sort((left, right) => (
        String(left[1]).localeCompare(String(right[1]))
        || String(left[3]).localeCompare(String(right[3]))
      ));
    const csv = [header, ...rows]
      .map((row) => row.map(csvCell).join(','))
      .join('\r\n');

    downloadFile(
      `\ufeff${csv}`,
      'text/csv;charset=utf-8',
      `focusly-专注记录-${toLocalDateKey()}.csv`,
    );
    showExportFeedback('success', 'CSV 文件已导出。');
  } catch (error) {
    showExportFeedback('error', `CSV 导出失败：${resultErrorMessage(error)}`);
  }
}

function exportJson(): void {
  try {
    const report = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      summary: {
        totalFocusSeconds: totalFocusSeconds.value,
        completedPomodoros: completedPomodoros.value,
        currentStreak: currentStreak.value,
        checkInDays: checkInDays.value,
      },
      focusSessions: focusSessions.value,
      clockRecords: clockRecords.value,
      statistics: {
        last7Days: weekStats.value.length > 0
          ? fillStatDateSequence(weekStats.value, 7)
          : aggregateSessionsByDate(positiveSessions.value, 7),
        last30Days: monthStats.value.length > 0
          ? fillStatDateSequence(monthStats.value, 30)
          : aggregateSessionsByDate(positiveSessions.value, 30),
        tags: tagStats.value,
      },
    };

    downloadFile(
      JSON.stringify(report, null, 2),
      'application/json;charset=utf-8',
      `focusly-学习数据-${toLocalDateKey()}.json`,
    );
    showExportFeedback('success', 'JSON 文件已导出。');
  } catch (error) {
    showExportFeedback('error', `JSON 导出失败：${resultErrorMessage(error)}`);
  }
}

watch(tagStats, (items) => {
  const availableNames = new Set(items.map((item) => item.name));
  const remainingHiddenNames = new Set(
    [...hiddenTagNames.value].filter((name) => availableNames.has(name)),
  );
  if (remainingHiddenNames.size !== hiddenTagNames.value.size) {
    hiddenTagNames.value = remainingHiddenNames;
  }
});

watch(selectedRange, async () => {
  await nextTick();
  renderTrendChart();
});

onMounted(async () => {
  await nextTick();
  ensureCharts();

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => resizeCharts());
    if (trendChartElement.value) resizeObserver.observe(trendChartElement.value);
    if (tagChartElement.value) resizeObserver.observe(tagChartElement.value);
  } else {
    isUsingWindowResizeFallback = true;
    window.addEventListener('resize', resizeCharts);
  }

  themeObserver = new MutationObserver(() => renderCharts());
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });

  stopDataSubscription = subscribeDataChanges(() => scheduleRefresh());
  await refreshData(true);
});

onUnmounted(() => {
  stopDataSubscription?.();
  resizeObserver?.disconnect();
  themeObserver?.disconnect();
  if (isUsingWindowResizeFallback) {
    window.removeEventListener('resize', resizeCharts);
  }
  if (refreshTimerId !== null) window.clearTimeout(refreshTimerId);
  if (exportFeedbackTimerId !== null) window.clearTimeout(exportFeedbackTimerId);
  trendChart?.dispose();
  tagChart?.dispose();
  trendChart = null;
  tagChart = null;
});
</script>

<template>
  <section class="stats-dashboard" aria-labelledby="stats-heading">
    <header class="dashboard-heading">
      <div>
        <p class="eyebrow">学习复盘</p>
        <h2 id="stats-heading">专注数据看板</h2>
      </div>
      <div class="heading-actions">
        <button
          type="button"
          class="icon-button"
          :disabled="isLoading"
          aria-label="刷新统计数据"
          title="刷新数据"
          @click="refreshData(true)"
        >
          <span aria-hidden="true">↻</span>
        </button>
        <button type="button" :disabled="!canExport" @click="exportCsv">
          导出 CSV
        </button>
        <button type="button" :disabled="!canExport" @click="exportJson">
          导出 JSON
        </button>
      </div>
    </header>

    <p v-if="loadWarning" class="load-warning" role="alert">
      {{ loadWarning }}
    </p>
    <p
      v-if="exportFeedback"
      class="export-feedback"
      :class="`is-${exportFeedback.kind}`"
      role="status"
      aria-live="polite"
    >
      {{ exportFeedback.message }}
    </p>

    <div class="summary-grid" aria-label="专注概览">
      <article>
        <span class="summary-icon" aria-hidden="true">⏱️</span>
        <div>
          <span>累计专注</span>
          <strong>{{ formatTotalDuration(totalFocusSeconds) }}</strong>
        </div>
      </article>
      <article>
        <span class="summary-icon" aria-hidden="true">🍅</span>
        <div>
          <span>完成番茄</span>
          <strong>{{ completedPomodoros }} 个</strong>
        </div>
      </article>
      <article>
        <span class="summary-icon" aria-hidden="true">🔥</span>
        <div>
          <span>当前连续</span>
          <strong>{{ currentStreak }} 天</strong>
        </div>
      </article>
      <article>
        <span class="summary-icon" aria-hidden="true">📅</span>
        <div>
          <span>累计打卡</span>
          <strong>{{ checkInDays }} 天</strong>
        </div>
      </article>
    </div>

    <div class="charts-grid">
      <article class="chart-card trend-card">
        <header class="chart-heading">
          <div>
            <h3>专注趋势</h3>
            <p>{{ rangeDescription }}每日专注时长</p>
          </div>
          <div class="range-switch" role="group" aria-label="趋势时间范围">
            <button
              type="button"
              :class="{ active: selectedRange === 7 }"
              :aria-pressed="selectedRange === 7"
              @click="selectRange(7)"
            >
              7 天
            </button>
            <button
              type="button"
              :class="{ active: selectedRange === 30 }"
              :aria-pressed="selectedRange === 30"
              @click="selectRange(30)"
            >
              30 天
            </button>
          </div>
        </header>
        <div class="chart-shell">
          <div
            ref="trendChartElement"
            class="chart"
            role="img"
            :aria-label="trendAriaLabel"
          />
          <div v-if="!isLoading && !hasTrendData" class="chart-empty">
            <span aria-hidden="true">📈</span>
            <p>完成一次专注后，这里会出现时长趋势。</p>
          </div>
          <div v-if="isLoading" class="chart-loading" role="status">正在整理数据…</div>
        </div>
      </article>

      <article class="chart-card tag-card">
        <header class="chart-heading">
          <div>
            <h3>标签分布</h3>
            <p>点击下方标签可隐藏或恢复占比</p>
          </div>
          <button
            v-if="hasHiddenTags"
            type="button"
            class="tag-reset-button"
            @click="showAllTags"
          >
            全部显示
          </button>
        </header>
        <div class="chart-shell">
          <div
            ref="tagChartElement"
            class="chart"
            role="img"
            :aria-label="tagAriaLabel"
          />
          <div v-if="!isLoading && !hasTagData" class="chart-empty">
            <span aria-hidden="true">🏷️</span>
            <p>为任务添加标签并完成专注后，可查看时间分布。</p>
          </div>
          <div v-if="!isLoading && hasTagData && !hasVisibleTagData" class="chart-empty">
            <span aria-hidden="true">👁️</span>
            <p>标签占比已全部隐藏，可点击“全部显示”恢复。</p>
            <button type="button" class="tag-reset-button" @click="showAllTags">
              全部显示
            </button>
          </div>
          <div v-if="isLoading" class="chart-loading" role="status">正在整理数据…</div>
        </div>
        <ul v-if="hasTagData" class="tag-breakdown" aria-label="标签时长完整明细">
          <li v-for="(item, index) in tagStats" :key="item.name">
            <button
              type="button"
              class="tag-toggle"
              :class="{ 'is-hidden': !isTagVisible(item.name) }"
              :aria-pressed="isTagVisible(item.name)"
              :aria-label="`${isTagVisible(item.name) ? '隐藏' : '显示'}标签“${item.name}”的占比`"
              @click="toggleTagVisibility(item.name)"
            >
              <span
                class="tag-swatch"
                :style="{ backgroundColor: getTagSwatch(index) }"
                aria-hidden="true"
              />
              <span class="tag-name" :title="item.name">{{ item.name }}</span>
              <span class="tag-value">
                <strong>{{ formatTagPercentage(item.durationSeconds) }}</strong>
                <small>{{ formatMinutes(item.durationMinutes) }} 分钟</small>
              </span>
            </button>
          </li>
        </ul>
      </article>
    </div>
  </section>
</template>

<style scoped lang="scss">
.stats-dashboard {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  width: 100%;
  padding: 2rem;
  color: var(--text-color);
  background: var(--card-bg);
  border: 1px solid var(--border-color);
  border-radius: 2rem;
  box-shadow: var(--shadow);
}

.dashboard-heading,
.chart-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.dashboard-heading h2 {
  font-size: 1.55rem;
  line-height: 1.25;
}

.eyebrow {
  margin-bottom: 0.25rem;
  color: var(--primary-color);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.heading-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem;

  button {
    min-height: 2.35rem;
    padding: 0.5rem 0.75rem;
    color: var(--text-color);
    background: var(--bg-color);
    border: 1px solid var(--border-color);
    border-radius: 0.7rem;
    font-size: 0.78rem;
    font-weight: 650;

    &:hover:not(:disabled) {
      color: var(--primary-color);
      border-color: var(--primary-color);
    }

    &:focus-visible {
      outline: 3px solid color-mix(in srgb, var(--primary-color) 30%, transparent);
      outline-offset: 2px;
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.45;
    }
  }

  .icon-button {
    width: 2.35rem;
    padding: 0;
    font-size: 1.15rem;
  }
}

.load-warning,
.export-feedback {
  padding: 0.7rem 0.9rem;
  background: var(--bg-color);
  border: 1px solid var(--border-color);
  border-radius: 0.8rem;
  font-size: 0.82rem;
}

.load-warning,
.export-feedback.is-error {
  color: var(--primary-color);
  border-color: color-mix(in srgb, var(--primary-color) 30%, transparent);
}

.export-feedback.is-success {
  border-color: color-mix(in srgb, var(--secondary-color) 45%, transparent);
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.8rem;

  article {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    min-width: 0;
    padding: 1rem;
    background: var(--bg-color);
    border: 1px solid var(--border-color);
    border-radius: 1rem;
  }

  .summary-icon {
    display: grid;
    flex: none;
    place-items: center;
    width: 2.3rem;
    height: 2.3rem;
    background: var(--card-bg);
    border-radius: 0.75rem;
    font-size: 1.1rem;
  }

  span:not(.summary-icon) {
    display: block;
    margin-bottom: 0.15rem;
    font-size: 0.72rem;
    opacity: 0.58;
  }

  strong {
    display: block;
    overflow: hidden;
    font-size: 1rem;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
}

.charts-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(300px, 0.85fr);
  gap: 1rem;
}

.chart-card {
  min-width: 0;
  padding: 1.15rem;
  background: var(--bg-color);
  border: 1px solid var(--border-color);
  border-radius: 1.15rem;
}

.chart-heading {
  min-height: 2.9rem;

  h3 {
    font-size: 1rem;
  }

  p {
    margin-top: 0.15rem;
    font-size: 0.74rem;
    opacity: 0.58;
  }
}

.tag-reset-button {
  flex: none;
  min-height: 2rem;
  padding: 0.35rem 0.65rem;
  color: var(--primary-color);
  background: var(--card-bg);
  border: 1px solid color-mix(in srgb, var(--primary-color) 35%, var(--border-color));
  border-radius: 0.6rem;
  font-size: 0.7rem;
  font-weight: 700;

  &:hover {
    background: color-mix(in srgb, var(--primary-color) 8%, var(--card-bg));
  }

  &:focus-visible {
    outline: 3px solid color-mix(in srgb, var(--primary-color) 30%, transparent);
    outline-offset: 2px;
  }
}

.range-switch {
  display: flex;
  flex: none;
  padding: 0.2rem;
  background: var(--card-bg);
  border: 1px solid var(--border-color);
  border-radius: 0.65rem;

  button {
    padding: 0.35rem 0.6rem;
    color: var(--text-color);
    background: transparent;
    border-radius: 0.45rem;
    font-size: 0.72rem;
    font-weight: 650;

    &.active {
      color: #fff;
      background: var(--primary-color);
    }

    &:focus-visible {
      outline: 2px solid var(--primary-color);
      outline-offset: 1px;
    }
  }
}

.chart-shell {
  position: relative;
  min-height: 310px;
}

.chart {
  width: 100%;
  height: 310px;
}

.tag-card .chart-shell {
  min-height: 230px;
}

.tag-card .chart {
  height: 230px;
}

.tag-breakdown {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
  gap: 0.55rem;
  margin: 0.7rem 0 0;
  padding: 0;
  list-style: none;

  li {
    min-width: 0;
  }
}

.tag-toggle {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.45rem;
  width: 100%;
  min-height: 3rem;
  padding: 0.55rem 0.65rem;
  color: var(--text-color);
  text-align: left;
  background: var(--card-bg);
  border: 1px solid var(--border-color);
  border-radius: 0.75rem;
  transition: border-color 160ms ease, opacity 160ms ease, transform 160ms ease;

  &:hover {
    border-color: color-mix(in srgb, var(--primary-color) 45%, var(--border-color));
    transform: translateY(-1px);
  }

  &:focus-visible {
    outline: 3px solid color-mix(in srgb, var(--primary-color) 30%, transparent);
    outline-offset: 2px;
  }

  &.is-hidden {
    opacity: 0.45;

    .tag-name,
    .tag-value {
      text-decoration: line-through;
    }

    .tag-swatch {
      background: transparent !important;
      border: 2px solid currentColor;
    }
  }
}

.tag-swatch {
  width: 0.62rem;
  height: 0.62rem;
  box-sizing: border-box;
  border-radius: 50%;
}

.tag-name {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 0.76rem;
  font-weight: 700;
  line-height: 1.25;
}

.tag-value {
  text-align: right;
  white-space: nowrap;

  strong,
  small {
    display: block;
  }

  strong {
    font-size: 0.76rem;
    color: var(--text-color);
  }

  small {
    margin-top: 0.05rem;
    color: var(--text-muted);
    font-size: 0.62rem;
  }
}

.chart-empty,
.chart-loading {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: grid;
  place-content: center;
  justify-items: center;
  padding: 2rem;
  text-align: center;
  background: var(--bg-color);
  border-radius: 0.8rem;
  font-size: 0.82rem;
  opacity: 0.85;

  span {
    margin-bottom: 0.6rem;
    font-size: 2rem;
  }

  p {
    max-width: 16rem;
    opacity: 0.65;
  }

  .tag-reset-button {
    margin-top: 0.8rem;
  }
}

.chart-loading {
  opacity: 0.92;
}

@media (max-width: 940px) {
  .summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .charts-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 620px) {
  .stats-dashboard {
    padding: 1.25rem;
    border-radius: 1.4rem;
  }

  .dashboard-heading {
    flex-direction: column;
  }

  .heading-actions {
    width: 100%;
    justify-content: flex-start;
  }

  .summary-grid {
    grid-template-columns: 1fr;
  }

  .chart-card {
    padding: 0.85rem;
  }

  .chart-heading {
    align-items: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  .heading-actions button,
  .tag-toggle {
    transition: none;
  }
}
</style>
