type TimerCommand =
  | { type: 'schedule'; sessionId: string; deadline: number }
  | { type: 'cancel'; sessionId?: string }
  | { type: 'dispose' };

let timeoutId: number | null = null;
let activeSessionId: string | null = null;
let activeDeadline = 0;

const clearScheduledTick = () => {
  if (timeoutId !== null) {
    self.clearTimeout(timeoutId);
    timeoutId = null;
  }
};

const tick = () => {
  if (!activeSessionId) return;

  const now = Date.now();
  const remainingMs = Math.max(0, activeDeadline - now);
  self.postMessage({
    type: 'tick',
    sessionId: activeSessionId,
    remainingMs,
    now,
  });

  if (remainingMs <= 0) {
    const completedSessionId = activeSessionId;
    activeSessionId = null;
    clearScheduledTick();
    self.postMessage({ type: 'elapsed', sessionId: completedSessionId, now });
    return;
  }

  // Recalculate against an absolute deadline on every tick. This avoids the
  // accumulated drift caused by decrementing a counter in a throttled tab.
  const nextSecondBoundary = remainingMs % 1000 || 1000;
  timeoutId = self.setTimeout(tick, Math.max(50, Math.min(1000, nextSecondBoundary)));
};

self.onmessage = (event: MessageEvent<TimerCommand>) => {
  const command = event.data;

  if (command.type === 'schedule') {
    clearScheduledTick();
    activeSessionId = command.sessionId;
    activeDeadline = command.deadline;
    tick();
    return;
  }

  if (command.type === 'cancel') {
    if (!command.sessionId || command.sessionId === activeSessionId) {
      clearScheduledTick();
      activeSessionId = null;
    }
    return;
  }

  clearScheduledTick();
  activeSessionId = null;
  self.close();
};
