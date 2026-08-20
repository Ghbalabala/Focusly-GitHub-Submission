export const STORAGE_KEYS = {
  TIMER_CONFIG: 'focusly_timer_config',
  TASKS: 'focusly_task_list',
  CLOCK_RECORDS: 'focusly_clock_list',
  FOCUS_SESSIONS: 'focusly_focus_sessions',
  WEEK_STATS: 'focusly_stat_week',
  MONTH_STATS: 'focusly_stat_month',
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];
export type DataChangeSource = 'local' | 'broadcast' | 'storage';

export interface DataChangeEvent {
  key: StorageKey;
  source: DataChangeSource;
  timestamp: number;
}

export type DataChangeHandler = (event: DataChangeEvent) => void;

interface BroadcastDataChange {
  type: 'focusly:data-change';
  key: StorageKey;
  timestamp: number;
}

const CHANNEL_NAME = 'focusly_data_changes';
const canonicalKeys = new Set<string>(Object.values(STORAGE_KEYS));
// Entries exist only when native storage could not persist the latest value.
// `null` represents a failed native removal.
const memoryOverrides = new Map<string, string | null>();
const listeners = new Set<DataChangeHandler>();

let channel: BroadcastChannel | null = null;
let storageListenerAttached = false;

const isStorageKey = (key: string | null): key is StorageKey =>
  key !== null && canonicalKeys.has(key);

const getLocalStorage = (): Storage | null => {
  if (typeof window === 'undefined') return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const readRaw = (key: string): string | null => {
  if (memoryOverrides.has(key)) return memoryOverrides.get(key) ?? null;

  const storage = getLocalStorage();
  if (storage) {
    try {
      return storage.getItem(key);
    } catch {
      // An in-memory fallback keeps the current tab usable in restricted modes.
    }
  }

  return null;
};

const notifyListeners = (event: DataChangeEvent): void => {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.error('Focusly data-change listener failed:', error);
    }
  }
};

const isBroadcastDataChange = (value: unknown): value is BroadcastDataChange => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<BroadcastDataChange>;
  return (
    candidate.type === 'focusly:data-change' &&
    typeof candidate.key === 'string' &&
    isStorageKey(candidate.key) &&
    typeof candidate.timestamp === 'number'
  );
};

const ensureChannel = (): BroadcastChannel | null => {
  if (channel || typeof window === 'undefined' || typeof window.BroadcastChannel !== 'function') {
    return channel;
  }

  channel = new window.BroadcastChannel(CHANNEL_NAME);
  channel.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (!isBroadcastDataChange(event.data)) return;
    notifyListeners({
      key: event.data.key,
      source: 'broadcast',
      timestamp: event.data.timestamp,
    });
  });
  return channel;
};

const handleStorageEvent = (event: StorageEvent): void => {
  if (!isStorageKey(event.key)) return;

  // The native storage event is authoritative for changes from another tab.
  memoryOverrides.delete(event.key);

  notifyListeners({
    key: event.key,
    source: 'storage',
    timestamp: Date.now(),
  });
};

const ensureStorageListener = (): void => {
  if (storageListenerAttached || typeof window === 'undefined') return;
  window.addEventListener('storage', handleStorageEvent);
  storageListenerAttached = true;
};

const publishDataChange = (key: string): void => {
  if (!isStorageKey(key)) return;

  const timestamp = Date.now();
  notifyListeners({ key, source: 'local', timestamp });
  ensureChannel()?.postMessage({
    type: 'focusly:data-change',
    key,
    timestamp,
  } satisfies BroadcastDataChange);
};

/** Safely parses JSON and returns the supplied fallback for missing or corrupt data. */
export function readJson<T>(
  key: string,
  fallback: T,
  validate?: (value: unknown) => value is T,
): T {
  const raw = readRaw(key);
  if (raw === null) return fallback;

  try {
    const value: unknown = JSON.parse(raw);
    if (validate) return validate(value) ? value : fallback;
    return value as T;
  } catch {
    return fallback;
  }
}

/** Persists JSON locally and emits a change only when the serialized value changed. */
export function writeJson(key: string, value: unknown): boolean {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError(`Value for ${key} cannot be serialized as JSON.`);
  }

  if (readRaw(key) === serialized) return false;

  const storage = getLocalStorage();
  let persisted = false;
  if (storage) {
    try {
      storage.setItem(key, serialized);
      persisted = true;
    } catch {
      // Keep an in-memory copy if persistence is unavailable or quota is full.
    }
  }

  if (persisted) {
    memoryOverrides.delete(key);
  } else {
    memoryOverrides.set(key, serialized);
  }
  publishDataChange(key);
  return true;
}

export function removeJson(key: string): boolean {
  if (readRaw(key) === null) return false;

  const storage = getLocalStorage();
  let removed = false;
  if (storage) {
    try {
      storage.removeItem(key);
      removed = true;
    } catch {
      // The in-memory fallback is still cleared below.
    }
  }

  if (removed) {
    memoryOverrides.delete(key);
  } else {
    memoryOverrides.set(key, null);
  }
  publishDataChange(key);
  return true;
}

/** Subscribes to same-tab, BroadcastChannel, and storage-event data changes. */
export function subscribeDataChanges(handler: DataChangeHandler): () => void {
  listeners.add(handler);
  ensureChannel();
  ensureStorageListener();

  return () => {
    listeners.delete(handler);
  };
}
