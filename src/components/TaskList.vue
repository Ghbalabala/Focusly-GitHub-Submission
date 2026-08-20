<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, reactive, ref } from 'vue';
import {
  STORAGE_KEYS,
  addTask,
  clearTasks,
  deleteTask,
  getTaskList,
  subscribeDataChanges,
  updateTask,
} from '../api';
import type { TaskItem } from '../api/types';

const CONTENT_MAX_LENGTH = 80;
const DESCRIPTION_MAX_LENGTH = 240;
const TAG_MAX_LENGTH = 16;
const TAG_MAX_COUNT = 8;

interface TaskDraft {
  content: string;
  description: string;
  tags: string;
}

interface ValidatedTaskDraft {
  content: string;
  description: string;
  tags: string[];
}

const props = withDefaults(
  defineProps<{
    activeTaskId?: string | null;
  }>(),
  {
    activeTaskId: null,
  },
);

const emit = defineEmits<{
  select: [task: TaskItem | null];
  change: [tasks: TaskItem[]];
}>();

const tasks = ref<TaskItem[]>([]);
const isLoading = ref(true);
const isAdding = ref(false);
const isClearing = ref(false);
const pendingTaskIds = reactive(new Set<string>());
const operationError = ref('');
const addError = ref('');
const editError = ref('');
const editingTaskId = ref<string | null>(null);

const newTask = reactive<TaskDraft>({
  content: '',
  description: '',
  tags: '',
});

const editTask = reactive<TaskDraft>({
  content: '',
  description: '',
  tags: '',
});

const newTaskInput = ref<HTMLInputElement | null>(null);
let unsubscribeDataChanges: (() => void) | undefined;
let latestLoadId = 0;

const focusEditTask = async (taskId: string) => {
  await nextTick();
  document.getElementById(`edit-task-content-${taskId}`)?.focus();
};

const cloneTasks = (items: TaskItem[]): TaskItem[] =>
  items.map((task) => ({
    ...task,
    description: task.description ?? '',
    tags: [...(task.tags ?? [])],
  }));

const commitTasks = (items: TaskItem[]) => {
  const normalizedTasks = cloneTasks(items);
  tasks.value = normalizedTasks;
  emit('change', cloneTasks(normalizedTasks));

  if (props.activeTaskId) {
    const activeTask = normalizedTasks.find((task) => task.id === props.activeTaskId);
    if (!activeTask || activeTask.status === 1) {
      emit('select', null);
    }
  }
};

const errorMessage = (action: string, error: unknown) => {
  console.error(`Failed to ${action}:`, error);
  return `${action}失败，请稍后重试。`;
};

const loadTasks = async (showLoading = true) => {
  const loadId = ++latestLoadId;
  if (showLoading) {
    isLoading.value = true;
  }
  operationError.value = '';

  try {
    const result = await getTaskList();
    if (loadId === latestLoadId) {
      commitTasks(result);
    }
  } catch (error: unknown) {
    if (loadId === latestLoadId) {
      operationError.value = errorMessage('加载任务', error);
    }
  } finally {
    if (loadId === latestLoadId) {
      isLoading.value = false;
    }
  }
};

