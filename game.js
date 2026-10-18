/* ============================================================================
   ПОЛУНОЧНЫЙ ЭКСПРЕСС — Часть I
   ----------------------------------------------------------------------------
   Единый ES-модуль игры (вантаж JS + Three.js r161 через import map).
   index.html содержит CSS и DOM; этот файл — вся логика:
     CONFIG            — настраиваемые константы
     EventBus          — слабая связь между системами
     SettingsStore     — сохранение настроек (localStorage)
     AudioManager      — синтезированный эмбиент, шаги, UI-звуки, микрофон
     TextureFactory    — процедурные текстуры (без внешних ассетов)
     TrainCar          — геометрия, свет и атмосфера вагона
     PlayerController  — PointerLockControls, движение, выносливость, коллизии
     NetworkManager    — заглушка для Части II (точка расширения)
     UIManager         — экраны, HUD, настройки, микрофон
     Game              — сборка и жизненный цикл

   Точки расширения для Части II отмечены комментариями [PART II].
   ========================================================================== */

import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// =============================================================================
// КОНФИГУРАЦИЯ
// =============================================================================

const CONFIG = {
  version: '0.1.0',
  part: 1,
  car: {
    width: 3.8,          // внутренняя ширина
    length: 32,          // внутренняя длина
    height: 3.05,        // высота до потолка
  },
  camera: {
    fov: 68,
    sprintFov: 73,
    near: 0.045,
    far: 90,
  },
  player: {
    eyeHeight: 1.66,
    radius: 0.32,
    walkSpeed: 2.9,
    sprintSpeed: 5.35,
    acceleration: 12,
    staminaMax: 100,
    sprintDrain: 21,
    staminaRegen: 14,
    regenDelay: 0.9,
    exhaustedRecovery: 28,
    stepLengthWalk: 1.45,
    stepLengthSprint: 1.9,
    spawn: { x: 0, z: 13.35 },
  },
  network: {
    lobbyCodeLength: 4,
    tickRate: 20,
  },
};

const STATE = Object.freeze({
  BOOT: 'boot',
  MENU: 'menu',
  DEPLOYING: 'deploying',
  PLAYING: 'playing',
  PAUSED: 'paused',
});

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');

// =============================================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// =============================================================================

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const damp = (current, target, lambda, dt) => THREE.MathUtils.damp(current, target, lambda, dt);
const pad2 = (value) => String(value).padStart(2, '0');

