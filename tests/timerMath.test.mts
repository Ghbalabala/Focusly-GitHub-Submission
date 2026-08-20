import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampRemainingSeconds,
  formatDuration,
  timerProgress,
  validateDurationMinutes,
} from '../src/utils/timerMath.ts';

test('formatDuration formats minutes and long sessions', () => {
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(25 * 60), '25:00');
  assert.equal(formatDuration(3661), '01:01:01');
  assert.equal(formatDuration(-20), '00:00');
});

test('deadline calculation rounds up partial seconds and clamps expired timers', () => {
  assert.equal(clampRemainingSeconds(10_001, 10_000), 1);
  assert.equal(clampRemainingSeconds(11_000, 10_000), 1);
  assert.equal(clampRemainingSeconds(9_999, 10_000), 0);
});

test('timer progress remains inside the visual range', () => {
  assert.equal(timerProgress(30, 60), 0.5);
  assert.equal(timerProgress(90, 60), 1);
  assert.equal(timerProgress(-1, 60), 0);
  assert.equal(timerProgress(1, 0), 0);
});

test('duration validation rejects empty, fractional and out-of-range values', () => {
  assert.deepEqual(validateDurationMinutes('25', 180), { valid: true, value: 25 });
  assert.equal(validateDurationMinutes('', 180).valid, false);
  assert.equal(validateDurationMinutes('2.5', 180).valid, false);
  assert.equal(validateDurationMinutes('-1', 180).valid, false);
  assert.equal(validateDurationMinutes('181', 180).valid, false);
});
