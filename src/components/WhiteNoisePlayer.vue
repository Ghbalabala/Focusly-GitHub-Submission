<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';

type NoisePreset = 'rain' | 'forest' | 'brown';
type AudioContextConstructor = typeof AudioContext;

const presets: Array<{ id: NoisePreset; label: string; icon: string }> = [
  { id: 'rain', label: '细雨', icon: '🌧' },
  { id: 'forest', label: '森林', icon: '🌲' },
  { id: 'brown', label: '深色噪音', icon: '〜' },
];

const preset = ref<NoisePreset>('rain');
const volume = ref(24);
const playing = ref(false);
const audioError = ref('');
let audioContext: AudioContext | null = null;
let source: AudioBufferSourceNode | null = null;
let filter: BiquadFilterNode | null = null;
let gain: GainNode | null = null;

const contextConstructor = () => window.AudioContext
  ?? (window as Window & { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;

const createNoiseBuffer = (context: AudioContext, kind: NoisePreset) => {
  const length = context.sampleRate * 3;
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  let previous = 0;

  for (let index = 0; index < length; index += 1) {
    const white = Math.random() * 2 - 1;
    if (kind === 'brown') {
      previous = (previous + 0.02 * white) / 1.02;
      data[index] = previous * 3.2;
    } else if (kind === 'forest') {
      previous = previous * 0.82 + white * 0.18;
      data[index] = previous * 0.72;
    } else {
      data[index] = white * 0.48;
    }
  }
  return buffer;
};

const disconnectNodes = () => {
  try { source?.disconnect(); } catch { /* already disconnected */ }
  try { filter?.disconnect(); } catch { /* already disconnected */ }
  source = null;
  filter = null;
};

const stop = (updateState = true) => {
  if (gain && audioContext) {
    const now = audioContext.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
    const oldSource = source;
    window.setTimeout(() => {
      try { oldSource?.stop(); } catch { /* source may have already stopped */ }
      if (oldSource === source) disconnectNodes();
    }, 480);
  } else {
    try { source?.stop(); } catch { /* source may have already stopped */ }
    disconnectNodes();
  }
  if (updateState) playing.value = false;
};

const start = async () => {
  audioError.value = '';
  const AudioContextClass = contextConstructor();
  if (!AudioContextClass) {
    audioError.value = '当前浏览器不支持白噪音。';
    return;
  }

  try {
    audioContext ??= new AudioContextClass();
    if (audioContext.state === 'suspended') await audioContext.resume();
    try { source?.stop(); } catch { /* replacing an existing source */ }
    disconnectNodes();

    source = audioContext.createBufferSource();
    filter = audioContext.createBiquadFilter();
    gain ??= audioContext.createGain();
    source.buffer = createNoiseBuffer(audioContext, preset.value);
    source.loop = true;

    if (preset.value === 'rain') {
      filter.type = 'highpass';
      filter.frequency.value = 620;
      filter.Q.value = 0.35;
    } else if (preset.value === 'forest') {
      filter.type = 'bandpass';
      filter.frequency.value = 980;
      filter.Q.value = 0.25;
    } else {
      filter.type = 'lowpass';
      filter.frequency.value = 720;
      filter.Q.value = 0.2;
    }

    const targetVolume = Math.max(0.0001, volume.value / 100 * 0.35);
    const now = audioContext.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(targetVolume, now + 0.55);
    source.connect(filter).connect(gain).connect(audioContext.destination);
    source.start();
    playing.value = true;
  } catch {
    audioError.value = '音频启动失败，请再点击一次。';
    playing.value = false;
  }
};

const toggle = () => {
  if (playing.value) stop();
  else void start();
};

watch(volume, (value) => {
  try { localStorage.setItem('focusly_noise_volume', String(value)); } catch { /* optional */ }
  if (!gain || !audioContext || !playing.value) return;
  gain.gain.setTargetAtTime(Math.max(0.0001, value / 100 * 0.35), audioContext.currentTime, 0.08);
});

watch(preset, (value) => {
  try { localStorage.setItem('focusly_noise_preset', value); } catch { /* optional */ }
  if (playing.value) void start();
});

onMounted(() => {
  try {
    const savedPreset = localStorage.getItem('focusly_noise_preset');
    const savedVolumeValue = localStorage.getItem('focusly_noise_volume');
    const savedVolume = savedVolumeValue === null ? Number.NaN : Number(savedVolumeValue);
    if (presets.some((item) => item.id === savedPreset)) preset.value = savedPreset as NoisePreset;
    if (Number.isFinite(savedVolume) && savedVolume >= 0 && savedVolume <= 100) volume.value = savedVolume;
  } catch {
    // Defaults keep the player functional when storage is unavailable.
  }
});

onUnmounted(() => {
  stop(false);
  void audioContext?.close();
});
</script>

<template>
  <div class="noise-player" :class="{ playing }">
    <button
      class="noise-toggle"
      type="button"
      :aria-pressed="playing"
      :aria-label="playing ? '关闭白噪音' : '播放白噪音'"
      @click="toggle"
    >
      <span class="sound-bars" aria-hidden="true"><i></i><i></i><i></i></span>
      {{ playing ? '正在播放' : '专注声景' }}
    </button>
    <label class="preset-select">
      <span class="sr-only">选择白噪音</span>
      <select v-model="preset" aria-label="白噪音场景">
        <option v-for="item in presets" :key="item.id" :value="item.id">
          {{ item.icon }} {{ item.label }}
        </option>
      </select>
    </label>
    <label class="volume-control" title="白噪音音量">
      <span aria-hidden="true">🔈</span>
      <input v-model.number="volume" type="range" min="0" max="100" aria-label="白噪音音量" />
    </label>
    <span v-if="audioError" class="audio-error" role="status">{{ audioError }}</span>
  </div>
</template>

<style scoped lang="scss">
.noise-player {
  min-height: 2.55rem;
  padding: 0.28rem;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  background: var(--card-bg);
  box-shadow: var(--shadow-sm);
  position: relative;
}

.noise-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.48rem 0.65rem;
  border-radius: 999px;
  background: transparent;
  color: var(--text-secondary);
  font-weight: 700;
  white-space: nowrap;
}

.playing .noise-toggle { color: var(--accent-dark); background: var(--accent-soft); }
.sound-bars { height: 0.9rem; display: flex; align-items: center; gap: 2px; }
.sound-bars i { width: 2px; height: 40%; border-radius: 2px; background: currentColor; }
.playing .sound-bars i { animation: sound 700ms ease-in-out infinite alternate; }
.playing .sound-bars i:nth-child(2) { animation-delay: 180ms; }
.playing .sound-bars i:nth-child(3) { animation-delay: 360ms; }

.preset-select select {
  max-width: 7.5rem;
  border: 0;
  background: var(--surface-muted);
  color: var(--text-color);
  border-radius: 999px;
  padding: 0.42rem 0.55rem;
  font: inherit;
  font-size: 0.78rem;
}

.volume-control { display: flex; align-items: center; gap: 0.2rem; padding-right: 0.45rem; }
.volume-control input { width: 4rem; accent-color: var(--accent-color); }
.audio-error {
  position: absolute;
  top: calc(100% + 0.4rem);
  right: 0;
  width: max-content;
  max-width: 16rem;
  padding: 0.45rem 0.6rem;
  border-radius: 0.55rem;
  background: var(--danger-soft);
  color: var(--danger-color);
  font-size: 0.72rem;
  z-index: 5;
}

@keyframes sound { to { height: 100%; } }

@media (max-width: 720px) {
  .volume-control { display: none; }
}

@media (max-width: 480px) {
  .noise-toggle { font-size: 0; }
  .noise-toggle .sound-bars { font-size: initial; }
  .preset-select select { max-width: 6.6rem; }
}

@media (prefers-reduced-motion: reduce) {
  .playing .sound-bars i { animation: none; height: 70%; }
}
</style>