const parseTags = (value: string): string[] => {
  const uniqueTags = new Set<string>();

  value
    .split(/[,，\s]+/u)
    .map((tag) => tag.trim().replace(/^#+/u, ''))
    .filter(Boolean)
    .forEach((tag) => uniqueTags.add(tag));

  return [...uniqueTags];
};

const validateDraft = (draft: TaskDraft): ValidatedTaskDraft | string => {
  const content = draft.content.trim();
  const description = draft.description.trim();
  const tags = parseTags(draft.tags);

  if (!content) {
    return '请输入任务内容。';
  }
  if (content.length > CONTENT_MAX_LENGTH) {
    return `任务内容不能超过 ${CONTENT_MAX_LENGTH} 个字符。`;
  }
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    return `任务描述不能超过 ${DESCRIPTION_MAX_LENGTH} 个字符。`;
  }
  if (tags.length > TAG_MAX_COUNT) {
    return `最多添加 ${TAG_MAX_COUNT} 个标签。`;
  }
  if (tags.some((tag) => tag.length > TAG_MAX_LENGTH)) {
    return `每个标签不能超过 ${TAG_MAX_LENGTH} 个字符。`;
  }

  return { content, description, tags };
};

const replaceTask = (updatedTask: TaskItem) => {
  commitTasks(
    tasks.value.map((task) => (task.id === updatedTask.id ? updatedTask : task)),
  );
};

const resetNewTask = () => {
  newTask.content = '';
  newTask.description = '';
  newTask.tags = '';
  addError.value = '';
};

const handleAddTask = async () => {
  addError.value = '';
  operationError.value = '';
  const validated = validateDraft(newTask);

  if (typeof validated === 'string') {
    addError.value = validated;
    await nextTick();
    newTaskInput.value?.focus();
    return;
  }

  isAdding.value = true;
  try {
    const createdTask = await addTask({
      ...validated,
      status: 0,
      createTime: new Date().toISOString(),
    });
    commitTasks([createdTask, ...tasks.value.filter((task) => task.id !== createdTask.id)]);
    resetNewTask();
    await nextTick();
    newTaskInput.value?.focus();
  } catch (error: unknown) {
    addError.value = errorMessage('添加任务', error);
  } finally {
    isAdding.value = false;
  }
};

const startEditing = async (task: TaskItem) => {
  editingTaskId.value = task.id;
  editTask.content = task.content;
  editTask.description = task.description ?? '';
  editTask.tags = (task.tags ?? []).join(', ');
  editError.value = '';
  await focusEditTask(task.id);
};

const cancelEditing = () => {
  editingTaskId.value = null;
  editError.value = '';
};

const saveTask = async (task: TaskItem) => {
  editError.value = '';
  operationError.value = '';
  const validated = validateDraft(editTask);

  if (typeof validated === 'string') {
    editError.value = validated;
    await focusEditTask(task.id);
    return;
  }

  pendingTaskIds.add(task.id);
  try {
    const updatedTask = await updateTask({ ...task, ...validated });
    replaceTask(updatedTask);
    if (props.activeTaskId === task.id) {
      emit('select', { ...updatedTask, tags: [...updatedTask.tags] });
    }
    cancelEditing();
  } catch (error: unknown) {
    editError.value = errorMessage('保存任务', error);
  } finally {
    pendingTaskIds.delete(task.id);
  }
};

const toggleStatus = async (task: TaskItem) => {
  operationError.value = '';
  pendingTaskIds.add(task.id);
  const nextStatus: 0 | 1 = task.status === 0 ? 1 : 0;

  try {
    const updatedTask = await updateTask({ ...task, status: nextStatus });
    replaceTask(updatedTask);
  } catch (error: unknown) {
    operationError.value = errorMessage('更新任务状态', error);
  } finally {
    pendingTaskIds.delete(task.id);
  }
};

const removeTask = async (task: TaskItem) => {
  operationError.value = '';
  pendingTaskIds.add(task.id);

  try {
    await deleteTask(task.id);
    commitTasks(tasks.value.filter((item) => item.id !== task.id));
    if (editingTaskId.value === task.id) {
      cancelEditing();
    }
  } catch (error: unknown) {
    operationError.value = errorMessage('删除任务', error);
  } finally {
    pendingTaskIds.delete(task.id);
  }
};

const clearAllTasks = async () => {
  if (tasks.value.length === 0) {
    return;
  }

  const confirmed = window.confirm('确定清空全部任务吗？此操作无法撤销。');
  if (!confirmed) {
    return;
  }

  operationError.value = '';
  isClearing.value = true;
  try {
    await clearTasks();
    commitTasks([]);
    cancelEditing();
  } catch (error: unknown) {
    operationError.value = errorMessage('清空任务', error);
  } finally {
    isClearing.value = false;
  }
};

const selectTask = (task: TaskItem) => {
  if (task.status === 1 || pendingTaskIds.has(task.id)) {
    return;
  }

  if (props.activeTaskId === task.id) {
    emit('select', null);
    return;
  }

  emit('select', { ...task, tags: [...task.tags] });
};

const focusNewTask = async () => {
  await nextTick();
  newTaskInput.value?.focus();
  newTaskInput.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

const handleNewTaskShortcut = (event: KeyboardEvent) => {
  if (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    event.key.toLowerCase() === 'n'
  ) {
    event.preventDefault();
    void focusNewTask();
  }
};

onMounted(() => {
  document.addEventListener('keydown', handleNewTaskShortcut);
  unsubscribeDataChanges = subscribeDataChanges(({ key, source }) => {
    // Local writes are already applied from the mutation result. Reload only for
    // another tab/window so an in-flight local request cannot overwrite the UI.
    if (key === STORAGE_KEYS.TASKS && source !== 'local') {
      void loadTasks(false);
    }
  });
  void loadTasks();
});

onUnmounted(() => {
  document.removeEventListener('keydown', handleNewTaskShortcut);
  unsubscribeDataChanges?.();
});
</script>

<template>
  <section class="task-card" aria-labelledby="task-list-title" :aria-busy="isLoading">
    <header class="task-header">
      <div>
        <h2 id="task-list-title">学习任务清单</h2>
        <p class="task-summary">
          {{ tasks.filter((task) => task.status === 0).length }} 项待完成
          <span aria-hidden="true">·</span>
          <kbd>{{ '⌘/Ctrl + N' }}</kbd> 快速新建
        </p>
      </div>
      <button
        type="button"
        class="clear-button"
        :disabled="tasks.length === 0 || isClearing"
        aria-label="清空全部学习任务"
        @click="clearAllTasks"
      >
        {{ isClearing ? '清空中…' : '清空全部' }}
      </button>
    </header>

    <form class="task-form" novalidate @submit.prevent="handleAddTask">
      <div class="field-group content-field">
        <label for="new-task-content">任务内容 <span aria-hidden="true">*</span></label>
        <div class="primary-input-row">
          <input
            id="new-task-content"
            ref="newTaskInput"
            v-model="newTask.content"
            type="text"
            :maxlength="CONTENT_MAX_LENGTH"
            placeholder="例如：完成高等数学第三章习题"
            autocomplete="off"
            :aria-invalid="Boolean(addError)"
            aria-describedby="new-task-content-help add-task-error"
          />
          <button type="submit" class="add-button" :disabled="isAdding">
            {{ isAdding ? '添加中…' : '添加任务' }}
          </button>
        </div>
        <span id="new-task-content-help" class="character-count">
          {{ newTask.content.length }}/{{ CONTENT_MAX_LENGTH }}
        </span>
      </div>

      <div class="form-grid">
        <div class="field-group">
          <label for="new-task-description">简要描述（可选）</label>
          <textarea
            id="new-task-description"
            v-model="newTask.description"
            :maxlength="DESCRIPTION_MAX_LENGTH"
            rows="2"
            placeholder="补充范围、目标或完成标准"
          ></textarea>
          <span class="character-count">
            {{ newTask.description.length }}/{{ DESCRIPTION_MAX_LENGTH }}
          </span>
        </div>
        <div class="field-group">
          <label for="new-task-tags">标签（可选）</label>
          <input
            id="new-task-tags"
            v-model="newTask.tags"
            type="text"
            placeholder="科研, 编程（逗号或空格分隔）"
            autocomplete="off"
          />
          <span class="field-help">最多 {{ TAG_MAX_COUNT }} 个，每个 {{ TAG_MAX_LENGTH }} 字</span>
        </div>
      </div>

      <p v-if="addError" id="add-task-error" class="form-error" role="alert">
        {{ addError }}
      </p>
    </form>

    <div v-if="operationError" class="error-banner" role="alert">
      <span>{{ operationError }}</span>
      <button type="button" aria-label="重新加载任务" @click="loadTasks()">重试</button>
    </div>

    <div v-if="isLoading && tasks.length === 0" class="state-panel" role="status">
      <span class="spinner" aria-hidden="true"></span>
      正在加载任务…
    </div>

    <div v-else-if="tasks.length === 0 && !operationError" class="state-panel empty-state">
      <span class="empty-icon" aria-hidden="true">✓</span>
      <strong>还没有学习任务</strong>
      <span>写下一个清晰目标，开始今天的专注。</span>
      <button type="button" @click="focusNewTask">创建第一个任务</button>
    </div>

    <ul v-else class="task-list" aria-label="学习任务">
      <li
        v-for="task in tasks"
        :key="task.id"
        class="task-item"
        :class="{
          completed: task.status === 1,
          active: props.activeTaskId === task.id,
          pending: pendingTaskIds.has(task.id),
        }"
        :aria-busy="pendingTaskIds.has(task.id)"
      >
        <form
          v-if="editingTaskId === task.id"
          class="edit-form"
          novalidate
          @submit.prevent="saveTask(task)"
        >
          <div class="field-group">
            <label :for="`edit-task-content-${task.id}`">任务内容</label>
            <input
              :id="`edit-task-content-${task.id}`"
              v-model="editTask.content"
              type="text"
              :maxlength="CONTENT_MAX_LENGTH"
              :aria-invalid="Boolean(editError)"
              :aria-describedby="`edit-task-error-${task.id}`"
            />
            <span class="character-count">
              {{ editTask.content.length }}/{{ CONTENT_MAX_LENGTH }}
            </span>
          </div>
          <div class="field-group">
            <label :for="`edit-task-description-${task.id}`">简要描述</label>
            <textarea
              :id="`edit-task-description-${task.id}`"
              v-model="editTask.description"
              :maxlength="DESCRIPTION_MAX_LENGTH"
              rows="2"
            ></textarea>
            <span class="character-count">
              {{ editTask.description.length }}/{{ DESCRIPTION_MAX_LENGTH }}
            </span>
          </div>
          <div class="field-group">
            <label :for="`edit-task-tags-${task.id}`">标签</label>
            <input
              :id="`edit-task-tags-${task.id}`"
              v-model="editTask.tags"
              type="text"
              placeholder="用逗号或空格分隔"
            />
          </div>
          <p
            v-if="editError"
            :id="`edit-task-error-${task.id}`"
            class="form-error"
            role="alert"
          >
            {{ editError }}
          </p>
          <div class="edit-actions">
            <button type="button" class="secondary-button" @click="cancelEditing">取消</button>
            <button
              type="submit"
              class="primary-button"
              :disabled="pendingTaskIds.has(task.id)"
            >
              {{ pendingTaskIds.has(task.id) ? '保存中…' : '保存修改' }}
            </button>
          </div>
        </form>

        <template v-else>
          <input
            :id="`task-status-${task.id}`"
            class="status-checkbox"
            type="checkbox"
            :checked="task.status === 1"
            :disabled="pendingTaskIds.has(task.id)"
            :aria-label="`${task.status === 1 ? '标记为未完成' : '标记为已完成'}：${task.content}`"
            @change="toggleStatus(task)"
          />

          <button
            type="button"
            class="task-copy"
            :class="{ selected: props.activeTaskId === task.id }"
            :disabled="task.status === 1 || pendingTaskIds.has(task.id)"
            :aria-label="
              props.activeTaskId === task.id
                ? `取消当前专注任务：${task.content}`
                : `选择为当前专注任务：${task.content}`
            "
            :aria-pressed="props.activeTaskId === task.id"
            @click="selectTask(task)"
          >
            <span class="task-content">{{ task.content }}</span>
            <span v-if="task.description" class="task-description">{{ task.description }}</span>
            <span v-if="task.tags.length" class="tags" aria-label="任务标签">
              <span v-for="tag in task.tags" :key="tag" class="tag">#{{ tag }}</span>
            </span>
          </button>

          <div class="task-actions">
            <span v-if="props.activeTaskId === task.id" class="active-label">当前专注</span>
            <button
              type="button"
              class="icon-button"
              :disabled="pendingTaskIds.has(task.id)"
              :aria-label="`编辑任务：${task.content}`"
              title="编辑任务"
              @click="startEditing(task)"
            >
              编辑
            </button>
            <button
              type="button"
              class="icon-button danger-button"
              :disabled="pendingTaskIds.has(task.id)"
              :aria-label="`删除任务：${task.content}`"
              title="删除任务"
              @click="removeTask(task)"
            >
              删除
            </button>
          </div>
        </template>
      </li>
    </ul>
  </section>
</template>

<style scoped lang="scss">
.task-card {
  width: 100%;
  min-width: 0;
  min-height: 560px;
  padding: clamp(1.1rem, 3vw, 2rem);
  border: 1px solid var(--border-color);
  border-radius: 2rem;
  background: var(--card-bg);
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.task-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;

  h2 {
    color: var(--text-color);
    font-size: clamp(1.25rem, 3vw, 1.5rem);
    line-height: 1.3;
  }
}

.task-summary {
  margin-top: 0.3rem;
  color: var(--text-color);
  font-size: 0.82rem;
  opacity: 0.65;

  kbd {
    padding: 0.08rem 0.3rem;
    border: 1px solid var(--border-color);
    border-radius: 0.35rem;
    background: var(--bg-color);
    font-family: inherit;
  }
}

.clear-button,
.secondary-button,
.icon-button {
  border: 1px solid var(--border-color);
  background: var(--bg-color);
  color: var(--text-color);
}

.clear-button {
  flex: none;
  padding: 0.55rem 0.75rem;
  border-radius: 0.65rem;
  font-size: 0.82rem;

  &:hover:not(:disabled) {
    border-color: var(--primary-color);
    color: var(--primary-color);
  }
}

.task-form,
.edit-form {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.task-form {
  padding: 1rem;
  border: 1px solid var(--border-color);
  border-radius: 1rem;
  background: var(--bg-color);
}

.form-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 0.8rem;
}

.field-group {
  position: relative;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.32rem;

  label {
    color: var(--text-color);
    font-size: 0.78rem;
    font-weight: 650;
  }

  input,
  textarea {
    width: 100%;
    border: 1px solid var(--border-color);
    border-radius: 0.7rem;
    outline: none;
    background: var(--card-bg);
    color: var(--text-color);
    font: inherit;
    font-size: 0.9rem;

    &::placeholder {
      color: var(--text-color);
      opacity: 0.42;
    }

    &:focus {
      border-color: var(--primary-color);
      box-shadow: 0 0 0 3px rgb(255 107 107 / 16%);
    }

    &[aria-invalid='true'] {
      border-color: #d92d20;
    }
  }

  input {
    min-height: 42px;
    padding: 0.65rem 0.75rem;
  }

  textarea {
    min-height: 68px;
    padding: 0.6rem 0.75rem;
    resize: vertical;
  }
}

.primary-input-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.55rem;
}

