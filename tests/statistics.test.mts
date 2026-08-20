import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateSessionsByDate,
  aggregateSessionsByTag,
  calculateCurrentStreak,
  calculateTotalFocusSeconds,
  createLocalDateSequence,
  parseLocalDateKey,
  toLocalDateKey,
} from '../src/utils/statistics.ts';

const session = (id: string, date: string, seconds: number, tags: string[] = []) => ({
  id,
  tags,
  durationSeconds: seconds,
  startedAt: `${date}T01:00:00.000Z`,
  completedAt: `${date}T01:25:00.000Z`,
  date,
});

test('local date helpers are strict and produce gap-free sequences', () => {
  const end = new Date(2026, 7, 20, 12);
  assert.equal(toLocalDateKey(end), '2026-08-20');
  assert.equal(parseLocalDateKey('2026-02-30'), null);
  assert.deepEqual(createLocalDateSequence(3, end), [
    '2026-08-18',
    '2026-08-19',
    '2026-08-20',
  ]);
});

test('daily aggregation fills missing dates with zero', () => {
  const end = new Date(2026, 7, 20, 12);
  assert.deepEqual(aggregateSessionsByDate([
    session('one', '2026-08-18', 1500),
    session('two', '2026-08-20', 3000),
  ], 3, end), [
    { date: '2026-08-18', duration: 25 },
    { date: '2026-08-19', duration: 0 },
    { date: '2026-08-20', duration: 50 },
  ]);
});

test('multi-tag sessions split their duration without double counting', () => {
  const result = aggregateSessionsByTag([
    session('one', '2026-08-20', 3600, ['编程', '科研']),
    session('two', '2026-08-20', 1800),
  ]);
  assert.equal(result.reduce((sum, item) => sum + item.durationSeconds, 0), 5400);
  assert.equal(result.find((item) => item.name === '编程')?.durationMinutes, 30);
  assert.equal(result.find((item) => item.name === '未分类')?.durationMinutes, 30);
});

test('check-in snapshots do not double count their underlying sessions', () => {
  const sessions = [session('one', '2026-08-20', 3000)];
  const records = [{ date: '2026-08-20', studyTime: 50, createTime: '2026-08-20T10:00:00Z' }];
  assert.equal(calculateTotalFocusSeconds(sessions, records), 3000);
});

test('current streak can continue from yesterday before today is recorded', () => {
  const today = new Date(2026, 7, 20, 12);
  assert.equal(calculateCurrentStreak(['2026-08-18', '2026-08-19'], today), 2);
  assert.equal(calculateCurrentStreak(['2026-08-17'], today), 0);
});