function createRng(seed = 1337) {
  let state = seed >>> 0;
  return function random() {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomRange(min, max, random = Math.random) {
  return min + random() * (max - min);
}

function formatDb(db) {
  if (!Number.isFinite(db)) return '−∞ дБ';
  return `${Math.round(db)} дБ`;
}

// =============================================================================
// ШИНА СОБЫТИЙ
// =============================================================================

class EventBus {
  constructor() {
    this._listeners = new Map();
  }

  on(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(handler);
    return () => this.off(type, handler);
  }

  off(type, handler) {
    const handlers = this._listeners.get(type);
    if (handlers) handlers.delete(handler);
  }

  emit(type, payload) {
    const handlers = this._listeners.get(type);
    if (!handlers) return;
    for (const handler of Array.from(handlers)) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[EventBus] Ошибка обработчика «${type}»`, error);
      }
    }
  }

  clear() {
    this._listeners.clear();
  }
}

// =============================================================================
// НАСТРОЙКИ
// =============================================================================

const DEFAULT_SETTINGS = Object.freeze({
  volume: 0.7,
  sensitivity: 1.0,
  micTested: false,
});

class SettingsStore {
  constructor(key = 'midnight-express:settings:v1') {
    this.key = key;
    this.values = { ...DEFAULT_SETTINGS };
    this.load();
  }

  load() {
    try {
      const raw = window.localStorage.getItem(this.key);
      if (!raw) return this.values;
      const parsed = JSON.parse(raw);
      if (typeof parsed.volume === 'number') {
        this.values.volume = clamp(parsed.volume, 0, 1);
      }
      if (typeof parsed.sensitivity === 'number') {
        this.values.sensitivity = clamp(parsed.sensitivity, 0.3, 2.2);
      }
      if (typeof parsed.micTested === 'boolean') {
        this.values.micTested = parsed.micTested;
      }
    } catch (error) {
      console.warn('[Settings] Не удалось прочитать localStorage', error);
    }
    return this.values;
  }

  save(patch = {}) {
    Object.assign(this.values, patch);
    try {
      window.localStorage.setItem(this.key, JSON.stringify(this.values));
    } catch (error) {
      // Приватный режим Safari может запрещать запись — игра продолжает работать.
      console.warn('[Settings] Не удалось сохранить настройки', error);
    }
    return this.values;
  }

  reset() {
    this.values = { ...DEFAULT_SETTINGS };
    try {
      window.localStorage.removeItem(this.key);
    } catch (error) {
      /* ignore */
    }
    return this.values;
  }
}

// =============================================================================
// АУДИО
// =============================================================================

class AudioManager {
  constructor({ volume = 0.7 } = {}) {
    this.ctx = null;
    this.master = null;
    this.sfx = null;
    this.ambience = null;
    this.limiter = null;
    this.volume = clamp(volume, 0, 1);
    this.scene = 'menu';
    this._whiteNoise = null;
    this._brownNoise = null;
    this._clackCountdown = 1.1;
    this._isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    this._sceneLevels = { menu: 0.56, game: 1, paused: 0.42 };
    this.mic = {
      active: false,
      requesting: false,
      stream: null,
      source: null,
      analyser: null,
      data: null,
      level: 0,
      db: -Infinity,
    };

    this._onVisibility = this._onVisibility.bind(this);
    document.addEventListener('visibilitychange', this._onVisibility);
    window.addEventListener('pagehide', () => this.disableMic());
  }

  get ready() {
    return Boolean(this.ctx);
  }

  /** Инициализация разрешена только из пользовательского жеста. */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      console.warn('[Audio] Web Audio API недоступен.');
      return;
    }
    try {
      this.ctx = new AudioContextClass();
      this._buildGraph();
      this.ctx.resume().catch(() => {});
    } catch (error) {
      console.warn('[Audio] Не удалось инициализировать звук', error);
      this.ctx = null;
    }
  }

  _volumeGain() {
    if (this.volume <= 0) return 0;
    return Math.pow(this.volume, 1.55) * 0.9;
  }

  _buildGraph() {
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this._volumeGain();

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -12;
    this.limiter.knee.value = 8;
    this.limiter.ratio.value = 8;
    this.limiter.attack.value = 0.004;
    this.limiter.release.value = 0.25;

    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.85;
    this.sfx.connect(this.master);

    // Отдельная «вентиляция» вагона — включается только в салоне.
    this.interior = ctx.createGain();
    this.interior.gain.value = 0.12;
    this.interior.connect(this.master);

    this.ambience = ctx.createGain();
    this.ambience.gain.value = 0.45 * (this._sceneLevels[this.scene] ?? 1);
    this.ambience.connect(this.master);

    this._whiteNoise = this._createNoiseBuffer(2, 'white');
    this._brownNoise = this._createNoiseBuffer(3.5, 'brown');

    // Основной низкочастотный гул состава.
    const rumbleSource = ctx.createBufferSource();
    rumbleSource.buffer = this._brownNoise;
    rumbleSource.loop = true;
    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 145;
    rumbleFilter.Q.value = 0.8;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0.42;
    rumbleSource.connect(rumbleFilter);
    rumbleFilter.connect(rumbleGain);
    rumbleGain.connect(this.ambience);
    rumbleSource.start();

    // Инфразвуковой «дизель» на грани слышимости.
    const engine = ctx.createOscillator();
    engine.type = 'sine';
    engine.frequency.value = 37;
    const engineGain = ctx.createGain();
    engineGain.gain.value = 0.055;
    engine.connect(engineGain);
    engineGain.connect(this.ambience);
    engine.start();

    const engineLfo = ctx.createOscillator();
    engineLfo.type = 'sine';
    engineLfo.frequency.value = 0.09;
    const engineLfoGain = ctx.createGain();
    engineLfoGain.gain.value = 0.018;
    engineLfo.connect(engineLfoGain);
    engineLfoGain.connect(engineGain.gain);
    engineLfo.start();

    // Едва слышный «шорох» вентиляции.
    const airSource = ctx.createBufferSource();
    airSource.buffer = this._whiteNoise;
    airSource.loop = true;
    const airFilter = ctx.createBiquadFilter();
    airFilter.type = 'bandpass';
    airFilter.frequency.value = 900;
    airFilter.Q.value = 0.35;
    const airGain = ctx.createGain();
    airGain.gain.value = 0.014;
    airSource.connect(airFilter);
    airFilter.connect(airGain);
    airGain.connect(this.ambience);
    airSource.start();

    // Шипение вентиляции салона.
    const ventSource = ctx.createBufferSource();
    ventSource.buffer = this._whiteNoise;
    ventSource.loop = true;
    const ventFilter = ctx.createBiquadFilter();
    ventFilter.type = 'bandpass';
    ventFilter.frequency.value = 2400;
    ventFilter.Q.value = 0.9;
    const ventGain = ctx.createGain();
    ventGain.gain.value = 0.02;
    ventSource.connect(ventFilter);
    ventFilter.connect(ventGain);
    ventGain.connect(this.interior);
    ventSource.start();
  }

  _createNoiseBuffer(seconds, kind) {
    const length = Math.floor(this.ctx.sampleRate * seconds);
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);

    if (kind === 'brown') {
      let last = 0;
      for (let i = 0; i < length; i += 1) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.2;
      }
    } else {
      for (let i = 0; i < length; i += 1) {
        data[i] = Math.random() * 2 - 1;
      }
    }
    return buffer;
  }

  setVolume(volume) {
    this.volume = clamp(volume, 0, 1);
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this._volumeGain(), this.ctx.currentTime, 0.045);
    }
  }

  setScene(scene) {
    this.scene = scene;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (this.ambience) {
      const level = this._sceneLevels[scene] ?? 0.8;
      this.ambience.gain.setTargetAtTime(0.45 * level, now, 0.35);
    }
    if (this.interior) {
      this.interior.gain.setTargetAtTime(scene === 'game' ? 1 : scene === 'paused' ? 0.35 : 0, now, 0.5);
    }
  }

  /** Короткий скрежет при возвращении в салон после паузы. */
  hitch() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const source = this.ctx.createBufferSource();
    source.buffer = this._brownNoise;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(180, now);
    filter.frequency.exponentialRampToValueAtTime(70, now + 0.7);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.75);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfx);
    source.start(now);
    source.stop(now + 0.8);
  }

  update(dt) {
    if (!this.ctx || this.ctx.state !== 'running' || document.hidden) return;
    this._clackCountdown -= dt;
    if (this._clackCountdown <= 0) {
      this._railClack();
      this._clackCountdown = randomRange(1.05, 1.7);
    }
  }

  _railClack() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime + 0.01;
    const panning = Math.random() > 0.5 ? 0.4 : -0.4;

    const hit = (time, strength, pan) => {
      const source = this.ctx.createBufferSource();
      source.buffer = this._whiteNoise;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = randomRange(620, 1100);
      filter.Q.value = 1.2;
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(0.11 * strength, time + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.12);
      const panner = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
      source.connect(filter);
      filter.connect(gain);
      if (panner) {
        panner.pan.value = pan;
        gain.connect(panner);
        panner.connect(this.ambience);
      } else {
        gain.connect(this.ambience);
      }
      source.start(time);
      source.stop(time + 0.16);
    };

    hit(now, 1, panning);
    hit(now + 0.085, 0.55, -panning);

    const thud = this.ctx.createOscillator();
    thud.type = 'triangle';
    thud.frequency.setValueAtTime(82, now);
    thud.frequency.exponentialRampToValueAtTime(42, now + 0.14);
    const thudGain = this.ctx.createGain();
    thudGain.gain.setValueAtTime(0.0001, now);
    thudGain.gain.exponentialRampToValueAtTime(0.055, now + 0.006);
    thudGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    thud.connect(thudGain);
    thudGain.connect(this.ambience);
    thud.start(now);
    thud.stop(now + 0.18);
  }

  footstep(intensity = 1) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const source = this.ctx.createBufferSource();
    source.buffer = this._whiteNoise;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = randomRange(340, 520);
    filter.Q.value = 0.8;
    const gain = this.ctx.createGain();
    const strength = clamp(intensity, 0.2, 1.4);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.032 * strength, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.115);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfx);
    source.start(now);
    source.stop(now + 0.14);

    const thud = this.ctx.createOscillator();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(78, now);
    thud.frequency.exponentialRampToValueAtTime(48, now + 0.1);
    const thudGain = this.ctx.createGain();
    thudGain.gain.setValueAtTime(0.0001, now);
    thudGain.gain.exponentialRampToValueAtTime(0.025 * strength, now + 0.008);
    thudGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    thud.connect(thudGain);
    thudGain.connect(this.sfx);
    thud.start(now);
    thud.stop(now + 0.13);
  }

  _blip({ frequency = 600, endFrequency = null, duration = 0.06, type = 'square', gainValue = 0.014, delay = 0 }) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const start = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, start);
    if (endFrequency) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(30, endFrequency), start + duration);
    }
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    gain.connect(this.sfx);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  uiHover() {
    this._blip({ frequency: 1320, duration: 0.026, type: 'sine', gainValue: 0.0055 });
  }

  uiClick() {
    this._blip({ frequency: 560, endFrequency: 300, duration: 0.055, type: 'square', gainValue: 0.012 });
  }

  uiConfirm() {
    this._blip({ frequency: 520, duration: 0.055, type: 'sine', gainValue: 0.014 });
    this._blip({ frequency: 780, duration: 0.08, type: 'sine', gainValue: 0.012, delay: 0.07 });
  }

  uiBack() {
    this._blip({ frequency: 430, endFrequency: 290, duration: 0.07, type: 'sine', gainValue: 0.012 });
  }

  uiError() {
    this._blip({ frequency: 180, endFrequency: 120, duration: 0.19, type: 'sawtooth', gainValue: 0.016 });
  }

  async enableMic() {
    this.init();
    if (this.mic.active) return { ok: true };
    if (this.mic.requesting) return { ok: false, error: 'MIC_REQUEST_IN_PROGRESS' };
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      const error = new Error('MEDIA_UNSUPPORTED');
      error.code = 'MEDIA_UNSUPPORTED';
      throw error;
    }

    this.mic.requesting = true;
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      if (!this.ctx) this.init();
      if (!this.ctx) {
        const error = new Error('AUDIO_CONTEXT_UNAVAILABLE');
        error.code = 'AUDIO_CONTEXT_UNAVAILABLE';
        throw error;
      }
      await this.ctx.resume().catch(() => {});

      const source = this.ctx.createMediaStreamSource(stream);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.35;
      source.connect(analyser);

      this.mic.stream = stream;
      this.mic.source = source;
      this.mic.analyser = analyser;
      this.mic.data = new Uint8Array(analyser.fftSize);
      this.mic.active = true;
      this.mic.level = 0;
      this.mic.db = -Infinity;

      stream.getAudioTracks().forEach((track) => {
        track.addEventListener('ended', () => this.disableMic());
      });

      return { ok: true };
    } catch (error) {
      if (stream) stream.getTracks().forEach((track) => track.stop());
      this.mic.active = false;
      throw error;
    } finally {
      this.mic.requesting = false;
    }
  }

  disableMic() {
    if (this.mic.stream) {
      this.mic.stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (error) {
          /* ignore */
        }
      });
    }
    if (this.mic.source) {
      try {
        this.mic.source.disconnect();
      } catch (error) {
        /* ignore */
      }
    }
    if (this.mic.analyser) {
      try {
        this.mic.analyser.disconnect();
      } catch (error) {
        /* ignore */
      }
    }
    this.mic.active = false;
    this.mic.requesting = false;
    this.mic.stream = null;
    this.mic.source = null;
    this.mic.analyser = null;
    this.mic.data = null;
    this.mic.level = 0;
    this.mic.db = -Infinity;
  }

  /** Возвращает сглаженный уровень 0..1 и уровень в дБ. Не пишет микрофон в выход. */
  getMicLevel() {
    if (!this.mic.active || !this.mic.analyser || !this.mic.data) {
      return { level: 0, db: -Infinity };
    }
    const analyser = this.mic.analyser;
    const data = this.mic.data;
    analyser.getByteTimeDomainData(data);

    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const sample = (data[i] - 128) / 128;
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / data.length);
    const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    const target = clamp((rms - 0.012) * 6.5, 0, 1);
    this.mic.level += (target - this.mic.level) * 0.35;
    this.mic.db = db;
    return { level: this.mic.level, db };
  }

  _onVisibility() {
    if (!this.ctx) return;
    if (document.hidden) {
      this.ctx.suspend().catch(() => {});
    } else {
      this.ctx.resume().catch(() => {});
    }
  }
}

// =============================================================================
// ПРОЦЕДУРНЫЕ ТЕКСТУРЫ
// =============================================================================

class TextureFactory {
  constructor(renderer) {
    this.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  }

  _canvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  _texture(canvas, options = {}) {
    const {
      repeat = [1, 1],
      offset = [0, 0],
      srgb = true,
      wrap = THREE.RepeatWrapping,
    } = options;

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.wrapS = wrap;
    texture.wrapT = wrap;
    texture.repeat.set(repeat[0], repeat[1]);
    texture.offset.set(offset[0], offset[1]);
    texture.anisotropy = this.anisotropy;
    texture.needsUpdate = true;
    return texture;
  }

  _speckle(ctx, width, height, count, random, colors, maxSize = 1.6) {
    for (let i = 0; i < count; i += 1) {
      ctx.fillStyle = colors[Math.floor(random() * colors.length)];
      const size = 0.4 + random() * maxSize;
      ctx.fillRect(random() * width, random() * height, size, size);
    }
  }

  floor() {
    const width = 512;
    const height = 512;
    const canvas = this._canvas(width, height);
    const ctx = canvas.getContext('2d');
    const random = createRng(0x1a2b3c);
    const planks = 7;
    const plankWidth = width / planks;
    const tones = ['#241c15', '#2b2219', '#30261c', '#281f18', '#33281d'];

    ctx.fillStyle = '#1d1711';
    ctx.fillRect(0, 0, width, height);

    for (let i = 0; i < planks; i += 1) {
      const x = i * plankWidth;
      ctx.fillStyle = tones[Math.floor(random() * tones.length)];
      ctx.fillRect(x, 0, plankWidth, height);

      const lengthGradient = ctx.createLinearGradient(x, 0, x + plankWidth, 0);
      lengthGradient.addColorStop(0, 'rgba(0,0,0,0.28)');
      lengthGradient.addColorStop(0.22, 'rgba(255,255,255,0.035)');
      lengthGradient.addColorStop(0.55, 'rgba(0,0,0,0.04)');
      lengthGradient.addColorStop(0.86, 'rgba(255,255,255,0.02)');
      lengthGradient.addColorStop(1, 'rgba(0,0,0,0.34)');
      ctx.fillStyle = lengthGradient;
      ctx.fillRect(x, 0, plankWidth, height);

      // Продольные волокна дерева.
      for (let line = 0; line < 26; line += 1) {
        const gx = x + 3 + random() * (plankWidth - 6);
        const dark = random() > 0.42;
        ctx.strokeStyle = dark
          ? `rgba(0,0,0,${0.08 + random() * 0.18})`
          : `rgba(190,158,112,${0.015 + random() * 0.04})`;
        ctx.lineWidth = 0.5 + random() * 1.3;
        ctx.beginPath();
        ctx.moveTo(gx, 0);
        for (let gy = 10; gy <= height; gy += 10) {
          const wobble = Math.sin(gy * 0.03 + line * 1.7) * (0.6 + random() * 2.2);
          ctx.lineTo(gx + wobble, gy);
        }
        ctx.stroke();
      }

      // Поперечные стыки досок.
      const jointCount = 1 + Math.floor(random() * 2);
      for (let joint = 0; joint < jointCount; joint += 1) {
        const jy = Math.floor(random() * (height - 80)) + 40;
        ctx.fillStyle = 'rgba(0,0,0,0.46)';
        ctx.fillRect(x + 2, jy, plankWidth - 4, 2);
        ctx.fillStyle = 'rgba(220,190,140,0.045)';
        ctx.fillRect(x + 2, jy + 2, plankWidth - 4, 1);
      }

      // Гвозди / шурупы.
      for (let nail = 0; nail < 4; nail += 1) {
        const nx = x + 6 + random() * (plankWidth - 12);
        const ny = 20 + random() * (height - 40);
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.beginPath();
        ctx.arc(nx, ny, 1.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(190,170,135,0.14)';
        ctx.fillRect(nx - 1.5, ny - 1.5, 1, 1);
      }

      // Тёмный шов между досками.
      ctx.fillStyle = 'rgba(0,0,0,0.62)';
      ctx.fillRect(x - 1, 0, 2.5, height);
      ctx.fillStyle = 'rgba(210,180,130,0.06)';
      ctx.fillRect(x + 2, 0, 1, height);
    }

    // Пятна грязи и потёртости.
    for (let i = 0; i < 26; i += 1) {
      const gx = random() * width;
      const gy = random() * height;
      const radius = 20 + random() * 90;
      const grime = ctx.createRadialGradient(gx, gy, 0, gx, gy, radius);
      grime.addColorStop(0, `rgba(8,6,4,${0.1 + random() * 0.22})`);
      grime.addColorStop(1, 'rgba(8,6,4,0)');
      ctx.fillStyle = grime;
      ctx.fillRect(gx - radius, gy - radius, radius * 2, radius * 2);
    }

    for (let i = 0; i < 34; i += 1) {
      const sx = random() * width;
      const sy = random() * height;
      ctx.strokeStyle = random() > 0.5
        ? `rgba(220,200,160,${0.03 + random() * 0.05})`
        : `rgba(0,0,0,${0.12 + random() * 0.15})`;
      ctx.lineWidth = 0.6 + random() * 0.8;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + (random() - 0.5) * 60, sy + (random() - 0.5) * 18);
      ctx.stroke();
    }

    this._speckle(ctx, width, height, 800, random, ['rgba(0,0,0,0.16)', 'rgba(220,200,160,0.035)'], 1.1);

    return this._texture(canvas, { repeat: [1, 8] });
  }

  wall() {
    const width = 512;
    const height = 512;
    const canvas = this._canvas(width, height);
    const ctx = canvas.getContext('2d');
    const random = createRng(0x51a9e2);

    const base = ctx.createLinearGradient(0, 0, width, height);
    base.addColorStop(0, '#33372c');
    base.addColorStop(0.45, '#2e3329');
    base.addColorStop(1, '#262b22');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, width, height);

    // Краска: крупные пятна и потёртости.
    for (let i = 0; i < 32; i += 1) {
      const gx = random() * width;
      const gy = random() * height;
      const radius = 18 + random() * 80;
      const blotch = ctx.createRadialGradient(gx, gy, 0, gx, gy, radius);
      blotch.addColorStop(0, random() > 0.5
        ? `rgba(190,196,164,${0.02 + random() * 0.035})`
        : `rgba(10,12,8,${0.08 + random() * 0.12})`);
      blotch.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = blotch;
      ctx.fillRect(gx - radius, gy - radius, radius * 2, radius * 2);
    }

    // Нижняя деревянная панель.
    const wainscotY = height * 0.6;
    const wainscot = ctx.createLinearGradient(0, wainscotY, 0, height);
    wainscot.addColorStop(0, '#2c2118');
    wainscot.addColorStop(0.5, '#241a12');
    wainscot.addColorStop(1, '#1c140f');
    ctx.fillStyle = wainscot;
    ctx.fillRect(0, wainscotY, width, height - wainscotY);

    // Филёнки нижней панели.
    for (let i = 0; i < 4; i += 1) {
      const panelX = i * 128 + 16;
      ctx.strokeStyle = 'rgba(0,0,0,0.34)';
      ctx.lineWidth = 2;
      ctx.strokeRect(panelX, wainscotY + 28, 96, height - wainscotY - 55);
      ctx.strokeStyle = 'rgba(214,180,132,0.055)';
      ctx.lineWidth = 1;
      ctx.strokeRect(panelX + 3, wainscotY + 31, 90, height - wainscotY - 61);
    }

    // Молдинг на стыке.
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, wainscotY - 3, width, 2);
    ctx.fillStyle = 'rgba(206,192,152,0.13)';
    ctx.fillRect(0, wainscotY - 7, width, 3);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(0, wainscotY + 1, width, 2);

    // Вертикальные стойки и заклёпки.
    for (let seam = 0; seam < 4; seam += 1) {
      const sx = seam * 128;
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.fillRect(sx, 0, 9, height);
      ctx.fillStyle = 'rgba(220,214,180,0.06)';
      ctx.fillRect(sx + 9, 0, 1.5, height);

      for (let rivet = 0; rivet < 13; rivet += 1) {
        const ry = 14 + rivet * 36 + random() * 5;
        const rx = sx + 15 + random() * 4;
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.beginPath();
        ctx.arc(rx + 1.2, ry + 1.2, 2.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(210,206,176,0.17)';
        ctx.beginPath();
        ctx.arc(rx, ry, 1.6, 0, Math.PI * 2);
        ctx.fill();

        // Ржавые подтёки.
        if (random() > 0.55) {
          const drip = ctx.createLinearGradient(0, ry, 0, ry + 50 + random() * 90);
          drip.addColorStop(0, 'rgba(96,58,26,0.22)');
          drip.addColorStop(1, 'rgba(96,58,26,0)');
          ctx.fillStyle = drip;
          ctx.fillRect(rx - 1.2, ry, 2 + random() * 3, 90);
        }
      }
    }

    // Верхний молдинг.
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(0, 0, width, 3);
    ctx.fillStyle = 'rgba(212,206,172,0.09)';
    ctx.fillRect(0, 3, width, 2);

    // Грязь у пола.
    const floorGrime = ctx.createLinearGradient(0, height - 110, 0, height);
    floorGrime.addColorStop(0, 'rgba(5,4,3,0)');
    floorGrime.addColorStop(1, 'rgba(5,4,3,0.5)');
    ctx.fillStyle = floorGrime;
    ctx.fillRect(0, height - 110, width, 110);

    // Царапины.
    for (let i = 0; i < 46; i += 1) {
      const sx = random() * width;
      const sy = 40 + random() * (height - 90);
      ctx.strokeStyle = random() > 0.4
        ? `rgba(0,0,0,${0.1 + random() * 0.2})`
        : `rgba(220,210,180,${0.03 + random() * 0.05})`;
      ctx.lineWidth = 0.5 + random() * 1.1;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + (random() - 0.5) * 34, sy + (random() - 0.5) * 90);
      ctx.stroke();
    }

    this._speckle(ctx, width, height, 1100, random, ['rgba(0,0,0,0.09)', 'rgba(230,225,200,0.025)'], 1.4);

    return this._texture(canvas, { repeat: [6, 1] });
  }

  ceiling() {
    const width = 512;
    const height = 512;
    const canvas = this._canvas(width, height);
    const ctx = canvas.getContext('2d');
    const random = createRng(0x99c0de);

    ctx.fillStyle = '#222520';
    ctx.fillRect(0, 0, width, height);

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(0,0,0,0.22)');
    gradient.addColorStop(0.5, 'rgba(255,255,255,0.02)');
    gradient.addColorStop(1, 'rgba(0,0,0,0.3)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    // Потолочные панели.
    for (let i = 0; i < 8; i += 1) {
      const x = i * 64;
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(x, 0, 3, height);
      ctx.fillStyle = 'rgba(210,214,196,0.025)';
      ctx.fillRect(x + 3, 0, 1, height);
    }

    // Водяные разводы.
    for (let i = 0; i < 14; i += 1) {
      const x = random() * width;
      const y = random() * height;
      const radius = 24 + random() * 90;
      const stain = ctx.createRadialGradient(x, y, 0, x, y, radius);
      stain.addColorStop(0, `rgba(94,72,42,${0.1 + random() * 0.12})`);
      stain.addColorStop(0.6, 'rgba(94,72,42,0.035)');
      stain.addColorStop(1, 'rgba(94,72,42,0)');
      ctx.fillStyle = stain;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }

    // Заклёпки.
    for (let i = 0; i < 60; i += 1) {
      const x = random() * width;
      const y = random() * height;
      ctx.fillStyle = 'rgba(0,0,0,0.34)';
      ctx.beginPath();
      ctx.arc(x, y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    this._speckle(ctx, width, height, 500, random, ['rgba(0,0,0,0.12)', 'rgba(220,220,200,0.02)'], 1.2);

    return this._texture(canvas, { repeat: [2, 8] });
  }

  fabric() {
    const size = 256;
    const canvas = this._canvas(size, size);
    const ctx = canvas.getContext('2d');
    const random = createRng(0x3210abcd);

    ctx.fillStyle = '#3b3025';
    ctx.fillRect(0, 0, size, size);

    // Тканое переплетение.
    for (let i = 0; i < size; i += 3) {
      ctx.fillStyle = `rgba(0,0,0,${0.04 + random() * 0.05})`;
      ctx.fillRect(0, i, size, 1);
      ctx.fillStyle = `rgba(220,190,150,${0.018 + random() * 0.022})`;
      ctx.fillRect(i, 0, 1, size);
    }

    // Ворс и потёртости.
    for (let i = 0; i < 3200; i += 1) {
      ctx.fillStyle = random() > 0.5
        ? `rgba(0,0,0,${0.05 + random() * 0.12})`
        : `rgba(196,166,120,${0.02 + random() * 0.05})`;
      ctx.fillRect(random() * size, random() * size, 1, 1 + random() * 1.4);
    }

    for (let i = 0; i < 10; i += 1) {
      const x = random() * size;
      const y = random() * size;
      const radius = 10 + random() * 40;
      const wear = ctx.createRadialGradient(x, y, 0, x, y, radius);
      wear.addColorStop(0, 'rgba(120,95,64,0.15)');
      wear.addColorStop(1, 'rgba(120,95,64,0)');
      ctx.fillStyle = wear;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }

    return this._texture(canvas, { repeat: [2, 2] });
  }

  runner() {
    const width = 256;
    const height = 1024;
    const canvas = this._canvas(width, height);
    const ctx = canvas.getContext('2d');
    const random = createRng(0x0c0ffee1);

    ctx.fillStyle = '#2c1718';
    ctx.fillRect(0, 0, width, height);

    // Боковые каймы.
    ctx.fillStyle = '#3d2220';
    ctx.fillRect(0, 0, 20, height);
    ctx.fillRect(width - 20, 0, 20, height);
    ctx.fillStyle = 'rgba(172,139,92,0.22)';
    ctx.fillRect(24, 0, 3, height);
    ctx.fillRect(width - 27, 0, 3, height);
    ctx.fillRect(11, 0, 3, height);
    ctx.fillRect(width - 14, 0, 3, height);

    // Тусклый геометрический узор.
    ctx.strokeStyle = 'rgba(168,134,88,0.13)';
    ctx.lineWidth = 2;
    for (let y = 0; y < height; y += 128) {
      ctx.beginPath();
      ctx.moveTo(width / 2, y + 22);
      ctx.lineTo(width - 52, y + 64);
      ctx.lineTo(width / 2, y + 106);
      ctx.lineTo(52, y + 64);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(width / 2, y + 50);
      ctx.lineTo(width / 2, y + 78);
      ctx.stroke();
    }

    // Продольные полосы.
    ctx.fillStyle = 'rgba(12,7,7,0.18)';
    ctx.fillRect(34, 0, 2, height);
    ctx.fillRect(width - 36, 0, 2, height);

    // Износ ковра.
    for (let i = 0; i < 54; i += 1) {
      const x = 18 + random() * (width - 36);
      const y = random() * height;
      const radius = 8 + random() * 40;
      const wear = ctx.createRadialGradient(x, y, 0, x, y, radius);
      wear.addColorStop(0, `rgba(8,5,4,${0.1 + random() * 0.22})`);
      wear.addColorStop(1, 'rgba(8,5,4,0)');
      ctx.fillStyle = wear;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }

    for (let i = 0; i < 1600; i += 1) {
      ctx.fillStyle = random() > 0.55
        ? `rgba(0,0,0,${0.06 + random() * 0.14})`
        : `rgba(180,140,95,${0.015 + random() * 0.03})`;
      ctx.fillRect(18 + random() * (width - 36), random() * height, 1.2, 1.2);
    }

    return this._texture(canvas, { repeat: [1, 6] });
  }

  night() {
    const width = 512;
    const height = 512;
    const canvas = this._canvas(width, height);
    const ctx = canvas.getContext('2d');
    const random = createRng(0x0f0f0f);

    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, '#050a12');
    sky.addColorStop(0.42, '#0a141d');
    sky.addColorStop(0.72, '#132430');
    sky.addColorStop(1, '#1b303a');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);

    // Смазанные огни встречных фонарей.
    for (let i = 0; i < 7; i += 1) {
      const y = height * (0.42 + random() * 0.34);
      const x = random() * width;
      const len = 40 + random() * 150;
      const streak = ctx.createLinearGradient(x - len, y, x + len, y);
      streak.addColorStop(0, 'rgba(255,190,110,0)');
      streak.addColorStop(0.5, `rgba(255,196,120,${0.1 + random() * 0.16})`);
      streak.addColorStop(1, 'rgba(255,190,110,0)');
      ctx.fillStyle = streak;
      ctx.fillRect(x - len, y - 1.2, len * 2, 2.4 + random() * 2);
    }

    // Далёкие огни.
    for (let i = 0; i < 9; i += 1) {
      const x = random() * width;
      const y = height * (0.55 + random() * 0.3);
      const radius = 4 + random() * 20;
      const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
      const warm = random() > 0.4;
      glow.addColorStop(0, warm ? 'rgba(255,201,128,0.52)' : 'rgba(158,208,228,0.36)');
      glow.addColorStop(0.35, warm ? 'rgba(255,172,92,0.16)' : 'rgba(122,174,204,0.12)');
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }

    // Тёмные столбы и силуэты за окном.
    for (let i = 0; i < 12; i += 1) {
      const x = random() * width;
      const w = 3 + random() * 13;
      const h = 60 + random() * 190;
      ctx.fillStyle = `rgba(1,4,6,${0.34 + random() * 0.4})`;
      ctx.fillRect(x, height - h, w, h);
    }

    // Дождь.
    for (let i = 0; i < 260; i += 1) {
      const x = random() * width;
      const y = random() * height;
      const len = 8 + random() * 44;
      ctx.strokeStyle = `rgba(176,206,222,${0.05 + random() * 0.17})`;
      ctx.lineWidth = 0.5 + random() * 1.1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - len * 0.16, y + len);
      ctx.stroke();
    }

    // Капли и размытые блики на стекле.
    for (let i = 0; i < 36; i += 1) {
      const x = random() * width;
      const y = random() * height;
      const radius = 0.8 + random() * 3.2;
      ctx.fillStyle = `rgba(190,216,226,${0.09 + random() * 0.16})`;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      if (random() > 0.7) {
        ctx.fillStyle = 'rgba(160,190,200,0.035)';
        ctx.fillRect(x - 0.5, y, 1, 4 + random() * 22);
      }
    }

    // Отражения салонного света на стекле.
    const reflection = ctx.createLinearGradient(0, 0, width, height);
    reflection.addColorStop(0, 'rgba(255,214,160,0)');
    reflection.addColorStop(0.42, 'rgba(255,214,160,0.075)');
    reflection.addColorStop(0.55, 'rgba(255,214,160,0)');
    reflection.addColorStop(0.8, 'rgba(160,200,220,0.02)');
    reflection.addColorStop(1, 'rgba(255,214,160,0)');
    ctx.fillStyle = reflection;
    ctx.fillRect(0, 0, width, height);

    // Ночь снаружи всегда темнее салона.
    const vignette = ctx.createRadialGradient(width / 2, height / 2, height * 0.15, width / 2, height / 2, height * 0.8);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.42)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);

    return this._texture(canvas, { wrap: THREE.RepeatWrapping, srgb: true });
  }

  poster(title, lines, accent = '#7c2318') {
    const width = 384;
    const height = 512;
    const canvas = this._canvas(width, height);
    const ctx = canvas.getContext('2d');
    const random = createRng(0x707070 + title.length * 31);

    // Старая бумага.
    const paper = ctx.createLinearGradient(0, 0, width, height);
    paper.addColorStop(0, '#c9bb95');
    paper.addColorStop(0.45, '#bfae85');
    paper.addColorStop(1, '#a89471');
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, width, height);

    for (let i = 0; i < 26; i += 1) {
      const x = random() * width;
      const y = random() * height;
      const radius = 20 + random() * 90;
      const stain = ctx.createRadialGradient(x, y, 0, x, y, radius);
      stain.addColorStop(0, `rgba(106,78,45,${0.025 + random() * 0.06})`);
      stain.addColorStop(1, 'rgba(106,78,45,0)');
      ctx.fillStyle = stain;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }

    // Волокна и выцветание.
    for (let i = 0; i < 1500; i += 1) {
      ctx.fillStyle = random() > 0.5 ? 'rgba(60,44,28,0.07)' : 'rgba(245,236,210,0.045)';
      ctx.fillRect(random() * width, random() * height, 1, 1 + random() * 2);
    }

    // Рамка.
    ctx.strokeStyle = 'rgba(45,38,24,0.75)';
    ctx.lineWidth = 4;
    ctx.strokeRect(18, 18, width - 36, height - 36);
    ctx.strokeStyle = 'rgba(45,38,24,0.4)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(27, 27, width - 54, height - 54);

    // Шапка.
    ctx.fillStyle = accent;
    ctx.fillRect(31, 34, width - 62, 66);
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(31, 92, width - 62, 8);

    ctx.fillStyle = '#e9dfc2';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 25px "Courier New", monospace';
    ctx.fillText(title, width / 2, 68);

    // Основной текст.
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(39,33,23,0.9)';
    ctx.font = 'bold 18px "Courier New", monospace';
    let y = 146;
    for (const line of lines) {
      ctx.fillText(line, 43, y);
      y += 31;
      if (y > height - 92) break;
    }

    // Печать.
    ctx.save();
    ctx.translate(width - 92, height - 92);
    ctx.rotate(-0.14);
    ctx.strokeStyle = 'rgba(124,35,24,0.55)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, 38, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, 31, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(124,35,24,0.62)';
    ctx.font = 'bold 31px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('06', 0, 1);
    ctx.restore();

    // Служебная строка.
    ctx.fillStyle = 'rgba(55,47,32,0.7)';
    ctx.font = '11px "Courier New", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('МПС // НОЧНАЯ ЛИНИЯ // СЕКТОР 06', 43, height - 42);

    // Потёртые края.
    ctx.fillStyle = 'rgba(48,38,24,0.16)';
    ctx.fillRect(0, 0, 8, height);
    ctx.fillRect(width - 8, 0, 8, height);
    ctx.fillRect(0, 0, width, 7);
    ctx.fillRect(0, height - 7, width, 7);

    return this._texture(canvas, { wrap: THREE.ClampToEdgeWrapping });
  }

  sign(text, options = {}) {
    const {
      fg = '#d9f7c8',
      bg = '#0a140d',
      sub = '',
      border = 'rgba(150,220,170,0.45)',
    } = options;

    const width = 512;
    const height = 176;
    const canvas = this._canvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    const shine = ctx.createLinearGradient(0, 0, 0, height);
    shine.addColorStop(0, 'rgba(255,255,255,0.055)');
    shine.addColorStop(0.5, 'rgba(255,255,255,0)');
    shine.addColorStop(1, 'rgba(0,0,0,0.3)');
    ctx.fillStyle = shine;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = border;
    ctx.lineWidth = 4;
    ctx.strokeRect(12, 12, width - 24, height - 24);

    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let fontSize = 84;
    ctx.font = `bold ${fontSize}px "Courier New", monospace`;
    while (ctx.measureText(text).width > width - 90 && fontSize > 20) {
      fontSize -= 2;
      ctx.font = `bold ${fontSize}px "Courier New", monospace`;
    }
    ctx.shadowColor = fg;
    ctx.shadowBlur = 16;
    ctx.fillText(text, width / 2, sub ? height / 2 - 12 : height / 2);
    ctx.shadowBlur = 0;

    if (sub) {
      ctx.fillStyle = 'rgba(220,230,215,0.6)';
      ctx.font = '16px "Courier New", monospace';
      ctx.fillText(sub, width / 2, height - 40);
    }

    // Винты по углам.
    for (const [x, y] of [[26, 26], [width - 26, 26], [26, height - 26], [width - 26, height - 26]]) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(210,220,200,0.25)';
      ctx.fillRect(x - 2, y - 0.5, 4, 1);
    }

    // Потёртости.
    const random = createRng(0x5155aa);
    for (let i = 0; i < 220; i += 1) {
      ctx.fillStyle = random() > 0.5 ? 'rgba(0,0,0,0.1)' : 'rgba(230,255,230,0.03)';
      ctx.fillRect(random() * width, random() * height, 1 + random() * 2, 1);
    }

    return this._texture(canvas, { wrap: THREE.ClampToEdgeWrapping });
  }

  clock() {
    const size = 256;
    const canvas = this._canvas(size, size);
    const ctx = canvas.getContext('2d');
    const random = createRng(0x00c10c);

    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#121007';
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2);
    ctx.fill();

    const face = ctx.createRadialGradient(size / 2, size / 2, 10, size / 2, size / 2, size / 2);
    face.addColorStop(0, '#cfc4a0');
    face.addColorStop(0.72, '#b4a880');
    face.addColorStop(1, '#877a58');
    ctx.fillStyle = face;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 14, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(47,40,25,0.8)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 14, 0, Math.PI * 2);
    ctx.stroke();

    // Деления.
    for (let i = 0; i < 60; i += 1) {
      const angle = (i / 60) * Math.PI * 2;
      const inner = i % 5 === 0 ? size / 2 - 34 : size / 2 - 24;
      const outer = size / 2 - 17;
      ctx.strokeStyle = i % 5 === 0 ? 'rgba(40,34,20,0.9)' : 'rgba(40,34,20,0.5)';
      ctx.lineWidth = i % 5 === 0 ? 2.5 : 1.2;
      ctx.beginPath();
      ctx.moveTo(size / 2 + Math.cos(angle) * inner, size / 2 + Math.sin(angle) * inner);
      ctx.lineTo(size / 2 + Math.cos(angle) * outer, size / 2 + Math.sin(angle) * outer);
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(35,30,18,0.85)';
    ctx.font = 'bold 20px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('12', size / 2, 50);
    ctx.fillText('3', size - 48, size / 2);
    ctx.fillText('6', size / 2, size - 47);
    ctx.fillText('9', 47, size / 2);

    // Стрелки: ровно полночь.
    const centerX = size / 2;
    const centerY = size / 2;
    ctx.strokeStyle = 'rgba(30,25,15,0.95)';
    ctx.lineCap = 'round';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(centerX, centerY + 12);
    ctx.lineTo(centerX, centerY - 56);
    ctx.stroke();
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(centerX, centerY + 16);
    ctx.lineTo(centerX + 3, centerY - 86);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(110,30,22,0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(centerX, centerY + 22);
    ctx.lineTo(centerX - 1, centerY + 96);
    ctx.stroke();

    ctx.fillStyle = '#2a2416';
    ctx.beginPath();
    ctx.arc(centerX, centerY, 7, 0, Math.PI * 2);
    ctx.fill();

    // Трещина на стекле.
    ctx.strokeStyle = 'rgba(50,44,28,0.55)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(94, 70);
    ctx.lineTo(120, 98);
    ctx.lineTo(116, 122);
    ctx.lineTo(137, 146);
    ctx.stroke();

    // Грязь.
    for (let i = 0; i < 220; i += 1) {
      ctx.fillStyle = `rgba(50,42,26,${0.015 + random() * 0.05})`;
      ctx.fillRect(random() * size, random() * size, 1 + random() * 3, 1 + random() * 3);
    }

    return this._texture(canvas, { wrap: THREE.ClampToEdgeWrapping });
  }

  graffiti(text) {
    const width = 512;
    const height = 160;
    const canvas = this._canvas(width, height);
    const ctx = canvas.getContext('2d');
    const random = createRng(0x666013);

    ctx.clearRect(0, 0, width, height);
    ctx.translate(width / 2, height / 2);
    ctx.rotate(-0.045);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 52px "Courier New", monospace';
    ctx.lineJoin = 'round';

    // «Нацарапано» несколько раз с дрожанием.
    for (let pass = 0; pass < 3; pass += 1) {
      ctx.fillStyle = pass === 0 ? 'rgba(72,14,10,0.72)' : `rgba(48,9,7,${0.32 - pass * 0.07})`;
      ctx.save();
      ctx.translate((random() - 0.5) * 5, (random() - 0.5) * 3);
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }

    // Потёки.
    ctx.strokeStyle = 'rgba(72,14,10,0.34)';
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 14; i += 1) {
      const x = -210 + random() * 420;
      const y = 12 + random() * 20;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (random() - 0.5) * 3, y + 12 + random() * 42);
      ctx.stroke();
    }

    return this._texture(canvas, { wrap: THREE.ClampToEdgeWrapping });
  }

  dust() {
    const size = 64;
    const canvas = this._canvas(size, size);
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,240,215,0.95)');
    gradient.addColorStop(0.3, 'rgba(255,235,205,0.45)');
    gradient.addColorStop(1, 'rgba(255,235,205,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    return this._texture(canvas, { wrap: THREE.ClampToEdgeWrapping });
  }
}

// =============================================================================
// ВАГОН
// =============================================================================

class TrainCar {
  constructor(scene, renderer, { reducedMotion = false } = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.reducedMotion = reducedMotion;

    const { width, length, height } = CONFIG.car;
    this.width = width;
    this.length = length;
    this.height = height;
    this.halfW = width / 2;
    this.halfL = length / 2;

    this.group = new THREE.Group();
    this.group.name = 'Вагон 06';
    scene.add(this.group);

    this.bounds = {
      minX: -this.halfW,
      maxX: this.halfW,
      minZ: -this.halfL,
      maxZ: this.halfL,
      minY: 0,
      maxY: height,
    };
    this.spawn = { ...CONFIG.player.spawn };
    this.colliders = [];

    this.swayTargets = [];
    this.dust = null;
    this.windowMap = null;
    this.lampMainMaterial = null;
    this.centralLight = null;
    this.centralBaseIntensity = 34;

    this._flickerValue = 1;
    this._flickerTimer = randomRange(2.2, 5.5);
    this._flickerBurst = 0;
    this.dread = 0;

    this.textures = new TextureFactory(renderer);
    this.materials = this._createMaterials();
    this._rivetGeometry = new THREE.SphereGeometry(0.012, 6, 5);

    this._build();
    this._lighting();
  }

  _createMaterials() {
    const t = this.textures;

    const wallMapSide = t.wall();
    const wallMapEnd = wallMapSide.clone();
    wallMapEnd.repeat.set(1, 1);
    wallMapEnd.needsUpdate = true;

    const windowMap = t.night();
    this.windowMap = windowMap;

    this.lampMainMaterial = new THREE.MeshStandardMaterial({
      color: 0x2a251a,
      emissive: 0xffdda5,
      emissiveIntensity: 1.55,
      roughness: 0.55,
      metalness: 0.05,
      toneMapped: true,
    });

    const lampSideMaterial = new THREE.MeshStandardMaterial({
      color: 0x241f16,
      emissive: 0xffc98c,
      emissiveIntensity: 0.55,
      roughness: 0.6,
      metalness: 0.05,
    });

    return {
      floor: new THREE.MeshStandardMaterial({
        map: t.floor(),
        color: 0xffffff,
        roughness: 0.9,
        metalness: 0.03,
      }),
      runner: new THREE.MeshStandardMaterial({
        map: t.runner(),
        color: 0xffffff,
        roughness: 1,
        metalness: 0,
      }),
      wallSide: new THREE.MeshStandardMaterial({
        map: wallMapSide,
        color: 0xffffff,
        roughness: 0.84,
        metalness: 0.12,
      }),
      wallEnd: new THREE.MeshStandardMaterial({
        map: wallMapEnd,
        color: 0xf4f1e6,
        roughness: 0.86,
        metalness: 0.1,
      }),
      ceiling: new THREE.MeshStandardMaterial({
        map: t.ceiling(),
        color: 0xd6d4c8,
        roughness: 0.92,
        metalness: 0.04,
      }),
      wood: new THREE.MeshStandardMaterial({
        color: 0x2e2118,
        roughness: 0.72,
        metalness: 0.04,
      }),
      woodTrim: new THREE.MeshStandardMaterial({
        color: 0x3b2b1e,
        roughness: 0.58,
        metalness: 0.08,
      }),
      darkMetal: new THREE.MeshStandardMaterial({
        color: 0x1a1d1a,
        roughness: 0.52,
        metalness: 0.62,
      }),
      trim: new THREE.MeshStandardMaterial({
        color: 0x2c2e28,
        roughness: 0.4,
        metalness: 0.66,
      }),
      brass: new THREE.MeshStandardMaterial({
        color: 0x7f6338,
        roughness: 0.42,
        metalness: 0.82,
      }),
      seat: new THREE.MeshStandardMaterial({
        map: t.fabric(),
        color: 0xc8beac,
        roughness: 0.97,
        metalness: 0,
      }),
      upholsteryEdge: new THREE.MeshStandardMaterial({
        color: 0x2f261c,
        roughness: 0.9,
      }),
      linen: new THREE.MeshStandardMaterial({
        color: 0x8b8777,
        roughness: 0.98,
        metalness: 0,
      }),
      leather: new THREE.MeshStandardMaterial({
        color: 0x2d2015,
        roughness: 0.78,
        metalness: 0.03,
      }),
      leatherDark: new THREE.MeshStandardMaterial({
        color: 0x1d150f,
        roughness: 0.82,
        metalness: 0.03,
      }),
      suitcaseTag: new THREE.MeshStandardMaterial({
        color: 0x9a8455,
        roughness: 0.85,
      }),
      rubber: new THREE.MeshStandardMaterial({
        color: 0x121312,
        roughness: 0.96,
        metalness: 0.02,
      }),
      window: new THREE.MeshBasicMaterial({
        map: windowMap,
        color: 0xffffff,
        toneMapped: true,
        fog: true,
      }),
      windowGlass: new THREE.MeshStandardMaterial({
        color: 0x8fb3bb,
        roughness: 0.08,
        metalness: 0.55,
        transparent: true,
        opacity: 0.09,
        depthWrite: false,
      }),
      lampMain: this.lampMainMaterial,
      lampSide: lampSideMaterial,
      redLamp: new THREE.MeshStandardMaterial({
        color: 0x360707,
        emissive: 0xff2416,
        emissiveIntensity: 2.1,
        roughness: 0.45,
        metalness: 0.2,
      }),
      paper: new THREE.MeshStandardMaterial({
        color: 0xa9a184,
        roughness: 0.95,
      }),
    };
  }

  _box({ w, h, d, material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, parent = this.group, cast = false, receive = true }) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    parent.add(mesh);
    return mesh;
  }

  _plane({ w, h, material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, parent = this.group, receive = true }) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    mesh.receiveShadow = receive;
    parent.add(mesh);
    return mesh;
  }

  _build() {
    this._buildShell();
    this._buildSeating();
    this._buildWindows();
    this._buildCeiling();
    this._buildWallDetails();
    this._buildEndDoors();
    this._buildDust();
    this._batchStaticBoxes();
  }

  /**
   * Статичные коробки (рамы, скамьи, чемоданы, рёбра) объединяются в один
   * меш на материал. Вместо ~450 draw call остаётся ~15, при этом картинка
   * не меняется: свет и тени считаются для объединённой геометрии.
   */
  _batchStaticBoxes() {
    this.group.updateMatrixWorld(true);

    const buckets = new Map();
    const candidates = [];

    this.group.traverse((object) => {
      if (!object.isMesh) return;
      if (!object.geometry || object.geometry.type !== 'BoxGeometry') return;
      if (object.material.transparent) return;
      if (object.userData.dynamic) return;
      let parent = object.parent;
      while (parent && parent !== this.group) {
        if (parent.userData.dynamic) return;
        parent = parent.parent;
      }
      candidates.push(object);
    });

    for (const mesh of candidates) {
      const key = `${mesh.material.uuid}|${mesh.castShadow ? 1 : 0}|${mesh.receiveShadow ? 1 : 0}`;
      if (!buckets.has(key)) {
        buckets.set(key, {
          material: mesh.material,
          castShadow: mesh.castShadow,
          receiveShadow: mesh.receiveShadow,
          meshes: [],
        });
      }
      buckets.get(key).meshes.push(mesh);
    }

    for (const bucket of buckets.values()) {
      if (bucket.meshes.length < 2) continue;

      const geometries = [];
      for (const mesh of bucket.meshes) {
        const geometry = mesh.geometry.clone();
        geometry.applyMatrix4(mesh.matrixWorld);
        geometry.deleteAttribute('uv2');
        geometries.push(geometry);
      }

      const merged = mergeGeometries(geometries, false);
      for (const geometry of geometries) geometry.dispose();
      if (!merged) continue;

      for (const mesh of bucket.meshes) {
        mesh.parent.remove(mesh);
        mesh.geometry.dispose();
      }

      const batched = new THREE.Mesh(merged, bucket.material);
      batched.castShadow = bucket.castShadow;
      batched.receiveShadow = bucket.receiveShadow;
      batched.matrixAutoUpdate = false;
      batched.name = 'Статичная геометрия вагона';
      this.group.add(batched);
    }

    // Пустые группы после переноса геометрии больше не нужны.
    const emptyGroups = [];
    this.group.traverse((object) => {
      if (object !== this.group && object.isGroup && object.children.length === 0) {
        emptyGroups.push(object);
      }
    });
    for (const group of emptyGroups) group.parent.remove(group);
  }

  _buildShell() {
    const { halfW, halfL, height } = this;
    const m = this.materials;

    const floor = this._plane({
      w: this.width,
      h: this.length,
      material: m.floor,
      rx: -Math.PI / 2,
      y: 0,
      receive: true,
    });
    floor.name = 'Пол';

    const ceiling = this._plane({
      w: this.width,
      h: this.length,
      material: m.ceiling,
      rx: Math.PI / 2,
      y: height,
    });
    ceiling.name = 'Потолок';

    const rightWall = this._plane({
      w: this.length,
      h: height,
      material: m.wallSide,
      x: halfW,
      y: height / 2,
      ry: -Math.PI / 2,
    });
    rightWall.name = 'Стена правая';

    const leftWall = this._plane({
      w: this.length,
      h: height,
      material: m.wallSide,
      x: -halfW,
      y: height / 2,
      ry: Math.PI / 2,
    });
    leftWall.name = 'Стена левая';

    this._plane({
      w: this.width,
      h: height,
      material: m.wallEnd,
      z: -halfL,
      y: height / 2,
      ry: 0,
    });
    this._plane({
      w: this.width,
      h: height,
      material: m.wallEnd,
      z: halfL,
      y: height / 2,
      ry: Math.PI,
    });

    // Ковровая дорожка.
    this._plane({
      w: 1.06,
      h: 26.4,
      material: m.runner,
      rx: -Math.PI / 2,
      y: 0.006,
      z: 0,
    });

    // Плинтусы.
    for (const side of [-1, 1]) {
      this._box({
        w: 0.075,
        h: 0.13,
        d: this.length - 0.08,
        material: m.darkMetal,
        x: side * (halfW - 0.045),
        y: 0.065,
        receive: true,
      });
    }

    // Потолочный карниз.
    for (const side of [-1, 1]) {
      this._box({
        w: 0.1,
        h: 0.09,
        d: this.length - 0.06,
        material: m.trim,
        x: side * (halfW - 0.06),
        y: height - 0.055,
      });
    }

    // Продольный поручень у окон.
    for (const side of [-1, 1]) {
      this._box({
        w: 0.045,
        h: 0.05,
        d: this.length - 1.2,
        material: m.brass,
        x: side * (halfW - 0.1),
        y: 1.06,
      });
    }
  }

  _buildSeating() {
    const benchCenters = [-9.9, -4.95, 0, 4.95, 9.9];
    const benchLength = 3.5;

    for (const side of [-1, 1]) {
      for (const centerZ of benchCenters) {
        this._buildBench(side, centerZ, benchLength);
      }
    }

    // Упавший чемодан в проходе — учит игрока обходить препятствия.
    this._buildFloorTrunk();
  }

  _buildBench(side, centerZ, benchLength) {
    const m = this.materials;
    const benchDepth = 0.64;
    const innerEdge = this.halfW - 0.09;
    const centerX = side * (innerEdge - benchDepth / 2);

    const group = new THREE.Group();
    group.name = 'Скамья';
    this.group.add(group);

    const localBox = (opts) => this._box({ ...opts, parent: group });

    // Основание.
    localBox({
      w: benchDepth,
      h: 0.42,
      d: benchLength,
      material: m.wood,
      x: centerX,
      y: 0.21,
      cast: true,
      receive: true,
    });

    // Тёмная ниша под сиденьем.
    localBox({
      w: benchDepth - 0.08,
      h: 0.18,
      d: benchLength - 0.16,
      material: m.rubber,
      x: centerX - side * 0.02,
      y: 0.11,
      receive: false,
    });

    // Два мягких сиденья.
    for (const offset of [-0.86, 0.86]) {
      localBox({
        w: benchDepth - 0.07,
        h: 0.115,
        d: 1.52,
        material: m.seat,
        x: centerX - side * 0.025,
        y: 0.485,
        z: centerZ + offset,
        receive: true,
      });
      // Обивочный кант.
      localBox({
        w: benchDepth - 0.04,
        h: 0.028,
        d: 1.54,
        material: m.upholsteryEdge,
        x: centerX - side * 0.02,
        y: 0.43,
        z: centerZ + offset,
      });
    }

    // Спинка.
    const backX = side * (innerEdge - 0.06);
    localBox({
      w: 0.14,
      h: 0.92,
      d: benchLength,
      material: m.wood,
      x: backX,
      y: 0.92,
      cast: true,
    });
    localBox({
      w: 0.055,
      h: 0.66,
      d: benchLength - 0.16,
      material: m.seat,
      x: backX - side * 0.095,
      y: 0.93,
      z: centerZ,
    });
    // Верхний поручень спинки.
    localBox({
      w: 0.16,
      h: 0.055,
      d: benchLength + 0.04,
      material: m.woodTrim,
      x: backX,
      y: 1.405,
    });

    // Подголовники-салфетки — деталь старого вагона.
    for (const offset of [-0.86, 0.86]) {
      localBox({
        w: 0.012,
        h: 0.2,
        d: 0.45,
        material: m.linen,
        x: backX - side * 0.135,
        y: 1.22,
        z: centerZ + offset,
        ry: 0.015,
      });
    }

    // Торцевые подлокотники.
    for (const offset of [-1, 1]) {
      localBox({
        w: 0.48,
        h: 0.06,
        d: 0.09,
        material: m.woodTrim,
        x: centerX - side * 0.06,
        y: 0.58,
        z: centerZ + offset * (benchLength / 2 - 0.1),
      });
      localBox({
        w: 0.07,
        h: 0.26,
        d: 0.07,
        material: m.darkMetal,
        x: centerX - side * 0.27,
        y: 0.43,
        z: centerZ + offset * (benchLength / 2 - 0.1),
      });
    }

    // Ножки / крепления к полу.
    for (const offset of [-1.4, 1.4]) {
      localBox({
        w: 0.08,
        h: 0.1,
        d: 0.16,
        material: m.darkMetal,
        x: centerX,
        y: 0.05,
        z: centerZ + offset,
      });
    }

    // Коллизия скамьи.
    const minX = side > 0 ? this.halfW - 0.76 : -this.halfW;
    const maxX = side > 0 ? this.halfW : -this.halfW + 0.76;
    this.colliders.push({
      minX,
      maxX,
      minZ: centerZ - benchLength / 2 - 0.05,
      maxZ: centerZ + benchLength / 2 + 0.05,
      type: 'bench',
    });
  }

  _buildFloorTrunk() {
    const m = this.materials;
    const group = new THREE.Group();
    group.position.set(-1.05, 0, -7.95);
    group.rotation.y = 0.18;
    this.group.add(group);

    this._box({
      w: 0.82,
      h: 0.48,
      d: 0.54,
      material: m.leather,
      y: 0.25,
      parent: group,
      cast: true,
    });
    this._box({
      w: 0.84,
      h: 0.06,
      d: 0.56,
      material: m.leatherDark,
      y: 0.5,
      parent: group,
      cast: true,
    });
    this._box({
      w: 0.06,
      h: 0.5,
      d: 0.56,
      material: m.darkMetal,
      x: -0.24,
      y: 0.26,
      parent: group,
    });
    this._box({
      w: 0.06,
      h: 0.5,
      d: 0.56,
      material: m.darkMetal,
      x: 0.24,
      y: 0.26,
      parent: group,
    });
    this._box({
      w: 0.16,
      h: 0.05,
      d: 0.04,
      material: m.brass,
      y: 0.56,
      parent: group,
    });
    this._box({
      w: 0.24,
      h: 0.055,
      d: 0.02,
      material: m.suitcaseTag,
      x: 0.1,
      y: 0.56,
      z: 0.12,
      rz: 0.08,
      parent: group,
    });

    this.colliders.push({
      minX: -1.47,
      maxX: -0.63,
      minZ: -8.28,
      maxZ: -7.62,
      type: 'trunk',
    });
  }

  _buildWindows() {
    const m = this.materials;
    const windowZ = [-12.4, -7.4, -2.4, 2.4, 7.4, 12.4];

    for (const side of [-1, 1]) {
      for (const z of windowZ) {
        this._buildWindow(side, z);
      }
    }

    // Вертикальные стойки между окнами.
    const ribZ = [-15, -10, -5, 0, 5, 10, 15];
    for (const side of [-1, 1]) {
      for (const z of ribZ) {
        this._box({
          w: 0.11,
          h: 2.78,
          d: 0.15,
          material: m.woodTrim,
          x: side * (this.halfW - 0.065),
          y: 1.39,
          z,
          cast: true,
        });
        this._box({
          w: 0.03,
          h: 2.7,
          d: 0.04,
          material: m.brass,
          x: side * (this.halfW - 0.145),
          y: 1.39,
          z,
        });
      }
    }
  }

  _buildWindow(side, z) {
    const m = this.materials;
    const group = new THREE.Group();
    group.position.set(side * (this.halfW - 0.012), 1.95, z);
    group.rotation.y = -side * Math.PI / 2;
    group.name = 'Окно';
    this.group.add(group);

    // Ночной пейзаж.
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(1.26, 0.76), m.window);
    pane.position.z = 0.002;
    pane.name = 'Ночь за окном';
    group.add(pane);

    // Отражение на стекле.
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(1.24, 0.74), m.windowGlass);
    glass.position.z = 0.012;
    group.add(glass);

    // Рама.
    const frameZ = 0.045;
    this._box({ w: 1.44, h: 0.065, d: 0.07, material: m.trim, y: 0.415, z: frameZ, parent: group });
    this._box({ w: 1.44, h: 0.065, d: 0.07, material: m.trim, y: -0.415, z: frameZ, parent: group });
    this._box({ w: 0.065, h: 0.9, d: 0.07, material: m.trim, x: -0.69, y: 0, z: frameZ, parent: group });
    this._box({ w: 0.065, h: 0.9, d: 0.07, material: m.trim, x: 0.69, y: 0, z: frameZ, parent: group });
    this._box({ w: 0.038, h: 0.8, d: 0.045, material: m.trim, y: 0, z: frameZ - 0.005, parent: group });
    this._box({ w: 1.3, h: 0.032, d: 0.038, material: m.darkMetal, y: -0.12, z: frameZ, parent: group });

    // Подоконник.
    this._box({ w: 1.5, h: 0.06, d: 0.17, material: m.woodTrim, y: -0.45, z: 0.055, parent: group });
    this._box({ w: 1.46, h: 0.028, d: 0.2, material: m.brass, y: -0.48, z: 0.05, parent: group });

    // Скрученная штора.
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.047, 0.047, 1.38, 10), m.linen);
    shade.rotation.z = Math.PI / 2;
    shade.position.set(0, 0.47, 0.045);
    group.add(shade);

    this._box({ w: 0.05, h: 0.13, d: 0.02, material: m.linen, y: 0.375, z: 0.09, parent: group });

    // Задвижка.
    this._box({ w: 0.09, h: 0.025, d: 0.03, material: m.brass, x: 0.52, y: -0.03, z: frameZ + 0.03, parent: group });
  }

  _buildCeiling() {
    const m = this.materials;

    // Поперечные рёбра потолка.
    for (const z of [-12, -8, -4, 0, 4, 8, 12]) {
      this._box({
        w: this.width - 0.12,
        h: 0.055,
        d: 0.12,
        material: m.darkMetal,
        y: this.height - 0.095,
        z,
      });
    }

    // Продольные балки.
    for (const x of [-0.98, 0.98]) {
      this._box({
        w: 0.07,
        h: 0.05,
        d: this.length - 0.3,
        material: m.darkMetal,
        x,
        y: this.height - 0.09,
      });
    }

    // Светильники.
    this._buildLightFixture(0, true);
    this._buildLightFixture(-10, false);
    this._buildLightFixture(10, false);

    // Потолочные поручни и подвесные петли.
    this._buildHangingStraps();

    // Багажные полки.
    this._buildLuggageRacks();
  }

  _buildLightFixture(z, isMain) {
    const m = this.materials;
    const group = new THREE.Group();
    group.position.set(0, 0, z);
    this.group.add(group);

    this._box({
      w: 0.86,
      h: 0.07,
      d: 1.98,
      material: m.darkMetal,
      y: this.height - 0.13,
      parent: group,
    });
    this._box({
      w: 0.56,
      h: 0.055,
      d: 1.66,
      material: m.trim,
      y: this.height - 0.18,
      parent: group,
    });
    this._box({
      w: 0.44,
      h: 0.022,
      d: 1.5,
      material: isMain ? m.lampMain : m.lampSide,
      y: this.height - 0.21,
      parent: group,
    });
    // Торцевые заглушки.
    for (const offset of [-0.78, 0.78]) {
      this._box({
        w: 0.52,
        h: 0.06,
        d: 0.06,
        material: m.trim,
        y: this.height - 0.2,
        z: offset,
        parent: group,
      });
    }
    // Металлические дуги крепления.
    for (const offset of [-0.55, 0.55]) {
      this._box({
        w: 0.72,
        h: 0.025,
        d: 0.035,
        material: m.brass,
        y: this.height - 0.065,
        z: offset,
        parent: group,
      });
    }
  }

  _buildHangingStraps() {
    const m = this.materials;
    const railLength = 27.2;

    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(
        new THREE.CylinderGeometry(0.022, 0.022, railLength, 8),
        m.brass,
      );
      rail.rotation.x = Math.PI / 2;
      rail.position.set(side * 1.04, 2.78, 0);
      rail.castShadow = false;
      this.group.add(rail);

      for (let z = -12.65; z <= 12.66; z += 2.3) {
        const holder = new THREE.Group();
        holder.position.set(side * 1.04, 2.76, z);
        holder.userData.dynamic = true;
        this.group.add(holder);

        this._box({
          w: 0.045,
          h: 0.3,
          d: 0.014,
          material: m.rubber,
          y: -0.15,
          parent: holder,
          cast: false,
        });

        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(0.088, 0.011, 6, 16),
          m.rubber,
        );
        ring.position.y = -0.47;
        holder.add(ring);

        this.swayTargets.push({
          object: holder,
          phase: Math.random() * Math.PI * 2,
          amplitude: 0.026 + Math.random() * 0.015,
        });
      }
    }
  }

  _buildLuggageRacks() {
    const m = this.materials;
    const rackLength = 25.2;

    for (const side of [-1, 1]) {
      this._box({
        w: 0.66,
        h: 0.04,
        d: rackLength,
        material: m.darkMetal,
        x: side * 1.57,
        y: 2.42,
      });
      this._box({
        w: 0.03,
        h: 0.1,
        d: rackLength,
        material: m.trim,
        x: side * 1.25,
        y: 2.47,
      });
      // Опоры полки.
      for (const z of [-11.4, -7, -2.6, 1.8, 6.2, 10.6]) {
        this._box({
          w: 0.56,
          h: 0.035,
          d: 0.045,
          material: m.trim,
          x: side * 1.56,
          y: 2.36,
          z,
        });
        this._box({
          w: 0.03,
          h: 0.16,
          d: 0.045,
          material: m.trim,
          x: side * 1.84,
          y: 2.44,
          z,
        });
      }
    }

    // Чемоданы на полках.
    const luggage = [
      { side: 1, z: -8.4, w: 0.42, h: 0.28, d: 0.64, color: 'leather', tilt: 0.02 },
      { side: 1, z: 1.3, w: 0.46, h: 0.32, d: 0.72, color: 'leatherDark', tilt: -0.03 },
      { side: 1, z: 9.6, w: 0.38, h: 0.24, d: 0.54, color: 'leather', tilt: 0.045 },
      { side: -1, z: -3.5, w: 0.44, h: 0.3, d: 0.68, color: 'leatherDark', tilt: -0.02 },
      { side: -1, z: 6.4, w: 0.4, h: 0.26, d: 0.58, color: 'leather', tilt: 0.03 },
      { side: -1, z: 12.0, w: 0.34, h: 0.22, d: 0.5, color: 'leatherDark', tilt: 0 },
    ];

    for (const item of luggage) {
      const group = new THREE.Group();
      group.position.set(item.side * 1.57, 2.44, item.z);
      group.rotation.y = item.tilt;
      this.group.add(group);

      this._box({
        w: item.w,
        h: item.h,
        d: item.d,
        material: m[item.color],
        y: item.h / 2,
        parent: group,
        cast: true,
      });
      for (const x of [-item.w * 0.26, item.w * 0.26]) {
        this._box({
          w: 0.025,
          h: item.h + 0.012,
          d: item.d + 0.012,
          material: m.leatherDark,
          x,
          y: item.h / 2,
          parent: group,
        });
      }
      this._box({
        w: 0.15,
        h: 0.035,
        d: 0.06,
        material: m.rubber,
        y: item.h + 0.02,
        parent: group,
      });
      this._box({
        w: 0.1,
        h: 0.075,
        d: 0.012,
        material: m.suitcaseTag,
        x: 0.07,
        y: item.h * 0.58,
        z: item.d / 2 + 0.008,
        parent: group,
      });
    }
  }

  _buildWallDetails() {
    const m = this.materials;

    // Часы.
    const clock = new THREE.Mesh(
      new THREE.CircleGeometry(0.21, 40),
      new THREE.MeshStandardMaterial({
        map: this.textures.clock(),
        roughness: 0.8,
        metalness: 0.08,
        emissive: 0x2e2a1c,
        emissiveIntensity: 0.22,
      }),
    );
    const clockGroup = new THREE.Group();
    clockGroup.position.set(this.halfW - 0.02, 2.26, -6.3);
    clockGroup.rotation.y = -Math.PI / 2;
    clock.position.z = 0.005;
    clockGroup.add(clock);
    const clockRim = new THREE.Mesh(
      new THREE.TorusGeometry(0.215, 0.022, 8, 40),
      m.brass,
    );
    clockRim.position.z = 0.012;
    clockGroup.add(clockRim);
    this.group.add(clockGroup);

    // Плакаты.
    this._addWallPoster({
      side: 1,
      z: -3.6,
      y: 1.9,
      width: 0.54,
      height: 0.72,
      tilt: 0.012,
      texture: this.textures.poster('ПРАВИЛА ПРОЕЗДА', [
        '1. НЕ ВЫХОДИТЕ В ТАМБУР',
        '2. НЕ СМОТРИТЕ В ОКНА',
        '   ПОСЛЕ ПОЛУНОЧИ',
        '3. ПРИ ОСТАНОВКЕ СОСТАВА',
        '   ОСТАВАЙТЕСЬ НА МЕСТАХ',
        '4. НЕ ОТВЕЧАЙТЕ, ЕСЛИ',
        '   ВАС ОКЛИКНУТ',
      ]),
    });

    this._addWallPoster({
      side: 1,
      z: 8.5,
      y: 1.92,
      width: 0.54,
      height: 0.72,
      tilt: -0.018,
      texture: this.textures.poster('РАСПИСАНИЕ', [
        '00:00  САНКТ-ПЕТЕРБУРГ',
        '00:00  ПЕРЕГОН',
        '00:00  СЕКТОР 06',
        '00:00  КОНЕЧНАЯ',
        '',
        'ОПОЗДАНИЕ:',
        'НАВСЕГДА',
      ], '#223026'),
    });

    this._addWallPoster({
      side: -1,
      z: 11.15,
      y: 1.9,
      width: 0.52,
      height: 0.7,
      tilt: 0.026,
      texture: this.textures.poster('НЕ СПИ', [
        'ПАССАЖИР, ЗАСНУВШИЙ',
        'В ПУТИ, ПРОСЫПАЕТСЯ',
        'НЕ НА СВОЕЙ СТАНЦИИ.',
        '',
        'ОН ПРОСЫПАЕТСЯ НЕ СОБОЙ.',
        '',
        'БОДРСТВУЙТЕ.',
      ], '#5f1b13'),
    });

    // Надпись на стене.
    const graffiti = new THREE.Mesh(
      new THREE.PlaneGeometry(1.65, 0.52),
      new THREE.MeshStandardMaterial({
        map: this.textures.graffiti('НЕ ОБОРАЧИВАЙСЯ'),
        transparent: true,
        roughness: 1,
        metalness: 0,
        emissive: 0x220403,
        emissiveIntensity: 0.45,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      }),
    );
    graffiti.position.set(-this.halfW + 0.018, 1.62, -14.1);
    graffiti.rotation.y = Math.PI / 2;
    this.group.add(graffiti);

    // Красная табличка стоп-крана.
    const stopSign = new THREE.Mesh(
      new THREE.PlaneGeometry(0.28, 0.2),
      new THREE.MeshBasicMaterial({
        map: this.textures.sign('СТОП', { fg: '#ffd9cd', bg: '#5a100a', border: 'rgba(255,150,130,0.5)', sub: 'КРАН' }),
        toneMapped: true,
      }),
    );
    stopSign.position.set(-this.halfW + 0.025, 1.55, 6.7);
    stopSign.rotation.y = Math.PI / 2;
    this.group.add(stopSign);

    // Багетная табличка «ВАГОН 06» у дальнего торца.
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 0.17),
      new THREE.MeshBasicMaterial({
        map: this.textures.sign('ВАГОН 06', { fg: '#e6dfc0', bg: '#15130c', border: 'rgba(200,190,150,0.35)' }),
        toneMapped: true,
      }),
    );
    plate.position.set(this.halfW - 0.025, 2.28, -14.6);
    plate.rotation.y = -Math.PI / 2;
    this.group.add(plate);

    // Мусор на полу.
    this._buildPaperLitter();
  }

  _addWallPoster({ side, z, y, width, height, tilt, texture }) {
    const group = new THREE.Group();
    group.position.set(side * (this.halfW - 0.018), y, z);
    group.rotation.y = -side * Math.PI / 2;
    this.group.add(group);

    const paper = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshStandardMaterial({
        map: texture,
        roughness: 0.94,
        metalness: 0.02,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      }),
    );
    paper.rotation.z = tilt;
    paper.position.z = 0.004;
    group.add(paper);
  }

  _buildPaperLitter() {
    const m = this.materials;
    for (const [x, z, rot] of [[0.35, 7.4, 0.6], [-0.52, 3.2, -1.1], [0.22, -11.6, 0.2]]) {
      const paper = new THREE.Mesh(
        new THREE.PlaneGeometry(0.22, 0.3),
        new THREE.MeshStandardMaterial({
          color: 0x8e866c,
          roughness: 1,
          side: THREE.DoubleSide,
        }),
      );
      paper.rotation.x = -Math.PI / 2;
      paper.rotation.z = rot;
      paper.position.set(x, 0.012, z);
      this.group.add(paper);
    }
    // Пара потерянных перчаток.
    this._box({ w: 0.16, h: 0.035, d: 0.23, material: m.linen, x: -0.75, y: 0.02, z: 11.8, ry: 0.4 });
  }

  _buildEndDoors() {
    this._buildEndDoor(-1);
    this._buildEndDoor(1);
  }

  _buildEndDoor(direction) {
    const m = this.materials;
    const group = new THREE.Group();
    group.position.set(0, 0, direction * this.halfL);
    group.rotation.y = direction > 0 ? Math.PI : 0;
    group.name = direction < 0 ? 'Дверь тамбура' : 'Дверь вагона';
    this.group.add(group);

    // Дверное полотно из двух створок.
    for (const x of [-0.3, 0.3]) {
      this._box({
        w: 0.58,
        h: 2.08,
        d: 0.06,
        material: m.darkMetal,
        x,
        y: 1.06,
        z: 0.035,
        parent: group,
        cast: true,
      });
      this._box({
        w: 0.48,
        h: 0.52,
        d: 0.075,
        material: m.trim,
        x,
        y: 0.44,
        z: 0.05,
        parent: group,
      });
      this._box({
        w: 0.5,
        h: 0.12,
        d: 0.07,
        material: m.trim,
        x,
        y: 1.98,
        z: 0.05,
        parent: group,
      });
      this._box({
        w: 0.24,
        h: 0.18,
        d: 0.005,
        material: m.paper,
        x,
        y: 1.32,
        z: 0.07,
        parent: group,
      });
      // Продольные рёбра створки.
      for (const rx of [-0.17, 0.17]) {
        this._box({
          w: 0.025,
          h: 1.5,
          d: 0.02,
          material: m.trim,
          x: x + rx,
          y: 1.12,
          z: 0.075,
          parent: group,
        });
      }
    }

    // Центральный шов.
    this._box({
      w: 0.018,
      h: 2.08,
      d: 0.08,
      material: m.trim,
      y: 1.06,
      z: 0.045,
      parent: group,
    });

    // Иллюминатор.
    const porthole = new THREE.Mesh(
      new THREE.CircleGeometry(0.16, 28),
      new THREE.MeshBasicMaterial({ color: 0x010203 }),
    );
    porthole.position.set(0, 1.64, 0.075);
    group.add(porthole);

    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.166, 0.018, 8, 32), m.brass);
    ring.position.set(0, 1.64, 0.082);
    group.add(ring);

    const glass = new THREE.Mesh(
      new THREE.CircleGeometry(0.16, 28),
      new THREE.MeshStandardMaterial({
        color: 0x6e8d92,
        roughness: 0.08,
        metalness: 0.4,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
      }),
    );
    glass.position.set(0, 1.64, 0.086);
    group.add(glass);

    // Рама.
    this._box({ w: 0.09, h: 2.28, d: 0.12, material: m.trim, x: -0.68, y: 1.14, parent: group });
    this._box({ w: 0.09, h: 2.28, d: 0.12, material: m.trim, x: 0.68, y: 1.14, parent: group });
    this._box({ w: 1.45, h: 0.09, d: 0.12, material: m.trim, y: 2.3, parent: group });
    this._box({ w: 1.36, h: 0.05, d: 0.1, material: m.darkMetal, y: 2.38, parent: group });

    // Ручки.
    for (const x of [-0.48, 0.48]) {
      const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.27, 8), m.brass);
      handle.position.set(x, 1.02, 0.115);
      group.add(handle);
      for (const y of [-0.12, 0.12]) {
        this._box({
          w: 0.024,
          h: 0.03,
          d: 0.055,
          material: m.brass,
          x,
          y: 1.02 + y,
          z: 0.075,
          parent: group,
        });
      }
    }

    // Порог.
    this._box({
      w: 1.5,
      h: 0.025,
      d: 0.42,
      material: m.trim,
      y: 0.012,
      z: 0.12,
      parent: group,
    });

    // Заклёпки.
    const rivetMaterial = m.brass;
    for (let i = 0; i < 10; i += 1) {
      for (const x of [-0.56, 0.56]) {
        const rivet = new THREE.Mesh(this._rivetGeometry, rivetMaterial);
        rivet.position.set(x, 0.22 + i * 0.2, 0.075);
        group.add(rivet);
      }
    }

    // Табличка над дверью.
    const isExit = direction > 0;
    const signTexture = isExit
      ? this.textures.sign('ВЫХОД', { fg: '#a7ffc0', bg: '#07160c', border: 'rgba(120,255,170,0.45)', sub: 'ВАГОН 06' })
      : this.textures.sign('НЕ ОТКРЫВАТЬ', { fg: '#ffc0b4', bg: '#1b0806', border: 'rgba(255,120,100,0.5)', sub: 'ТАМБУР' });

    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(0.86, 0.295),
      new THREE.MeshBasicMaterial({ map: signTexture, toneMapped: true }),
    );
    sign.position.set(0, 2.58, 0.065);
    group.add(sign);

    // Лампа над дверью.
    this._box({
      w: 0.3,
      h: 0.07,
      d: 0.08,
      material: isExit ? new THREE.MeshStandardMaterial({
        color: 0x07180d,
        emissive: 0x68ffa0,
        emissiveIntensity: 1.4,
        roughness: 0.5,
      }) : m.redLamp,
      y: 2.82,
      z: 0.055,
      parent: group,
    });

    // Номер вагона рядом с дверью.
    const number = new THREE.Mesh(
      new THREE.PlaneGeometry(0.38, 0.28),
      new THREE.MeshBasicMaterial({
        map: this.textures.sign('06', { fg: '#ded6b8', bg: '#131109', border: 'rgba(190,180,140,0.3)', sub: 'ВАГОН' }),
        toneMapped: true,
      }),
    );
    number.position.set(0.98, 1.92, 0.04);
    group.add(number);
  }

  _buildDust() {
    const count = 180;
    const positions = new Float32Array(count * 3);
    const speeds = new Float32Array(count);
    const phases = new Float32Array(count);
    const random = createRng(0xd057);

    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = randomRange(-1.65, 1.65, random);
      positions[i * 3 + 1] = randomRange(0.15, 2.9, random);
      positions[i * 3 + 2] = randomRange(-15, 15, random);
      speeds[i] = randomRange(0.012, 0.055, random);
      phases[i] = randomRange(0, Math.PI * 2, random);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = new THREE.PointsMaterial({
      size: 0.045,
      map: this.textures.dust(),
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      blending: THREE.NormalBlending,
      color: 0xffe0b0,
      sizeAttenuation: true,
      fog: true,
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    this.group.add(points);

    this.dust = { points, positions, speeds, phases, count };
  }

  _lighting() {
    // Общая холодная подсветка, чтобы тени не были абсолютно чёрными.
    this.hemiLight = new THREE.HemisphereLight(0x44586a, 0x120d08, 0.46);
    this.scene.add(this.hemiLight);

    // Главная мигающая лампа.
    this.centralLight = new THREE.PointLight(0xffd6a0, this.centralBaseIntensity, 21, 2);
    this.centralLight.position.set(0, 2.76, 0);
    this.centralLight.castShadow = true;
    this.centralLight.shadow.mapSize.set(512, 512);
    this.centralLight.shadow.camera.near = 0.15;
    this.centralLight.shadow.camera.far = 20;
    this.centralLight.shadow.bias = -0.0025;
    this.centralLight.shadow.normalBias = 0.018;
    this.centralLight.shadow.radius = 3;
    this.scene.add(this.centralLight);

    // Боковые лампы (без теней — дешевле).
    this.sideLights = [];
    for (const z of [-10, 10]) {
      const light = new THREE.PointLight(0xffc98f, 7.4, 12.5, 2);
      light.position.set(0, 2.78, z);
      this.scene.add(light);
      this.sideLights.push(light);
    }

    // Красная лампа тамбура.
    this.emergencyLight = new THREE.PointLight(0xff2b1c, 3.2, 5.2, 2);
    this.emergencyLight.position.set(0, 2.68, -15.1);
    this.scene.add(this.emergencyLight);

    // Зелёный свет у выхода.
    this.exitLight = new THREE.PointLight(0x5dff9c, 1.5, 3.4, 2);
    this.exitLight.position.set(0, 2.55, 15.25);
    this.scene.add(this.exitLight);

    // Слабый холодный отсвет в проходе.
    this.aisleFill = new THREE.PointLight(0x8fb7c7, 1.4, 9, 2);
    this.aisleFill.position.set(0, 1.9, 6.8);
    this.scene.add(this.aisleFill);

    // Мягкая «заливка» между основными лампами — иначе середина вагона
    // проваливается в абсолютную темноту и препятствия не видны.
    this.fillLights = [];
    for (const z of [-5.2, 5.2]) {
      const light = new THREE.PointLight(0xffc793, 2.4, 8.6, 2);
      light.position.set(0, 2.66, z);
      this.scene.add(light);
      this.fillLights.push(light);
    }
  }

  /**
   * При истощении выносливости свет «садится» и становится тревожнее.
   * @param {number} amount 0..1
   */
  setDread(amount) {
    this.dread = clamp(amount, 0, 1);
  }

  update(dt, elapsed) {
    // Мерцание главной лампы.
    if (this.reducedMotion) {
      this._flickerValue = 0.97;
    } else {
      this._flickerTimer -= dt;
      if (this._flickerTimer <= 0) {
        this._flickerBurst = randomRange(0.16, 0.48);
        this._flickerTimer = randomRange(3.6, 8.4);
      }

      let target = 0.97 + Math.sin(elapsed * 1.25) * 0.028 + Math.sin(elapsed * 0.43) * 0.012;

      if (this._flickerBurst > 0) {
        this._flickerBurst -= dt;
        const strobe = Math.sin(elapsed * 47 + Math.sin(elapsed * 6.3) * 2.4);
        if (strobe > 0.1) target *= 0.42;
        else if (strobe > -0.3) target *= 0.78;
      }

      // Изредка лампа проседает чуть сильнее.
      if (Math.sin(elapsed * 0.21) > 0.998) target *= 0.68;

      this._flickerValue = damp(this._flickerValue, target, 20, dt);
    }

    const dread = this.dread || 0;
    if (this.centralLight) {
      this.centralLight.intensity = this.centralBaseIntensity * this._flickerValue * (1 - dread * 0.52);
    }
    if (this.lampMainMaterial) {
      this.lampMainMaterial.emissiveIntensity = (0.75 + 1.35 * this._flickerValue) * (1 - dread * 0.55);
    }
    if (this.sideLights) {
      for (const light of this.sideLights) {
        light.intensity = 7.4 * (1 - dread * 0.6);
      }
    }

    // Дождь на стёклах (общая текстура всех окон).
    if (this.windowMap && !this.reducedMotion) {
      this.windowMap.offset.y = (this.windowMap.offset.y - dt * 0.055) % 1;
      this.windowMap.offset.x = 0.13 + Math.sin(elapsed * 0.05) * 0.02;
    }

    // Покачивание подвесных петель.
    for (const sway of this.swayTargets) {
      const angle = this.reducedMotion
        ? 0.004 * Math.sin(sway.phase)
        : Math.sin(elapsed * 1.05 + sway.phase) * sway.amplitude;
      sway.object.rotation.x = angle;
      sway.object.rotation.z = Math.cos(elapsed * 0.7 + sway.phase) * sway.amplitude * 0.4;
    }

    // Пыль.
    if (this.dust) {
      const { positions, speeds, phases, count, points } = this.dust;
      for (let i = 0; i < count; i += 1) {
        const index = i * 3;
        positions[index + 1] += speeds[i] * dt;
        positions[index] += Math.sin(elapsed * 0.5 + phases[i]) * dt * 0.012;
        if (positions[index + 1] > 2.95) {
          positions[index + 1] = 0.1;
          positions[index] = randomRange(-1.65, 1.65);
        }
        if (positions[index] > 1.75) positions[index] = -1.75;
        if (positions[index] < -1.75) positions[index] = 1.75;
      }
      points.geometry.attributes.position.needsUpdate = true;
    }

    if (this.fillLights) {
      for (const light of this.fillLights) light.intensity = 2.4 * (1 - dread * 0.55);
    }

    // Лёгкое «дыхание» аварийного света.
    if (this.emergencyLight) {
      this.emergencyLight.intensity = 2.9 + Math.sin(elapsed * 2.1) * 0.35;
    }
  }
}

// =============================================================================
// ИГРОК
// =============================================================================

class PlayerController {
  constructor({ camera, domElement, world, audio, bus, sensitivity = 1 }) {
    this.camera = camera;
    this.world = world;
    this.audio = audio;
    this.bus = bus;

    this.controls = new PointerLockControls(camera, domElement);
    this.controls.pointerSpeed = clamp(sensitivity, 0.3, 2.2);
    this.controls.minPolarAngle = 0.06;
    this.controls.maxPolarAngle = Math.PI - 0.06;

    this.eyeHeight = CONFIG.player.eyeHeight;
    this.radius = CONFIG.player.radius;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.feetY = 0;
    this.verticalVelocity = 0;
    this.grounded = true;

    this.enabled = false;
    this.stamina = CONFIG.player.staminaMax;
    this.exhausted = false;
    this.sprinting = false;
    this.walkPhase = 0;
    this.bobAmount = 0;
    this.stepAccumulator = 0;
    this.regenDelay = 0;
    this.sensitivity = clamp(sensitivity, 0.3, 2.2);
    this.reducedMotion = REDUCED_MOTION.matches;

    this._lastStamina = -1;
    this._lastSprinting = null;
    this._lastExhausted = null;
    this._moveCodes = new Set([
      'KeyW', 'KeyA', 'KeyS', 'KeyD',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'ShiftLeft', 'ShiftRight',
    ]);
    this.keys = new Set();

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onBlur = this._onBlur.bind(this);

    this._lockTimestamp = 0;
    // Pointer Lock иногда присылает «прыжок» курсора при захвате — гасим его.
    this._onMouseMoveGuard = (event) => {
      if (!this.controls.isLocked) return;
      const delta = Math.abs(event.movementX || 0) + Math.abs(event.movementY || 0);
      if (performance.now() - this._lockTimestamp < 140 && delta > 90) {
        event.stopImmediatePropagation();
      }
    };
    document.addEventListener('mousemove', this._onMouseMoveGuard, { capture: true });

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);

    this.controls.addEventListener('lock', () => {
      this._lockTimestamp = performance.now();
      this.keys.clear();
      this.bus.emit('player:lock');
    });
    this.controls.addEventListener('unlock', () => {
      this.keys.clear();
      this.sprinting = false;
      this.bus.emit('player:unlock');
    });

    this.reset();
  }

  /** [PART II] Стартовая точка будет приходить от сервера/хоста. */
  reset(spawn = this.world.spawn) {
    this.position.set(spawn.x, 0, spawn.z);
    this.feetY = 0;
    this.verticalVelocity = 0;
    this.grounded = true;
    this.velocity.set(0, 0, 0);
    this.stamina = CONFIG.player.staminaMax;
    this.exhausted = false;
    this.sprinting = false;
    this.walkPhase = 0;
    this.bobAmount = 0;
    this.stepAccumulator = 0;
    this.regenDelay = 0;
    this.camera.fov = CONFIG.camera.fov;
    this.camera.updateProjectionMatrix();
    this.camera.rotation.set(0, 0, 0, 'YXZ');
    this._syncCamera(0);
    this._emitStamina(true);
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) {
      this.keys.clear();
      this.sprinting = false;
      this.velocity.set(0, 0, 0);
    }
  }

  setSensitivity(value) {
    this.sensitivity = clamp(Number(value) || 1, 0.3, 2.2);
    this.controls.pointerSpeed = this.sensitivity;
  }

  lock() {
    this.controls.lock();
  }

  unlock() {
    if (this.controls.isLocked) this.controls.unlock();
  }

  get isLocked() {
    return this.controls.isLocked;
  }

  _onKeyDown(event) {
    if (!this.enabled) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (!this._moveCodes.has(event.code)) return;
    event.preventDefault();
    this.keys.add(event.code);
  }

  _onKeyUp(event) {
    this.keys.delete(event.code);
  }

  _onBlur() {
    this.keys.clear();
  }

  _isBlocked(x, z) {
    const bounds = this.world.bounds;
    const radius = this.radius;
    if (
      x < bounds.minX + radius ||
      x > bounds.maxX - radius ||
      z < bounds.minZ + radius ||
      z > bounds.maxZ - radius
    ) {
      return true;
    }

    for (const collider of this.world.colliders) {
      const closestX = clamp(x, collider.minX, collider.maxX);
      const closestZ = clamp(z, collider.minZ, collider.maxZ);
      const dx = x - closestX;
      const dz = z - closestZ;
      if (dx * dx + dz * dz < radius * radius) return true;
    }
    return false;
  }

  _axisMove(dx, dz) {
    if (dx !== 0) {
      const nextX = this.position.x + dx;
      if (!this._isBlocked(nextX, this.position.z)) {
        this.position.x = nextX;
      } else {
        this.velocity.x = 0;
      }
    }
    if (dz !== 0) {
      const nextZ = this.position.z + dz;
      if (!this._isBlocked(this.position.x, nextZ)) {
        this.position.z = nextZ;
      } else {
        this.velocity.z = 0;
      }
    }
  }

  _inputAxes() {
    const forward = (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0)
      - (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0);
    const right = (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0)
      - (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0);
    return { forward, right };
  }

  _wishDirection(forward, right, target = new THREE.Vector3()) {
    const euler = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    const yaw = euler.y;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);

    // Вектор взгляда, спроецированный на пол.
    const dirX = -sin * forward + cos * right;
    const dirZ = -cos * forward - sin * right;
    target.set(dirX, 0, dirZ);
    if (target.lengthSq() > 1) target.normalize();
    return target;
  }

  update(dt, elapsed) {
    if (!this.enabled) return;

    const { forward, right } = this._inputAxes();
    const wish = this._wishDirection(forward, right);
    const moving = wish.lengthSq() > 0.001;
    const shiftHeld = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const wantsSprint = shiftHeld && moving && !this.exhausted && this.stamina > 0;

    // --- Выносливость ---
    if (wantsSprint) {
      this.stamina = Math.max(0, this.stamina - CONFIG.player.sprintDrain * dt);
      this.regenDelay = CONFIG.player.regenDelay;
      if (this.stamina <= 0.001) {
        this.stamina = 0;
        this.exhausted = true;
      }
    } else {
      this.regenDelay = Math.max(0, this.regenDelay - dt);
      if (this.regenDelay <= 0 && this.stamina < CONFIG.player.staminaMax) {
        const rate = this.exhausted
          ? CONFIG.player.staminaRegen * 1.35
          : CONFIG.player.staminaRegen;
        this.stamina = Math.min(CONFIG.player.staminaMax, this.stamina + rate * dt);
      }
    }

    if (this.exhausted && this.stamina >= CONFIG.player.exhaustedRecovery) {
      this.exhausted = false;
    }

    this.sprinting = wantsSprint;

    // --- Движение ---
    const speed = wantsSprint ? CONFIG.player.sprintSpeed : CONFIG.player.walkSpeed;
    const targetX = wish.x * speed;
    const targetZ = wish.z * speed;
    const lambda = moving ? CONFIG.player.acceleration : 11;

    this.velocity.x = damp(this.velocity.x, targetX, lambda, dt);
    this.velocity.z = damp(this.velocity.z, targetZ, lambda, dt);

    const dx = this.velocity.x * dt;
    const dz = this.velocity.z * dt;
    const distance = Math.hypot(dx, dz);
    const steps = Math.min(5, Math.max(1, Math.ceil(distance / 0.1)));
    for (let i = 0; i < steps; i += 1) {
      this._axisMove(dx / steps, dz / steps);
    }

    // --- Пол и потолок (прыжка нет, но основа для Части II) ---
    this.verticalVelocity -= 22 * dt;
    this.feetY += this.verticalVelocity * dt;
    if (this.feetY <= 0) {
      this.feetY = 0;
      this.verticalVelocity = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }
    const maxFeetY = this.world.bounds.maxY - this.eyeHeight - 0.12;
    if (this.feetY > maxFeetY) {
      this.feetY = maxFeetY;
      this.verticalVelocity = Math.min(0, this.verticalVelocity);
    }

    // --- Походка и шаги ---
    const horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    const speedRatio = clamp(horizontalSpeed / CONFIG.player.walkSpeed, 0, 2);
    if (horizontalSpeed > 0.12) {
      this.walkPhase += dt * (5.0 + speedRatio * 2.2);
      this.stepAccumulator += horizontalSpeed * dt;
      const stride = this.sprinting
        ? CONFIG.player.stepLengthSprint
        : CONFIG.player.stepLengthWalk;
      if (this.stepAccumulator >= stride) {
        this.stepAccumulator = 0;
        this.audio.footstep(this.sprinting ? 1.2 : 0.68);
      }
    }

    const targetBob = horizontalSpeed > 0.12 ? (this.sprinting ? 0.032 : 0.022) : 0;
    this.bobAmount = damp(this.bobAmount, targetBob, 8, dt);

    // --- FOV от бега ---
    const targetFov = this.sprinting ? CONFIG.camera.sprintFov : CONFIG.camera.fov;
    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      this.camera.fov = damp(this.camera.fov, targetFov, 6, dt);
      this.camera.updateProjectionMatrix();
    }

    this._syncCamera(elapsed);
    this._emitStamina(false);
  }

  _syncCamera(elapsed) {
    const bob = Math.sin(this.walkPhase * 2) * this.bobAmount;
    const idleSway = Math.sin(elapsed * 1.15) * 0.0035 + Math.sin(elapsed * 23.7) * 0.0008;
    // Микровибрация состава: почти незаметна, но добавляет тревоги.
    const rumble = this.reducedMotion ? 0 : 0.0012;
    const rumbleX = Math.sin(elapsed * 19.3) * rumble + Math.sin(elapsed * 7.1) * rumble * 0.5;
    const rumbleY = Math.sin(elapsed * 24.7 + 1.3) * rumble * 1.4;
    this.camera.position.set(
      this.position.x + rumbleX,
      this.feetY + this.eyeHeight + bob + idleSway + rumbleY,
      this.position.z,
    );
  }

  _emitStamina(force) {
    const rounded = Math.round(this.stamina);
    if (
      !force &&
      rounded === this._lastStamina &&
      this.sprinting === this._lastSprinting &&
      this.exhausted === this._lastExhausted
    ) {
      return;
    }
    this._lastStamina = rounded;
    this._lastSprinting = this.sprinting;
    this._lastExhausted = this.exhausted;

    this.bus.emit('player:stamina', {
      value: rounded,
      max: CONFIG.player.staminaMax,
      sprinting: this.sprinting,
      exhausted: this.exhausted,
    });
  }

  /** [PART II] Снимок состояния для будущей синхронизации по сети. */
  getNetworkState() {
    const euler = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    return {
      x: Number(this.position.x.toFixed(3)),
      y: Number(this.feetY.toFixed(3)),
      z: Number(this.position.z.toFixed(3)),
      yaw: Number(euler.y.toFixed(3)),
      pitch: Number(euler.x.toFixed(3)),
      stamina: Math.round(this.stamina),
      sprinting: this.sprinting,
    };
  }
}

// =============================================================================
// СЕТЬ (ЗАГЛУШКА ДЛЯ ЧАСТИ II)
// =============================================================================

class NetworkManager {
  constructor(bus) {
    this.bus = bus;
    this.session = null;
    this.connected = false;
    this._tickAccumulator = 0;
    this._localStateProvider = null;
    this._codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  }

  get isHost() {
    return Boolean(this.session && this.session.host);
  }

  _generateCode() {
    let code = '';
    for (let i = 0; i < CONFIG.network.lobbyCodeLength; i += 1) {
      code += this._codeAlphabet[Math.floor(Math.random() * this._codeAlphabet.length)];
    }
    return code;
  }

  /**
   * Часть I: лобби локальное. Часть II: здесь появится создание комнаты
   * (WebSocket / WebRTC / GitHub-friendly сервис) и код приглашения.
   */
  createLobby() {
    const code = this._generateCode();
    this.session = {
      code,
      host: true,
      mode: 'local',
      createdAt: Date.now(),
      peers: [],
    };
    this.connected = false;
    this.bus.emit('network:lobbyCreated', this.session);
    return this.session;
  }

  sanitizeCode(raw) {
    return String(raw || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .replace(/^06/, '')
      .slice(0, 6);
  }

  /**
   * Часть II: подключение к существующему лобби.
   * Возвращает единый формат результата, чтобы UI не зависел от транспорта.
   */
  async joinLobby(code) {
    const clean = this.sanitizeCode(code);
    await new Promise((resolve) => window.setTimeout(resolve, 550));
    this.bus.emit('network:joinFailed', { code: clean, reason: 'not-implemented' });
    return {
      ok: false,
      reason: 'not-implemented',
      message: 'СЕТЕВОЙ МОДУЛЬ БУДЕТ УСТАНОВЛЕН В ЧАСТИ II',
    };
  }

  leave() {
    if (this.session) this.bus.emit('network:left', this.session);
    this.session = null;
    this.connected = false;
    this._tickAccumulator = 0;
  }

  /** [PART II] Функция, возвращающая локальное состояние игрока для рассылки. */
  setLocalStateProvider(provider) {
    this._localStateProvider = provider;
  }

  update(dt) {
    if (!this.session) return;
    this._tickAccumulator += dt;
    const interval = 1 / CONFIG.network.tickRate;
    if (this._tickAccumulator < interval) return;
    this._tickAccumulator = 0;

    // [PART II] Здесь локальный пакет будет уходить на сервер.
    const local = this._localStateProvider ? this._localStateProvider() : null;
    this.bus.emit('network:tick', { session: this.session, local });
  }
}

// =============================================================================
// ИНТЕРФЕЙС
// =============================================================================

const MIC_MESSAGES = {
  NotAllowedError: 'ДОСТУП К МИКРОФОНУ ЗАПРЕЩЁН. РАЗРЕШИТЕ ЕГО В НАСТРОЙКАХ БРАУЗЕРА И ПОВТОРИТЕ ПОПЫТКУ.',
  SecurityError: 'ДОСТУП К МИКРОФОНУ ЗАПРЕЩЁН. ОТКРОЙТЕ САЙТ ПО HTTPS И РАЗРЕШИТЕ ЗАПИСЬ.',
  NotFoundError: 'МИКРОФОН НЕ ОБНАРУЖЕН. ПОДКЛЮЧИТЕ УСТРОЙСТВО ВВОДА И ПОВТОРИТЕ.',
  DevicesNotFoundError: 'МИКРОФОН НЕ ОБНАРУЖЕН. ПОДКЛЮЧИТЕ УСТРОЙСТВО ВВОДА И ПОВТОРИТЕ.',
  NotReadableError: 'МИКРОФОН ЗАНЯТ ДРУГИМ ПРИЛОЖЕНИЕМ. ЗАКРОЙТЕ ЕГО И ПОВТОРИТЕ.',
  TrackStartError: 'МИКРОФОН ЗАНЯТ ДРУГИМ ПРИЛОЖЕНИЕМ. ЗАКРОЙТЕ ЕГО И ПОВТОРИТЕ.',
  OverconstrainedError: 'МИКРОФОН НЕ ПОДДЕРЖИВАЕТ ТРЕБУЕМЫЕ ПАРАМЕТРЫ.',
  MEDIA_UNSUPPORTED: 'БРАУЗЕР НЕ ПОДДЕРЖИВАЕТ ЗАХВАТ АУДИО. ОТКРОЙТЕ САЙТ ПО HTTPS В СОВРЕМЕННОМ БРАУЗЕРЕ.',
  AUDIO_CONTEXT_UNAVAILABLE: 'НЕ УДАЛОСЬ ЗАПУСТИТЬ АУДИОСИСТЕМУ. ПРОВЕРЬТЕ ЗВУКОВЫЕ УСТРОЙСТВА.',
};

class UIManager {
  constructor({ bus, audio, store, network }) {
    this.bus = bus;
    this.audio = audio;
    this.store = store;
    this.network = network;

    this._settingsOpen = false;
    this._settingsOrigin = 'menu';
    this._micRaf = 0;
    this._micPeak = 0;
    this._micPeakAt = 0;
    this._meterCount = -1;
    this._peakIndex = -1;
    this._micBusy = false;
    this._joinToken = 0;
    this._joining = false;
    this._hintsTimer = 0;
    this._toastTimer = 0;
    this._toastHideTimer = 0;
    this._hauntTimer = 0;
    this._lobbyCodeText = '—';
    this._clockSeconds = 23 * 3600 + 58 * 60;
    this._defaultStaminaCaption = 'SHIFT — БЕГ / ВЫНОСЛИВОСТЬ ВОССТАНАВЛИВАЕТСЯ В ПОКОЕ';

    this.el = {
      boot: $('#boot'),
      menu: $('#screen-menu'),
      settings: $('#screen-settings'),
      join: $('#modal-join'),
      hud: $('#hud'),
      pause: $('#pause-screen'),
      toast: $('#toast'),

      create: $('#btn-create'),
      joinButton: $('#btn-join'),
      settingsButton: $('#btn-settings'),
      settingsClose: $('#btn-settings-close'),
      settingsReset: $('#btn-settings-reset'),
      settingsBack: $('#btn-settings-back'),

      volume: $('#volume'),
      volumeValue: $('#volume-value'),
      sensitivity: $('#sensitivity'),
      sensitivityValue: $('#sensitivity-value'),

      micStatus: $('#mic-status'),
      micMeter: $('#mic-meter'),
      micButton: $('#btn-mic'),
      micButtonLabel: $('#btn-mic-label'),
      micError: $('#mic-error'),
      micDb: $('#mic-db'),
      micPeak: $('#mic-peak'),

      joinForm: $('#join-form'),
      joinInput: $('#lobby-code'),
      joinError: $('#join-error'),
      joinClose: $('#btn-join-close'),
      joinCancel: $('#btn-join-cancel'),
      joinSubmit: $('#btn-join-submit'),

      hudLobbyCode: $('#hud-lobby-code'),
      staminaFill: $('#stamina-fill'),
      staminaValue: $('#stamina-value'),
      staminaTrack: $('#stamina-track'),
      vitals: $('#hud-vitals'),
      staminaCaption: $('.vitals-caption'),
      hints: $('#hud-hints'),

      pauseResume: $('#btn-resume'),
      pauseSettings: $('#btn-pause-settings'),
      pauseExit: $('#btn-exit'),
      pauseTitle: $('#pause-title'),
      pauseText: $('#pause-text'),
      pauseLobbyCode: $('#pause-lobby-code'),

      clock: $('#menu-clock'),
    };

    this._buildMeter();
    this._bind();
    this._applySettingsToUI();
    this._resetMicVisuals();
    this._startClock();

    this.bus.on('player:stamina', (state) => this.setStamina(state));
    this.bus.on('network:lobbyCreated', (session) => this.setLobbyCode(session.code));
  }

  get isSettingsOpen() {
    return this._settingsOpen;
  }

  _buildMeter() {
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < 28; i += 1) {
      const segment = document.createElement('span');
      segment.className = 'meter-seg';
      segment.setAttribute('aria-hidden', 'true');
      fragment.appendChild(segment);
    }
    this.el.micMeter.appendChild(fragment);
    this._meterSegments = $$('.meter-seg', this.el.micMeter);
  }

  _bind() {
    // Пользовательский жест разблокирует Web Audio.
    document.addEventListener('pointerdown', () => this.audio.init(), { capture: true });
    window.addEventListener('keydown', () => this.audio.init(), { capture: true });

    // Звук наведения и нажатия у всех кнопок.
    for (const button of $$('button')) {
      button.addEventListener('pointerenter', () => this.audio.uiHover());
    }
    document.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (button && !button.disabled) this.audio.uiClick();
    });

    this.el.create.addEventListener('click', () => this.bus.emit('ui:createLobby'));
    this.el.joinButton.addEventListener('click', () => this.openJoin());
    this.el.settingsButton.addEventListener('click', () => this.openSettings('menu'));
    this.el.pauseSettings.addEventListener('click', () => this.openSettings('pause'));

    this.el.settingsClose.addEventListener('click', () => {
      this.audio.uiBack();
      this.closeSettings();
    });
    this.el.settingsBack.addEventListener('click', () => {
      this.audio.uiBack();
      this.closeSettings();
    });
    this.el.settingsReset.addEventListener('click', () => this._resetSettings());

    this.el.volume.addEventListener('input', () => this._onVolumeInput());
    this.el.sensitivity.addEventListener('input', () => this._onSensitivityInput());

    this.el.micButton.addEventListener('click', () => this._toggleMic());
    this.el.micMeter.setAttribute('data-active', 'false');

    this.el.joinClose.addEventListener('click', () => this.closeJoin());
    this.el.joinCancel.addEventListener('click', () => {
      this.audio.uiBack();
      this.closeJoin();
    });
    this.el.joinForm.addEventListener('submit', (event) => this._onJoinSubmit(event));
    this.el.joinInput.addEventListener('input', () => this._sanitizeJoinInput());

    this.el.pauseResume.addEventListener('click', () => {
      this.audio.uiConfirm();
      this.bus.emit('ui:resume');
    });
    this.el.pauseExit.addEventListener('click', () => {
      this.audio.uiBack();
      this.bus.emit('ui:exit');
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (this._settingsOpen) {
        event.stopPropagation();
        this.closeSettings();
        this.audio.uiBack();
      } else if (!this.el.join.hidden) {
        event.stopPropagation();
        this.closeJoin();
        this.audio.uiBack();
      }
    });

    // Клик по затемнению закрывает служебные окна.
    for (const [screen, close] of [
      [this.el.settings, () => this.closeSettings()],
      [this.el.join, () => this.closeJoin()],
    ]) {
      screen.addEventListener('click', (event) => {
        if (event.target === screen) {
          close();
          this.audio.uiBack();
        }
      });
    }

    window.addEventListener('beforeunload', () => this.stopMicTest(false));
  }

  // ---------------------------------------------------------------------------
  // Настройки
  // ---------------------------------------------------------------------------

  _applySettingsToUI() {
    const volumePercent = Math.round(this.store.values.volume * 100);
    this.el.volume.value = String(volumePercent);
    this.el.volumeValue.textContent = String(volumePercent);
    this._setSliderFill(this.el.volume, volumePercent);
    this.el.volume.setAttribute('aria-valuetext', `${volumePercent} процентов`);

    const sensitivityValue = Math.round(this.store.values.sensitivity * 100);
    this.el.sensitivity.value = String(sensitivityValue);
    this.el.sensitivityValue.textContent = (this.store.values.sensitivity).toFixed(1);
    this._setSliderFill(
      this.el.sensitivity,
      ((sensitivityValue - 30) / (220 - 30)) * 100,
    );
    this.el.sensitivity.setAttribute('aria-valuetext', this.el.sensitivityValue.textContent);
  }

  _setSliderFill(slider, percent) {
    const fill = clamp(percent, 0, 100);
    slider.style.setProperty('--fill', `${fill}%`);
    if (slider.type === 'range') {
      // Firefox рисует заполнение через ::-moz-range-progress, WebKit — через фон.
    }
  }

  _onVolumeInput() {
    const value = Number(this.el.volume.value);
    this.el.volumeValue.textContent = String(value);
    this._setSliderFill(this.el.volume, value);
    this.el.volume.setAttribute('aria-valuetext', `${value} процентов`);
    this.store.save({ volume: value / 100 });
    this.audio.setVolume(value / 100);
    this.bus.emit('settings:volume', value / 100);
  }

  _onSensitivityInput() {
    const raw = Number(this.el.sensitivity.value);
    const sensitivity = raw / 100;
    this.el.sensitivityValue.textContent = sensitivity.toFixed(1);
    this._setSliderFill(this.el.sensitivity, ((raw - 30) / (220 - 30)) * 100);
    this.el.sensitivity.setAttribute('aria-valuetext', sensitivity.toFixed(1));
    this.store.save({ sensitivity });
    this.bus.emit('settings:sensitivity', sensitivity);
  }

  notifySettingsApplied() {
    if (!this.el.hud.hidden) {
      this.showToast('ПАРАМЕТРЫ ПРИМЕНЕНЫ', 'success', 2200);
    }
  }

  _resetSettings() {
    const values = this.store.reset();
    this._applySettingsToUI();
    this.audio.setVolume(values.volume);
    this.bus.emit('settings:sensitivity', values.sensitivity);
    this.audio.uiConfirm();
    this.showToast('НАСТРОЙКИ СБРОШЕНЫ К ЗАВОДСКИМ ЗНАЧЕНИЯМ', 'info');
  }

  openSettings(origin = 'menu') {
    if (this._settingsOpen) return;
    this._settingsOpen = true;
    this._settingsOrigin = origin;

    if (origin === 'menu') {
      this.el.menu.hidden = true;
    } else {
      this.el.pause.hidden = true;
    }

    this.el.settings.hidden = false;
    const shell = $('.modal-shell', this.el.settings);
    if (shell) shell.scrollTop = 0;
    this._applySettingsToUI();
    this._resetMicVisuals();
    window.setTimeout(() => this.el.settingsClose.focus({ preventScroll: true }), 0);
  }

  closeSettings() {
    if (!this._settingsOpen) return;
    this._settingsOpen = false;
    this.stopMicTest(false);
    this.el.settings.hidden = true;

    if (this._settingsOrigin === 'pause') {
      this.el.pause.hidden = false;
      this.notifySettingsApplied();
      window.setTimeout(() => this.el.pauseResume.focus({ preventScroll: true }), 0);
    } else {
      this.el.menu.hidden = false;
      window.setTimeout(() => this.el.settingsButton.focus({ preventScroll: true }), 0);
    }
    this._settingsOrigin = 'menu';
  }

  // ---------------------------------------------------------------------------
  // Микрофон
  // ---------------------------------------------------------------------------

  _resetMicVisuals() {
    this.el.micStatus.dataset.state = 'off';
    this.el.micStatus.textContent = 'НЕ ПОДКЛЮЧЁН';
    this.el.micButtonLabel.textContent = 'ЗАПРОСИТЬ ДОСТУП';
    this.el.micButton.disabled = false;
    this.el.micButton.setAttribute('aria-pressed', 'false');
    this.el.micError.hidden = true;
    this.el.micError.textContent = '';
    this.el.micDb.textContent = '−∞ дБ';
    this.el.micPeak.textContent = '0%';
    this.el.micMeter.dataset.active = 'false';
    this.el.micMeter.setAttribute('aria-valuenow', '0');
    this.el.micMeter.setAttribute('aria-valuetext', 'Микрофон не активен');
    this._setMeterLevel(0);
  }

  _setMicChip(state, text) {
    this.el.micStatus.dataset.state = state;
    this.el.micStatus.textContent = text;
  }

  _showMicError(message) {
    this.el.micError.textContent = message;
    this.el.micError.hidden = false;
    this.el.micError.classList.remove('is-shaking');
    void this.el.micError.offsetWidth;
    this.el.micError.classList.add('is-shaking');
  }

  async _toggleMic() {
    if (this._micBusy) return;

    if (this.audio.mic.active) {
      this.stopMicTest(true);
      return;
    }

    this._micBusy = true;
    this.el.micError.hidden = true;
    this.el.micButton.disabled = true;
    this.el.micButtonLabel.textContent = 'ЗАПРОС РАЗРЕШЕНИЯ...';
    this._setMicChip('requesting', 'ОЖИДАНИЕ ДОСТУПА');
    this.audio.init();

    try {
      await this.audio.enableMic();

      // Настройки могли закрыть, пока браузер показывал запрос.
      if (!this._settingsOpen) {
        this.audio.disableMic();
        return;
      }

      this.micStatusOk();
    } catch (error) {
      console.warn('[Mic] Не удалось включить микрофон', error);
      this.el.micMeter.dataset.active = 'false';
      this._stopMeterLoop();
      this._setMeterLevel(0);
      this._setMicChip('error', 'НЕТ ДОСТУПА');
      this.el.micButtonLabel.textContent = 'ПОВТОРИТЬ ЗАПРОС';
      const key = error && (error.name || error.code);
      this._showMicError(MIC_MESSAGES[key] || 'НЕ УДАЛОСЬ ПОЛУЧИТЬ ДОСТУП К МИКРОФОНУ. ПРОВЕРЬТЕ РАЗРЕШЕНИЯ БРАУЗЕРА.');
      this.audio.uiError();
    } finally {
      this._micBusy = false;
      this.el.micButton.disabled = false;
    }
  }

  micStatusOk() {
    if (!this.audio.mic.active) return;
    this.el.micError.hidden = true;
    this._setMicChip('active', 'МИКРОФОН АКТИВЕН');
    this.el.micButtonLabel.textContent = 'ОСТАНОВИТЬ ПРОВЕРКУ';
    this.el.micButton.setAttribute('aria-pressed', 'true');
    this.el.micMeter.dataset.active = 'true';
    this.store.save({ micTested: true });
    this.audio.uiConfirm();
    this._startMeterLoop();
  }

  stopMicTest(animate = false) {
    this.audio.disableMic();
    this._stopMeterLoop();
    this._resetMicVisuals();
    if (animate) this.audio.uiBack();
  }

  _startMeterLoop() {
    this._stopMeterLoop();
    this._micPeak = 0;
    this._micPeakAt = performance.now();
    this._meterCount = -1;
    this._peakIndex = -1;
    let last = performance.now();

    const tick = (now) => {
      if (!this.audio.mic.active || !this._settingsOpen) {
        this._micRaf = 0;
        return;
      }
      this._micRaf = window.requestAnimationFrame(tick);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;

      const { level, db } = this.audio.getMicLevel();
      this._setMeterLevel(level);
      this.el.micDb.textContent = formatDb(db);

      if (level >= this._micPeak) {
        this._micPeak = level;
        this._micPeakAt = now;
      } else if (now - this._micPeakAt > 700) {
        this._micPeak = Math.max(0, this._micPeak - dt * 0.42);
      }
      this.el.micPeak.textContent = `${Math.round(this._micPeak * 100)}%`;

      const percent = Math.round(level * 100);
      this.el.micMeter.setAttribute('aria-valuenow', String(percent));
      this.el.micMeter.setAttribute('aria-valuetext', `Уровень микрофона ${percent} процентов`);

      const peakIndex = this._micPeak > 0.02
        ? clamp(Math.round(this._micPeak * 27), 0, 27)
        : -1;
      if (peakIndex !== this._peakIndex) {
        if (this._peakIndex >= 0 && this._meterSegments[this._peakIndex]) {
          this._meterSegments[this._peakIndex].classList.remove('is-peak');
        }
        if (peakIndex >= 0) this._meterSegments[peakIndex].classList.add('is-peak');
        this._peakIndex = peakIndex;
      }
    };

    this._micRaf = window.requestAnimationFrame(tick);
  }

  _stopMeterLoop() {
    if (this._micRaf) {
      window.cancelAnimationFrame(this._micRaf);
      this._micRaf = 0;
    }
  }

  _setMeterLevel(level) {
    const count = level <= 0.005 ? 0 : Math.ceil(clamp(level, 0, 1) * this._meterSegments.length);
    if (count === this._meterCount) return;

    for (let i = 0; i < this._meterSegments.length; i += 1) {
      this._meterSegments[i].classList.toggle('is-on', i < count);
      if (i >= count) this._meterSegments[i].classList.remove('is-peak');
    }
    this._meterCount = count;
    this._peakIndex = -1;
  }

  // ---------------------------------------------------------------------------
  // Подключение
  // ---------------------------------------------------------------------------

  openJoin() {
    this.el.menu.hidden = true;
    this.el.join.hidden = false;
    this._joinToken += 1;
    this._joining = false;
    this.el.joinSubmit.disabled = false;
    this.el.joinSubmit.textContent = 'Войти в сеанс';
    this.el.joinInput.value = '';
    this.el.joinInput.removeAttribute('aria-invalid');
    this.el.joinError.hidden = true;
    window.setTimeout(() => this.el.joinInput.focus({ preventScroll: true }), 40);
  }

  closeJoin() {
    if (this.el.join.hidden) return;
    this._joinToken += 1;
    this._joining = false;
    this.el.join.hidden = true;
    this.el.menu.hidden = false;
    this.el.joinSubmit.disabled = false;
    this.el.joinSubmit.textContent = 'Войти в сеанс';
    this.el.joinError.hidden = true;
    this.el.joinInput.removeAttribute('aria-invalid');
    window.setTimeout(() => this.el.joinButton.focus({ preventScroll: true }), 0);
  }

  _sanitizeJoinInput() {
    const cleaned = this.el.joinInput.value
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 6);
    if (this.el.joinInput.value !== cleaned) this.el.joinInput.value = cleaned;
    if (!this.el.joinError.hidden) {
      this.el.joinError.hidden = true;
      this.el.joinInput.removeAttribute('aria-invalid');
    }
  }

  _showJoinError(message) {
    this.el.joinError.textContent = message;
    this.el.joinError.hidden = false;
    this.el.joinError.classList.remove('is-shaking');
    void this.el.joinError.offsetWidth;
    this.el.joinError.classList.add('is-shaking');
    this.el.joinInput.setAttribute('aria-invalid', 'true');
  }

  async _onJoinSubmit(event) {
    event.preventDefault();
    if (this._joining) return;

    const clean = this.network.sanitizeCode(this.el.joinInput.value);
    if (clean.length < 4) {
      this._showJoinError('КОД СЕАНСА ДОЛЖЕН СОДЕРЖАТЬ НЕ МЕНЕЕ 4 СИМВОЛОВ.');
      this.audio.uiError();
      this.el.joinInput.focus();
      return;
    }

    const token = this._joinToken;
    this._joining = true;
    this.el.joinSubmit.disabled = true;
    this.el.joinSubmit.textContent = 'УСТАНОВКА СВЯЗИ...';
    this.el.joinError.hidden = true;

    const result = await this.network.joinLobby(clean);

    if (token !== this._joinToken) return;
    this._joining = false;
    this.el.joinSubmit.disabled = false;
    this.el.joinSubmit.textContent = 'Войти в сеанс';

    if (result && result.ok) {
      this.el.join.hidden = true;
      this.el.menu.hidden = true;
      this.bus.emit('ui:sessionJoined', result);
      return;
    }

    this._showJoinError(
      result && result.reason === 'not-implemented'
        ? 'СЕТЕВОЙ МОДУЛЬ НЕ УСТАНОВЛЕН // ЧАСТЬ II. ДЛЯ ЛОКАЛЬНОГО СЕАНСА ИСПОЛЬЗУЙТЕ «СОЗДАТЬ ЛОББИ».'
        : 'НЕ УДАЛОСЬ ПОДКЛЮЧИТЬСЯ К СЕАНСУ. ПРОВЕРЬТЕ КОД И ПОВТОРИТЕ ПОПЫТКУ.',
    );
    this.audio.uiError();
  }

  // ---------------------------------------------------------------------------
  // Экраны и HUD
  // ---------------------------------------------------------------------------

  setMenuReady() {
    this.el.menu.classList.add('is-ready');
  }

  enterGame(lobbyCode) {
    this.el.menu.hidden = true;
    this.el.settings.hidden = true;
    this.el.join.hidden = true;
    this.el.pause.hidden = true;
    this.el.hud.hidden = false;
    this.el.hud.classList.remove('is-paused');
    this.el.hints.classList.remove('is-faded');
    this.setLobbyCode(lobbyCode);
    this._startHaunt();
    this.setStamina({ value: CONFIG.player.staminaMax, max: CONFIG.player.staminaMax, sprinting: false, exhausted: false });
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();

    window.clearTimeout(this._hintsTimer);
    this._hintsTimer = window.setTimeout(() => {
      this.el.hints.classList.add('is-faded');
    }, 9000);
  }

  showMenu() {
    this._stopHaunt();
    this.el.hud.hidden = true;
    this.el.pause.hidden = true;
    this.el.settings.hidden = true;
    this.el.join.hidden = true;
    this.el.menu.hidden = false;
    this._settingsOpen = false;
    this.stopMicTest(false);
    this.setLobbyCode(null);
    window.clearTimeout(this._hintsTimer);
    window.setTimeout(() => this.el.create.focus({ preventScroll: true }), 0);
  }

  showPause(options = {}) {
    const {
      title = 'Пауза',
      text = 'Двери остаются закрытыми. Поезд не остановился.',
    } = options;
    this.el.hud.classList.add('is-paused');
    this.el.pauseTitle.textContent = title;
    this.el.pauseText.textContent = text;
    this.el.pause.hidden = false;
    window.setTimeout(() => {
      if (!this.el.pause.hidden && !this._settingsOpen) {
        this.el.pauseResume.focus({ preventScroll: true });
      }
    }, 30);
  }

  hidePause() {
    this.el.pause.hidden = true;
    this.el.hud.classList.remove('is-paused');
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  setStamina(state) {
    if (!state) return;
    const value = clamp(Math.round(state.value), 0, state.max || 100);
    const ratio = value / (state.max || 100);

    this.el.staminaValue.textContent = String(value);
    this.el.staminaFill.style.transform = `scaleX(${ratio})`;
    this.el.staminaTrack.setAttribute('aria-valuenow', String(value));

    this.el.vitals.classList.toggle('is-low', value < 40 && value >= 18);
    this.el.vitals.classList.toggle('is-critical', value < 18 || Boolean(state.exhausted));
    this.el.vitals.classList.toggle('is-active', Boolean(state.sprinting));
    this.el.hud.classList.toggle('is-exhausted', Boolean(state.exhausted));

    if (state.exhausted) {
      this.el.staminaCaption.textContent = 'ВЫНОСЛИВОСТЬ ИСТОЩЕНА // ПЕРЕДОХНИТЕ';
    } else if (state.sprinting) {
      this.el.staminaCaption.textContent = 'БЕГ // РАСХОД ВЫНОСЛИВОСТИ';
    } else {
      this.el.staminaCaption.textContent = this._defaultStaminaCaption;
    }
  }

  setLobbyCode(code) {
    this._lobbyCodeText = code ? `06-${String(code).toUpperCase()}` : '—';
    if (this.el.hudLobbyCode) this.el.hudLobbyCode.textContent = this._lobbyCodeText;
    if (this.el.pauseLobbyCode) this.el.pauseLobbyCode.textContent = this._lobbyCodeText;
  }

  /** Редкий «сбой» HUD: на мгновение вместо кода сеанса появляется чужой текст. */
  _startHaunt() {
    window.clearTimeout(this._hauntTimer);
    const schedule = () => {
      this._hauntTimer = window.setTimeout(() => {
        if (this._lobbyCodeText && !this.el.hud.hidden && this.el.hudLobbyCode) {
          const phrases = ['ОН СМОТРИТ', 'ВАГОН 07', 'НЕ ОБОРАЧИВАЙСЯ', 'ВЫ НЕ ОДНИ'];
          this.el.hudLobbyCode.textContent = phrases[Math.floor(Math.random() * phrases.length)];
          this.el.hud.classList.add('is-haunting');
          window.setTimeout(() => {
            if (this.el.hudLobbyCode) {
              this.el.hudLobbyCode.textContent = this._lobbyCodeText || '—';
            }
            this.el.hud.classList.remove('is-haunting');
          }, 150);
        }
        schedule();
      }, randomRange(26000, 62000));
    };
    schedule();
  }

  _stopHaunt() {
    window.clearTimeout(this._hauntTimer);
    this._hauntTimer = 0;
    this.el.hud.classList.remove('is-haunting');
    if (this.el.hudLobbyCode) this.el.hudLobbyCode.textContent = this._lobbyCodeText || '—';
  }

  showToast(message, type = 'info', duration = 4200) {
    window.clearTimeout(this._toastTimer);
    window.clearTimeout(this._toastHideTimer);

    const toast = this.el.toast;
    toast.classList.remove('is-leaving');
    toast.dataset.type = type;
    toast.textContent = message;
    toast.hidden = false;

    if (duration > 0) {
      this._toastTimer = window.setTimeout(() => {
        toast.classList.add('is-leaving');
        this._toastHideTimer = window.setTimeout(() => {
          toast.hidden = true;
          toast.classList.remove('is-leaving');
        }, 320);
      }, duration);
    }
  }

  _startClock() {
    const render = () => {
      const hours = Math.floor(this._clockSeconds / 3600) % 24;
      const minutes = Math.floor((this._clockSeconds % 3600) / 60);
      const seconds = this._clockSeconds % 60;
      this.el.clock.textContent = `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
    };
    render();
    window.setInterval(() => {
      this._clockSeconds = (this._clockSeconds + 1) % 86400;
      render();
    }, 1000);
  }
}

// =============================================================================
// ИГРА
// =============================================================================

class Game {
  constructor() {
    this.bus = new EventBus();
    this.store = new SettingsStore();
    this.audio = new AudioManager({ volume: this.store.values.volume });
    this.network = new NetworkManager(this.bus);

    this.state = STATE.BOOT;
    this.session = null;
    this.elapsed = 0;
    this._dread = 0;
    this._dreadTarget = 0;
    this.reducedMotion = REDUCED_MOTION.matches;
    this.clock = new THREE.Clock();
    this._lockFallbackTimer = 0;
    this._menuEnteredAt = 0;
    this._raf = 0;
    this._tick = this._tick.bind(this);

    const canvas = document.getElementById('scene');
    const isCoarse = window.matchMedia('(pointer: coarse)').matches;

    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
      });
    } catch (error) {
      const wrapped = new Error('WEBGL_UNAVAILABLE');
      wrapped.cause = error;
      throw wrapped;
    }

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isCoarse ? 1.3 : 1.75));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.22;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Вагон статичен: карта теней пересчитывается один раз, а не каждый кадр.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x030504);
    this.scene.fog = new THREE.FogExp2(0x050807, 0.034);

    this.camera = new THREE.PerspectiveCamera(
      CONFIG.camera.fov,
      window.innerWidth / Math.max(1, window.innerHeight),
      CONFIG.camera.near,
      CONFIG.camera.far,
    );
    this.camera.rotation.order = 'YXZ';

    this.world = new TrainCar(this.scene, this.renderer, { reducedMotion: this.reducedMotion });

    this.player = new PlayerController({
      camera: this.camera,
      domElement: canvas,
      world: this.world,
      audio: this.audio,
      bus: this.bus,
      sensitivity: this.store.values.sensitivity,
    });

    this.ui = new UIManager({
      bus: this.bus,
      audio: this.audio,
      store: this.store,
      network: this.network,
    });

    this.network.setLocalStateProvider(() => this.player.getNetworkState());
    this.audio.setVolume(this.store.values.volume);
    this.audio.setScene('menu');

    this._bindEvents();
    this._setupMenuView();

    this.state = STATE.MENU;
    this.clock.start();
    this._raf = window.requestAnimationFrame(this._tick);

    // Показываем меню после первого кадра — так загрузочный экран
    // не «мигает» голым интерфейсом.
    window.requestAnimationFrame(() => {
      this.ui.setMenuReady();
      if (window.__MX_BOOT__) window.__MX_BOOT__.ready();
      window.dispatchEvent(new CustomEvent('midnight:ready'));
    });
  }

  // ---------------------------------------------------------------------------
  // События
  // ---------------------------------------------------------------------------

  _bindEvents() {
    this.bus.on('ui:createLobby', () => this.createLobby());
    this.bus.on('ui:resume', () => this.resumeSession());
    this.bus.on('ui:exit', () => this.exitToMenu());
    this.bus.on('settings:sensitivity', (value) => this.player.setSensitivity(value));

    // Усталость игрока притемняет салон — «дыхание» становится частью хоррора.
    this.bus.on('player:stamina', (state) => {
      if (!state) return;
      const ratio = state.value / (state.max || 100);
      const target = state.exhausted ? 1 : ratio < 0.42 ? (0.42 - ratio) / 0.42 : 0;
      this._dreadTarget = clamp(target, 0, 1);
    });
    this.bus.on('settings:volume', (value) => {
      if (this.state === STATE.MENU) this.audio.uiConfirm();
      else if (value > 0) this.audio.uiHover();
    });

    this.bus.on('player:lock', () => this._onPointerLock());
    this.bus.on('player:unlock', () => this._onPointerUnlock());

    document.addEventListener('pointerlockerror', () => this._onPointerLockError());
    this.renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());
    window.addEventListener('resize', () => this._resize());

    // Вкладка скрыта — ставим на паузу, чтобы игрок не вернулся в темноту.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === STATE.PLAYING) {
        this._enterPause();
      }
    });

    this.renderer.domElement.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.player.setEnabled(false);
      this.state = STATE.PAUSED;
      this.ui.showPause({
        title: 'Сигнал потерян',
        text: 'Видеосигнал прерван. Перезагрузите страницу, чтобы вернуться в вагон.',
      });
    });

    if (typeof REDUCED_MOTION.addEventListener === 'function') {
      REDUCED_MOTION.addEventListener('change', (event) => {
        this.reducedMotion = event.matches;
        this.world.reducedMotion = event.matches;
        this.player.reducedMotion = event.matches;
      });
    }
  }

  _resize() {
    const width = window.innerWidth;
    const height = Math.max(1, window.innerHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    const isCoarse = window.matchMedia('(pointer: coarse)').matches;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isCoarse ? 1.3 : 1.75));
    this.renderer.setSize(width, height, false);
  }

  // ---------------------------------------------------------------------------
  // Камера в меню
  // ---------------------------------------------------------------------------

  _setupMenuView() {
    this.camera.fov = CONFIG.camera.fov;
    this.camera.updateProjectionMatrix();
    this.camera.rotation.set(-0.025, 0, 0, 'YXZ');
    this.camera.position.set(0.16, 1.66, 14.2);
  }

  _updateMenuCamera(elapsed) {
    if (this.reducedMotion) {
      this.camera.position.set(0.16, 1.66, 14.15);
      this.camera.rotation.set(-0.02, 0, 0, 'YXZ');
      return;
    }
    const drift = 1;
    this.camera.position.set(
      0.16 + Math.sin(elapsed * 0.063) * 0.2 * drift,
      1.64 + Math.sin(elapsed * 0.43) * 0.008 * drift,
      14.15 + Math.sin(elapsed * 0.037) * 0.5 * drift,
    );
    const yaw = Math.sin(elapsed * 0.047) * 0.05 * drift;
    const pitch = -0.022 + Math.sin(elapsed * 0.113) * 0.008 * drift;
    this.camera.rotation.set(pitch, yaw, 0, 'YXZ');
  }

  // ---------------------------------------------------------------------------
  // Жизненный цикл сеанса
  // ---------------------------------------------------------------------------

  createLobby(options = {}) {
    if (this.state !== STATE.MENU) return;
    // Зажатая клавиша не должна повторно входить в сеанс после выхода
    // (но программный вход, например из автотеста, это правило не ловит).
    if (!options.force && performance.now() - this._menuEnteredAt < 700) return;
    if (!('requestPointerLock' in this.renderer.domElement)) {
      this.ui.showToast(
        'ДЛЯ УПРАВЛЕНИЯ НУЖНЫ КЛАВИАТУРА И МЫШЬ. ОТКРОЙТЕ ИГРУ НА КОМПЬЮТЕРЕ.',
        'warning',
        7000,
      );
    }

    this.audio.init();
    this.session = this.network.createLobby();
    this.state = STATE.DEPLOYING;

    this.player.reset();
    this.player.setEnabled(false);
    this.ui.enterGame(this.session.code);
    this.audio.setScene('game');
    this.clock.getDelta();

    this.ui.showToast(
      `ЛОКАЛЬНЫЙ СЕАНС 06-${this.session.code} // ЭКИПАЖ: 1 // ОЖИДАНИЕ СЕТИ`,
      'info',
      4600,
    );

    this._requestPointerLock(true);
  }

  _requestPointerLock(initial = false) {
    this._clearLockFallback();

    this._lockFallbackTimer = window.setTimeout(() => {
      if (this.state === STATE.DEPLOYING && !this.player.isLocked) {
        this._showEntryFallback();
      } else if (this.state === STATE.PAUSED && !this.player.isLocked && !initial) {
        this.ui.showToast(
          'УПРАВЛЕНИЕ НЕ ЗАХВАЧЕНО. ПОДОЖДИТЕ СЕКУНДУ И НАЖМИТЕ «ПРОДОЛЖИТЬ» СНОВА.',
          'warning',
          5000,
        );
      }
    }, 1400);

    try {
      this.player.lock();
    } catch (error) {
      console.warn('[Game] pointer lock недоступен', error);
      if (initial) this._showEntryFallback();
      else this.ui.showToast('НЕ УДАЛОСЬ ЗАХВАТИТЬ КУРСОР. ПОВТОРИТЕ ПОПЫТКУ.', 'error');
    }
  }

  _showEntryFallback() {
    if (this.state !== STATE.DEPLOYING && this.state !== STATE.PAUSED) return;
    this._clearLockFallback();
    this.state = STATE.PAUSED;
    this.player.setEnabled(false);
    this.audio.setScene('paused');
    this.ui.showPause({
      title: 'Вход в вагон',
      text: 'Браузер не отдал управление курсором. Нажмите «Продолжить», чтобы войти в салон.',
    });
  }

  _onPointerLock() {
    this._clearLockFallback();
    if (this.state !== STATE.DEPLOYING && this.state !== STATE.PAUSED) return;
    this.state = STATE.PLAYING;
    this.player.setEnabled(true);
    this.ui.hidePause();
    this.audio.setScene('game');
    this.audio.hitch();
    this.clock.getDelta();
    this.bus.emit('session:started', this.session);
  }

  _onPointerUnlock() {
    if (this.state !== STATE.PLAYING) return;
    this._enterPause();
  }

  _enterPause() {
    if (this.state !== STATE.PLAYING) return;
    this.state = STATE.PAUSED;
    this.player.setEnabled(false);
    this.audio.setScene('paused');
    this.ui.showPause();
    if (this.player.isLocked) this.player.unlock();
  }

  _onPointerLockError() {
    if (this.state === STATE.DEPLOYING) {
      this._showEntryFallback();
      return;
    }
    if (this.state === STATE.PAUSED) {
      this._clearLockFallback();
      this.ui.showToast(
        'НЕ УДАЛОСЬ ЗАХВАТИТЬ КУРСОР. ПОДОЖДИТЕ СЕКУНДУ И НАЖМИТЕ «ПРОДОЛЖИТЬ» СНОВА.',
        'warning',
        5200,
      );
    }
  }

  resumeSession() {
    if (this.state !== STATE.PAUSED) return;
    if (this.ui.isSettingsOpen) return;
    if (this.player.isLocked) {
      // Вкладка возвращалась из фона, курсор так и не освободился.
      this._onPointerLock();
      return;
    }
    this._requestPointerLock(false);
  }

  exitToMenu() {
    if (this.state === STATE.MENU) return;
    this._clearLockFallback();
    this._menuEnteredAt = performance.now();
    this.state = STATE.MENU;

    this.player.setEnabled(false);
    this.player.unlock();
    this.network.leave();
    this.session = null;

    this.audio.setScene('menu');
    this.ui.showMenu();
    this.player.reset();
    this._setupMenuView();
    this.clock.getDelta();
    this.bus.emit('session:ended');
  }

  _clearLockFallback() {
    if (this._lockFallbackTimer) {
      window.clearTimeout(this._lockFallbackTimer);
      this._lockFallbackTimer = 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Главный цикл
  // ---------------------------------------------------------------------------

  _tick() {
    this._raf = window.requestAnimationFrame(this._tick);
    // Пока курсор захвачен, мышь и клавиатура приходят событиями, но
    // requestAnimationFrame может быть сильно разрежен (фоновая вкладка,
    // энергосбережение). Досчитываем время, чтобы управление не «залипало».
    const rawDelta = this.clock.getDelta();
    const dt = this.state === STATE.PLAYING
      ? Math.min(rawDelta, 0.5)
      : Math.min(rawDelta, 0.05);
    this.elapsed += dt;

    if (this.state === STATE.PLAYING) {
      this.player.update(dt, this.elapsed);
    } else if (this.state === STATE.MENU) {
      this._updateMenuCamera(this.elapsed);
    }

    // Плавно подводим «атмосферную» усталость к цели.
    this._dread = damp(this._dread ?? 0, this._dreadTarget ?? 0, 2.6, dt);
    this.world.setDread(this._dread);

    this.world.update(dt, this.elapsed);
    this.network.update(dt);
    this.audio.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    window.cancelAnimationFrame(this._raf);
    this._clearLockFallback();
    this.audio.disableMic();
  }
}

// =============================================================================
// СТАРТ
// =============================================================================

function startGame() {
  let game = null;
  try {
    game = new Game();
  } catch (error) {
    console.error('[Полуночный экспресс] Ошибка запуска', error);
    if (window.__MX_BOOT__) {
      window.__MX_BOOT__.fail(
        error && error.message === 'WEBGL_UNAVAILABLE'
          ? 'БРАУЗЕР НЕ ПОДДЕРЖИВАЕТ WEBGL. ОБНОВИТЕ БРАУЗЕР ИЛИ ВКЛЮЧИТЕ АППАРАТНОЕ УСКОРЕНИЕ.'
          : 'НЕ УДАЛОСЬ ЗАПУСТИТЬ 3D-СЦЕНУ. ПЕРЕЗАГРУЗИТЕ СТРАНИЦУ И ПОПРОБУЙТЕ СНОВА.',
      );
    }
    return;
  }

  // Публичный интерфейс для отладки и для модуля Части II.
  window.MidnightExpress = {
    version: CONFIG.version,
    part: CONFIG.part,
    config: CONFIG,
    THREE,
    game,
    bus: game.bus,
    audio: game.audio,
    network: game.network,
    ui: game.ui,
    modules: {
      EventBus,
      SettingsStore,
      AudioManager,
      TextureFactory,
      TrainCar,
      PlayerController,
      NetworkManager,
      UIManager,
    },
  };

  window.addEventListener('pagehide', () => game.dispose(), { once: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startGame, { once: true });
} else {
  startGame();
}

  