.add-button,
.primary-button {
  border-radius: 0.7rem;
  background: var(--primary-color);
  color: #fff;
  font-weight: 650;

  &:hover:not(:disabled) {
    background: var(--primary-light);
    transform: translateY(-1px);
  }
}

.add-button {
  min-width: 92px;
  padding: 0.65rem 0.9rem;
}

.primary-button,
.secondary-button {
  min-height: 38px;
  padding: 0.5rem 0.8rem;
}

.secondary-button {
  border-radius: 0.7rem;
}

.character-count,
.field-help {
  align-self: flex-end;
  color: var(--text-color);
  font-size: 0.7rem;
  opacity: 0.55;
}

.form-error {
  color: #d92d20;
  font-size: 0.82rem;
  font-weight: 600;
}

.error-banner {
  padding: 0.7rem 0.85rem;
  border: 1px solid rgb(217 45 32 / 28%);
  border-radius: 0.75rem;
  background: rgb(217 45 32 / 8%);
  color: #d92d20;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  font-size: 0.82rem;

  button {
    padding: 0.3rem 0.55rem;
    border-radius: 0.45rem;
    background: #d92d20;
    color: #fff;
  }
}

.state-panel {
  min-height: 190px;
  padding: 2rem 1rem;
  color: var(--text-color);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.65rem;
  text-align: center;
  opacity: 0.68;
}

