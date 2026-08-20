export type TimerMode = 'study' | 'rest';
export type TimerStatus = 'idle' | 'running' | 'paused';

export const clampRemainingSeconds = (deadline: number, now = Date.now()): number =>
  Math.max(0, Math.ceil((deadline - now) / 1000));

export const formatDuration = (seconds: number): string => {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainder = safeSeconds % 60;

  if (hours > 0) {
    return [hours, minutes, remainder]
      .map((part) => String(part).padStart(2, '0'))
      .join(':');
  }

  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
};

export const timerProgress = (remainingSeconds: number, totalSeconds: number): number => {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return 0;
  return Math.min(1, Math.max(0, remainingSeconds / totalSeconds));
};

export const validateDurationMinutes = (
  value: string | number,
  maximum: number,
): { valid: true; value: number } | { valid: false; message: string } => {
  const normalized = typeof value === 'string' ? value.trim() : value;
  const parsed = typeof normalized === 'number' ? normalized : Number(normalized);

  if (normalized === '' || !Number.isFinite(parsed)) {
    return { valid: false, message: '请输入有效数字' };
  }
  if (!Number.isInteger(parsed)) {
    return { valid: false, message: '时长需要使用整分钟' };
  }
  if (parsed < 1 || parsed > maximum) {
    return { valid: false, message: `请输入 1–${maximum} 分钟` };
  }

  return { valid: true, value: parsed };
};