.spinner {
  width: 1.1rem;
  height: 1.1rem;
  border: 2px solid var(--border-color);
  border-top-color: var(--primary-color);
  border-radius: 50%;
  animation: spin 0.75s linear infinite;
}

.empty-state {
  flex-direction: column;

  .empty-icon {
    width: 3rem;
    height: 3rem;
    border-radius: 50%;
    background: var(--bg-color);
    color: var(--primary-color);
    display: grid;
    place-items: center;
    font-size: 1.35rem;
    font-weight: 800;
  }

  strong {
    opacity: 1;
  }

  button {
    margin-top: 0.35rem;
    padding: 0.55rem 0.8rem;
    border-radius: 0.65rem;
    background: var(--primary-color);
    color: #fff;
  }
}

.task-list {
  max-height: 520px;
  padding: 0;
  padding-right: 0.3rem;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--border-color) transparent;
}

.task-item {
  min-width: 0;
  padding: 0.85rem;
  border: 1px solid transparent;
  border-radius: 1rem;
  background: var(--bg-color);
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: start;
  gap: 0.8rem;
  transition: var(--transition);

  &:hover {
    border-color: var(--border-color);
  }

  &.active {
    border-color: var(--primary-color);
    box-shadow: inset 3px 0 0 var(--primary-color);
  }

  &.completed {
    opacity: 0.58;

    .task-content {
      text-decoration: line-through;
    }
  }

  &.pending {
    opacity: 0.6;
  }
}

.status-checkbox {
  width: 1.2rem;
  height: 1.2rem;
  margin-top: 0.2rem;
  accent-color: var(--primary-color);
  cursor: pointer;
}

.task-copy {
  min-width: 0;
  padding: 0;
  background: transparent;
  color: var(--text-color);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.25rem;
  text-align: left;

  &:hover:not(:disabled) .task-content,
  &.selected .task-content {
    color: var(--primary-color);
  }

  &:disabled {
    cursor: default;
  }
}

.task-content,
.task-description {
  max-width: 100%;
  overflow-wrap: anywhere;
}

.task-content {
  font-size: 0.97rem;
  font-weight: 650;
  transition: color 0.2s ease;
}

.task-description {
  font-size: 0.8rem;
  line-height: 1.45;
  opacity: 0.66;
}

.tags {
  margin-top: 0.2rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}

.tag,
.active-label {
  border-radius: 999px;
  font-size: 0.68rem;
  line-height: 1;
}

.tag {
  padding: 0.28rem 0.48rem;
  background: rgb(255 107 107 / 13%);
  color: var(--primary-color);
  font-weight: 650;
}

.task-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.active-label {
  padding: 0.34rem 0.5rem;
  background: var(--primary-color);
  color: #fff;
  white-space: nowrap;
}

.icon-button {
  min-height: 34px;
  padding: 0.35rem 0.55rem;
  border-radius: 0.55rem;
  font-size: 0.75rem;

  &:hover:not(:disabled) {
    border-color: var(--primary-color);
    color: var(--primary-color);
  }
}

.danger-button:hover:not(:disabled) {
  border-color: #d92d20;
  color: #d92d20;
}

.edit-form {
  grid-column: 1 / -1;
  padding: 0.2rem;
}

.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

button:disabled,
input:disabled {
  cursor: not-allowed;
  opacity: 0.58;
}

button:focus-visible,
input:focus-visible,
textarea:focus-visible {
  outline: 3px solid rgb(255 107 107 / 28%);
  outline-offset: 2px;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 640px) {
  .task-card {
    min-height: auto;
    border-radius: 1.35rem;
  }

  .task-header,
  .primary-input-row {
    align-items: stretch;
  }

  .primary-input-row,
  .form-grid {
    grid-template-columns: 1fr;
  }

  .add-button {
    width: 100%;
  }

  .task-item {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .task-actions {
    grid-column: 2;
    justify-content: flex-start;
  }
}

@media (max-width: 420px) {
  .task-header {
    flex-direction: column;
  }

  .clear-button {
    align-self: flex-end;
  }
}

@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation-duration: 1.5s;
  }

  .add-button:hover:not(:disabled) {
    transform: none;
  }
}
</style>
