/* ============================================================================
   ПОЛУНОЧНЫЙ ЭКСПРЕСС — Часть III
   ----------------------------------------------------------------------------
   Единый ES-модуль игры (ванильный JS + Three.js r161 + PeerJS 1.5).
   index.html содержит CSS и DOM; этот файл — вся логика:
     CONFIG            — настраиваемые константы
     EventBus          — слабая связь между системами
     SettingsStore     — сохранение настроек (localStorage)
     AudioManager      — эмбиент, шаги, UI-звуки, микрофон (ref-counted)
     TextureFactory    — процедурные текстуры (без внешних ассетов)
     TrainCar          — геометрия, свет и атмосфера вагона
     PlayerController  — PointerLockControls, движение, выносливость, коллизии
     NetworkManager    — PeerJS: лобби, роутинг данных, heartbeat, реконнект
     RemotePlayers     — капсулы удалённых игроков, nametag, интерполяция
     VoiceChat         — WebRTC-голос, позиционное аудио, «рация»
     PassengerNPC      — сидящий пассажир, позы и «кровавые» материалы
     VoiceWatcher      — распознавание ru-RU и детектор крика
     DemonDirector     — пробуждение, погоня, захват и Game Over
     UIManager         — экраны, HUD, настройки, микрофон
     Game              — сборка и жизненный цикл
   ========================================================================== */

import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// =============================================================================
// КОНФИГУРАЦИЯ
// =============================================================================

const CONFIG = {
  version: '0.3.0',
  part: 3,
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
    lobbyCodeLength: 5,
    tickRate: 20,
    maxPlayers: 6,
    prefix: 'nv06-',
    heartbeatInterval: 1.0,
    peerTimeout: 20.0,
    joinTimeout: 14000,
    reconnectDelay: 1600,
    // Публичный PeerJS Cloud. Для продакшена укажите свой peerjs-server.
    signaling: {
      host: '0.peerjs.com',
      port: 443,
      secure: true,
      path: '/',
      key: 'peerjs',
    },
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:global.stun.twilio.com:3478' },
      // Для игроков за symmetric NAT добавьте сюда TURN (см. README).
    ],
    // ---------------------------------------------------------------------
    // Вариант А: сигнализация через публичные relay-сети (Trystero).
    // 0.peerjs.com у части провайдеров недоступен, а эти узлы живут на 443
    // и потому проходят там, где «сигнальный сервер» PeerJS молчит.
    // Всё остальное (позиции, голос) по-прежнему идёт напрямую по WebRTC.
    // ---------------------------------------------------------------------
    relay: {
      appId: 'nv06-polunochny-express',
      password: 'nv06-platform-9',
      // Сколько ждать открытия сокета при проверке канала.
      probeTimeout: 3000,
      // Как часто повторять «я здесь» до установки прямого соединения.
      announceInterval: 1200,
      // Таймаут ожидания хоста в режиме relay (голос/рукопожатие дольше).
      joinTimeout: 18000,
      redundancy: 2,
      order: ['mqtt', 'torrent', 'nostr'],
      transports: {
        mqtt: [
          'wss://broker.emqx.io:8084/mqtt',
          'wss://broker.hivemq.com:8884/mqtt',
          'wss://test.mosquitto.org:8081/mqtt',
          'wss://mqtt.eclipseprojects.io/mqtt',
          'wss://public:public@public.cloud.shiftr.io',
        ],
        torrent: [
          'wss://tracker.openwebtorrent.com',
          'wss://tracker.webtorrent.dev',
          'wss://tracker.files.fm:7073/announce',
          'wss://tracker.btorrent.xyz',
        ],
        nostr: [
          'wss://relay.damus.io',
          'wss://nos.lol',
          'wss://relay.nostr.band',
        ],
      },
    },
  },
  voice: {
    refDistance: 2.2,
    rolloff: 1.15,
    maxDistance: 16,
    fadeStart: 9.5,
    fadeEnd: 14,
    nametagDistance: 22,
    radioGain: 0.9,
  },
  // ---------------------------------------------------------------------
  // Часть III. «Пассажир», который едет в вагоне.
  // ---------------------------------------------------------------------
  npc: {
    // Сиденье у левой стены: скамья z=3.2…6.7, сиденье на высоте ~0.47 м.
    seat: { x: -1.44, y: 0.47, z: 5.55 },
    lookDistance: 4.4,
    grabDistance: 3.0,
    // Волочение тяжёлого тела: доля обычной скорости.
    dragScale: 0.34,
    dragOffset: 0.92,
    dragLerp: 9.5,
    // Сколько секунд тело остаётся обмякшим после захвата.
    stunTime: 6.0,
  },
  demon: {
    huntSpeed: 4.15,
    wakeDelay: 1.3,
    killDistance: 0.92,
    aisleX: 0.05,
    bodyRadius: 0.3,
    standTime: 0.9,
    stateInterval: 0.05,
  },
  speech: {
    lang: 'ru-RU',
    keywords: ['демон', 'бежим', 'шокер', 'шесть пальцев'],
    screamLevel: 0.66,
    screamHold: 0.14,
    screamCooldown: 9000,
    restartDelay: 700,
  },
};

const STATE = Object.freeze({
  BOOT: 'boot',
  MENU: 'menu',
  LOBBY: 'lobby',
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
  voiceEnabled: true,
  voiceMode: 'open', // 'open' | 'ptt'
  callsign: '',
  // Канал сигнализации: 'auto' перебирает relay-сети и в крайнем случае
  // откатывается на PeerJS Cloud. 'peerjs' — принудительно старый путь.
  netTransport: 'auto', // 'auto' | 'mqtt' | 'torrent' | 'nostr' | 'peerjs'
  relayCustom: '',
});

const NET_TRANSPORTS = ['auto', 'mqtt', 'torrent', 'nostr', 'peerjs'];

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
      if (typeof parsed.voiceEnabled === 'boolean') {
        this.values.voiceEnabled = parsed.voiceEnabled;
      }
      if (parsed.voiceMode === 'open' || parsed.voiceMode === 'ptt') {
        this.values.voiceMode = parsed.voiceMode;
      }
      if (typeof parsed.callsign === 'string') {
        this.values.callsign = parsed.callsign.slice(0, 18);
      }
      if (NET_TRANSPORTS.includes(parsed.netTransport)) {
        this.values.netTransport = parsed.netTransport;
      }
      if (typeof parsed.relayCustom === 'string') {
        this.values.relayCustom = parsed.relayCustom.slice(0, 160);
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
    // Микрофон один на всю вкладку. Потребители (проверка в настройках и
    // голосовой чат) берут его по ссылке и возвращают, когда закончат.
    this.mic = {
      active: false,
      requesting: false,
      requestPromise: null,
      stream: null,
      source: null,
      analyser: null,
      data: null,
      level: 0,
      db: -Infinity,
      refs: new Set(),
      permission: 'unknown',
      error: null,
    };

    this._onVisibility = this._onVisibility.bind(this);
    document.addEventListener('visibilitychange', this._onVisibility);
    window.addEventListener('pagehide', () => this.hardStopMic());
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

  /**
   * Визг «пассажира», когда тот сбрасывает личину.
   * Ни одного сэмпла: расстроенная пила + шумовой всплеск + низкий удар.
   */
  screech() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const out = this.ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.exponentialRampToValueAtTime(0.42, now + 0.04);
    out.gain.exponentialRampToValueAtTime(0.0001, now + 1.75);
    out.connect(this.sfx);

    // Кластер расстроенных осцилляторов: «человеческий» визг из гармоник.
    const partials = [1170, 1480, 1760, 2340];
    partials.forEach((frequency, index) => {
      const osc = this.ctx.createOscillator();
      osc.type = index % 2 === 0 ? 'sawtooth' : 'square';
      osc.frequency.setValueAtTime(frequency, now);
      osc.frequency.exponentialRampToValueAtTime(
        frequency * (0.38 + index * 0.05),
        now + 1.3,
      );
      const vibrato = this.ctx.createOscillator();
      vibrato.type = 'sine';
      vibrato.frequency.value = 17 + index * 3.5;
      const vibratoGain = this.ctx.createGain();
      vibratoGain.gain.value = 26 + index * 8;
      vibrato.connect(vibratoGain);
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.12 / Math.sqrt(index + 1), now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.55);
      vibratoGain.connect(osc.frequency);
      osc.connect(gain);
      gain.connect(out);
      vibrato.start(now);
      osc.start(now);
      vibrato.stop(now + 1.6);
      osc.stop(now + 1.6);
    });

    // Шумовой выдох с падающей полосой — «дыхание» твари.
    if (this._whiteNoise) {
      const noise = this.ctx.createBufferSource();
      noise.buffer = this._whiteNoise;
      const band = this.ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.Q.value = 1.7;
      band.frequency.setValueAtTime(2800, now);
      band.frequency.exponentialRampToValueAtTime(360, now + 1.15);
      const noiseGain = this.ctx.createGain();
      noiseGain.gain.setValueAtTime(0.22, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.35);
      noise.connect(band);
      band.connect(noiseGain);
      noiseGain.connect(out);
      noise.start(now);
      noise.stop(now + 1.4);
    }

    // Низкий удар: слышно телом, а не ушами.
    const sub = this.ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(78, now);
    sub.frequency.exponentialRampToValueAtTime(34, now + 0.9);
    const subGain = this.ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, now);
    subGain.gain.exponentialRampToValueAtTime(0.3, now + 0.03);
    subGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.15);
    sub.connect(subGain);
    subGain.connect(this.sfx);
    sub.start(now);
    sub.stop(now + 1.2);
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

  /** Запрашивает поток микрофона и возвращает его. Общий для всех систем. */
  async _openMic() {
    if (this.mic.stream) return this.mic.stream;
    if (this.mic.requestPromise) return this.mic.requestPromise;

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      const error = new Error('MEDIA_UNSUPPORTED');
      error.code = 'MEDIA_UNSUPPORTED';
      this.mic.permission = 'unsupported';
      this.mic.error = error;
      throw error;
    }

    this.mic.requesting = true;
    this.mic.requestPromise = (async () => {
      this.init();
      let stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
          video: false,
        });

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
        this.mic.permission = 'granted';
        this.mic.error = null;

        stream.getAudioTracks().forEach((track) => {
          track.addEventListener('ended', () => {
            if (this.mic.stream === stream) this._handleMicEnded();
          });
        });

        return stream;
      } catch (error) {
        if (stream) stream.getTracks().forEach((track) => track.stop());
        this.mic.active = false;
        this.mic.error = error;
        const name = error && (error.name || error.code);
        this.mic.permission = name === 'NotAllowedError' || name === 'SecurityError'
          ? 'denied'
          : 'unavailable';
        throw error;
      } finally {
        this.mic.requesting = false;
        this.mic.requestPromise = null;
      }
    })();

    return this.mic.requestPromise;
  }

  async acquireMic(reason) {
    this.mic.refs.add(reason);
    try {
      const stream = await this._openMic();
      return { ok: true, stream };
    } catch (error) {
      this.mic.refs.delete(reason);
      throw error;
    }
  }

  releaseMic(reason) {
    this.mic.refs.delete(reason);
    if (this.mic.refs.size === 0) this.closeMic();
  }

  /** Полная остановка захвата. Вызывается, когда микрофон больше никому не нужен. */
  closeMic() {
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
    if (this.mic.stream) {
      this.mic.stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (error) {
          /* ignore */
        }
      });
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

  hardStopMic() {
    this.mic.refs.clear();
    this.closeMic();
  }

  _handleMicEnded() {
    const refs = Array.from(this.mic.refs);
    this.closeMic();
    if (typeof this.onMicLost === 'function') this.onMicLost(refs);
  }

  /** Совместимость с Частью I: проверка микрофона в настройках. */
  async enableMic() {
    await this.acquireMic('settings');
    return { ok: true };
  }

  disableMic() {
    this.releaseMic('settings');
  }

  get micActive() {
    return this.mic.active;
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
    // Аварийное отключение света (Часть III).
    this.blackout = 0;
    this.blackoutTarget = 0;

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
    this.lampSideMaterial = lampSideMaterial;

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

  /** Гасит основной свет и оставляет только красную аварийную лампу. */
  setBlackout(on) {
    this.blackoutTarget = on ? 1 : 0;
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
    this.blackout = damp(this.blackout, this.blackoutTarget, 3.4, dt);
    const power = 1 - clamp(this.blackout, 0, 1);

    if (this.centralLight) {
      this.centralLight.intensity = this.centralBaseIntensity
        * this._flickerValue * (1 - dread * 0.52) * power;
    }
    if (this.lampMainMaterial) {
      this.lampMainMaterial.emissiveIntensity = (0.75 + 1.35 * this._flickerValue)
        * (1 - dread * 0.55) * power;
    }
    if (this.lampSideMaterial) {
      // Плафоны боковых ламп тоже гаснут: иначе в темноте остаются
      // светящиеся прямоугольники, и «отключение света» не читается.
      this.lampSideMaterial.emissiveIntensity = 0.55 * power;
    }
    if (this.sideLights) {
      for (const light of this.sideLights) {
        light.intensity = 7.4 * (1 - dread * 0.6) * power;
      }
    }
    if (this.fillLights) {
      for (const light of this.fillLights) {
        light.intensity = 2.4 * power * (1 - dread * 0.55);
      }
    }
    if (this.hemiLight) {
      this.hemiLight.intensity = 0.46 * (0.1 + 0.9 * power);
    }
    if (this.exitLight) this.exitLight.intensity = 1.5 * (0.15 + 0.85 * power);
    if (this.aisleFill) this.aisleFill.intensity = 1.4 * power;
    if (this.emergencyLight) {
      // Красная лампа тамбура — единственный источник после отключения.
      // Дыхание заложено в саму формулу, без второго слагаемого ниже:
      // иначе пульсация «съедает» лампу почти до нуля.
      this.emergencyLight.intensity = 3.2 * power
        + this.blackout * (1.9 + Math.sin(elapsed * 8.5) * 0.35);
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
    // Волочение тела и прочие эффекты масштабируют скорость, не трогая настройки.
    this.speedScale = 1;
    // E — взаимодействие с пассажиром: нажатие и удержание.
    this.interactHeld = false;
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
    this.speedScale = 1;
    this._releaseInteract();
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
      this._releaseInteract();
    }
  }

  _releaseInteract() {
    if (!this.interactHeld) return;
    this.interactHeld = false;
    this.bus.emit('player:interact', { held: false });
  }

  setSensitivity(value) {
    this.sensitivity = clamp(Number(value) || 1, 0.3, 2.2);
    this.controls.pointerSpeed = this.sensitivity;
  }

  /** 1 — обычная скорость, 0.34 — тянешь тяжёлое тело. */
  setSpeedScale(value) {
    this.speedScale = clamp(Number(value) || 1, 0.15, 1);
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
    if (event.code === 'KeyE') {
      event.preventDefault();
      if (!event.repeat && !this.interactHeld) {
        this.interactHeld = true;
        this.bus.emit('player:interact', { held: true });
      }
      return;
    }
    if (!this._moveCodes.has(event.code)) return;
    event.preventDefault();
    this.keys.add(event.code);
  }

  _onKeyUp(event) {
    if (event.code === 'KeyE') {
      this._releaseInteract();
      return;
    }
    this.keys.delete(event.code);
  }

  _onBlur() {
    this.keys.clear();
    this._releaseInteract();
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
    const wantsSprint = shiftHeld && moving && !this.exhausted && this.stamina > 0
      && this.speedScale > 0.7;

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
    const speed = (wantsSprint ? CONFIG.player.sprintSpeed : CONFIG.player.walkSpeed)
      * this.speedScale;
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
// СЕТЬ — RELAY-СИГНАЛИЗАЦИЯ (Trystero: MQTT / WebTorrent / Nostr)
// -----------------------------------------------------------------------------
// Публичный PeerJS Cloud (0.peerjs.com) у части провайдеров недоступен.
// Эти стратегии ищут друг друга через открытые relay-узлы на 443 (MQTT/WSS,
// WebTorrent-трекеры, Nostr-реле), а сам игровой трафик и голос по-прежнему
// идут напрямую между браузерами по WebRTC.
// =============================================================================

const RELAY_MODULE = { loaded: null, loading: null };

function loadRelayModule() {
  if (RELAY_MODULE.loaded) return Promise.resolve(RELAY_MODULE.loaded);
  if (!RELAY_MODULE.loading) {
    RELAY_MODULE.loading = import('./vendor/trystero-relays.js')
      .then((mod) => {
        if (typeof mod.joinMqtt !== 'function' || typeof mod.selfId !== 'string') {
          throw new Error('RELAY_BUNDLE_INVALID');
        }
        RELAY_MODULE.loaded = mod;
        return mod;
      })
      .catch((error) => {
        RELAY_MODULE.loading = null;
        throw error;
      });
  }
  return RELAY_MODULE.loading;
}

/**
 * Проверяет, открывается ли WebSocket до relay-узла. Это единственный
 * надёжный способ узнать, что канал не режет провайдер: сам joinRoom
 * возвращается сразу и молча ждёт узлы в фоне.
 */
function probeSocket(url, options = {}) {
  const timeout = options.timeout || CONFIG.network.relay.probeTimeout;
  const useMqttProtocol = options.mqtt !== false && /\/mqtt(\?|$)/i.test(url);
  return new Promise((resolve) => {
    const started = performance.now();
    let socket = null;
    let settled = false;
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (socket) {
        try {
          socket.close();
        } catch (error) {
          /* ignore */
        }
      }
      resolve({ url, ok, ms: Math.round(performance.now() - started), detail });
    };
    const timer = window.setTimeout(() => finish(false, 'timeout'), timeout);
    try {
      // Для MQTT-брокеров нужен подпротокол mqtt, иначе часть узлов
      // закрывает соединение ещё на рукопожатии.
      socket = useMqttProtocol ? new WebSocket(url, ['mqtt']) : new WebSocket(url);
      socket.onopen = () => finish(true, 'open');
      socket.onerror = () => finish(false, 'error');
      socket.onclose = (event) => finish(false, event.code ? `close ${event.code}` : 'close');
    } catch (error) {
      finish(false, 'blocked');
    }
  });
}

/** Отдельная проверка PeerJS Cloud: XHR к /peerjs/id, как у самого клиента. */
function probePeerJs(timeout = 3500) {
  return new Promise((resolve) => {
    const started = performance.now();
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeout);
    fetch(`https://0.peerjs.com/peerjs/id?ts=${Date.now()}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then((response) => {
        window.clearTimeout(timer);
        resolve({
          ok: Boolean(response.ok),
          ms: Math.round(performance.now() - started),
          detail: response.ok ? 'open' : `http ${response.status}`,
        });
      })
      .catch((error) => {
        window.clearTimeout(timer);
        resolve({
          ok: false,
          ms: Math.round(performance.now() - started),
          detail: error && error.name === 'AbortError' ? 'timeout' : 'blocked',
        });
      });
  });
}

/**
 * Мини-адаптер PeerJS DataConnection поверх Trystero. Благодаря ему весь
 * протокол лобби (welcome/roster/state/ping) остаётся прежним и не зависит
 * от транспорта.
 */
class RelaySocket {
  constructor({ peer, metadata, send }) {
    this.peer = peer;
    this.metadata = metadata || {};
    this.open = true;
    this.destroyed = false;
    this._handlers = new Map();
    this._send = send;
    this._closeTimer = 0;
  }

  on(event, handler) {
    if (typeof handler !== 'function') return this;
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(handler);
    return this;
  }

  off(event, handler) {
    const set = this._handlers.get(event);
    if (set) set.delete(handler);
    return this;
  }

  emit(event, ...args) {
    const set = this._handlers.get(event);
    if (!set) return;
    for (const handler of Array.from(set)) {
      try {
        handler(...args);
      } catch (error) {
        console.warn('[Relay] handler error', error);
      }
    }
  }

  send(payload) {
    if (!this.open) throw new Error('RELAY_SOCKET_CLOSED');
    this._send(payload, this.peer);
    return true;
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.destroyed = true;
    // _dropConnection закрывает сокет из обработчика close; выносим событие
    // из текущего стека, чтобы не уйти в рекурсию.
    window.clearTimeout(this._closeTimer);
    this._closeTimer = window.setTimeout(() => this.emit('close'), 0);
  }
}

// =============================================================================
// СЕТЬ — PeerJS
// =============================================================================

const PEER_SIGNALING = () => {
  const override = typeof window !== 'undefined' ? window.__MX_PEER_SIGNALING__ : null;
  return { ...CONFIG.network.signaling, ...(override || {}) };
};

class NetworkManager {
  constructor(bus) {
    this.bus = bus;
    this.peer = null;
    this.session = null;
    this.connected = false;

    // Транспорт текущей сессии: 'peerjs' (старый путь) или 'relay'
    // (Trystero через публичные relay-сети).
    this.transport = 'peerjs';
    this.room = null;
    this._relay = null;
    this._relaySelfId = null;
    this._relayAction = null;
    this._relayAnnounceTimer = 0;
    this._relaySockets = new Map();
    this._relayMeta = new Map();
    this._relayPlan = null;
    this._relayRole = null;
    this._relayVoiceStreams = new Set();
    this._relayJoinWaiter = null;
    this._netPref = { mode: 'auto', custom: '' };
    this._lastProbe = null;

    this.roster = new Map();        // id -> { id, name, host, slot, ping, joinedAt }
    this.connections = new Map();   // host: clientId -> DataConnection
    this.remoteStates = new Map();  // id -> { s, at }
    this._hostConn = null;
    this._hostId = null;

    this._status = 'idle';
    this._localStateProvider = null;
    this._nameProvider = null;
    this._voice = null;

    this._tickAccumulator = 0;
    this._lastSeen = new Map();
    this._hostLastSeen = 0;
    this._rtt = null;

    this._pendingJoin = null;
    this._joinTimer = 0;
    this._reconnectTimer = 0;
    this._destroyTimer = 0;
    this._heartbeatTimer = 0;
    this._sessionFailed = false;
    this._destroying = false;

    this._codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

    this._onOnline = () => {
      if (this.peer && this.peer.disconnected && !this._destroying) {
        try {
          this.peer.reconnect();
        } catch (error) {
          /* ignore */
        }
      }
    };
    window.addEventListener('online', this._onOnline);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this._onOnline();
    });
  }

  // ---------------------------------------------------------------------------
  // Служебное
  // ---------------------------------------------------------------------------

  get isHost() {
    return Boolean(this.session && this.session.host);
  }

  get isActive() {
    if (!this.session) return false;
    if (this.transport === 'relay') return Boolean(this.room && this._relaySelfId);
    return Boolean(this.peer && !this.peer.destroyed);
  }

  get usesRelay() {
    return this.transport === 'relay';
  }

  get selfId() {
    if (this.transport === 'relay') return this._relaySelfId;
    return this.peer && !this.peer.destroyed ? this.peer.id : null;
  }

  get status() {
    return this._status;
  }

  get rtt() {
    return this._rtt;
  }

  setVoiceChat(voice) {
    this._voice = voice;
  }

  setNameProvider(provider) {
    this._nameProvider = provider;
  }

  setLocalStateProvider(provider) {
    this._localStateProvider = provider;
  }

  /** Настройки канала из «Настроек»: режим и необязательный свой relay. */
  setNetworkPreference(pref = {}) {
    this._netPref = {
      mode: NET_TRANSPORTS.includes(pref.mode) ? pref.mode : 'auto',
      custom: String(pref.custom || '').trim().slice(0, 160),
    };
  }

  get networkPreference() {
    return { ...this._netPref };
  }

  _displayName() {
    let name = '';
    try {
      name = this._nameProvider ? this._nameProvider() : '';
    } catch (error) {
      name = '';
    }
    return this._sanitizeName(name);
  }

  _sanitizeName(raw) {
    const cleaned = String(raw || '')
      .toUpperCase()
      .replace(/[<>{}[\]\\/|`~^]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 14);
    return cleaned;
  }

  _setStatus(status, detail = null) {
    this._status = status;
    this.bus.emit('network:status', { status, detail });
  }

  _emitRoster() {
    const players = this._rosterArray();
    if (this.session) this.session.peers = players;
    this.bus.emit('network:roster', {
      players,
      selfId: this.selfId,
      hostId: this._hostId || (this.isHost ? this.selfId : null),
      maxPlayers: CONFIG.network.maxPlayers,
      isHost: this.isHost,
    });
  }

  _rosterArray() {
    return Array.from(this.roster.values()).sort((a, b) => a.slot - b.slot);
  }

  _generateCode() {
    const cryptoApi = window.crypto || window.msCrypto;
    let code = '';
    if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
      const values = new Uint32Array(CONFIG.network.lobbyCodeLength);
      cryptoApi.getRandomValues(values);
      for (const value of values) {
        code += this._codeAlphabet[value % this._codeAlphabet.length];
      }
    } else {
      for (let i = 0; i < CONFIG.network.lobbyCodeLength; i += 1) {
        code += this._codeAlphabet[Math.floor(Math.random() * this._codeAlphabet.length)];
      }
    }
    return code;
  }

  _fullPeerId(code) {
    return `${CONFIG.network.prefix}${code}`;
  }

  sanitizeCode(raw) {
    let clean = String(raw || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    // Полный peer id (nv06-XXXXX) тоже принимаем: его видно в отладке.
    if (clean.startsWith('NV06') && clean.length > CONFIG.network.lobbyCodeLength) {
      clean = clean.slice(4);
    }
    return clean.slice(0, CONFIG.network.lobbyCodeLength);
  }

  _nextSlot() {
    const used = new Set(Array.from(this.roster.values()).map((player) => player.slot));
    for (let slot = 1; slot <= CONFIG.network.maxPlayers; slot += 1) {
      if (!used.has(slot)) return slot;
    }
    return CONFIG.network.maxPlayers;
  }

  _nextGuestName() {
    const names = new Set(Array.from(this.roster.values()).map((player) => player.name));
    for (let index = 1; index <= CONFIG.network.maxPlayers; index += 1) {
      const name = `ПАССАЖИР ${index}`;
      if (!names.has(name)) return name;
    }
    return 'ПАССАЖИР';
  }

  _peerOptions() {
    const signaling = PEER_SIGNALING();
    return {
      debug: 0,
      host: signaling.host,
      port: signaling.port,
      secure: Boolean(signaling.secure),
      path: signaling.path || '/',
      key: signaling.key || 'peerjs',
      pingInterval: 5000,
      config: {
        iceServers: CONFIG.network.iceServers,
        sdpSemantics: 'unified-plan',
        iceCandidatePoolSize: 4,
      },
    };
  }

  _newPeer(id) {
    if (typeof window.Peer !== 'function') {
      const error = new Error('PEER_LIB_UNAVAILABLE');
      error.type = 'peer-lib';
      throw error;
    }
    return id ? new window.Peer(id, this._peerOptions()) : new window.Peer(this._peerOptions());
  }

  _waitForPeerOpen(peer, timeout = 15000) {
    return new Promise((resolve, reject) => {
      if (peer.destroyed) {
        reject(Object.assign(new Error('PEER_DESTROYED'), { type: 'destroyed' }));
        return;
      }
      if (peer.open) {
        resolve(peer);
        return;
      }
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        peer.off('open', onOpen);
        peer.off('error', onError);
        peer.off('close', onClose);
        fn(value);
      };
      const onOpen = () => finish(resolve, peer);
      const onError = (error) => finish(reject, error);
      const onClose = () => finish(reject, Object.assign(new Error('PEER_CLOSED'), { type: 'closed' }));
      const timer = window.setTimeout(() => {
        finish(reject, Object.assign(new Error('PEER_TIMEOUT'), { type: 'timeout' }));
      }, timeout);
      peer.on('open', onOpen);
      peer.on('error', onError);
      peer.on('close', onClose);
    });
  }

  _attachCommon(peer) {
    peer.on('error', (error) => this._onPeerError(error));
    peer.on('disconnected', () => {
      if (this._destroying || !this.session) return;
      this._setStatus('reconnecting', 'СИГНАЛЬНЫЙ СЕРВЕР НЕДОСТУПЕН');
      this._scheduleReconnect();
    });
    peer.on('call', (call) => {
      if (this._voice) this._voice.acceptIncomingCall(call);
      else {
        try {
          call.close();
        } catch (error) {
          /* ignore */
        }
      }
    });
    peer.on('close', () => {
      if (this._destroying || !this.session) return;
      this._failSession('network');
    });
  }

  /**
   * Пульс живёт на setInterval, а не на requestAnimationFrame: в фоновой
   * вкладке кадры замирают, и без этого хост выкидывал бы игрока через 9 с.
   */
  _startHeartbeat() {
    window.clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = window.setInterval(
      () => this._heartbeat(),
      Math.max(400, CONFIG.network.heartbeatInterval * 1000),
    );
  }

  _stopHeartbeat() {
    window.clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = 0;
  }

  _heartbeat() {
    if (!this.session || !this.isActive) return;
    const now = performance.now();
    const timeout = CONFIG.network.peerTimeout * 1000;

    // Пульс дублирует и координаты: даже если кадры вкладки замерли,
    // собеседники видят, что игрок на месте и жив.
    const local = this._localStateProvider ? this._localStateProvider() : null;

    if (this.isHost) {
      for (const [id, conn] of Array.from(this.connections.entries())) {
        const seen = this._lastSeen.get(id) || 0;
        if (now - seen > timeout) {
          this._dropConnection(id, 'timeout');
          continue;
        }
        if (local) this._send(conn, { t: 'state', id: this.selfId, s: local });
        this._send(conn, { t: 'ping', ts: now });
      }
    } else if (this._hostConn) {
      if (now - this._hostLastSeen > timeout) {
        this._failSession('timeout');
        return;
      }
      if (local) this._send(this._hostConn, { t: 'state', s: local });
      this._send(this._hostConn, { t: 'ping', ts: now });
    }
  }

  _scheduleReconnect() {
    window.clearTimeout(this._reconnectTimer);
    this._reconnectTimer = window.setTimeout(() => {
      if (!this.peer || this._destroying || !this.session) return;
      if (!this.peer.disconnected || this.peer.destroyed) return;
      try {
        this.peer.reconnect();
      } catch (error) {
        this._scheduleReconnect();
      }
    }, CONFIG.network.reconnectDelay);
  }

  // ---------------------------------------------------------------------------
  // Выбор канала сигнализации
  // ---------------------------------------------------------------------------

  _customRelayUrl() {
    const raw = String(this._netPref.custom || '').trim();
    if (!/^wss?:\/\/\S+$/i.test(raw)) return '';
    return raw;
  }

  _relayBuckets(cfg, strategies, custom) {
    const buckets = [];
    if (custom) {
      // Свой узел проверяется первым: тип определяем по адресу.
      const strategy = /\/mqtt(\?|$)/i.test(custom) ? 'mqtt' : 'torrent';
      buckets.push({ strategy, urls: [custom], custom: true });
    }
    for (const strategy of strategies) {
      const urls = (cfg.transports[strategy] || []).filter((url) => url !== custom);
      if (urls.length) buckets.push({ strategy, urls });
    }
    return buckets;
  }

  _probeBucket(bucket) {
    const mqtt = bucket.strategy === 'mqtt';
    return Promise.all(bucket.urls.map((url) => probeSocket(url, { mqtt })));
  }

  async probeAll() {
    const cfg = CONFIG.network.relay;
    const custom = this._customRelayUrl();
    const mode = this._netPref.mode;
    const strategies = mode === 'auto' || mode === 'peerjs' ? cfg.order.slice() : [mode];
    const peerjsProbe = probePeerJs();
    const buckets = await Promise.all(
      this._relayBuckets(cfg, strategies, custom).map(async (bucket) => {
        const results = await this._probeBucket(bucket);
        return { ...bucket, results };
      }),
    );
    const peerjs = await peerjsProbe;
    const round = {
      at: Date.now(),
      mode: this._netPref.mode,
      buckets,
      results: buckets.flatMap((bucket) => bucket.results),
      peerjs,
    };
    this._lastProbe = round;
    this.bus.emit('network:probe', round);
    return round;
  }

  /**
   * Возвращает { strategy, urls } либо null, если ни один канал не отвечает.
   * 'auto' перебирает relay-сети и в последнюю очередь пробует PeerJS.
   */
  async _preparePlan() {
    const cfg = CONFIG.network.relay;
    const mode = this._netPref.mode;

    if (mode === 'peerjs') {
      this._lastProbe = { at: Date.now(), mode, buckets: [], results: [], peerjs: null };
      return { strategy: 'peerjs', mode, urls: [] };
    }

    const custom = this._customRelayUrl();
    const strategies = mode === 'auto' ? cfg.order.slice() : [mode];
    // Проверяем каналы по очереди и останавливаемся на первом живом:
    // обычно это занимает меньше секунды вместо ожидания всех реле.
    const buckets = [];
    let chosen = null;
    const names = { mqtt: 'MQTT', torrent: 'WEBTORRENT', nostr: 'NOSTR' };
    for (const bucket of this._relayBuckets(cfg, strategies, custom)) {
      // Пользователь видит, какой канал проверяется прямо сейчас.
      this._setStatus('signaling', `ПРОВЕРКА КАНАЛА ${names[bucket.strategy] || bucket.strategy}...`);
      const limit = Math.min(bucket.urls.length, 3);
      const partial = { strategy: bucket.strategy, urls: bucket.urls.slice(0, limit) };
      const results = await this._probeBucket(partial);
      const alive = results.filter((result) => result.ok);
      buckets.push({ ...bucket, results, alive });
      if (alive.length) {
        chosen = {
          strategy: bucket.strategy,
          mode,
          urls: alive
            .map((result) => result.url)
            .slice(0, Math.max(1, cfg.redundancy)),
        };
        break;
      }
    }

    const peerjs = mode === 'auto' && !chosen ? await probePeerJs() : null;
    const round = {
      at: Date.now(),
      mode,
      buckets,
      results: buckets.flatMap((bucket) => bucket.results),
      peerjs,
    };
    this._lastProbe = round;
    this.bus.emit('network:probe', round);

    if (chosen) return { ...chosen, round };

    // Реле не ответили: в авто-режиме остаётся старый PeerJS Cloud.
    if (mode === 'auto' && peerjs && peerjs.ok) {
      return { strategy: 'peerjs', mode, urls: [], round };
    }
    return null;
  }

  async hostLobby(options = {}) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      const offline = { reason: 'offline', message: 'НЕТ ПОДКЛЮЧЕНИЯ К ИНТЕРНЕТУ. ПРОВЕРЬТЕ СЕТЬ И ПОВТОРИТЕ.' };
      this.bus.emit('network:error', offline);
      return { ok: false, ...offline };
    }

    const token = (this._hostToken || 0) + 1;
    this._hostToken = token;
    this._setStatus('signaling', 'ПОИСК КАНАЛА СВЯЗИ...');

    let plan = null;
    try {
      plan = await this._preparePlan();
    } catch (error) {
      console.warn('[Net] Не удалось проверить каналы', error);
      plan = null;
    }

    if (token !== this._hostToken) {
      return { ok: false, reason: 'cancelled', message: 'СЕАНС ОТМЕНЁН.' };
    }
    if (!plan) {
      this._setStatus('error');
      const message = 'НЕ УДАЛОСЬ ОТКРЫТЬ КАНАЛ СВЯЗИ. ОТКРОЙТЕ «НАСТРОЙКИ» → «ПРОВЕРИТЬ СВЯЗЬ» И ВЫБЕРИТЕ ДРУГОЙ КАНАЛ.';
      this.bus.emit('network:error', { reason: 'network', message });
      return { ok: false, reason: 'network', message };
    }
    if (plan.strategy === 'peerjs') return this._hostWithPeerJs(options);
    return this._hostWithRelay(options, plan);
  }

  async joinLobby(code) {
    const clean = this.sanitizeCode(code);
    const length = CONFIG.network.lobbyCodeLength;

    if (clean.length !== length) {
      return {
        ok: false,
        reason: 'invalid-code',
        message: `КОД ЛОББИ СОСТОИТ ИЗ ${length} СИМВОЛОВ.`,
      };
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      const offline = { reason: 'offline', message: 'НЕТ ПОДКЛЮЧЕНИЯ К ИНТЕРНЕТУ. ПРОВЕРЬТЕ СЕТЬ И ПОВТОРИТЕ.' };
      this.bus.emit('network:error', offline);
      return { ok: false, ...offline };
    }

    const token = (this._hostToken || 0) + 1;
    this._hostToken = token;
    this._setStatus('signaling', 'ПОИСК КАНАЛА СВЯЗИ...');

    let plan = null;
    try {
      plan = await this._preparePlan();
    } catch (error) {
      console.warn('[Net] Не удалось проверить каналы', error);
      plan = null;
    }

    if (token !== this._hostToken) {
      return { ok: false, reason: 'cancelled', message: 'ПОДКЛЮЧЕНИЕ ОТМЕНЕНО.' };
    }
    if (!plan) {
      this._setStatus('error');
      const message = 'НЕ УДАЛОСЬ ОТКРЫТЬ КАНАЛ СВЯЗИ. ОТКРОЙТЕ «НАСТРОЙКИ» → «ПРОВЕРИТЬ СВЯЗЬ» И ВЫБЕРИТЕ ДРУГОЙ КАНАЛ.';
      this.bus.emit('network:error', { reason: 'network', message });
      return { ok: false, reason: 'network', message };
    }
    if (plan.strategy === 'peerjs') return this._joinWithPeerJs(clean);
    return this._joinWithRelay(clean, plan);
  }

  // ---------------------------------------------------------------------------
  // Relay-транспорт (Trystero)
  // ---------------------------------------------------------------------------

  _relaySend(payload, target) {
    if (!this._relayAction) return false;
    try {
      const promise = target
        ? this._relayAction.send(payload, { target })
        : this._relayAction.send(payload);
      if (promise && typeof promise.catch === 'function') promise.catch(() => {});
      return true;
    } catch (error) {
      return false;
    }
  }

  _startRelayAnnounce(role) {
    window.clearInterval(this._relayAnnounceTimer);
    const announce = () => {
      if (!this.room || this._destroying) return;
      this._relaySend({
        t: 'net',
        role,
        code: this.session ? this.session.code : '',
        name: this._displayName(),
        v: CONFIG.version,
      });
    };
    announce();
    this._relayAnnounceTimer = window.setInterval(
      announce,
      Math.max(400, CONFIG.network.relay.announceInterval),
    );
  }

  async _openRelayRoom(code, role, plan) {
    let mod = null;
    try {
      mod = await loadRelayModule();
    } catch (error) {
      throw Object.assign(new Error('RELAY_LIB_UNAVAILABLE'), { type: 'relay-lib' });
    }
    const cfg = CONFIG.network.relay;
    const joiners = { mqtt: mod.joinMqtt, torrent: mod.joinTorrent, nostr: mod.joinNostr };
    const join = joiners[plan.strategy];
    if (typeof join !== 'function') {
      throw Object.assign(new Error('RELAY_STRATEGY_UNAVAILABLE'), { type: 'relay' });
    }

    const relays = plan.urls && plan.urls.length ? plan.urls.slice() : (cfg.transports[plan.strategy] || []).slice(0, 2);
    this.transport = 'relay';
    this._relayPlan = plan;
    this._relaySelfId = mod.selfId;
    this._relay = { plan, module: mod, relays };
    this.peer = { id: mod.selfId, destroyed: false };

    const room = join(
      {
        appId: cfg.appId,
        password: cfg.password,
        relayConfig: { urls: relays, redundancy: cfg.redundancy },
        rtcConfig: { iceServers: CONFIG.network.iceServers },
      },
      `${CONFIG.network.prefix}${code}`,
      {
        onJoinError: (error) => {
          console.warn('[Relay] Ошибка входа в комнату', error);
          if (this._relayJoinWaiter) {
            const waiter = this._relayJoinWaiter;
            this._relayJoinWaiter = null;
            waiter.reject({
              type: 'network',
              reason: 'network',
              message: 'НЕ УДАЛОСЬ ЗАКРЕПИТЬСЯ НА RELAY-УЗЛЕ. ПРОВЕРЬТЕ КАНАЛ СВЯЗИ.',
            });
          }
        },
      },
    );

    this.room = room;
    this._relay = { plan, module: mod, relays, room };
    this._relayAction = room.makeAction('mx');
    this._relayAction.onMessage = (data, context) => {
      this._onRelayMessage(data, context && context.peerId);
    };

    room.onPeerJoin = (id) => this._onRelayPeerJoin(id);
    room.onPeerLeave = (id) => this._onRelayPeerLeave(id);
    room.onPeerStream = (stream, id) => this._onRelayStream(id, stream);

    this._relayRole = role;
    this._startRelayAnnounce(role);
    return { room, selfId: mod.selfId, relays };
  }

  _ensureRelaySocket(id, accept) {
    if (!this.room || !id || id === this._relaySelfId) return null;
    let conn = this._relaySockets.get(id);
    if (conn && !conn.open) {
      // После таймаута или разрыва сокет закрыт: даём паре новый шанс.
      this._relaySockets.delete(id);
      conn = null;
    }
    if (conn) {
      if (accept && !conn._accepted && conn.open) {
        conn._accepted = true;
        this._acceptConnection(conn);
      }
      return conn.open ? conn : null;
    }
    const meta = this._relayMeta.get(id) || {};
    conn = new RelaySocket({
      peer: id,
      metadata: { name: meta.name || '' },
      send: (payload, target) => this._relaySend(payload, target),
    });
    this._relaySockets.set(id, conn);
    if (accept) {
      conn._accepted = true;
      this._acceptConnection(conn);
    }
    return conn;
  }

  _onRelayPeerJoin(id) {
    if (this._destroying || !this.session) return;
    // Trystero не хранит локальные потоки для будущих соединений: новому
    // пиру микрофон нужно отдать заново, иначе он останется без голоса.
    for (const stream of this._relayVoiceStreams) {
      try {
        const pending = this.room.addStream(stream, { target: id });
        if (Array.isArray(pending)) pending.forEach((item) => item && item.catch && item.catch(() => {}));
      } catch (error) {
        /* ignore */
      }
    }
    if (this.isHost) this._ensureRelaySocket(id, true);
  }

  _onRelayPeerLeave(id) {
    const conn = this._relaySockets.get(id);
    this._relaySockets.delete(id);
    this._relayMeta.delete(id);
    if (conn) {
      conn.open = false;
      conn.destroyed = true;
    }
    this._dropConnection(id, 'close');
    if (!this.isHost && (id === this._hostId || id === (this._hostConn && this._hostConn.peer))) {
      this._failSession('host-left');
    }
  }

  _onRelayMessage(data, fromId) {
    if (!data || typeof data !== 'object' || !fromId) return;
    if (data.t === 'net') {
      this._relayMeta.set(fromId, { name: data.name || '', role: data.role || 'guest' });
      if (this.isHost) {
        if (data.role === 'guest') this._ensureRelaySocket(fromId, true);
        return;
      }
      if (data.role === 'host' && this.session && data.code === this.session.code) {
        this._onRelayHost(fromId);
      }
      return;
    }
    const conn = this._relaySockets.get(fromId)
      || (this.isHost ? this._ensureRelaySocket(fromId, true) : null);
    if (conn && conn.open) conn.emit('data', data);
  }

  _onRelayHost(hostId) {
    if (!this.session || this.isHost || this._hostConn) return;
    this._hostId = hostId;
    const conn = this._ensureRelaySocket(hostId, false);
    if (!conn) return;
    this._hostConn = conn;
    this._hostLastSeen = performance.now();
    this._setStatus('connecting');
    const waiter = this._relayJoinWaiter;
    if (!waiter) return;
    this._awaitWelcome(conn, CONFIG.network.relay.joinTimeout).then(
      (welcome) => waiter.resolve(welcome),
      (error) => waiter.reject(error),
    );
  }

  _onRelayStream(id, stream) {
    if (!stream || !this._voice) return;
    this._voice.attachRemoteStream(id, stream);
  }

  publishVoiceStream(stream) {
    if (!stream || this.transport !== 'relay' || !this.room) return;
    if (this._relayVoiceStreams.has(stream)) return;
    this._relayVoiceStreams.add(stream);
    try {
      const pending = this.room.addStream(stream);
      if (Array.isArray(pending)) pending.forEach((item) => item && item.catch && item.catch(() => {}));
    } catch (error) {
      console.warn('[Relay] Не удалось добавить микрофон', error);
    }
  }

  unpublishVoiceStream(stream) {
    if (!stream || !this._relayVoiceStreams.has(stream)) return;
    this._relayVoiceStreams.delete(stream);
    if (!this.room) return;
    try {
      this.room.removeStream(stream);
    } catch (error) {
      /* ignore */
    }
  }

  _leaveRelayRoom() {
    window.clearInterval(this._relayAnnounceTimer);
    this._relayAnnounceTimer = 0;
    const room = this.room;
    this.room = null;
    this._relay = null;
    this._relayAction = null;
    this._relaySelfId = null;
    this._relayPlan = null;
    this._relayRole = null;
    this._relayJoinWaiter = null;
    this._relayVoiceStreams.clear();
    for (const conn of this._relaySockets.values()) {
      conn.open = false;
      conn.destroyed = true;
    }
    this._relaySockets.clear();
    this._relayMeta.clear();
    if (room) {
      try {
        Promise.resolve(room.leave()).catch(() => {});
      } catch (error) {
        /* ignore */
      }
    }
  }

  async _hostWithRelay(options, plan) {
    this.leave({ silent: true });
    this._destroying = false;
    this._sessionFailed = false;

    const length = CONFIG.network.lobbyCodeLength;
    const code = options && options.code ? this.sanitizeCode(options.code) : this._generateCode();
    if (code.length !== length) {
      return {
        ok: false,
        reason: 'invalid-code',
        message: `КОД ЛОББИ СОСТОИТ ИЗ ${length} СИМВОЛОВ.`,
      };
    }

    this.session = {
      code,
      host: true,
      mode: 'online',
      transport: 'relay',
      strategy: plan.strategy,
      createdAt: Date.now(),
      maxPlayers: CONFIG.network.maxPlayers,
      peers: [],
    };
    this._setStatus('signaling');
    this.bus.emit('network:session', this.session);

    try {
      const opened = await this._openRelayRoom(code, 'host', plan);
      if (!this.session) {
        this._leaveRelayRoom();
        return { ok: false, reason: 'cancelled', message: 'СЕАНС ОТМЕНЁН.' };
      }

      const hostName = this._displayName() || 'ПАССАЖИР 1';
      this.roster.clear();
      this.roster.set(opened.selfId, {
        id: opened.selfId,
        name: hostName,
        host: true,
        slot: 1,
        ping: 0,
        joinedAt: Date.now(),
      });

      this.connected = true;
      this._startHeartbeat();
      this._setStatus('hosting', `КАНАЛ ${plan.strategy.toUpperCase()}`);
      this.bus.emit('network:lobbyReady', {
        session: this.session,
        code,
        transport: 'relay',
        strategy: plan.strategy,
        relays: opened.relays,
      });
      this._emitRoster();
      return {
        ok: true,
        session: this.session,
        code,
        transport: 'relay',
        strategy: plan.strategy,
        relay: opened.relays[0] || '',
      };
    } catch (error) {
      this._leaveRelayRoom();
      this.peer = null;
      this.session = null;
      this.connected = false;
      this.transport = 'peerjs';
      this._setStatus('error');
      const mapped = this._mapError(error, 'host');
      this.bus.emit('network:error', mapped);
      return { ok: false, reason: mapped.reason, message: mapped.message };
    }
  }

  async _joinWithRelay(code, plan) {
    this.leave({ silent: true });
    this._destroying = false;
    this._sessionFailed = false;

    this.session = {
      code,
      host: false,
      mode: 'online',
      transport: 'relay',
      strategy: plan.strategy,
      createdAt: Date.now(),
      maxPlayers: CONFIG.network.maxPlayers,
      peers: [],
    };
    this._setStatus('signaling');
    this.bus.emit('network:session', this.session);

    try {
      // Ждём хоста ещё до входа в комнату: его объявление может прийти
      // в тот же тик, что и подписка на relay.
      const welcomePromise = new Promise((resolve, reject) => {
        let timer = 0;
        const done = (fn, value) => {
          window.clearTimeout(timer);
          if (this._relayJoinWaiter && this._relayJoinWaiter.resolve === resolve) {
            this._relayJoinWaiter = null;
          }
          fn(value);
        };
        this._relayJoinWaiter = {
          resolve: (value) => done(resolve, value),
          reject: (error) => done(reject, error),
        };
        timer = window.setTimeout(() => {
          done(reject, {
            type: 'not-found',
            reason: 'not-found',
            message: 'ЛОББИ НЕ НАЙДЕНО: ХОСТ НЕ В СЕТИ ИЛИ КОД НЕВЕРНЫЙ.',
          });
        }, CONFIG.network.relay.joinTimeout + 1500);
      });

      const opened = await this._openRelayRoom(code, 'guest', plan);
      const welcome = await welcomePromise;

      if (!this.session) {
        this._leaveRelayRoom();
        return { ok: false, reason: 'cancelled', message: 'ПОДКЛЮЧЕНИЕ ОТМЕНЕНО.' };
      }

      this._hostId = welcome.hostId || (this._hostConn && this._hostConn.peer);
      this.roster.clear();
      if (Array.isArray(welcome.players)) {
        for (const player of welcome.players) {
          if (player && player.id) this.roster.set(player.id, player);
        }
      }
      if (!this.roster.has(opened.selfId)) {
        this.roster.set(opened.selfId, {
          id: opened.selfId,
          name: this._displayName() || 'ПАССАЖИР',
          host: false,
          slot: this.roster.size + 1,
          ping: null,
          joinedAt: Date.now(),
        });
      }

      this.session.code = welcome.code || code;
      this.connected = true;
      this._hostLastSeen = performance.now();
      this._startHeartbeat();
      this._setStatus('connected');
      this._emitRoster();
      this.bus.emit('network:joined', { session: this.session, code: this.session.code });
      return {
        ok: true,
        session: this.session,
        code: this.session.code,
        transport: 'relay',
        strategy: plan.strategy,
      };
    } catch (error) {
      this._leaveRelayRoom();
      this.peer = null;
      this._hostConn = null;
      this.session = null;
      this.connected = false;
      this.transport = 'peerjs';
      this._setStatus('error');
      const mapped = this._mapError(error, 'join');
      this.bus.emit('network:error', mapped);
      return { ok: false, reason: mapped.reason, message: mapped.message };
    }
  }

  // ---------------------------------------------------------------------------
  // Создание лобби (PeerJS — резервный путь)
  // ---------------------------------------------------------------------------

  async _hostWithPeerJs(options = {}) {
    this.leave({ silent: true });
    this._destroying = false;
    this._sessionFailed = false;

    this.session = {
      code: null,
      host: true,
      mode: 'online',
      createdAt: Date.now(),
      maxPlayers: CONFIG.network.maxPlayers,
      peers: [],
    };
    this._setStatus('signaling');
    this.bus.emit('network:session', this.session);

    let lastError = null;
    const attempts = 5;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const code = attempt === 0 && options.code ? this.sanitizeCode(options.code) : this._generateCode();
      let peer = null;

      try {
        peer = this._newPeer(this._fullPeerId(code));
        await this._waitForPeerOpen(peer);

        if (!this.session) {
          try {
            peer.destroy();
          } catch (error) {
            /* ignore */
          }
          return { ok: false, reason: 'cancelled', message: 'СЕАНС ОТМЕНЁН.' };
        }

        this.peer = peer;
        this._hostId = peer.id;
        this.session.code = code;

        const hostName = this._displayName() || 'ПАССАЖИР 1';
        this.roster.clear();
        this.roster.set(peer.id, {
          id: peer.id,
          name: hostName,
          host: true,
          slot: 1,
          ping: 0,
          joinedAt: Date.now(),
        });

        this._attachCommon(peer);
        peer.on('connection', (conn) => this._acceptConnection(conn));

        this.connected = true;
        this._startHeartbeat();
        this._setStatus('hosting');
        this.bus.emit('network:lobbyReady', { session: this.session, code });
        this._emitRoster();
        return { ok: true, session: this.session, code };
      } catch (error) {
        lastError = error;
        if (peer) {
          try {
            peer.destroy();
          } catch (destroyError) {
            /* ignore */
          }
        }
        const unavailable = error && (error.type === 'unavailable-id' || error.type === 'invalid-id');
        if (!unavailable) break;
      }
    }

    this.session = null;
    this.connected = false;
    this._setStatus('error');
    const mapped = this._mapError(lastError, 'host');
    this.bus.emit('network:error', mapped);
    return { ok: false, reason: mapped.reason, message: mapped.message };
  }

  _acceptConnection(conn) {
    if (!this.isHost || !this.session) {
      try {
        conn.close();
      } catch (error) {
        /* ignore */
      }
      return;
    }

    const id = conn.peer;
    const existing = this.connections.get(id);
    if (existing && existing !== conn) {
      try {
        existing.close();
      } catch (error) {
        /* ignore */
      }
    }

    const handleOpen = () => {
      conn.off('open', handleOpen);

      if (this.connections.size >= CONFIG.network.maxPlayers - 1) {
        try {
          conn.send({ t: 'reject', reason: 'full', message: 'ВАГОН ЗАПОЛНЕН: 6 ПАССАЖИРОВ.' });
        } catch (error) {
          /* ignore */
        }
        window.setTimeout(() => {
          try {
            conn.close();
          } catch (error) {
            /* ignore */
          }
        }, 260);
        return;
      }

      const metadata = conn.metadata || {};
      let name = this._sanitizeName(metadata.name);
      if (!name) name = this._nextGuestName();
      if (Array.from(this.roster.values()).some((player) => player.name === name && player.id !== id)) {
        name = `${name.slice(0, 11)} ${this._nextSlot()}`;
      }

      const player = {
        id,
        name,
        host: false,
        slot: this._nextSlot(),
        ping: null,
        joinedAt: Date.now(),
      };

      this.connections.set(id, conn);
      this.roster.set(id, player);
      this._lastSeen.set(id, performance.now());
      this._setupConnection(conn);

      this._send(conn, {
        t: 'welcome',
        v: CONFIG.version,
        code: this.session.code,
        selfId: id,
        hostId: this.selfId,
        players: this._rosterArray(),
        maxPlayers: CONFIG.network.maxPlayers,
      });

      this._broadcastRoster();
      this._emitRoster();
      this.bus.emit('network:peerJoined', player);
    };

    conn.on('open', handleOpen);
    conn.on('error', () => this._dropConnection(id, 'error'));
    if (conn.open) handleOpen();
  }

  _setupConnection(conn) {
    conn.on('data', (data) => this._onData(conn, data));
    conn.on('close', () => this._dropConnection(conn.peer, 'close'));
    conn.on('error', () => this._dropConnection(conn.peer, 'error'));
  }

  _send(conn, payload) {
    if (!conn || !conn.open) return false;
    try {
      conn.send(payload);
      return true;
    } catch (error) {
      return false;
    }
  }

  _broadcast(payload, exceptId = null) {
    for (const [id, conn] of this.connections) {
      if (id === exceptId) continue;
      this._send(conn, payload);
    }
  }

  _broadcastRoster() {
    if (!this.isHost) return;
    this._broadcast({ t: 'roster', players: this._rosterArray(), hostId: this.selfId });
  }

  /**
   * Часть III: события «пассажира». Хост рассылает всем, гость — только хосту.
   * Виды: wake (проснулся), state (позиция), kill (кого достал).
   */
  sendDemon(payload, targetId = null) {
    if (!this.isActive || !payload) return false;
    if (this.isHost) {
      if (targetId) {
        const conn = this.connections.get(targetId);
        return conn ? this._send(conn, { t: 'demon', ...payload }) : false;
      }
      this._broadcast({ t: 'demon', ...payload });
      return true;
    }
    return this._hostConn ? this._send(this._hostConn, { t: 'demon', ...payload }) : false;
  }

  _onData(conn, data) {
    if (!data || typeof data !== 'object' || typeof data.t !== 'string') return;
    const fromId = conn.peer;
    this._lastSeen.set(fromId, performance.now());
    if (!this.isHost) this._hostLastSeen = performance.now();

    if (this.isHost) this._onHostData(conn, data, fromId);
    else this._onClientData(conn, data, fromId);
  }

  _onHostData(conn, data, fromId) {
    switch (data.t) {
      case 'state': {
        if (!data.s || typeof data.s !== 'object') return;
        this.remoteStates.set(fromId, { s: data.s, at: performance.now() });
        this._broadcast({ t: 'state', id: fromId, s: data.s }, fromId);
        break;
      }
      case 'ping': {
        this._send(conn, { t: 'pong', ts: data.ts });
        break;
      }
      case 'pong': {
        this._updateRtt(performance.now() - data.ts, fromId);
        break;
      }
      case 'hello': {
        // Клиент может уточнить позывной после подключения.
        const player = this.roster.get(fromId);
        const name = this._sanitizeName(data.name);
        if (player && name && name !== player.name) {
          player.name = name;
          this._broadcastRoster();
          this._emitRoster();
        }
        // Welcome мог уйти раньше, чем у гостя открылся канал: повторяем.
        this._send(conn, {
          t: 'welcome',
          v: CONFIG.version,
          code: this.session ? this.session.code : '',
          selfId: fromId,
          hostId: this.selfId,
          players: this._rosterArray(),
          maxPlayers: CONFIG.network.maxPlayers,
        });
        break;
      }
      case 'bye': {
        this._send(conn, { t: 'ack' });
        this._dropConnection(fromId, 'bye');
        break;
      }
      case 'demon': {
        this.bus.emit('network:demon', { ...data, from: fromId });
        break;
      }
      default:
        break;
    }
  }

  _onClientData(conn, data, fromId) {
    switch (data.t) {
      case 'welcome': {
        if (this._pendingJoin) this._pendingJoin.resolve(data);
        break;
      }
      case 'roster': {
        if (Array.isArray(data.players)) {
          this.roster.clear();
          for (const player of data.players) {
            if (!player || !player.id) continue;
            this.roster.set(player.id, player);
          }
          if (data.hostId) this._hostId = data.hostId;
          this._emitRoster();
        }
        break;
      }
      case 'state': {
        if (!data.id || !data.s) return;
        this.remoteStates.set(data.id, { s: data.s, at: performance.now() });
        break;
      }
      case 'ping': {
        this._send(conn, { t: 'pong', ts: data.ts });
        break;
      }
      case 'pong': {
        this._updateRtt(performance.now() - data.ts, this._hostId);
        break;
      }
      case 'reject': {
        if (this._pendingJoin) {
          this._pendingJoin.reject({
            type: 'reject',
            reason: data.reason || 'rejected',
            message: data.message || 'ХОСТ ОТКЛОНИЛ ПОДКЛЮЧЕНИЕ.',
          });
        }
        break;
      }
      case 'close': {
        this._failSession(data.reason || 'host-left');
        break;
      }
      case 'demon': {
        this.bus.emit('network:demon', { ...data, from: fromId });
        break;
      }
      default:
        break;
    }
  }

  _updateRtt(rtt, peerId) {
    if (!Number.isFinite(rtt)) return;
    this._rtt = Math.round(rtt);
    if (this.isHost && peerId) {
      const player = this.roster.get(peerId);
      if (player) player.ping = this._rtt;
    }
    this.bus.emit('network:latency', { rtt: this._rtt, id: peerId || null });
  }

  _dropConnection(id, reason) {
    const conn = this.connections.get(id);
    if (conn) {
      try {
        conn.close();
      } catch (error) {
        /* ignore */
      }
    }
    this.connections.delete(id);
    this._lastSeen.delete(id);
    const player = this.roster.get(id);
    if (player) {
      this.roster.delete(id);
      this.remoteStates.delete(id);
      if (this._voice) this._voice.removePeer(id);
      if (this.isHost) {
        this._broadcastRoster();
        this._emitRoster();
        this.bus.emit('network:peerLeft', { player, reason });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Подключение к лобби
  // ---------------------------------------------------------------------------

  async _joinWithPeerJs(code) {
    const clean = this.sanitizeCode(code);
    const length = CONFIG.network.lobbyCodeLength;

    if (clean.length !== length) {
      return {
        ok: false,
        reason: 'invalid-code',
        message: `КОД ЛОББИ СОСТОИТ ИЗ ${length} СИМВОЛОВ.`,
      };
    }

    this.leave({ silent: true });
    this._destroying = false;
    this._sessionFailed = false;

    this.session = {
      code: clean,
      host: false,
      mode: 'online',
      createdAt: Date.now(),
      maxPlayers: CONFIG.network.maxPlayers,
      peers: [],
    };
    this._setStatus('signaling');
    this.bus.emit('network:session', this.session);

    let peer = null;
    try {
      peer = this._newPeer();
      await this._waitForPeerOpen(peer);
      this.peer = peer;
      this._attachCommon(peer);

      const conn = peer.connect(this._fullPeerId(clean), {
        reliable: true,
        metadata: { name: this._displayName() },
      });
      this._hostConn = conn;

      const welcome = await this._awaitWelcome(conn);
      this._hostId = welcome.hostId || conn.peer;
      this.roster.clear();
      if (Array.isArray(welcome.players)) {
        for (const player of welcome.players) {
          if (player && player.id) this.roster.set(player.id, player);
        }
      }
      if (!this.roster.has(peer.id)) {
        this.roster.set(peer.id, {
          id: peer.id,
          name: this._displayName() || 'ПАССАЖИР',
          host: false,
          slot: this.roster.size + 1,
          ping: null,
          joinedAt: Date.now(),
        });
      }

      this.session.code = welcome.code || clean;
      this.connected = true;
      this._hostLastSeen = performance.now();
      this._startHeartbeat();
      this._setStatus('connected');
      this._emitRoster();
      this.bus.emit('network:joined', { session: this.session, code: this.session.code });

      return { ok: true, session: this.session, code: this.session.code };
    } catch (error) {
      if (peer) {
        try {
          peer.destroy();
        } catch (destroyError) {
          /* ignore */
        }
      }
      this.peer = null;
      this._hostConn = null;
      this.session = null;
      this.connected = false;
      this._setStatus('error');
      const mapped = this._mapError(error, 'join');
      this.bus.emit('network:error', mapped);
      return { ok: false, reason: mapped.reason, message: mapped.message };
    }
  }

  _awaitWelcome(conn, timeout = CONFIG.network.joinTimeout) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(this._joinTimer);
        conn.off('open', onOpen);
        conn.off('close', onClose);
        conn.off('error', onError);
        conn.off('data', onData);
        this._pendingJoin = null;
        fn(value);
      };

      const onOpen = () => {
        this._send(conn, { t: 'hello', name: this._displayName() });
      };
      const onClose = () => finish(reject, { type: 'closed', reason: 'host-unreachable' });
      const onError = (error) => finish(reject, error);
      const onData = (data) => {
        if (!data || typeof data !== 'object') return;
        if (data.t === 'welcome') {
          this._setupConnection(conn);
          finish(resolve, data);
        } else if (data.t === 'reject') {
          finish(reject, {
            type: 'reject',
            reason: data.reason || 'rejected',
            message: data.message || 'ХОСТ ОТКЛОНИЛ ПОДКЛЮЧЕНИЕ.',
          });
        }
      };

      this._pendingJoin = { resolve, reject };

      conn.on('open', onOpen);
      conn.on('close', onClose);
      conn.on('error', onError);
      conn.on('data', onData);

      if (conn.open) onOpen();

      this._joinTimer = window.setTimeout(() => {
        finish(reject, {
          type: 'timeout',
          reason: 'timeout',
          message: 'ХОСТ НЕ ОТВЕЧАЕТ. ПРОВЕРЬТЕ КОД И ПОВТОРИТЕ ПОПЫТКУ.',
        });
      }, timeout);
    });
  }

  // ---------------------------------------------------------------------------
  // Ошибки и завершение
  // ---------------------------------------------------------------------------

  _onPeerError(error) {
    const type = error && error.type;
    if (type === 'peer-unavailable') {
      if (this._pendingJoin) {
        this._pendingJoin.reject({
          type: 'peer-unavailable',
          reason: 'not-found',
          message: 'ЛОББИ С ТАКИМ КОДОМ НЕ НАЙДЕНО.',
        });
      }
      return;
    }
    if (type === 'unavailable-id' || type === 'invalid-id') {
      // Обрабатывается в hostLobby (повторная генерация кода).
      return;
    }
    if (type === 'network' || type === 'server-error' || type === 'socket-error') {
      if (this.session) this._setStatus('reconnecting', 'ПОТЕРЯ СВЯЗИ С СИГНАЛЬНЫМ СЕРВЕРОМ');
      this._scheduleReconnect();
      return;
    }
    if (type === 'webrtc' || type === 'webrtc-error') {
      this.bus.emit('network:warning', {
        reason: 'webrtc',
        message: 'НЕ УДАЛОСЬ УСТАНОВИТЬ ПРЯМОЕ СОЕДИНЕНИЕ. ВОЗМОЖЕН СТРОГИЙ NAT — НУЖЕН TURN-СЕРВЕР.',
      });
    }
  }

  _mapError(error, mode) {
    const type = (error && (error.type || error.reason)) || 'unknown';
    if (type === 'peer-lib' || type === 'relay-lib') {
      return {
        reason: 'peer-lib',
        message: 'НЕ УДАЛОСЬ ЗАГРУЗИТЬ СЕТЕВОЙ МОДУЛЬ. ПРОВЕРЬТЕ СОЕДИНЕНИЕ И ПЕРЕЗАГРУЗИТЕ СТРАНИЦУ.',
      };
    }
    if (type === 'unavailable-id') {
      return { reason: 'unavailable-id', message: 'КОД ЛОББИ УЖЕ ЗАНЯТ. ПОПРОБУЙТЕ ЕЩЁ РАЗ.' };
    }
    if (type === 'peer-unavailable' || type === 'not-found') {
      return { reason: 'not-found', message: 'ЛОББИ С ТАКИМ КОДОМ НЕ НАЙДЕНО.' };
    }
    if (type === 'reject' || type === 'full') {
      return { reason: 'full', message: 'ВАГОН ЗАПОЛНЕН: 6 ПАССАЖИРОВ.' };
    }
    if (type === 'timeout') {
      return {
        reason: 'timeout',
        message: mode === 'host'
          ? 'СИГНАЛЬНЫЙ СЕРВЕР НЕ ОТВЕТИЛ. ПРОВЕРЬТЕ СЕТЬ И ПОВТОРИТЕ.'
          : 'ХОСТ НЕ ОТВЕЧАЕТ. ПРОВЕРЬТЕ КОД И ПОВТОРИТЕ ПОПЫТКУ.',
      };
    }
    if (type === 'network' || type === 'server-error' || type === 'socket-error') {
      return {
        reason: 'network',
        message: 'КАНАЛ СВЯЗИ НЕДОСТУПЕН. ОТКРОЙТЕ «НАСТРОЙКИ» → «ПРОВЕРИТЬ СВЯЗЬ» И ВЫБЕРИТЕ ДРУГОЙ КАНАЛ.',
      };
    }
    return { reason: 'unknown', message: 'НЕ УДАЛОСЬ УСТАНОВИТЬ СВЯЗЬ. ПОВТОРИТЕ ПОПЫТКУ.' };
  }

  _failSession(reason) {
    if (this._sessionFailed || !this.session) return;
    this._sessionFailed = true;
    const session = this.session;
    const wasHost = this.isHost;
    this.leave({ silent: true });
    this.bus.emit('network:hostLeft', { reason, session, wasHost });
  }

  leave({ silent = false } = {}) {
    this._destroying = true;
    // Отменяет незавершённую проверку каналов / создание лобби.
    this._hostToken = (this._hostToken || 0) + 1;
    window.clearTimeout(this._joinTimer);
    window.clearTimeout(this._reconnectTimer);
    this._stopHeartbeat();
    this._pendingJoin = null;
    this._sessionFailed = false;

    const hadSession = Boolean(this.session);

    if (this._voice) this._voice.leave();
    this._leaveRelayRoom();
    this.transport = 'peerjs';

    if (this.isHost) {
      for (const conn of this.connections.values()) {
        this._send(conn, { t: 'close', reason: 'host-left' });
      }
    } else if (this._hostConn) {
      this._send(this._hostConn, { t: 'bye' });
    }

    for (const conn of this.connections.values()) {
      try {
        conn.close();
      } catch (error) {
        /* ignore */
      }
    }
    if (this._hostConn) {
      try {
        this._hostConn.close();
      } catch (error) {
        /* ignore */
      }
    }

    const peer = this.peer;
    this.peer = null;
    this._hostConn = null;
    this.connections.clear();
    this.roster.clear();
    this.remoteStates.clear();
    this._lastSeen.clear();
    this.session = null;
    this.connected = false;
    this._hostId = null;
    this._rtt = null;
    this._tickAccumulator = 0;
    this._status = 'idle';

    if (peer) {
      window.clearTimeout(this._destroyTimer);
      this._destroyTimer = window.setTimeout(() => {
        try {
          peer.destroy();
        } catch (error) {
          /* ignore */
        }
      }, 140);
    }

    this._destroying = false;

    if (hadSession && !silent) {
      this.bus.emit('network:closed', { reason: 'left' });
    }
  }

  /** Мягкий выход по кнопке «Покинуть лобби»: сначала уведомляем, потом рвём. */
  async closeLobby() {
    this.leave();
  }

  // ---------------------------------------------------------------------------
  // Тик
  // ---------------------------------------------------------------------------

  update(dt) {
    if (!this.session || !this.isActive) return;

    this._tickAccumulator += dt;
    if (this._tickAccumulator >= 1 / CONFIG.network.tickRate) {
      this._tickAccumulator = 0;
      const local = this._localStateProvider ? this._localStateProvider() : null;
      if (local) {
        if (this.isHost) {
          const packet = { t: 'state', id: this.selfId, s: local };
          for (const conn of this.connections.values()) this._send(conn, packet);
        } else if (this._hostConn) {
          this._send(this._hostConn, { t: 'state', s: local });
        }
      }
    }

  }

  /** Состояние удалённого игрока + признак «в вагоне». */
  getRemoteState(id) {
    return this.remoteStates.get(id) || null;
  }

  getPlayers() {
    return this._rosterArray();
  }
}

// =============================================================================
// УДАЛЁННЫЕ ИГРОКИ
// =============================================================================

class RemotePlayers {
  constructor({ scene, camera, bus, voice, world }) {
    this.scene = scene;
    this.camera = camera;
    this.bus = bus;
    this.voice = voice;
    this.world = world;
    this.avatars = new Map();
    this.selfId = null;
    this._tagTextures = new Map();
    this._group = new THREE.Group();
    this._group.name = 'Экипаж';
    scene.add(this._group);

    this._bodyGeometry = new THREE.CapsuleGeometry(0.27, 1.0, 5, 12);
    this._headGeometry = new THREE.SphereGeometry(0.165, 14, 10);
    this._shoulderGeometry = new THREE.BoxGeometry(0.62, 0.1, 0.3);
    this._visorGeometry = new THREE.BoxGeometry(0.2, 0.032, 0.02);
    this._ringGeometry = new THREE.RingGeometry(0.3, 0.37, 28);
    this._tagGeometry = new THREE.PlaneGeometry(1.5, 0.42);
  }

  sync(roster) {
    if (!roster) return;
    this.selfId = roster.selfId;
    const seen = new Set();

    for (const player of roster.players) {
      if (!player || player.id === this.selfId) continue;
      seen.add(player.id);
      let avatar = this.avatars.get(player.id);
      if (!avatar) {
        avatar = this._createAvatar(player);
        this.avatars.set(player.id, avatar);
      }
      avatar.player = player;
      if (avatar.name !== player.name) {
        avatar.name = player.name;
        this._setTag(avatar, player.name, false, false);
      }
    }

    for (const [id, avatar] of Array.from(this.avatars.entries())) {
      if (seen.has(id)) continue;
      this._removeAvatar(avatar);
      this.avatars.delete(id);
    }
  }

  _createAvatar(player) {
    const group = new THREE.Group();
    group.name = `Пассажир: ${player.name}`;
    group.visible = false;
    this._group.add(group);

    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: 0x3a4640,
      roughness: 0.88,
      metalness: 0.08,
      emissive: 0x18251c,
      emissiveIntensity: 0.85,
    });
    const body = new THREE.Mesh(this._bodyGeometry, bodyMaterial);
    body.position.y = 0.79;
    body.castShadow = false;
    body.receiveShadow = false;
    group.add(body);

    const head = new THREE.Mesh(this._headGeometry, bodyMaterial);
    head.position.y = 1.66;
    group.add(head);

    const shoulders = new THREE.Mesh(
      this._shoulderGeometry,
      new THREE.MeshStandardMaterial({ color: 0x232a25, roughness: 0.8, metalness: 0.2 }),
    );
    shoulders.position.y = 1.35;
    group.add(shoulders);

    // Светящаяся полоска визора — силуэт читается в темноте.
    const visorMaterial = new THREE.MeshStandardMaterial({
      color: 0x0a1410,
      emissive: 0x9be3dc,
      emissiveIntensity: 1.5,
      roughness: 0.4,
    });
    const visor = new THREE.Mesh(this._visorGeometry, visorMaterial);
    visor.position.set(0, 1.7, -0.15);
    group.add(visor);

    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x9be3dc,
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(this._ringGeometry, ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.012;
    group.add(ring);

    const tagMaterial = new THREE.SpriteMaterial({
      map: this._getTagTexture(player.name, false, false),
      transparent: true,
      depthTest: true,
      depthWrite: false,
      sizeAttenuation: true,
      toneMapped: false,
    });
    const tag = new THREE.Sprite(tagMaterial);
    tag.scale.set(1.5, 0.42, 1);
    tag.position.y = 2.18;
    group.add(tag);

    const avatar = {
      id: player.id,
      player,
      name: player.name,
      group,
      body,
      bodyMaterial,
      visor,
      visorMaterial,
      ring,
      ringMaterial,
      tag,
      tagMaterial,
      samples: [],
      speaking: false,
      stale: false,
      inCar: false,
      lastTagState: '',
      hasState: false,
    };

    if (this.voice) this.voice.attachAvatar(player.id, group);
    return avatar;
  }

  _removeAvatar(avatar) {
    this._group.remove(avatar.group);
    avatar.group.traverse((object) => {
      if (object.geometry && object.geometry !== this._bodyGeometry
        && object.geometry !== this._headGeometry
        && object.geometry !== this._shoulderGeometry
        && object.geometry !== this._visorGeometry
        && object.geometry !== this._ringGeometry
        && object.geometry !== this._tagGeometry) {
        object.geometry.dispose();
      }
    });
    avatar.tagMaterial.dispose();
    const seen = new Set();
    avatar.group.traverse((object) => {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material || seen.has(material)) continue;
        seen.add(material);
        if (material !== avatar.tagMaterial) material.dispose();
      }
    });
    if (this.voice) this.voice.removePeer(avatar.id);
  }

  _getTagTexture(name, speaking, stale) {
    const key = `${name}|${speaking ? 1 : 0}|${stale ? 1 : 0}`;
    if (this._tagTextures.has(key)) return this._tagTextures.get(key);

    const width = 512;
    const height = 144;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, width, height);

    // Подложка.
    ctx.fillStyle = 'rgba(4, 8, 6, 0.8)';
    ctx.fillRect(6, 14, width - 12, 116);
    ctx.strokeStyle = stale ? 'rgba(255, 90, 78, 0.55)' : 'rgba(185, 247, 164, 0.42)';
    ctx.lineWidth = 2;
    ctx.strokeRect(6, 14, width - 12, 116);

    // Уголки.
    ctx.fillStyle = stale ? 'rgba(255, 90, 78, 0.9)' : 'rgba(185, 247, 164, 0.9)';
    ctx.fillRect(6, 14, 3, 16);
    ctx.fillRect(6, 14, 16, 3);
    ctx.fillRect(width - 9, 14, 3, 16);
    ctx.fillRect(width - 22, 14, 16, 3);

    // Индикатор голоса.
    ctx.beginPath();
    ctx.arc(42, 72, 8, 0, Math.PI * 2);
    ctx.fillStyle = stale
      ? 'rgba(255, 90, 78, 0.9)'
      : speaking
        ? 'rgba(185, 247, 164, 1)'
        : 'rgba(120, 150, 122, 0.5)';
    ctx.fill();
    if (speaking) {
      ctx.strokeStyle = 'rgba(185, 247, 164, 0.45)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(42, 72, 15, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.font = '600 54px "Cascadia Mono", "Courier New", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = stale ? 'rgba(255, 190, 184, 0.86)' : 'rgba(235, 244, 228, 0.95)';
    const label = name.slice(0, 14);
    ctx.fillText(label, 66, 70);

    if (stale) {
      ctx.font = '500 22px "Cascadia Mono", "Courier New", monospace';
      ctx.fillStyle = 'rgba(255, 120, 105, 0.9)';
      ctx.textAlign = 'right';
      ctx.fillText('НЕТ СВЯЗИ', width - 20, 108);
    } else if (speaking) {
      // Мини-эквалайзер.
      ctx.fillStyle = 'rgba(185, 247, 164, 0.85)';
      for (let i = 0; i < 4; i += 1) {
        const bar = 8 + ((i * 9) % 18);
        ctx.fillRect(width - 34 - i * 15, 72 - bar / 2, 8, bar);
      }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = 4;
    this._tagTextures.set(key, texture);

    // Ограничиваем кэш, чтобы смена состояний не текла.
    if (this._tagTextures.size > 80) {
      const firstKey = this._tagTextures.keys().next().value;
      const old = this._tagTextures.get(firstKey);
      this._tagTextures.delete(firstKey);
      old.dispose();
    }
    return texture;
  }

  _setTag(avatar, name, speaking, stale) {
    const state = `${speaking ? 1 : 0}${stale ? 1 : 0}`;
    if (avatar.lastTagState === state && avatar.name === name) return;
    avatar.lastTagState = state;
    avatar.name = name;
    avatar.tagMaterial.map = this._getTagTexture(name, speaking, stale);
    avatar.tagMaterial.needsUpdate = true;
  }

  _applyState(avatar, state, receiveTime) {
    if (!state) return;
    avatar.hasState = true;
    avatar.inCar = state.c === 1 || state.c === true;
    if (!avatar.inCar) {
      avatar.group.visible = false;
      if (this.voice) this.voice.setRemoteInCar(avatar.id, false);
      return;
    }

    const sample = {
      t: receiveTime,
      x: Number(state.x) || 0,
      y: Number(state.y) || 0,
      z: Number(state.z) || 0,
      yaw: Number(state.yaw) || 0,
    };

    const samples = avatar.samples;
    const last = samples[samples.length - 1];
    // Отбрасываем телепорт-скачки дальше 6 метров (переподключение, лаг).
    if (last && Math.hypot(sample.x - last.x, sample.z - last.z) > 6) {
      samples.length = 0;
    }
    samples.push(sample);
    if (samples.length > 24) samples.shift();

    avatar.group.visible = true;
    if (this.voice) this.voice.setRemoteInCar(avatar.id, true);
  }

  update(dt, elapsed) {
    if (!this.network) return;
    const now = performance.now();
    const delay = 110;

    for (const avatar of this.avatars.values()) {
      const entry = this.network.getRemoteState(avatar.id);
      if (entry && (!avatar.lastAt || entry.at > avatar.lastAt)) {
        avatar.lastAt = entry.at;
        this._applyState(avatar, entry.s, entry.at);
      }

      if (!avatar.hasState || !avatar.inCar) continue;

      const samples = avatar.samples;
      if (samples.length === 0) continue;

      const renderTime = now - delay;
      let from = samples[0];
      let to = samples[samples.length - 1];
      for (let i = 0; i < samples.length - 1; i += 1) {
        if (samples[i].t <= renderTime && samples[i + 1].t >= renderTime) {
          from = samples[i];
          to = samples[i + 1];
          break;
        }
        if (samples[i + 1].t < renderTime) {
          from = samples[i + 1];
          to = samples[i + 1];
        }
      }

      let x = to.x;
      let y = to.y;
      let z = to.z;
      let yaw = to.yaw;
      if (to !== from && to.t > from.t) {
        const alpha = clamp((renderTime - from.t) / (to.t - from.t), 0, 1);
        x = from.x + (to.x - from.x) * alpha;
        y = from.y + (to.y - from.y) * alpha;
        z = from.z + (to.z - from.z) * alpha;
        let delta = to.yaw - from.yaw;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        yaw = from.yaw + delta * alpha;
      }

      avatar.group.position.set(x, y, z);
      avatar.group.rotation.y = yaw;

      const newest = samples[samples.length - 1];
      const stale = now - newest.t > 1200;
      if (stale !== avatar.stale) {
        avatar.stale = stale;
        avatar.bodyMaterial.emissive.setHex(stale ? 0x2a0d0a : 0x18251c);
        avatar.ringMaterial.color.setHex(stale ? 0xff5a4e : 0x9be3dc);
      }

      // Наблюдение за голосом.
      const speaking = Boolean(this.voice && this.voice.isSpeaking(avatar.id));
      if (speaking !== avatar.speaking) {
        avatar.speaking = speaking;
        avatar.visorMaterial.emissiveIntensity = speaking ? 2.6 : 1.5;
        avatar.ringMaterial.opacity = speaking ? 0.5 : 0.22;
      }
      this._setTag(avatar, avatar.name, speaking, stale);

      // Намётки исчезают в тумане и не мешают на расстоянии.
      const distance = this.camera.position.distanceTo(avatar.group.position);
      const visibleTag = distance < CONFIG.voice.nametagDistance;
      avatar.tag.visible = visibleTag;
      if (visibleTag) {
        // Табличка держит мировой размер: читается и вблизи, и в глубине вагона.
        avatar.tagMaterial.opacity = clamp((CONFIG.voice.nametagDistance - distance) / 5, 0.12, 1);
      }

      // Лёгкое «дыхание» капсулы.
      avatar.body.position.y = 0.79 + (speaking ? Math.sin(elapsed * 6) * 0.006 : 0);
    }
  }

  clear() {
    for (const avatar of this.avatars.values()) this._removeAvatar(avatar);
    this.avatars.clear();
  }

  setNetwork(network) {
    this.network = network;
  }
}

// =============================================================================
// ГОЛОСОВОЙ ЧАТ (WebRTC + пространственное аудио)
// =============================================================================

class VoiceChat {
  constructor({ audio, bus, scene, camera, store }) {
    this.audio = audio;
    this.bus = bus;
    this.scene = scene;
    this.camera = camera;
    this.store = store;

    this.network = null;
    this.listener = null;
    this.initialized = false;

    this.enabled = this.store.values.voiceEnabled !== false;
    this.mode = this.store.values.voiceMode === 'ptt' ? 'ptt' : 'open';
    this.localInCar = false;
    this.pttHeld = false;

    this.localStream = null;
    // Наружу уходит отдельный поток с гейтом: сырой микрофон остаётся
    // живым для анализатора крика и распознавания речи даже в режиме рации.
    this.outgoingStream = null;
    this._outgoing = null;
    this.localAnalyser = null;
    this.localSpeaking = false;
    this.localLevel = 0;

    this.peers = new Map();
    this.silentStream = null;
    this._silentNodes = null;
    this._statusTimer = 0;
    this._lastStatus = 0;
    this._lastLocalLevel = 0;
    this._retryTimers = new Map();
    this._noiseBuffer = null;
    this._pttBound = false;
    this._lastRoster = null;
    this._micRetryTimer = 0;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onBlur = this._onBlur.bind(this);

    this.bus.emit('voice:status', this._statusPayload());
  }

  // ---------------------------------------------------------------------------
  // Инициализация
  // ---------------------------------------------------------------------------

  setNetwork(network) {
    this.network = network;
  }

  init() {
    if (this.initialized) return true;
    this.audio.init();
    if (!this.audio.ctx) return false;

    // Один AudioContext на игру: и эмбиент, и пространственный голос.
    THREE.AudioContext.setContext(this.audio.ctx);
    this.listener = new THREE.AudioListener();
    this.camera.add(this.listener);

    this._ensureSceneCamera();
    this._noiseBuffer = this._createNoiseBuffer();
    this.initialized = true;

    if (!this._pttBound) {
      this._pttBound = true;
      window.addEventListener('keydown', this._onKeyDown, { passive: true });
      window.addEventListener('keyup', this._onKeyUp, { passive: true });
      window.addEventListener('blur', this._onBlur);
    }

    // Поток мог прийти раньше, чем появился AudioContext: гость получает
    // голос хоста ещё в лобби. Собираем отложенное позиционное аудио.
    for (const [id, entry] of this.peers) {
      if (entry.stream && !entry.audio && entry.object3D) this._buildAudio(id, entry);
    }

    this._emitStatus(true);
    return true;
  }

  _ensureSceneCamera() {
    if (this.camera.parent) return;
    this.scene.add(this.camera);
  }

  _createNoiseBuffer() {
    const ctx = this.listener ? this.listener.context : this.audio.ctx;
    const length = Math.floor(ctx.sampleRate * 1.5);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i += 1) {
      const white = Math.random() * 2 - 1;
      last = last * 0.82 + white * 0.18;
      data[i] = last * 0.7;
    }
    return buffer;
  }

  /** Запрос разрешения на старте (без удержания микрофона). */
  async probePermission() {
    if (this.audio.mic.permission === 'granted' && this.localStream) return true;
    try {
      await this.audio.acquireMic('probe');
      this.audio.releaseMic('probe');
      this._emitStatus(true);
      return true;
    } catch (error) {
      this._emitStatus(true);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Состояние / настройки
  // ---------------------------------------------------------------------------

  _statusPayload() {
    return {
      supported: Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      enabled: this.enabled,
      initialized: this.initialized,
      active: Boolean(this.localStream),
      mode: this.mode,
      permission: this.audio.mic.permission,
      speaking: this.localSpeaking,
      level: this.localLevel,
      peers: this.peers.size,
      inCar: this.localInCar,
    };
  }

  _emitStatus(force = false) {
    const now = performance.now();
    if (!force && now - this._lastStatus < 120) return;
    this._lastStatus = now;
    this.bus.emit('voice:status', this._statusPayload());
  }

  async setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.store.save({ voiceEnabled: this.enabled });

    if (!this.enabled) {
      this._releaseLocal();
      // В relay-режиме потоки живут в общем WebRTC-соединении: закрывать
      // записи нельзя, иначе после включения голоса не вернуть чужой звук.
      if (!(this.network && this.network.usesRelay)) {
        for (const id of Array.from(this.peers.keys())) this._closePeer(id);
      }
      this._emitStatus(true);
      return;
    }

    if (this.network && this.network.selfId) await this._ensureLocal();
    this._emitStatus(true);
  }

  setMode(mode) {
    this.mode = mode === 'ptt' ? 'ptt' : 'open';
    this.store.save({ voiceMode: this.mode });
    this._applyTrackState();
    this._emitStatus(true);
  }

  setLocalInCar(inCar) {
    this.localInCar = Boolean(inCar);
    this._emitStatus(true);
  }

  setRemoteInCar(id, inCar) {
    const peer = this.peers.get(id);
    if (!peer) return;
    if (peer.inCar === inCar) return;
    peer.inCar = Boolean(inCar);
    this._emitStatus(true);
  }

  async _ensureLocal() {
    if (!this.enabled) return null;
    if (this.localStream) return this.localStream;
    try {
      const result = await this.audio.acquireMic('voice');
      this.localStream = result.stream;
      this._buildOutgoing();
      this._applyTrackState();
      const outgoing = this.outgoingStream || this.localStream;
      if (this.network && this.network.publishVoiceStream) {
        this.network.publishVoiceStream(outgoing);
      }
      this._emitStatus(true);
      return this.localStream;
    } catch (error) {
      console.warn('[Voice] Микрофон недоступен', error);
      this.localStream = null;
      this._emitStatus(true);
      return null;
    }
  }

  /** Собирает исходящий поток с управляемым гейтом (PTT / выключенный голос). */
  _buildOutgoing() {
    if (!this.localStream || this.outgoingStream) return this.outgoingStream;
    const ctx = this.listener ? this.listener.context : this.audio.ctx;
    if (!ctx) return null;
    try {
      const source = ctx.createMediaStreamSource(this.localStream);
      const gate = ctx.createGain();
      gate.gain.value = 0;
      const dest = ctx.createMediaStreamDestination();
      source.connect(gate);
      gate.connect(dest);
      this.outgoingStream = dest.stream;
      this._outgoing = { source, gate, dest };
    } catch (error) {
      console.warn('[Voice] Не удалось собрать исходящий поток', error);
      this.outgoingStream = null;
      this._outgoing = null;
    }
    return this.outgoingStream;
  }

  _teardownOutgoing() {
    if (this.network && this.network.unpublishVoiceStream) {
      if (this.outgoingStream) this.network.unpublishVoiceStream(this.outgoingStream);
      if (this.localStream) this.network.unpublishVoiceStream(this.localStream);
    }
    if (this._outgoing) {
      try {
        this._outgoing.source.disconnect();
        this._outgoing.gate.disconnect();
      } catch (error) {
        /* ignore */
      }
      if (this._outgoing.dest) {
        this._outgoing.dest.stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch (error) {
            /* ignore */
          }
        });
      }
    }
    this._outgoing = null;
    this.outgoingStream = null;
  }

  _releaseLocal() {
    this._teardownOutgoing();
    this.localStream = null;
    if (this.localAnalyser) {
      try {
        this.localAnalyser.disconnect();
      } catch (error) {
        /* ignore */
      }
      this.localAnalyser = null;
    }
    this.audio.releaseMic('voice');
    this.localSpeaking = false;
    this.localLevel = 0;
  }

  _applyTrackState() {
    if (!this.localStream) return;
    const audible = this.enabled && (this.mode === 'open' || this.pttHeld);
    // Сырые дорожки не выключаем: анализатор должен слышать крик всегда,
    // а тишину в эфире обеспечивает гейт исходящего потока.
    this.localStream.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });
    if (this._outgoing) {
      const ctx = this.listener ? this.listener.context : this.audio.ctx;
      const now = ctx ? ctx.currentTime : 0;
      try {
        this._outgoing.gate.gain.setTargetAtTime(audible ? 1 : 0, now, 0.012);
      } catch (error) {
        this._outgoing.gate.gain.value = audible ? 1 : 0;
      }
    }
  }

  _getOutgoingStream() {
    if (this.localStream) return this.outgoingStream || this.localStream;
    if (!this.silentStream) {
      const ctx = this.listener ? this.listener.context : this.audio.ctx;
      if (!ctx) return null;
      const destination = ctx.createMediaStreamDestination();
      const oscillator = ctx.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.value = 60;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      oscillator.connect(gain);
      gain.connect(destination);
      oscillator.start();
      this.silentStream = destination.stream;
      this._silentNodes = { oscillator, gain, destination };
    }
    return this.silentStream;
  }

  // ---------------------------------------------------------------------------
  // Ростер и звонки
  // ---------------------------------------------------------------------------

  async syncRoster(roster) {
    if (!roster || !this.network) return;
    this._lastRoster = roster;
    this.selfId = roster.selfId;
    this.hostId = roster.hostId;

    if (!this.enabled) {
      this._emitStatus(true);
      return;
    }

    if (!this.initialized) this.init();
    await this._ensureLocal();

    const ids = new Set();
    for (const player of roster.players) {
      if (!player || !player.id || player.id === roster.selfId) continue;
      ids.add(player.id);
      this._ensureCall(player.id);
    }

    for (const id of Array.from(this.peers.keys())) {
      if (!ids.has(id)) this._closePeer(id);
    }

    this._emitStatus(true);
  }

  _ensureCall(remoteId) {
    if (!this.enabled || !this.network || !this.network.isActive) return;
    const selfId = this.network.selfId;
    if (!selfId || remoteId === selfId) return;

    // Запись могла появиться раньше из attachAvatar(): её нельзя затирать,
    // иначе позиционный объект потеряет привязку к капсуле.
    let entry = this.peers.get(remoteId);
    if (!entry) {
      entry = this._emptyPeer();
      this.peers.set(remoteId, entry);
    }

    if (this.network.usesRelay) {
      // Trystero добавляет микрофон в общий канал; отдельный «звонок»
      // не нужен, входящий поток приходит в attachRemoteStream().
      if (this.localStream) this.network.publishVoiceStream(this.localStream);
      return;
    }

    if (entry.call) return;

    // Инициатор — меньший peer id. Второй ждёт звонка, но через 6 секунд
    // пробует сам: так голос появляется даже если инициатор «завис».
    if (selfId > remoteId) {
      if (this._retryTimers.has(remoteId)) return;
      this._retryTimers.set(remoteId, window.setTimeout(() => {
        this._retryTimers.delete(remoteId);
        const current = this.peers.get(remoteId);
        if (current && !current.call) this._initiateCall(remoteId);
      }, 6000));
      return;
    }

    this._initiateCall(remoteId);
  }

  _emptyPeer() {
    return {
      call: null,
      outgoing: false,
      stream: null,
      source: null,
      nodes: [],
      analyser: null,
      analyserData: null,
      level: 0,
      speaking: false,
      audio: null,
      gain: null,
      object3D: null,
      inCar: false,
      flat: null,
      staticNodes: [],
      closed: false,
      retried: false,
    };
  }

  _initiateCall(remoteId) {
    if (!this.enabled || !this.network || !this.network.peer) return;
    if (remoteId === this.network.selfId) return;

    let entry = this.peers.get(remoteId);
    if (!entry) {
      entry = this._emptyPeer();
      this.peers.set(remoteId, entry);
    }
    if (entry.call) return;

    const stream = this._getOutgoingStream();
    if (!stream) return;

    let call = null;
    try {
      call = this.network.peer.call(remoteId, stream, {
        metadata: { name: this.store.values.callsign || '' },
      });
    } catch (error) {
      this._scheduleRetry(remoteId);
      return;
    }
    if (!call) {
      this._scheduleRetry(remoteId);
      return;
    }

    entry.call = call;
    entry.outgoing = true;
    entry.closed = false;

    call.on('stream', (remoteStream) => this._attachStream(remoteId, remoteStream));
    call.on('close', () => this._onCallClosed(remoteId));
    call.on('error', () => this._onCallClosed(remoteId));
  }

  _scheduleRetry(remoteId) {
    if (this._retryTimers.has(remoteId)) return;
    const timer = window.setTimeout(() => {
      this._retryTimers.delete(remoteId);
      if (!this.peers.get(remoteId)) return;
      const entry = this.peers.get(remoteId);
      if (entry && !entry.call) this._initiateCall(remoteId);
    }, 2600);
    this._retryTimers.set(remoteId, timer);
  }

  acceptIncomingCall(call) {
    if (!call) return;
    if (!this.enabled || !this.network || !this.network.peer) {
      try {
        call.close();
      } catch (error) {
        /* ignore */
      }
      return;
    }

    const remoteId = call.peer;
    if (!remoteId || remoteId === this.network.selfId) {
      try {
        call.close();
      } catch (error) {
        /* ignore */
      }
      return;
    }

    let entry = this.peers.get(remoteId);
    if (!entry) {
      entry = this._emptyPeer();
      this.peers.set(remoteId, entry);
    }

    // Дедупликация: оставляем один канал на пару.
    if (entry.call && entry.call !== call) {
      const selfId = this.network.selfId;
      if (entry.outgoing) {
        if (selfId < remoteId) {
          // Мы — инициатор: входящий дубль закрываем.
          try {
            call.close();
          } catch (error) {
            /* ignore */
          }
          return;
        }
        // Мы не инициатор: уступаем входящему, свой исходящий закрываем.
        try {
          entry.call.close();
        } catch (error) {
          /* ignore */
        }
        entry.call = null;
      } else {
        try {
          call.close();
        } catch (error) {
          /* ignore */
        }
        return;
      }
    }

    const outgoing = this._getOutgoingStream();
    try {
      if (outgoing) call.answer(outgoing);
      else call.answer();
    } catch (error) {
      return;
    }

    entry.call = call;
    entry.outgoing = false;
    entry.closed = false;

    call.on('stream', (remoteStream) => this._attachStream(remoteId, remoteStream));
    call.on('close', () => this._onCallClosed(remoteId));
    call.on('error', () => this._onCallClosed(remoteId));

    if (this._retryTimers.has(remoteId)) {
      window.clearTimeout(this._retryTimers.get(remoteId));
      this._retryTimers.delete(remoteId);
    }
  }

  _onCallClosed(remoteId) {
    const entry = this.peers.get(remoteId);
    if (!entry) return;
    entry.call = null;
    entry.outgoing = false;
    entry.closed = true;
    this._teardownAudio(entry);
    // Если игрок ещё в лобби — попробуем восстановить канал.
    if (this.network && this.network.roster.has(remoteId) && this.enabled) {
      this._scheduleRetry(remoteId);
    }
  }

  /** Входящий поток из relay-канала (Trystero onPeerStream). */
  attachRemoteStream(remoteId, stream) {
    if (!remoteId || !stream) return;
    if (this.network && remoteId === this.network.selfId) return;
    this._attachStream(remoteId, stream);
  }

  _attachStream(remoteId, stream) {
    let entry = this.peers.get(remoteId);
    if (!entry) {
      entry = this._emptyPeer();
      this.peers.set(remoteId, entry);
    }
    if (entry.stream === stream) return;

    entry.stream = stream;
    this._buildAudio(remoteId, entry);
  }

  // ---------------------------------------------------------------------------
  // Пространственное аудио
  // ---------------------------------------------------------------------------

  attachAvatar(remoteId, object3D) {
    let entry = this.peers.get(remoteId);
    if (!entry) {
      entry = this._emptyPeer();
      this.peers.set(remoteId, entry);
    }
    if (entry.object3D === object3D) return;
    entry.object3D = object3D;
    if (entry.audio) {
      entry.audio.parent && entry.audio.parent.remove(entry.audio);
      object3D.add(entry.audio);
    } else if (entry.stream) {
      this._buildAudio(remoteId, entry);
    }
  }

  _buildAudio(remoteId, entry) {
    if (!this.initialized || !entry.stream || !entry.object3D) return;
    if (entry.audio) return;

    const ctx = this.listener.context;
    const source = ctx.createMediaStreamSource(entry.stream);

    // «Рация»: срез низа, срез верха, подчёркнутая разборчивость и лёгкий грит.
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 280;
    highpass.Q.value = 0.7;

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 3400;
    lowpass.Q.value = 0.7;

    const presence = ctx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 1750;
    presence.Q.value = 1.1;
    presence.gain.value = 5;

    const shaper = ctx.createWaveShaper();
    shaper.curve = this._makeDistortionCurve(12);
    shaper.oversample = '2x';

    const voiceGain = ctx.createGain();
    voiceGain.gain.value = CONFIG.voice.radioGain;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.4;

    source.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(presence);
    presence.connect(shaper);
    shaper.connect(voiceGain);
    voiceGain.connect(analyser);

    const audio = new THREE.PositionalAudio(this.listener);
    audio.setDistanceModel('inverse');
    audio.setRefDistance(CONFIG.voice.refDistance);
    audio.setRolloffFactor(CONFIG.voice.rolloff);
    audio.setMaxDistance(CONFIG.voice.maxDistance);
    audio.setVolume(1);
    audio.setNodeSource(voiceGain);

    entry.object3D.add(audio);

    // Шум эфира, слышный только когда рядом кто-то говорит.
    const staticSource = ctx.createBufferSource();
    staticSource.buffer = this._noiseBuffer;
    staticSource.loop = true;
    const staticFilter = ctx.createBiquadFilter();
    staticFilter.type = 'bandpass';
    staticFilter.frequency.value = 1600;
    staticFilter.Q.value = 1.4;
    const staticGain = ctx.createGain();
    staticGain.gain.value = 0;
    staticSource.connect(staticFilter);
    staticFilter.connect(staticGain);
    staticGain.connect(voiceGain);
    try {
      staticSource.start();
    } catch (error) {
      /* ignore */
    }

    entry.audio = audio;
    entry.gain = voiceGain;
    entry.source = source;
    entry.nodes = [highpass, lowpass, presence, shaper, voiceGain];
    entry.staticNodes = [staticSource, staticFilter, staticGain];
    entry.staticGain = staticGain;
    entry.analyser = analyser;
    entry.analyserData = new Uint8Array(analyser.fftSize);
    entry.flat = null;

    this._applyRouting(entry);
    this.bus.emit('voice:peerAudio', { id: remoteId });
  }

  _makeDistortionCurve(amount) {
    const samples = 44100;
    const curve = new Float32Array(samples);
    const k = amount;
    for (let i = 0; i < samples; i += 1) {
      const x = (i * 2) / samples - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return curve;
  }

  _applyRouting(entry) {
    if (!entry.gain) return;
    const ctx = this.listener.context;
    const flat = !this.enabled || !this.localInCar || !entry.inCar;

    if (entry.flat === flat) return;
    entry.flat = flat;

    try {
      entry.gain.disconnect();
    } catch (error) {
      /* ignore */
    }

    if (flat) {
      entry.gain.connect(this.listener.getInput());
      if (entry.audio) entry.audio.setVolume(1);
    } else if (entry.audio) {
      entry.gain.connect(entry.audio.getOutput());
    }

    // Возобновляем цепочку после переподключения узлов.
    try {
      entry.source && entry.source.disconnect();
      entry.source.connect(entry.nodes[0]);
    } catch (error) {
      /* ignore */
    }
  }

  _teardownAudio(entry) {
    if (entry.audio) {
      if (entry.audio.parent) entry.audio.parent.remove(entry.audio);
      try {
        entry.audio.disconnect();
      } catch (error) {
        /* ignore */
      }
      entry.audio = null;
    }
    for (const node of entry.staticNodes || []) {
      try {
        node.stop && node.stop();
      } catch (error) {
        /* ignore */
      }
      try {
        node.disconnect();
      } catch (error) {
        /* ignore */
      }
    }
    entry.staticNodes = [];
    for (const node of entry.nodes || []) {
      try {
        node.disconnect();
      } catch (error) {
        /* ignore */
      }
    }
    entry.nodes = [];
    if (entry.source) {
      try {
        entry.source.disconnect();
      } catch (error) {
        /* ignore */
      }
      entry.source = null;
    }
    if (entry.analyser) {
      try {
        entry.analyser.disconnect();
      } catch (error) {
        /* ignore */
      }
      entry.analyser = null;
    }
    entry.stream = null;
    entry.gain = null;
    entry.flat = null;
    entry.level = 0;
    entry.speaking = false;
  }

  removePeer(remoteId) {
    this._closePeer(remoteId);
  }

  _closePeer(remoteId) {
    const entry = this.peers.get(remoteId);
    if (!entry) return;
    window.clearTimeout(this._retryTimers.get(remoteId));
    this._retryTimers.delete(remoteId);
    if (entry.call) {
      try {
        entry.call.close();
      } catch (error) {
        /* ignore */
      }
    }
    entry.call = null;
    this._teardownAudio(entry);
    this.peers.delete(remoteId);
    this._emitStatus(true);
  }

  isSpeaking(remoteId) {
    const entry = this.peers.get(remoteId);
    return Boolean(entry && entry.speaking);
  }

  // ---------------------------------------------------------------------------
  // Push-to-talk
  // ---------------------------------------------------------------------------

  _onKeyDown(event) {
    if (event.code !== 'KeyV' || this.mode !== 'ptt' || this.pttHeld) return;
    if (event.repeat) return;
    this.pttHeld = true;
    this._applyTrackState();
    if (this.enabled && !this.localStream && this.network && this.network.isActive) {
      this._ensureLocal().then(() => this._applyTrackState());
    }
    this.bus.emit('voice:ptt', { active: true });
  }

  _onKeyUp(event) {
    if (event.code !== 'KeyV' || !this.pttHeld) return;
    this.pttHeld = false;
    this._applyTrackState();
    this.bus.emit('voice:ptt', { active: false });
  }

  _onBlur() {
    if (!this.pttHeld) return;
    this.pttHeld = false;
    this._applyTrackState();
    this.bus.emit('voice:ptt', { active: false });
  }

  // ---------------------------------------------------------------------------
  // Кадр
  // ---------------------------------------------------------------------------

  update(dt, elapsed) {
    if (!this.initialized) return;
    if (this.audio.ctx && this.audio.ctx.state === 'suspended') {
      // Жест пользователя уже был — просто возобновляем.
      this.audio.ctx.resume().catch(() => {});
    }

    // Локальный уровень для индикаторов.
    if (this.localStream) {
      const { level } = this.audio.getMicLevel();
      this.localLevel = level;
      const speaking = this.enabled && (this.mode === 'open' || this.pttHeld) && level > 0.12;
      if (speaking !== this.localSpeaking) {
        this.localSpeaking = speaking;
        this.bus.emit('voice:localSpeaking', { speaking });
      }
    } else {
      this.localLevel = 0;
      this.localSpeaking = false;
    }

    // Удалённые игроки: пики, шум эфира, маршрутизация.
    for (const entry of this.peers.values()) {
      if (entry.analyser && entry.analyserData) {
        entry.analyser.getByteTimeDomainData(entry.analyserData);
        let sum = 0;
        for (let i = 0; i < entry.analyserData.length; i += 1) {
          const sample = (entry.analyserData[i] - 128) / 128;
          sum += sample * sample;
        }
        const rms = Math.sqrt(sum / entry.analyserData.length);
        const target = clamp((rms - 0.01) * 7, 0, 1);
        entry.level += (target - entry.level) * 0.35;
        entry.speaking = entry.level > 0.12;
        if (entry.staticGain) {
          const staticLevel = entry.speaking ? 0.006 + entry.level * 0.016 : 0.0006;
          entry.staticGain.gain.setTargetAtTime(staticLevel, this.listener.context.currentTime, 0.08);
        }
      }

      if (entry.audio) {
        const flat = !this.enabled || !this.localInCar || !entry.inCar;
        if (entry.flat !== flat) this._applyRouting(entry);
        if (!flat && entry.object3D) {
          const distance = this.camera.position.distanceTo(entry.object3D.position);
          const fade = 1 - clamp(
            (distance - CONFIG.voice.fadeStart) / (CONFIG.voice.fadeEnd - CONFIG.voice.fadeStart),
            0,
            1,
          );
          const volume = fade * fade * (this.enabled ? 1 : 0);
          if (Math.abs(volume - (entry.volume ?? -1)) > 0.01) {
            entry.volume = volume;
            entry.audio.setVolume(volume);
          }
        }
      }
    }

    this._emitStatus(false);
  }

  /** Микрофон отобрали в системе — восстанавливаем канал без перезапуска игры. */
  async handleMicLost() {
    window.clearTimeout(this._micRetryTimer);
    if (!this.enabled || !this.network || !this.network.isActive) return;
    this.bus.emit('voice:lost', {});
    for (const id of Array.from(this.peers.keys())) this._closePeer(id);
    this._teardownOutgoing();
    this.localStream = null;
    this._micRetryTimer = window.setTimeout(async () => {
      await this._ensureLocal();
      if (this._lastRoster) this.syncRoster(this._lastRoster);
    }, 1400);
  }

  leave() {
    window.clearTimeout(this._micRetryTimer);
    this._lastRoster = null;
    for (const id of Array.from(this.peers.keys())) this._closePeer(id);
    this.peers.clear();
    this._releaseLocal();
    this.localInCar = false;
    this.pttHeld = false;
    this._emitStatus(true);
  }
}

// =============================================================================
// ЧАСТЬ III — ПАССАЖИР, КОТОРЫЙ НЕ ПАССАЖИР
// -----------------------------------------------------------------------------
// Всё собрано из примитивов и процедурных материалов: ни одной внешней модели,
// ни одного сэмпла. Работает офлайн, в статике, без серверной части.
// =============================================================================

const DEMON_PHASE = Object.freeze({
  IDLE: 'idle',
  INCOGNITO: 'incognito',
  WAKING: 'waking',
  STUNNED: 'stunned',
  HUNTING: 'hunting',
  DEAD: 'dead',
});

const DEMON_BLOOD_COLOR = new THREE.Color(0x7c0a06);
const DEMON_BLOOD_EMISSIVE = new THREE.Color(0x520602);

/**
 * Сидящий пассажир: серое пальто, фарфоровое лицо, сгорбленная поза.
 * Умеет сидеть, обмякнуть в мешок с костями (ragdoll) и встать на охоту.
 */
class PassengerNPC {
  static POSES = {
    seated: {
      hipY: 0.53, bodyX: 0.16, bodyZ: 0.02, headX: 0.52, headY: 0,
      armX: -0.3, armZ: 0.06, elbowX: -1.2,
      thighX: -1.5, kneeX: 1.5, footX: 0.12,
    },
    waking: {
      hipY: 0.53, bodyX: 0.02, bodyZ: 0.05, headX: 0.06, headY: 0,
      armX: -0.52, armZ: 0.08, elbowX: -1.32,
      thighX: -1.5, kneeX: 1.5, footX: 0.12,
    },
    ragdoll: {
      hipY: 0.17, bodyX: 1.34, bodyZ: 0.24, headX: -0.22, headY: 0.4,
      armX: 0.16, armZ: 1.05, elbowX: -0.35,
      thighX: 1.45, kneeX: 0.12, footX: -0.2,
    },
    hunt: {
      hipY: 0.93, bodyX: -0.08, bodyZ: 0, headX: -0.14, headY: 0,
      armX: -1.5, armZ: 0.1, elbowX: -0.24,
      thighX: 0.02, kneeX: 0.04, footX: -0.04,
    },
  };

  constructor({ scene }) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'Пассажир без лица';
    scene.add(this.root);

    this.seat = { ...CONFIG.npc.seat };
    this.hitMeshes = [];
    this._bloodMats = [];
    this._joint = { ...PassengerNPC.POSES.seated };
    this._targetYaw = Math.PI / 2;
    this._time = 0;
    this._pulse = 0;
    this.pose = 'seated';
    this.blood = 0;

    this._build();
    this.reset();
  }

  // ---------------------------------------------------------------------------
  // Сборка
  // ---------------------------------------------------------------------------

  _material(color, { roughness = 0.92, metalness = 0.04, emissive = 0x000000, emissiveIntensity = 0, weight = 1, glow = 0.4 } = {}) {
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness,
      metalness,
      emissive,
      emissiveIntensity,
    });
    this._bloodMats.push({
      material,
      baseColor: new THREE.Color(color),
      baseEmissive: new THREE.Color(emissive),
      baseEmissiveIntensity: emissiveIntensity,
      weight,
      glow,
    });
    return material;
  }

  _add(geometry, material, parent, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    parent.add(mesh);
    this.hitMeshes.push(mesh);
    return mesh;
  }

  _build() {
    const coat = this._material(0x5a5c57, { roughness: 0.96, weight: 1, glow: 0.5 });
    const coatDark = this._material(0x3b3e3a, { roughness: 0.94, weight: 1, glow: 0.36 });
    const trousers = this._material(0x33352f, { roughness: 0.97, weight: 1, glow: 0.3 });
    const porcelain = this._material(0xd7d0bd, { roughness: 0.46, metalness: 0.02, weight: 1, glow: 0.8 });
    const hair = this._material(0x242723, { roughness: 0.9, weight: 1, glow: 0.2 });
    const leather = this._material(0x26221e, { roughness: 0.62, metalness: 0.12, weight: 1, glow: 0.24 });

    this.hips = new THREE.Group();
    this.hips.position.y = this.seat.y + 0.06;
    this.root.add(this.hips);

    this.body = new THREE.Group();
    this.hips.add(this.body);

    // Пальто / торс.
    this._add(new THREE.BoxGeometry(0.43, 0.63, 0.3), coat, this.body, 0, 0.33, 0);
    // Борт пальто и воротник.
    this._add(new THREE.BoxGeometry(0.08, 0.5, 0.02), coatDark, this.body, 0, 0.31, 0.155);
    this._add(new THREE.BoxGeometry(0.3, 0.08, 0.26), coatDark, this.body, 0, 0.625, 0);
    // Шарф.
    this._add(new THREE.BoxGeometry(0.24, 0.09, 0.22), leather, this.body, 0, 0.585, 0.02);
    // Плечи.
    this._add(new THREE.BoxGeometry(0.5, 0.1, 0.27), coat, this.body, 0, 0.55, 0);

    // Голова.
    this.head = new THREE.Group();
    this.head.position.set(0, 0.66, 0);
    this.body.add(this.head);
    this._add(new THREE.CylinderGeometry(0.055, 0.06, 0.1, 8), porcelain, this.head, 0, 0.02, 0);
    this._add(new THREE.SphereGeometry(0.132, 16, 12), porcelain, this.head, 0, 0.205, 0);
    // Фарфоровая маска: гладкая лицевая пластина без рта.
    this._add(new THREE.CylinderGeometry(0.118, 0.105, 0.1, 14, 1, false, 0, Math.PI * 2), porcelain, this.head, 0, 0.205, 0.055, Math.PI / 2, 0, 0);
    // Глазные впадины — две чёрные щели.
    this._add(new THREE.BoxGeometry(0.052, 0.018, 0.02), leather, this.head, -0.048, 0.225, 0.112);
    this._add(new THREE.BoxGeometry(0.052, 0.018, 0.02), leather, this.head, 0.048, 0.225, 0.112);
    // Волосы/кепка.
    this._add(new THREE.SphereGeometry(0.14, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), hair, this.head, 0, 0.235, -0.01);
    this._add(new THREE.CylinderGeometry(0.155, 0.155, 0.022, 16), hair, this.head, 0, 0.3, 0.01);

    // Глаза: в обычной личине погашены, после пробуждения — красные.
    this.eyeMaterial = new THREE.MeshStandardMaterial({
      color: 0x120504,
      emissive: 0xff2408,
      emissiveIntensity: 0,
      roughness: 0.3,
    });
    this._add(new THREE.SphereGeometry(0.017, 8, 6), this.eyeMaterial, this.head, -0.048, 0.226, 0.118);
    this._add(new THREE.SphereGeometry(0.017, 8, 6), this.eyeMaterial, this.head, 0.048, 0.226, 0.118);

    // Руки.
    const buildArm = (side) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.255, 0.53, 0);
      this.body.add(shoulder);
      this._add(new THREE.CapsuleGeometry(0.056, 0.24, 3, 8), coat, shoulder, 0, -0.15, 0);
      const elbow = new THREE.Group();
      elbow.position.set(0, -0.3, 0);
      shoulder.add(elbow);
      this._add(new THREE.CapsuleGeometry(0.048, 0.2, 3, 8), coatDark, elbow, 0, -0.14, 0);
      this._add(new THREE.SphereGeometry(0.055, 10, 8), porcelain, elbow, 0, -0.29, 0.01);
      return { shoulder, elbow };
    };
    const left = buildArm(-1);
    const right = buildArm(1);
    this.armL = left.shoulder;
    this.elbowL = left.elbow;
    this.armR = right.shoulder;
    this.elbowR = right.elbow;

    // Ноги.
    const buildLeg = (side) => {
      const hip = new THREE.Group();
      hip.position.set(side * 0.105, 0, 0);
      this.hips.add(hip);
      this._add(new THREE.CapsuleGeometry(0.075, 0.26, 3, 8), trousers, hip, 0, -0.2, 0);
      const knee = new THREE.Group();
      knee.position.set(0, -0.4, 0);
      hip.add(knee);
      this._add(new THREE.CapsuleGeometry(0.062, 0.3, 3, 8), trousers, knee, 0, -0.23, 0);
      const foot = this._add(new THREE.BoxGeometry(0.13, 0.075, 0.25), leather, knee, 0, -0.455, 0.06);
      return { hip, knee, foot };
    };
    const legLeft = buildLeg(-1);
    const legRight = buildLeg(1);
    this.legL = legLeft.hip;
    this.kneeL = legLeft.knee;
    this.footL = legLeft.foot;
    this.legR = legRight.hip;
    this.kneeR = legRight.knee;
    this.footR = legRight.foot;

    // Тень-пятно под телом: без неё в темноте фигура «висит».
    const shadowMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    this.shadow = new THREE.Mesh(new THREE.CircleGeometry(0.38, 20), shadowMaterial);
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.012;
    this.root.add(this.shadow);

    // Метка захвата.
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.3, 0.36, 26),
      new THREE.MeshBasicMaterial({
        color: 0xb9f7a4,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.marker.rotation.x = -Math.PI / 2;
    this.marker.position.y = 0.02;
    this.marker.visible = false;
    this.root.add(this.marker);

    // Красное свечение вокруг тела после пробуждения.
    this.aura = new THREE.PointLight(0xff2a12, 0, 4.6, 2);
    this.aura.position.set(0, 1.15, 0);
    this.root.add(this.aura);
  }

  // ---------------------------------------------------------------------------
  // Состояние
  // ---------------------------------------------------------------------------

  reset() {
    this.blood = 0;
    this.pose = 'seated';
    this.root.visible = true;
    this.root.position.set(this.seat.x, 0, this.seat.z);
    this.root.rotation.y = Math.PI / 2;
    this._targetYaw = Math.PI / 2;
    this._time = 0;
    this._joint = { ...PassengerNPC.POSES.seated };
    this.hips.position.y = this._joint.hipY;
    this.setBlood(0, true);
    this.setHighlight(false);
    this._applyJoints();
  }

  setPose(name) {
    if (!PassengerNPC.POSES[name]) return;
    this.pose = name;
  }

  setYaw(yaw, snap = false) {
    this._targetYaw = yaw;
    if (snap) this.root.rotation.y = yaw;
  }

  get yaw() {
    return this.root.rotation.y;
  }

  /** Мгновенно «наливает» материалы кровью. amount=1 — полное преображение. */
  setBlood(amount, instant = false) {
    this.blood = clamp(Number(amount) || 0, 0, 1);
    for (const entry of this._bloodMats) {
      entry.material.color.copy(entry.baseColor)
        .lerp(DEMON_BLOOD_COLOR, this.blood * entry.weight);
      entry.material.emissive.copy(entry.baseEmissive)
        .lerp(DEMON_BLOOD_EMISSIVE, this.blood * entry.weight);
      entry.material.emissiveIntensity = entry.baseEmissiveIntensity + this.blood * entry.glow;
    }
    if (this.eyeMaterial) this.eyeMaterial.emissiveIntensity = this.blood * 7.5;
    if (this.aura) this.aura.intensity = this.blood * 2.6;
    if (this.shadow) this.shadow.material.opacity = 0.5 - this.blood * 0.18;
    if (instant) this._applyJoints();
  }

  setHighlight(on) {
    if (this.marker) this.marker.visible = Boolean(on);
  }

  _applyJoints() {
    const j = this._joint;
    this.hips.position.y = j.hipY;
    this.body.rotation.set(j.bodyX, 0, j.bodyZ, 'XYZ');
    this.head.rotation.set(j.headX, j.headY, 0, 'XYZ');
    this.armL.rotation.set(j.armX, 0, j.armZ, 'XYZ');
    this.armR.rotation.set(j.armX, 0, -j.armZ, 'XYZ');
    this.elbowL.rotation.x = j.elbowX;
    this.elbowR.rotation.x = j.elbowX;
    this.legL.rotation.x = j.thighX;
    this.legR.rotation.x = j.thighX;
    this.kneeL.rotation.x = j.kneeX;
    this.kneeR.rotation.x = j.kneeX;
    this.footL.rotation.x = j.footX;
    this.footR.rotation.x = j.footX;
  }

  update(dt, elapsed) {
    if (!this.root.visible) return;
    this._time += dt;

    const target = PassengerNPC.POSES[this.pose] || PassengerNPC.POSES.seated;
    const lambda = this.pose === 'ragdoll' ? 7 : 9;
    for (const key of Object.keys(target)) {
      this._joint[key] = damp(this._joint[key], target[key], lambda, dt);
    }

    const shiver = this.pose === 'waking' ? Math.sin(this._time * 37) * 0.012 : 0;
    const breathe = this.pose === 'seated' ? Math.sin(elapsed * 1.6) * 0.008 : 0;

    this.hips.position.y = this._joint.hipY + breathe;
    this.body.rotation.set(this._joint.bodyX + shiver, 0, this._joint.bodyZ + shiver * 0.6, 'XYZ');
    this.head.rotation.set(
      this._joint.headX + breathe * 1.5,
      this._joint.headY + (this.pose === 'seated' ? Math.sin(elapsed * 0.23) * 0.05 : Math.sin(elapsed * 5.2) * 0.04),
      0,
      'XYZ',
    );
    this.armL.rotation.set(this._joint.armX, 0, this._joint.armZ, 'XYZ');
    this.armR.rotation.set(this._joint.armX, 0, -this._joint.armZ, 'XYZ');
    this.elbowL.rotation.x = this._joint.elbowX;
    this.elbowR.rotation.x = this._joint.elbowX;
    this.legL.rotation.x = this._joint.thighX;
    this.legR.rotation.x = this._joint.thighX;
    this.kneeL.rotation.x = this._joint.kneeX;
    this.kneeR.rotation.x = this._joint.kneeX;
    this.footL.rotation.x = this._joint.footX;
    this.footR.rotation.x = this._joint.footX;

    // Плавный поворот корпуса к цели (короткая дуга).
    const delta = Math.atan2(
      Math.sin(this._targetYaw - this.root.rotation.y),
      Math.cos(this._targetYaw - this.root.rotation.y),
    );
    this.root.rotation.y += delta * Math.min(1, dt * 10);

    if (this.marker && this.marker.visible) {
      this._pulse += dt;
      this.marker.material.opacity = 0.34 + Math.sin(this._pulse * 4.2) * 0.18;
    }

    if (this.aura && this.blood > 0) {
      this.aura.intensity = this.blood * (2.35 + Math.sin(elapsed * 6.4) * 0.28);
    }
    if (this.eyeMaterial && this.blood > 0) {
      this.eyeMaterial.emissiveIntensity = this.blood * (6.4 + Math.sin(elapsed * 9.1) * 1.1);
    }
  }
}

/**
 * «Уши» вагона: непрерывное распознавание русской речи + детектор крика
 * по сырому уровню микрофона. Микрофон берётся по ссылке у AudioManager,
 * поэтому не конфликтует с голосовым чатом.
 */
class VoiceWatcher {
  static PATTERNS = {
    'демон': /(?:^|\s)демон(?:а|у|ом|е|ы|ов)?(?=\s|$)/,
    'бежим': /(?:^|\s)(?:бежим|беги|бегом|бегите)(?=\s|$)/,
    'шокер': /(?:^|\s)шокер(?:а|у|ом|е|ы|ов)?(?=\s|$)/,
    'шесть пальцев': /шесть\s*пальц(?:ев|а|ы)?/,
  };

  constructor({ audio, bus, config }) {
    this.audio = audio;
    this.bus = bus;
    this.config = config;
    this.active = false;
    this.paused = false;
    this.micState = 'off';
    this.speechState = 'off';
    this.lastTranscript = '';
    this._micOk = false;
    this._fired = false;
    this._recognition = null;
    this._restartTimer = 0;
    this._screamAccum = 0;
    this._lastScreamAt = -Infinity;
    this._networkErrors = 0;
    this._lastStatus = '';
    this._supported = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
    this._onEnd = () => this._handleEnd();
  }

  get status() {
    return { mic: this.micState, speech: this.speechState };
  }

  _emit() {
    const key = `${this.micState}|${this.speechState}`;
    if (key === this._lastStatus) return;
    this._lastStatus = key;
    this.bus.emit('speech:status', { mic: this.micState, speech: this.speechState });
  }

  async start() {
    if (this.active) {
      this.resume();
      return;
    }
    this.active = true;
    this.paused = false;
    this._fired = false;
    this.lastTranscript = '';
    this._screamAccum = 0;
    this._networkErrors = 0;
    this.micState = 'requesting';
    this.speechState = 'off';
    this._emit();

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      this._micOk = false;
      this.micState = 'unsupported';
      this.speechState = 'unsupported';
      this._emit();
      return;
    }

    try {
      await this.audio.acquireMic('voiceai');
      if (!this.active) {
        this.audio.releaseMic('voiceai');
        return;
      }
      this._micOk = true;
      this.micState = 'on';
    } catch (error) {
      this._micOk = false;
      this.micState = error && error.code === 'MEDIA_UNSUPPORTED' ? 'unsupported' : 'denied';
      this.speechState = this._supported ? 'mic-denied' : 'unsupported';
      this._emit();
      return;
    }

    if (!this._supported) {
      this.speechState = 'unsupported';
      this._emit();
      return;
    }

    this._buildRecognition();
    this._startRecognition();
    this._emit();
  }

  stop() {
    this.active = false;
    this.paused = false;
    window.clearTimeout(this._restartTimer);
    this._restartTimer = 0;
    this._teardownRecognition();
    if (this._micOk) this.audio.releaseMic('voiceai');
    this._micOk = false;
    this._screamAccum = 0;
    this.micState = 'off';
    this.speechState = 'off';
    this._emit();
  }

  pause() {
    if (!this.active || this.paused) return;
    this.paused = true;
    this._screamAccum = 0;
    window.clearTimeout(this._restartTimer);
    this._restartTimer = 0;
    if (this._recognition) {
      try {
        this._recognition.abort();
      } catch (error) {
        /* ignore */
      }
    }
    if (this._micOk) this.speechState = 'paused';
    this._emit();
  }

  resume() {
    if (!this.active || !this.paused) return;
    this.paused = false;
    if (this._micOk && this._supported && this.speechState !== 'denied' && this.speechState !== 'error') {
      this._startRecognition();
    }
    this._emit();
  }

  _buildRecognition() {
    if (this._recognition) return;
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) return;
    let recognition;
    try {
      recognition = new Recognition();
    } catch (error) {
      this.speechState = 'unsupported';
      return;
    }
    recognition.lang = this.config.lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 3;
    recognition.onstart = () => {
      this._networkErrors = 0;
      this.speechState = 'listening';
      this._emit();
    };
    recognition.onresult = (event) => {
      this._networkErrors = 0;
      if (!event.results) return;
      let text = '';
      for (let index = event.resultIndex || 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result) continue;
        const alternative = result[0];
        if (alternative && alternative.transcript) text += ` ${alternative.transcript}`;
      }
      if (text.trim()) this.onTranscript(text);
    };
    recognition.onerror = (event) => {
      const error = event && event.error;
      if (error === 'not-allowed' || error === 'service-not-allowed') {
        this.speechState = 'denied';
        this._emit();
        return;
      }
      if (error === 'language-not-supported') {
        // В сборке без ru-RU распознавание бессмысленно: остаётся детектор крика.
        this.speechState = 'unsupported';
        this._emit();
        return;
      }
      if (error === 'audio-capture') {
        this._micOk = false;
        this.micState = 'denied';
        this.speechState = 'off';
        this._emit();
        return;
      }
      if (error === 'network') {
        this._networkErrors += 1;
        if (this._networkErrors >= 3) {
          this.speechState = 'error';
          this._emit();
          window.clearTimeout(this._restartTimer);
          this._restartTimer = 0;
        }
        return;
      }
      // no-speech, aborted, audio-capture — перезапуск сделает onend.
    };
    recognition.onend = this._onEnd;
    this._recognition = recognition;
  }

  _teardownRecognition() {
    if (!this._recognition) return;
    const recognition = this._recognition;
    this._recognition = null;
    recognition.onstart = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try {
      recognition.abort();
    } catch (error) {
      /* ignore */
    }
  }

  _startRecognition() {
    if (!this.active || this.paused || !this._recognition) return;
    if (this.speechState === 'denied' || this.speechState === 'error'
      || this.speechState === 'unsupported') return;
    window.clearTimeout(this._restartTimer);
    this._restartTimer = 0;
    this.speechState = 'restarting';
    this._emit();
    try {
      this._recognition.start();
    } catch (error) {
      // InvalidStateError: распознавание уже идёт.
      if (!error || error.name !== 'InvalidStateError') {
        this._restartTimer = window.setTimeout(() => this._startRecognition(), this.config.restartDelay);
      }
    }
  }

  _handleEnd() {
    if (!this.active || this.paused) {
      this.speechState = this.active ? 'paused' : 'off';
      this._emit();
      return;
    }
    if (this.speechState === 'denied' || this.speechState === 'error'
      || this.speechState === 'unsupported' || !this._micOk) {
      this._emit();
      return;
    }
    this.speechState = 'restarting';
    this._emit();
    window.clearTimeout(this._restartTimer);
    this._restartTimer = window.setTimeout(
      () => this._startRecognition(),
      this.config.restartDelay,
    );
  }

  normalize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      // «6 пальцев» после чистки знаков становится «шесть пальцев».
      .replace(/(^|\s)6(?=\s|$)/g, '$1шесть');
  }

  onTranscript(text) {
    if (!this.active || this.paused) return;
    const normalized = this.normalize(text);
    if (!normalized) return;
    this.lastTranscript = normalized;
    this.bus.emit('speech:heard', { text: normalized });

    for (const keyword of this.config.keywords) {
      const normalizedKeyword = String(keyword).toLowerCase().replace(/ё/g, 'е');
      const pattern = VoiceWatcher.PATTERNS[normalizedKeyword]
        || new RegExp(`(?:^|\\s)${normalizedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`);
      if (pattern.test(normalized)) {
        this._fire('voice', normalizedKeyword);
        return;
      }
    }
  }

  update(dt) {
    if (!this.active || this.paused) return;
    if (!this._micOk) {
      // Микрофон могли отобрать в системе и вернуть через голосовой чат.
      if (this.audio.mic.active) {
        this._micOk = true;
        this.micState = 'on';
        if (!this._recognition && this._supported) {
          this._buildRecognition();
          this._startRecognition();
        }
        this._emit();
      }
      return;
    }
    if (this._fired) return;
    if (this.audio.mic.active === false) {
      this._micOk = false;
      this.micState = 'denied';
      this.speechState = 'off';
      this._emit();
      return;
    }
    const { level } = this.audio.getMicLevel();
    if (!Number.isFinite(level)) return;
    if (level >= this.config.screamLevel) {
      this._screamAccum += dt;
      if (this._screamAccum >= this.config.screamHold) {
        const now = performance.now();
        if (now - this._lastScreamAt > this.config.screamCooldown) {
          this._lastScreamAt = now;
          this._fire('scream', null);
        }
      }
    } else {
      this._screamAccum = Math.max(0, this._screamAccum - dt * 2.4);
    }
  }

  _fire(source, keyword) {
    if (this._fired) return;
    this._fired = true;
    this._screamAccum = 0;
    this.bus.emit('demon:heard', { source, keyword });
  }
}

/**
 * Режиссёр Части III. Хост владеет пассажиром и рассылает его состояние,
 * гости присылают только «схватить» и «тащу». В соло роль хоста играет
 * локальный NetworkManager без соединений — код тот же самый.
 */
class DemonDirector {
  constructor({
    scene, camera, world, player, audio, bus, network, ui, watcher,
    getPlayerName, onGameOver,
  }) {
    this.scene = scene;
    this.camera = camera;
    this.world = world;
    this.player = player;
    this.audio = audio;
    this.bus = bus;
    this.network = network;
    this.ui = ui;
    this.watcher = watcher;
    this.getPlayerName = getPlayerName;
    this.onGameOver = onGameOver;

    this.npc = new PassengerNPC({ scene });
    this.active = false;
    this.phase = DEMON_PHASE.IDLE;
    this._ray = new THREE.Raycaster();
    this._center = new THREE.Vector2(0, 0);
    this._rayTarget = null;
    this._npcDistance = Infinity;
    this._wakeTimer = 0;
    this._stunTimer = 0;
    this._huntTime = 0;
    this._stateClock = 0;
    this._draggingId = null;
    this._dragStartedAt = 0;
    this._deadIds = new Set();
    this._killed = false;
    this._guestHuntAnnounced = false;
    this._selfPos = new THREE.Vector3();
    this._euler = new THREE.Euler();

    this.bus.on('player:interact', (payload) => this._onInteract(payload));
    this.bus.on('demon:heard', (payload) => this._onHeard(payload));
    this.bus.on('network:demon', (payload) => this._onNetworkDemon(payload));
    this.bus.on('network:peerJoined', (player) => this._onPeerJoined(player));
  }

  // ---------------------------------------------------------------------------
  // Жизненный цикл
  // ---------------------------------------------------------------------------

  activate() {
    this.npc.reset();
    this.active = true;
    this.phase = DEMON_PHASE.INCOGNITO;
    this._wakeTimer = 0;
    this._stunTimer = 0;
    this._huntTime = 0;
    this._stateClock = 0;
    this._draggingId = null;
    this._deadIds.clear();
    this._killed = false;
    this._guestHuntAnnounced = false;
    this._rayTarget = null;
    this._npcDistance = Infinity;
    this.player.setSpeedScale(1);
    this.world.setBlackout(false);
    this.ui.setScare(false);
    this.ui.hidePrompt();
  }

  reset() {
    this.active = false;
    this.phase = DEMON_PHASE.IDLE;
    this._draggingId = null;
    this._deadIds.clear();
    this._killed = false;
    this._rayTarget = null;
    this._npcDistance = Infinity;
    this._wakeTimer = 0;
    this._stunTimer = 0;
    this.player.setSpeedScale(1);
    this.world.setBlackout(false);
    this.ui.setScare(false);
    this.ui.hidePrompt();
    this.npc.reset();
  }

  /** Пауза: отпускаем тело, чтобы замедление не «залипло» после возврата. */
  pause() {
    this._endDrag({ silent: true });
    this._rayTarget = null;
    this.npc.setHighlight(false);
    this.ui.hidePrompt();
  }

  // ---------------------------------------------------------------------------
  // Триггеры
  // ---------------------------------------------------------------------------

  _onHeard({ source } = {}) {
    if (!this.active || this.phase !== DEMON_PHASE.INCOGNITO) return;
    if (this._isHost()) {
      this._beginReveal(source || 'voice', false);
      return;
    }
    this.network.sendDemon({ kind: 'wake', source: source || 'voice', stun: false });
    // До ответа хоста локально показываем, что сигнал ушёл.
    this.ui.showToast('СИГНАЛ УШЁЛ В ВАГОН…', 'warning', 1200);
  }

  _beginReveal(source, stun) {
    if (this.phase !== DEMON_PHASE.INCOGNITO) return false;
    this.network.sendDemon({ kind: 'wake', source, stun: Boolean(stun) });
    this._applyReveal(source, stun);
    return true;
  }

  _applyReveal(source, stun) {
    if (this.phase !== DEMON_PHASE.INCOGNITO) return;
    this.phase = stun ? DEMON_PHASE.STUNNED : DEMON_PHASE.WAKING;
    this._stunTimer = stun ? CONFIG.npc.stunTime : 0;
    this._wakeTimer = stun ? 0 : CONFIG.demon.wakeDelay;
    this._killed = false;
    this._guestHuntAnnounced = false;

    // Маска слетает мгновенно: кровь, глаза, свечение.
    this.npc.setBlood(1);
    this.npc.setPose(stun ? 'ragdoll' : 'waking');
    this.npc.setHighlight(false);
    this.ui.hidePrompt();
    this.ui.setScare(true);
    this.world.setBlackout(true);
    this.audio.screech();

    const target = this._closestPlayer();
    if (target) {
      const dx = target.x - this.npc.root.position.x;
      const dz = target.z - this.npc.root.position.z;
      this.npc.setYaw(Math.atan2(dx, dz), true);
    }

    const message = source === 'scream'
      ? 'КРИК РАЗБУДИЛ ЕГО // СВЕТ ПОГАС'
      : source === 'grab'
        ? 'ВЫ ПРИКОСНУЛИСЬ К НЕМУ // СВЕТ ПОГАС'
        : 'ОН УСЛЫШАЛ ВАС // СВЕТ ПОГАС';
    this.ui.showToast(message, 'error', 6200);
    this.bus.emit('demon:awakened', { source });
  }

  _startHunt() {
    if (this.phase === DEMON_PHASE.HUNTING || this.phase === DEMON_PHASE.DEAD) return;
    this.phase = DEMON_PHASE.HUNTING;
    this._huntTime = 0;
    this._wakeTimer = 0;
    this._stunTimer = 0;
    this._endDrag({ silent: true });
    this.npc.setPose('hunt');
    this.ui.hidePrompt();
    if (!this._guestHuntAnnounced) {
      this._guestHuntAnnounced = true;
      this.ui.showToast('ОН ВСТАЛ // БЕГИТЕ', 'error', 3600);
    }
  }

  // ---------------------------------------------------------------------------
  // Кадр
  // ---------------------------------------------------------------------------

  update(dt, elapsed) {
    if (!this.active) return;
    this.npc.update(dt, elapsed);

    if (this.phase === DEMON_PHASE.WAKING) {
      this._wakeTimer -= dt;
      if (this._wakeTimer <= 0) this._startHunt();
    } else if (this.phase === DEMON_PHASE.STUNNED) {
      this._stunTimer -= dt;
      if (this._stunTimer <= 0) this._startHunt();
    }

    if (this.phase === DEMON_PHASE.INCOGNITO || this.phase === DEMON_PHASE.STUNNED) {
      this._updateFocus();
      this._updatePrompt();
    } else {
      if (this._rayTarget) {
        this._rayTarget = null;
        this.npc.setHighlight(false);
      }
      this.ui.hidePrompt();
    }

    if (this.phase === DEMON_PHASE.STUNNED) this._updateDragging(dt);
    if (this.phase === DEMON_PHASE.HUNTING && this._isHost()) this._updateHunt(dt);
    if (this._isHost()) this._broadcastState(dt);
  }

  _updateFocus() {
    // Матрица камеры могла ещё не обновиться в этом кадре — иначе луч
    // уходит в старую точку и подсказка «мигает».
    this.camera.updateMatrixWorld(true);
    this.npc.root.updateMatrixWorld(true);
    const npc = this.npc.root.position;
    const distance = Math.hypot(this.player.position.x - npc.x, this.player.position.z - npc.z);
    this._npcDistance = distance;

    let hit = null;
    if (distance <= CONFIG.npc.lookDistance) {
      this._ray.setFromCamera(this._center, this.camera);
      const hits = this._ray.intersectObjects(this.npc.hitMeshes, false);
      if (hits.length > 0 && hits[0].distance <= CONFIG.npc.lookDistance + 1.4) hit = hits[0];
    }
    this._rayTarget = hit;
    this.npc.setHighlight(Boolean(hit));
  }

  _updatePrompt() {
    if (this.phase === DEMON_PHASE.STUNNED) {
      // Тело уже на полу: смотреть точно в него не нужно, достаточно близости.
      if (this._draggingId && this._draggingId === this._selfId()) {
        this.ui.showPrompt('ОТПУСТИТЕ E — БРОСИТЬ ТЕЛО', 'E', 'danger');
      } else if (this._npcDistance <= CONFIG.npc.grabDistance + 0.5) {
        this.ui.showPrompt('УДЕРЖИВАЙТЕ E — ТАЩИТЬ ТЕЛО', 'E', 'danger');
      } else {
        this.ui.hidePrompt();
      }
      return;
    }
    if (!this._rayTarget) {
      this.ui.hidePrompt();
      return;
    }
    if (this.phase === DEMON_PHASE.INCOGNITO) {
      if (this._npcDistance <= CONFIG.npc.grabDistance) {
        this.ui.showPrompt('СХВАТИТЬ ПАССАЖИРА ЗА ПЛЕЧО', 'E', 'normal');
      } else {
        this.ui.showPrompt('ПОДОЙДИТЕ БЛИЖЕ', '', 'normal');
      }
      return;
    }
    this.ui.hidePrompt();
  }

  // ---------------------------------------------------------------------------
  // Взаимодействие
  // ---------------------------------------------------------------------------

  _onInteract({ held } = {}) {
    if (!this.active) return;
    if (this.phase !== DEMON_PHASE.INCOGNITO && this.phase !== DEMON_PHASE.STUNNED) return;

    if (!held) {
      if (this._draggingId === this._selfId()) this._endDrag();
      return;
    }

    if (this.phase === DEMON_PHASE.STUNNED) {
      if (this._npcDistance <= CONFIG.npc.grabDistance + 0.5) this._beginDrag();
      return;
    }

    if (!this._rayTarget) return;
    if (this._npcDistance > CONFIG.npc.grabDistance) return;
    if (this._isHost()) {
      this._beginReveal('grab', true);
    } else {
      this.network.sendDemon({ kind: 'grab' });
    }
  }

  _beginDrag() {
    if (this.phase !== DEMON_PHASE.STUNNED) return;
    const selfId = this._selfId();
    if (this._draggingId && this._draggingId !== selfId) return;
    this._draggingId = selfId;
    this._dragStartedAt = performance.now();
    this.player.setSpeedScale(CONFIG.npc.dragScale);
    if (!this._isHost()) this.network.sendDemon({ kind: 'drag', active: true });
    this.ui.showToast('ТЕЛО СЛУШАЕТСЯ // ВЫ ЕДВА ИДЁТЕ', 'warning', 2600);
    this._stateClock = 0;
    this._updatePrompt();
  }

  _endDrag({ silent = false } = {}) {
    if (!this._draggingId) return;
    const selfId = this._selfId();
    const wasLocal = this._draggingId === selfId;
    this._draggingId = null;
    this.player.setSpeedScale(1);
    if (!this._isHost()) this.network.sendDemon({ kind: 'drag', active: false });
    if (wasLocal && !silent) this.ui.showToast('ТЕЛО ОСТАЛОСЬ НА ПОЛУ', 'warning', 2200);
    if (this.active && this.phase === DEMON_PHASE.STUNNED) this._updatePrompt();
  }

  _updateDragging(dt) {
    if (!this._draggingId) return;
    const pose = this._playerPose(this._draggingId);
    if (!pose) {
      this._endDrag({ silent: true });
      return;
    }
    this._placeBody(pose, dt);
  }

  _placeBody(pose, dt) {
    const yaw = pose.yaw;
    const forwardX = -Math.sin(yaw);
    const forwardZ = -Math.cos(yaw);
    const bounds = this.world.bounds;
    const targetX = clamp(
      pose.x + forwardX * CONFIG.npc.dragOffset,
      bounds.minX + CONFIG.demon.bodyRadius,
      bounds.maxX - CONFIG.demon.bodyRadius,
    );
    const targetZ = clamp(
      pose.z + forwardZ * CONFIG.npc.dragOffset,
      bounds.minZ + CONFIG.demon.bodyRadius,
      bounds.maxZ - CONFIG.demon.bodyRadius,
    );
    const position = this.npc.root.position;
    const lambda = CONFIG.npc.dragLerp;
    position.x = damp(position.x, targetX, lambda, dt);
    position.z = damp(position.z, targetZ, lambda, dt);
    this.npc.setYaw(yaw + Math.PI, true);
  }

  // ---------------------------------------------------------------------------
  // Охота (только хост)
  // ---------------------------------------------------------------------------

  _updateHunt(dt) {
    this._huntTime += dt;
    const target = this._closestPlayer();
    if (!target) return;

    const npc = this.npc.root.position;
    const dx = target.x - npc.x;
    const dz = target.z - npc.z;
    const distance = Math.hypot(dx, dz);
    if (distance <= CONFIG.demon.killDistance) {
      this._kill(target);
      return;
    }

    this.npc.setYaw(Math.atan2(dx, dz), false);
    const ramp = clamp(0.5 + (this._huntTime / Math.max(0.01, CONFIG.demon.standTime)) * 0.5, 0.5, 1);
    const step = CONFIG.demon.huntSpeed * ramp * dt;
    this._advance(target, step);

    const after = Math.hypot(target.x - npc.x, target.z - npc.z);
    if (after <= CONFIG.demon.killDistance) this._kill(target);
  }

  _advance(target, step) {
    const npc = this.npc.root.position;
    const dx = target.x - npc.x;
    const dz = target.z - npc.z;
    let moveX = 0;
    let moveZ = 0;

    if (Math.abs(npc.x) > 1.02) {
      // Тело поднимается из-за скамьи: коллизии игнорируем, пока оно
      // не выйдет в проход, иначе демон навсегда застревает в мебели.
      moveX = Math.sign(CONFIG.demon.aisleX - npc.x) || 1;
      moveZ = Math.abs(dz) > 0.8 ? Math.sign(dz) * 0.4 : 0;
    } else if (Math.abs(dz) > 0.85) {
      moveX = Math.sign(CONFIG.demon.aisleX - npc.x) * 0.35;
      moveZ = Math.sign(dz);
    } else {
      moveX = dx;
      moveZ = dz;
    }

    const length = Math.hypot(moveX, moveZ) || 1;
    const stepX = (moveX / length) * step;
    const stepZ = (moveZ / length) * step;

    if (Math.abs(npc.x) > 1.02) {
      npc.x += stepX;
      npc.z += stepZ;
      return;
    }

    const blocked = (x, z) => {
      const radius = CONFIG.demon.bodyRadius;
      const bounds = this.world.bounds;
      if (
        x < bounds.minX + radius || x > bounds.maxX - radius
        || z < bounds.minZ + radius || z > bounds.maxZ - radius
      ) {
        return true;
      }
      for (const collider of this.world.colliders) {
        const closestX = clamp(x, collider.minX, collider.maxX);
        const closestZ = clamp(z, collider.minZ, collider.maxZ);
        const offsetX = x - closestX;
        const offsetZ = z - closestZ;
        if (offsetX * offsetX + offsetZ * offsetZ < radius * radius) return true;
      }
      return false;
    };

    if (!blocked(npc.x + stepX, npc.z + stepZ)) {
      npc.x += stepX;
      npc.z += stepZ;
      return;
    }
    if (!blocked(npc.x + stepX, npc.z)) {
      npc.x += stepX;
      return;
    }
    if (!blocked(npc.x, npc.z + stepZ)) {
      npc.z += stepZ;
      return;
    }
    // Обходим препятствие по кратчайшей стороне.
    const nudge = Math.sign(CONFIG.demon.aisleX - npc.x) || 1;
    if (!blocked(npc.x + nudge * 0.02, npc.z)) npc.x += nudge * 0.02;
  }

  _kill(target) {
    if (this._killed || this.phase === DEMON_PHASE.DEAD) return;
    this._killed = true;
    const name = target.name || 'ПАССАЖИР';
    this._deadIds.add(target.id);
    this.network.sendDemon({ kind: 'kill', target: target.id, name });
    this._endDrag({ silent: true });
    this.phase = DEMON_PHASE.DEAD;
    this.npc.setPose('hunt');
    // Игра заканчивается для всего экипажа: это хоррор, а не аркада.
    this.onGameOver({ target: target.id, name });
  }

  // ---------------------------------------------------------------------------
  // Игроки и сеть
  // ---------------------------------------------------------------------------

  _selfId() {
    return (this.network && this.network.selfId) || 'local';
  }

  _isHost() {
    return Boolean(this.network && this.network.isHost);
  }

  _cameraYaw() {
    this._euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
    return this._euler.y;
  }

  _nameOf(id) {
    if (id === this._selfId()) return this.getPlayerName ? this.getPlayerName() : 'ВЫ';
    const entry = this.network.roster && this.network.roster.get(id);
    return (entry && entry.name) || 'ПАССАЖИР';
  }

  _playerPose(id) {
    if (id === this._selfId()) {
      return {
        id,
        x: this.player.position.x,
        z: this.player.position.z,
        yaw: this._cameraYaw(),
        name: this._nameOf(id),
      };
    }
    const entry = this.network.remoteStates && this.network.remoteStates.get(id);
    if (!entry || !entry.s) return null;
    return {
      id,
      x: Number(entry.s.x) || 0,
      z: Number(entry.s.z) || 0,
      yaw: Number(entry.s.yaw) || 0,
      name: this._nameOf(id),
    };
  }

  _allPlayers() {
    const list = [{
      id: this._selfId(),
      x: this.player.position.x,
      z: this.player.position.z,
      yaw: this._cameraYaw(),
      name: this._nameOf(this._selfId()),
    }];
    if (!this.network.remoteStates) return list;
    for (const [id, entry] of this.network.remoteStates) {
      if (!entry || !entry.s) continue;
      // Записи удаляются при выходе игрока, поэтому давность пакета не
      // проверяем: иначе на лагающем канале демон «теряет» цель.
      list.push({
        id,
        x: Number(entry.s.x) || 0,
        z: Number(entry.s.z) || 0,
        yaw: Number(entry.s.yaw) || 0,
        name: this._nameOf(id),
      });
    }
    return list;
  }

  _closestPlayer() {
    const npc = this.npc.root.position;
    let best = null;
    let bestDistance = Infinity;
    for (const player of this._allPlayers()) {
      if (this._deadIds.has(player.id)) continue;
      const distance = Math.hypot(player.x - npc.x, player.z - npc.z);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = player;
      }
    }
    return best;
  }

  _broadcastState(dt) {
    if (!this._isHost()) return;
    if (this.phase === DEMON_PHASE.IDLE || this.phase === DEMON_PHASE.INCOGNITO) return;
    this._stateClock -= dt;
    if (this._stateClock > 0) return;
    this._stateClock = CONFIG.demon.stateInterval;
    const position = this.npc.root.position;
    this.network.sendDemon({
      kind: 'state',
      phase: this.phase,
      x: Number(position.x.toFixed(3)),
      z: Number(position.z.toFixed(3)),
      yaw: Number(this.npc.yaw.toFixed(3)),
      blood: Number(this.npc.blood.toFixed(2)),
      drag: this._draggingId || null,
    });
  }

  _onPeerJoined(player) {
    if (!this._isHost() || !this.active || !player) return;
    if (this.phase === DEMON_PHASE.IDLE || this.phase === DEMON_PHASE.INCOGNITO) return;
    const position = this.npc.root.position;
    this.network.sendDemon({
      kind: 'sync',
      phase: this.phase,
      x: Number(position.x.toFixed(3)),
      z: Number(position.z.toFixed(3)),
      yaw: Number(this.npc.yaw.toFixed(3)),
      blood: this.npc.blood,
    }, player.id);
  }

  _onNetworkDemon(data = {}) {
    if (!this.active || !data) return;
    if (this._isHost()) {
      if (data.kind === 'wake') {
        if (data.from) this._beginReveal(data.source || 'voice', Boolean(data.stun));
      } else if (data.kind === 'grab') {
        this._hostGuestGrab(data.from);
      } else if (data.kind === 'drag') {
        this._hostGuestDrag(data.from, Boolean(data.active));
      }
      return;
    }

    if (data.kind === 'wake') {
      this._applyReveal(data.source || 'voice', Boolean(data.stun));
      return;
    }
    if (data.kind === 'state' || data.kind === 'sync') {
      this._applyRemoteState(data);
      return;
    }
    if (data.kind === 'kill') {
      if (!data.target) return;
      this._deadIds.add(data.target);
      if (this.phase !== DEMON_PHASE.DEAD) {
        // Пакет state мог не дойти до нас (например, канал только что открылся),
        // но смерть всё равно должна выглядеть одинаково: кровь, тьма, визг.
        if (this.phase === DEMON_PHASE.INCOGNITO) this._applyReveal('voice', false);
        this.phase = DEMON_PHASE.DEAD;
        this.npc.setPose('hunt');
        this.onGameOver({ target: data.target, name: data.name || 'ПАССАЖИР' });
      }
    }
  }

  _applyRemoteState(data) {
    if (!data.phase || data.phase === DEMON_PHASE.INCOGNITO) return;
    if (this.phase === DEMON_PHASE.DEAD) return;

    if (this.phase === DEMON_PHASE.INCOGNITO) {
      this._applyReveal('voice', data.phase === DEMON_PHASE.STUNNED);
      // Гость не тикает таймеры самостоятельно: всё придёт от хоста.
      if (this.phase === DEMON_PHASE.STUNNED) this._stunTimer = 999;
      if (this.phase === DEMON_PHASE.WAKING) this._wakeTimer = 999;
    }

    const incoming = data.phase;
    if (incoming !== DEMON_PHASE.STUNNED && this._draggingId) {
      this._endDrag({ silent: true });
    } else if (
      this._draggingId
      && this._draggingId !== data.drag
      && performance.now() - (this._dragStartedAt || 0) > 700
    ) {
      // Хост отпустил тело раньше нас (но не в первые кадры запроса).
      this._endDrag({ silent: true });
    }
    this.phase = incoming;
    this.npc.setBlood(typeof data.blood === 'number' ? data.blood : 1);
    this.npc.setPose(
      incoming === DEMON_PHASE.HUNTING
        ? 'hunt'
        : incoming === DEMON_PHASE.STUNNED || incoming === DEMON_PHASE.DEAD
          ? 'ragdoll'
          : 'waking',
    );
    if (typeof data.x === 'number') {
      const isLocalDrag = this._draggingId === this._selfId();
      if (!isLocalDrag) this.npc.root.position.set(data.x, 0, Number(data.z) || 0);
    }
    if (typeof data.yaw === 'number') this.npc.setYaw(data.yaw, true);
    if (incoming === DEMON_PHASE.HUNTING && !this._guestHuntAnnounced) {
      this._guestHuntAnnounced = true;
      this.ui.showToast('ОН ВСТАЛ // БЕГИТЕ', 'error', 3600);
    }
    this.ui.setScare(true);
    this.world.setBlackout(true);
  }

  _hostGuestGrab(fromId) {
    if (!fromId || this.phase !== DEMON_PHASE.INCOGNITO) return;
    const pose = this._playerPose(fromId);
    if (!pose) return;
    const npc = this.npc.root.position;
    const distance = Math.hypot(pose.x - npc.x, pose.z - npc.z);
    if (distance > CONFIG.npc.grabDistance + 0.7) return;
    this._beginReveal('grab', true);
  }

  _hostGuestDrag(fromId, active) {
    if (!fromId) return;
    if (!active) {
      if (this._draggingId === fromId) this._endDrag({ silent: true });
      return;
    }
    if (this.phase !== DEMON_PHASE.STUNNED) return;
    const pose = this._playerPose(fromId);
    if (!pose) return;
    const npc = this.npc.root.position;
    const distance = Math.hypot(pose.x - npc.x, pose.z - npc.z);
    if (distance > CONFIG.npc.grabDistance + 1.4) return;
    this._draggingId = fromId;
    this._stateClock = 0;
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
    this._lobbyCode = '';
    this._lobbyMode = 'host';
    this._roster = [];
    this._voiceState = null;
    this._micTestActive = false;
    this._copyTimer = 0;
    this._lastCrewCount = 0;
    this._promptKey = '';
    this._promptTone = '';
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
      prompt: $('#hud-prompt'),
      promptKey: $('#hud-prompt-key'),
      promptText: $('#hud-prompt-text'),
      listen: $('#hud-listen'),
      listenText: $('#hud-listen-text'),
      scare: $('#scare-overlay'),

      pauseResume: $('#btn-resume'),
      pauseSettings: $('#btn-pause-settings'),
      pauseExit: $('#btn-exit'),
      pauseTitle: $('#pause-title'),
      pauseText: $('#pause-text'),
      pauseLobbyCode: $('#pause-lobby-code'),
      pauseCrew: $('#pause-crew'),

      lobby: $('#lobby-screen'),
      lobbyTitle: $('#lobby-title'),
      lobbySubtitle: $('#lobby-subtitle'),
      lobbyCode: $('#lobby-code-value'),
      lobbyStatus: $('#lobby-status'),
      lobbyStatusText: $('#lobby-status-text'),
      lobbyRoster: $('#lobby-roster-list'),
      lobbyCount: $('#lobby-count'),
      lobbyVoice: $('#lobby-voice'),
      lobbyEnter: $('#btn-enter-car'),
      lobbyLeave: $('#btn-leave-lobby'),
      lobbyCopy: $('#btn-copy-code'),

      ended: $('#modal-ended'),
      endedKicker: $('#ended-kicker'),
      endedTitle: $('#ended-title'),
      endedText: $('#ended-text'),
      endedButton: $('#btn-ended-menu'),

      hudCrew: $('#hud-crew'),
      hudPing: $('#hud-ping'),
      hudVoice: $('#hud-voice'),
      hudVoiceText: $('#hud-voice-text'),
      menuVoiceStatus: $('#menu-voice-status'),

      voiceEnabled: $('#voice-enabled'),
      voiceModeButtons: $$('[data-voice-mode]'),
      voiceHint: $('#voice-hint'),
      callsign: $('#callsign'),

      netTransport: $('#net-transport'),
      netStatus: $('#net-status'),
      netResults: $('#net-results'),
      netTest: $('#btn-net-test'),
      netTestLabel: $('#btn-net-test-label'),
      relayCustom: $('#relay-custom'),

      clock: $('#menu-clock'),
    };

    this._buildMeter();
    this._bind();
    this._applySettingsToUI();
    this._resetMicVisuals();
    this._startClock();

    this.bus.on('player:stamina', (state) => this.setStamina(state));
    this.bus.on('network:lobbyCreated', (session) => this.setLobbyCode(session.code));
    this.bus.on('network:lobbyReady', ({ code, strategy }) => {
      this.setLobbyCode(code);
      this.setNetworkStatus({
        status: 'hosting',
        detail: strategy ? `КАНАЛ ${String(strategy).toUpperCase()}` : null,
      });
    });
    this.bus.on('network:roster', (roster) => this.onRoster(roster));
    this.bus.on('network:status', (status) => this.setNetworkStatus(status));
    this.bus.on('network:latency', ({ rtt }) => this.setLatency(rtt));
    this.bus.on('voice:status', (state) => this.setVoiceState(state));
    this.bus.on('voice:localSpeaking', ({ speaking }) => this.setLocalSpeaking(speaking));
    this.bus.on('voice:ptt', ({ active }) => this.setPttActive(active));
    this.bus.on('network:peerJoined', (player) => {
      if (player) this.showToast(`${player.name} ВОШЁЛ В ВАГОН`, 'success', 3200);
    });
    this.bus.on('network:peerLeft', ({ player, reason } = {}) => {
      if (!player) return;
      if (reason === 'timeout') {
        this.showToast(`${player.name}: СВЯЗЬ ПОТЕРЯНА`, 'warning', 3600);
      } else {
        this.showToast(`${player.name} ПОКИНУЛ ВАГОН`, 'info', 3200);
      }
    });
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

    if (this.el.lobbyEnter) {
      this.el.lobbyEnter.addEventListener('click', () => {
        this.audio.uiConfirm();
        this.bus.emit('ui:enterCar');
      });
    }
    if (this.el.lobbyLeave) {
      this.el.lobbyLeave.addEventListener('click', () => {
        this.audio.uiBack();
        this.bus.emit('ui:leaveLobby');
      });
    }
    if (this.el.lobbyCopy) {
      this.el.lobbyCopy.addEventListener('click', () => this._copyLobbyCode());
    }
    if (this.el.endedButton) {
      this.el.endedButton.addEventListener('click', () => {
        this.audio.uiBack();
        this.bus.emit('ui:endedMenu');
      });
    }

    if (this.el.voiceEnabled) {
      this.el.voiceEnabled.addEventListener('change', () => {
        const enabled = this.el.voiceEnabled.checked;
        this.store.save({ voiceEnabled: enabled });
        this.bus.emit('settings:voiceEnabled', enabled);
      });
    }
    for (const button of this.el.voiceModeButtons) {
      button.addEventListener('click', () => {
        const mode = button.dataset.voiceMode;
        if (!mode) return;
        this.store.save({ voiceMode: mode });
        this._applyVoiceModeUI(mode);
        this.bus.emit('settings:voiceMode', mode);
      });
    }
    if (this.el.callsign) {
      let lastCallsign = this.store.values.callsign || '';
      const commit = () => {
        const value = this.el.callsign.value.trim().slice(0, 14);
        this.el.callsign.value = value;
        if (value === lastCallsign) return;
        lastCallsign = value;
        this.store.save({ callsign: value });
        this.bus.emit('settings:callsign', value);
      };
      this.el.callsign.addEventListener('change', commit);
      this.el.callsign.addEventListener('blur', commit);
    }

    if (this.el.netTransport) {
      this.el.netTransport.addEventListener('change', () => {
        const mode = this.el.netTransport.value;
        this.store.save({ netTransport: mode });
        this._syncNetworkPreference();
        this.showToast('КАНАЛ СВЯЗИ ОБНОВЛЁН // ПРИМЕНИТСЯ К СЛЕДУЮЩЕМУ ЛОББИ', 'info', 3200);
      });
    }

    if (this.el.relayCustom) {
      let lastCustom = this.store.values.relayCustom || '';
      const commit = () => {
        const value = this.el.relayCustom.value.trim().slice(0, 160);
        if (value === lastCustom) return;
        lastCustom = value;
        this.el.relayCustom.value = value;
        this.store.save({ relayCustom: value });
        this._syncNetworkPreference();
        this.showToast('СВОЙ RELAY-УЗЕЛ СОХРАНЁН', 'info', 2600);
      };
      this.el.relayCustom.addEventListener('change', commit);
      this.el.relayCustom.addEventListener('blur', commit);
    }

    if (this.el.netTest) {
      this.el.netTest.addEventListener('click', () => this._runNetworkTest());
    }

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

    if (this.el.voiceEnabled) this.el.voiceEnabled.checked = this.store.values.voiceEnabled !== false;
    this._applyVoiceModeUI(this.store.values.voiceMode);
    if (this.el.callsign) this.el.callsign.value = this.store.values.callsign || '';
    if (this.el.netTransport) this.el.netTransport.value = this.store.values.netTransport || 'auto';
    if (this.el.relayCustom) this.el.relayCustom.value = this.store.values.relayCustom || '';
  }

  _syncNetworkPreference() {
    if (!this.network || !this.network.setNetworkPreference) return;
    this.network.setNetworkPreference({
      mode: this.store.values.netTransport,
      custom: this.store.values.relayCustom,
    });
  }

  _setNetStatus(text, state = 'idle') {
    if (!this.el.netStatus) return;
    this.el.netStatus.textContent = text;
    this.el.netStatus.dataset.state = state;
  }

  _shortRelay(url) {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
      return `${parsed.host}${path}`;
    } catch (error) {
      return String(url || '');
    }
  }

  _renderNetResults(round) {
    if (!this.el.netResults) return;
    const labels = { mqtt: 'MQTT', torrent: 'TORRENT', nostr: 'NOSTR' };
    const rows = [];
    for (const bucket of round.buckets || []) {
      for (const result of bucket.results || []) {
        rows.push({
          label: `${labels[bucket.strategy] || bucket.strategy} · ${this._shortRelay(result.url)}`,
          ok: Boolean(result.ok),
          text: result.ok ? `OK ${result.ms} мс` : (result.detail || 'нет'),
        });
      }
    }
    if (round.peerjs) {
      rows.push({
        label: 'PEERJS · 0.peerjs.com',
        ok: Boolean(round.peerjs.ok),
        text: round.peerjs.ok ? `OK ${round.peerjs.ms} мс` : (round.peerjs.detail || 'нет'),
      });
    }

    this.el.netResults.textContent = '';
    for (const row of rows) {
      const item = document.createElement('li');
      item.dataset.ok = String(row.ok);
      const name = document.createElement('span');
      name.textContent = row.label;
      const value = document.createElement('span');
      value.textContent = row.text;
      item.append(name, value);
      this.el.netResults.appendChild(item);
    }
    this.el.netResults.hidden = rows.length === 0;

    const available = (round.buckets || []).filter((bucket) => (bucket.results || []).some((r) => r.ok));
    if (available.length) {
      this._setNetStatus(`${labels[available[0].strategy] || available[0].strategy} доступен`, 'active');
    } else if (round.peerjs && round.peerjs.ok) {
      this._setNetStatus('только PeerJS', 'requesting');
    } else {
      this._setNetStatus('каналы недоступны', 'error');
    }
  }

  async _runNetworkTest() {
    if (this._netTesting || !this.network) return;
    this._netTesting = true;
    const button = this.el.netTest;
    if (button) button.disabled = true;
    if (this.el.netTestLabel) this.el.netTestLabel.textContent = 'Проверка...';
    this._setNetStatus('проверка...', 'requesting');
    if (this.el.netResults) {
      this.el.netResults.textContent = '';
      this.el.netResults.hidden = true;
    }
    try {
      const round = await this.network.probeAll();
      this._renderNetResults(round);
    } catch (error) {
      console.warn('[Net] Проверка не удалась', error);
      this._setNetStatus('ошибка проверки', 'error');
    } finally {
      this._netTesting = false;
      if (button) button.disabled = false;
      if (this.el.netTestLabel) this.el.netTestLabel.textContent = 'Проверить связь';
    }
  }

  _applyVoiceModeUI(mode) {
    const current = mode === 'ptt' ? 'ptt' : 'open';
    for (const button of this.el.voiceModeButtons) {
      const active = button.dataset.voiceMode === current;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    if (this.el.voiceHint) {
      this.el.voiceHint.textContent = current === 'ptt'
        ? 'Режим рации: удерживайте V, чтобы говорить. Остальное время микрофон молчит.'
        : 'Открытый микрофон: голос передаётся постоянно. Тише у края слышимости — дальше 14 м эфир глохнет.';
    }
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
    this.bus.emit('settings:voiceEnabled', values.voiceEnabled);
    this.bus.emit('settings:voiceMode', values.voiceMode);
    this.bus.emit('settings:callsign', values.callsign || '');
    this._syncNetworkPreference();
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
      .slice(0, CONFIG.network.lobbyCodeLength);
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
    if (clean.length !== CONFIG.network.lobbyCodeLength) {
      this._showJoinError(`КОД ЛОББИ СОСТОИТ ИЗ ${CONFIG.network.lobbyCodeLength} СИМВОЛОВ.`);
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
      (result && result.message)
        || 'НЕ УДАЛОСЬ ПОДКЛЮЧИТЬСЯ К СЕАНСУ. ПРОВЕРЬТЕ КОД И ПОВТОРИТЕ ПОПЫТКУ.',
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
    if (this.el.lobby) this.el.lobby.hidden = true;
    if (this.el.ended) this.el.ended.hidden = true;
    this.el.hud.hidden = false;
    this.el.hud.classList.remove('is-paused');
    this.el.hints.classList.remove('is-faded');
    this.hidePrompt();
    this.setScare(false);
    this.setListeningStatus({ mic: 'off', speech: 'off' });
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
    this.hidePrompt();
    this.setScare(false);
    this.el.hud.hidden = true;
    this.el.pause.hidden = true;
    this.el.settings.hidden = true;
    this.el.join.hidden = true;
    if (this.el.lobby) this.el.lobby.hidden = true;
    if (this.el.ended) this.el.ended.hidden = true;
    this.el.menu.hidden = false;
    this._lobbyCode = '';
    this._roster = [];
    this._settingsOpen = false;
    this.stopMicTest(false);
    this.setLobbyCode(null);
    window.clearTimeout(this._hintsTimer);
    window.setTimeout(() => this.el.create.focus({ preventScroll: true }), 0);
  }

  // ---------------------------------------------------------------------------
  // Лобби
  // ---------------------------------------------------------------------------

  showLobby({ code, mode = 'host' } = {}) {
    if (!this.el.lobby) return;
    this._lobbyMode = mode;
    this._lobbyCode = code || this._lobbyCode || '';
    this.el.menu.hidden = true;
    this.el.join.hidden = true;
    this.el.settings.hidden = true;
    if (this.el.ended) this.el.ended.hidden = true;
    this.el.lobby.hidden = false;
    this.setLobbyCode(this._lobbyCode);
    this._renderLobbyCode();
    this._renderRoster();
    this.setNetworkStatus({ status: mode === 'host' ? 'hosting' : 'connecting' });
    window.setTimeout(() => this.el.lobbyEnter && this.el.lobbyEnter.focus({ preventScroll: true }), 40);
  }

  hideLobby() {
    if (this.el.lobby) this.el.lobby.hidden = true;
  }

  _renderLobbyCode() {
    if (!this.el.lobbyCode) return;
    this.el.lobbyCode.textContent = this._lobbyCode || '—';
    this.el.lobbyCode.classList.toggle('is-empty', !this._lobbyCode);
  }

  _copyLobbyCode() {
    if (!this._lobbyCode) return;
    const done = () => {
      this.audio.uiConfirm();
      this.showToast(`КОД ${this._lobbyCode} СКОПИРОВАН`, 'success', 2400);
      if (this.el.lobbyCopy) {
        this.el.lobbyCopy.classList.add('is-done');
        window.clearTimeout(this._copyTimer);
        this._copyTimer = window.setTimeout(() => {
          this.el.lobbyCopy.classList.remove('is-done');
        }, 1400);
      }
    };
    const fallback = () => {
      try {
        const area = document.createElement('textarea');
        area.value = this._lobbyCode;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
        done();
      } catch (error) {
        this.showToast(`КОД: ${this._lobbyCode}`, 'info', 5000);
      }
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(this._lobbyCode).then(done).catch(fallback);
    } else {
      fallback();
    }
  }

  setNetworkStatus({ status, detail } = {}) {
    const map = {
      idle: ['СОЕДИНЕНИЕ НЕ УСТАНОВЛЕНО', 'idle'],
      signaling: [detail || 'УСТАНОВКА СВЯЗИ С СЕРВЕРОМ...', 'pending'],
      hosting: [detail ? `${detail} · ЖДЁМ ПАССАЖИРОВ` : 'КАНАЛ ОТКРЫТ · ЖДЁМ ПАССАЖИРОВ', 'ok'],
      connecting: ['ПОДКЛЮЧЕНИЕ К ХОСТУ...', 'pending'],
      connected: ['СВЯЗЬ С ХОСТОМ УСТАНОВЛЕНА', 'ok'],
      reconnecting: [detail || 'ПЕРЕПОДКЛЮЧЕНИЕ...', 'warn'],
      error: [detail || 'СВЯЗЬ ПОТЕРЯНА', 'error'],
    };
    const entry = map[status] || map.idle;
    if (this.el.lobbyStatus) {
      this.el.lobbyStatus.dataset.state = entry[1];
    }
    if (this.el.lobbyStatusText) this.el.lobbyStatusText.textContent = entry[0];
  }

  setLatency(rtt) {
    if (!this.el.hudPing) return;
    if (!Number.isFinite(rtt)) {
      this.el.hudPing.textContent = '— мс';
      this.el.hudPing.dataset.state = 'idle';
      return;
    }
    this.el.hudPing.textContent = `${rtt} мс`;
    this.el.hudPing.dataset.state = rtt < 120 ? 'ok' : rtt < 260 ? 'warn' : 'error';
  }

  onRoster(roster) {
    this._roster = Array.isArray(roster.players) ? roster.players : [];
    this._selfId = roster.selfId || null;
    this._hostId = roster.hostId || null;
    this._isHost = Boolean(roster.isHost);
    this._maxPlayers = roster.maxPlayers || CONFIG.network.maxPlayers;
    this._renderRoster();
  }

  _renderRoster() {
    if (!this.el.lobbyRoster) return;
    const players = this._roster || [];
    const max = this._maxPlayers || CONFIG.network.maxPlayers;

    if (this.el.lobbyCount) {
      this.el.lobbyCount.textContent = `${players.length} / ${max}`;
      this.el.lobbyCount.dataset.state = players.length >= max ? 'full' : 'ok';
    }
    if (this.el.lobbyTitle) {
      this.el.lobbyTitle.textContent = this._isHost ? 'Вагон открыт' : 'Вагон найден';
    }
    if (this.el.lobbySubtitle) {
      this.el.lobbySubtitle.textContent = this._isHost
        ? 'Передайте код экипажу. Как только все будут на месте — входите в салон.'
        : 'Хост уже в вагоне. Проверьте состав и входите.';
    }
    if (this.el.hudCrew) {
      this.el.hudCrew.textContent = `${players.length}/${max}`;
    }
    if (this.el.pauseCrew) this.el.pauseCrew.textContent = `${players.length}/${max}`;

    const fragment = document.createDocumentFragment();
    for (let index = 0; index < max; index += 1) {
      const player = players[index];
      const row = document.createElement('li');
      row.className = 'roster-row';
      if (!player) {
        row.classList.add('is-empty');
        row.innerHTML = '<span class="roster-slot"></span><span class="roster-name">СВОБОДНОЕ МЕСТО</span><span class="roster-badge">—</span>';
      } else {
        if (player.id === this._selfId) row.classList.add('is-self');
        if (player.host) row.classList.add('is-host');
        const slot = String(player.slot || index + 1).padStart(2, '0');
        const name = document.createElement('span');
        name.className = 'roster-name';
        name.textContent = player.name;

        const badge = document.createElement('span');
        badge.className = 'roster-badge';
        const parts = [];
        if (player.host) parts.push('ХОСТ');
        else if (Number.isFinite(player.ping)) parts.push(`${player.ping} МС`);
        if (player.id === this._selfId) parts.push('ВЫ');
        badge.textContent = parts.join(' · ') || 'В ЭФИРЕ';

        const slotEl = document.createElement('span');
        slotEl.className = 'roster-slot';
        slotEl.textContent = slot;

        row.append(slotEl, name, badge);
        if (player.id === this._selfId) {
          const dot = document.createElement('span');
          dot.className = 'roster-dot';
          dot.title = 'Это вы';
          row.append(dot);
        }
      }
      fragment.appendChild(row);
    }
    this.el.lobbyRoster.replaceChildren(fragment);

    if (this._lastCrewCount && players.length > this._lastCrewCount && this._lobbyMode === 'host') {
      this.audio.uiConfirm();
    }
    this._lastCrewCount = players.length;

    const empty = players.length <= 1;
    if (this.el.lobbyEnter) {
      this.el.lobbyEnter.disabled = false;
      this.el.lobbyEnter.textContent = empty && this._isHost ? 'Войти одному' : 'Войти в салон';
    }
  }

  setVoiceState(state) {
    if (!state) return;
    this._voiceState = state;

    let label = 'ГОЛОС: ВЫКЛ';
    let chip = 'off';
    if (state.enabled) {
      if (!state.supported) {
        label = 'ГОЛОС: НЕ ПОДДЕРЖИВАЕТСЯ';
        chip = 'error';
      } else if (state.permission === 'denied') {
        label = 'ГОЛОС: НЕТ ДОСТУПА К МИКРОФОНУ';
        chip = 'error';
      } else if (!state.active) {
        label = state.mode === 'ptt' ? 'ГОЛОС: РАЦИЯ · НЕТ МИКРОФОНА' : 'ГОЛОС: ОЖИДАНИЕ МИКРОФОНА';
        chip = 'warn';
      } else {
        const mode = state.mode === 'ptt' ? 'РАЦИЯ V' : 'ОТКРЫТЫЙ';
        const peers = state.peers ? ` · ${state.peers} В КАНАЛЕ` : '';
        label = `ГОЛОС: ${mode}${peers}`;
        chip = 'on';
      }
    }

    if (this.el.lobbyVoice) {
      this.el.lobbyVoice.dataset.state = chip;
      this.el.lobbyVoice.textContent = label;
    }
    if (this.el.hudVoice) {
      this.el.hudVoice.dataset.state = chip;
      if (this.el.hudVoiceText) this.el.hudVoiceText.textContent = label.replace('ГОЛОС: ', '');
    }
    if (this.el.menuVoiceStatus) {
      this.el.menuVoiceStatus.dataset.state = chip;
      this.el.menuVoiceStatus.textContent = label;
    }
    if (this.el.voiceModeButtons && this.el.voiceModeButtons.length) {
      this._applyVoiceModeUI(state.mode);
    }
  }

  setLocalSpeaking(speaking) {
    if (this.el.hudVoice) this.el.hudVoice.classList.toggle('is-speaking', Boolean(speaking));
    if (this.el.lobbyVoice) this.el.lobbyVoice.classList.toggle('is-speaking', Boolean(speaking));
  }

  setPttActive(active) {
    if (this.el.hudVoice) this.el.hudVoice.classList.toggle('is-ptt', Boolean(active));
    if (this.el.menuVoiceStatus) this.el.menuVoiceStatus.classList.toggle('is-ptt', Boolean(active));
    if (this.el.lobbyVoice) this.el.lobbyVoice.classList.toggle('is-ptt', Boolean(active));
  }

  showEnded({ title, text, kicker = null, dead = false }) {
    if (!this.el.ended) return;
    this.el.menu.hidden = true;
    this.el.join.hidden = true;
    this.el.settings.hidden = true;
    this._stopHaunt();
    this.el.hud.hidden = true;
    this.el.pause.hidden = true;
    this.hidePrompt();
    if (this.el.endedKicker) {
      this.el.endedKicker.textContent = kicker || 'ЛОББИ БОЛЬШЕ НЕ СУЩЕСТВУЕТ';
    }
    this.el.endedTitle.textContent = title;
    this.el.endedTitle.classList.toggle('is-dead', Boolean(dead));
    this.el.endedText.textContent = text;
    this.el.ended.hidden = false;
    window.setTimeout(() => this.el.endedButton.focus({ preventScroll: true }), 40);
  }

  hideEnded() {
    if (this.el.ended) this.el.ended.hidden = true;
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

  // ---------------------------------------------------------------------------
  // Часть III: подсказка взаимодействия, «слух» и паника
  // ---------------------------------------------------------------------------

  showPrompt(text, key = 'E', tone = 'normal') {
    if (!this.el.prompt) return;
    const signature = `${tone}|${key}|${text}`;
    if (signature === this._promptKey) return;
    this._promptKey = signature;
    this._promptTone = tone;
    if (this.el.promptKey) {
      this.el.promptKey.textContent = key || '';
      this.el.promptKey.hidden = !key;
    }
    if (this.el.promptText) this.el.promptText.textContent = text;
    this.el.prompt.dataset.tone = tone;
    this.el.prompt.hidden = false;
  }

  hidePrompt() {
    this._promptKey = '';
    if (this.el.prompt) this.el.prompt.hidden = true;
  }

  /** Состояние микрофона: слушает ли вагон игрока и доступна ли речь. */
  setListeningStatus({ mic = 'off', speech = 'off' } = {}) {
    if (!this.el.listen) return;
    let state = 'off';
    let text = 'МИКРОФОН: ВЫКЛ';
    if (mic === 'on') {
      if (speech === 'listening') {
        state = 'on';
        text = 'САЛОН СЛУШАЕТ // РЕЧЬ';
      } else if (speech === 'restarting') {
        state = 'warn';
        text = 'СЛУХ ВОССТАНАВЛИВАЕТСЯ…';
      } else if (speech === 'unsupported') {
        state = 'warn';
        text = 'РЕЧЬ НЕДОСТУПНА // ТОЛЬКО КРИК';
      } else if (speech === 'denied' || speech === 'error') {
        state = 'warn';
        text = 'РЕЧЬ ОТКЛЮЧЕНА // ТОЛЬКО КРИК';
      } else if (speech === 'paused') {
        state = 'off';
        text = 'СЛУХ ПРИОСТАНОВЛЕН';
      } else {
        state = 'warn';
        text = 'МИКРОФОН: ПОДКЛЮЧЕНИЕ…';
      }
    } else if (mic === 'denied') {
      state = 'error';
      text = 'МИКРОФОН ЗАПРЕЩЁН // ОН НЕ СЛЫШИТ';
    } else if (mic === 'unsupported') {
      state = 'error';
      text = 'МИКРОФОН НЕДОСТУПЕН';
    }
    this.el.listen.dataset.state = state;
    if (this.el.listenText) this.el.listenText.textContent = text;
  }

  setScare(active) {
    if (this.el.scare) this.el.scare.classList.toggle('is-active', Boolean(active));
    this.el.hud.classList.toggle('is-demon', Boolean(active));
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

    // Голос строится на том же AudioContext, что и эмбиент (см. VoiceChat.init).
    this.voice = new VoiceChat({
      audio: this.audio,
      bus: this.bus,
      scene: this.scene,
      camera: this.camera,
      store: this.store,
    });
    this.remotePlayers = new RemotePlayers({
      scene: this.scene,
      camera: this.camera,
      bus: this.bus,
      voice: this.voice,
      world: this.world,
    });

    // Часть III: «уши» вагона и сам пассажир.
    this.voiceWatcher = new VoiceWatcher({
      audio: this.audio,
      bus: this.bus,
      config: CONFIG.speech,
    });
    this.demon = new DemonDirector({
      scene: this.scene,
      camera: this.camera,
      world: this.world,
      player: this.player,
      audio: this.audio,
      bus: this.bus,
      network: this.network,
      ui: this.ui,
      watcher: this.voiceWatcher,
      getPlayerName: () => this.store.values.callsign || 'ВЫ',
      onGameOver: (payload) => this._onDemonGameOver(payload),
    });

    this._localInCar = false;
    this._demonDeath = false;
    this.network.setLocalStateProvider(() => {
      const state = this.player.getNetworkState();
      state.c = this._localInCar ? 1 : 0;
      return state;
    });
    this.network.setNameProvider(() => this.store.values.callsign || '');
    this.network.setVoiceChat(this.voice);
    this.network.setNetworkPreference({
      mode: this.store.values.netTransport,
      custom: this.store.values.relayCustom,
    });
    this.voice.setNetwork(this.network);
    this.remotePlayers.setNetwork(this.network);

    // Потерянный микрофон: пробуем вернуть канал, не выкидывая из игры.
    this.audio.onMicLost = () => this.voice.handleMicLost();

    this.audio.setVolume(this.store.values.volume);
    this.audio.setScene('menu');

    this._bindEvents();
    this._setupMenuView();
    this._requestStartupMic();

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
    this.bus.on('ui:sessionJoined', (result) => this.joinSession(result));
    this.bus.on('ui:enterCar', () => this.enterCar());
    this.bus.on('ui:leaveLobby', () => this.leaveLobby());
    this.bus.on('ui:endedMenu', () => this.closeEndedScreen());
    this.bus.on('ui:resume', () => this.resumeSession());
    this.bus.on('ui:exit', () => this.exitToMenu());
    this.bus.on('settings:sensitivity', (value) => this.player.setSensitivity(value));

    this.bus.on('settings:voiceEnabled', (enabled) => this.voice.setEnabled(enabled));
    this.bus.on('settings:voiceMode', (mode) => this.voice.setMode(mode));
    this.bus.on('settings:callsign', (name) => this._syncCallsign(name));

    this.bus.on('network:roster', (roster) => {
      this.remotePlayers.sync(roster);
      this.voice.syncRoster(roster);
    });
    this.bus.on('network:hostLeft', ({ reason, wasHost }) => this._onHostLeft(reason, wasHost));
    this.bus.on('network:warning', ({ message }) => this.ui.showToast(message, 'warning', 6000));
    this.bus.on('voice:lost', () => this.ui.showToast('МИКРОФОН ОТКЛЮЧЁН // ВОССТАНОВЛЕНИЕ КАНАЛА...', 'warning', 5000));
    this.bus.on('session:started', () => this.voice.setLocalInCar(true));

    // Часть III: состояние «слуха» в HUD.
    this.bus.on('speech:status', (status) => this.ui.setListeningStatus(status));

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

  /** Запрос микрофона на старте: разрешение спрашиваем сразу, поток не держим. */
  _requestStartupMic() {
    if (this.store.values.voiceEnabled === false) return;
    this._micProbeTimer = window.setTimeout(() => {
      this.voice.probePermission();
    }, 900);
  }

  _syncCallsign(name) {
    const clean = this.network._sanitizeName(name);
    if (this.network.isActive) {
      if (this.network.isHost) {
        const me = this.network.roster.get(this.network.selfId);
        if (me) {
          me.name = clean || 'ПАССАЖИР 1';
          this.network._broadcastRoster();
          this.network._emitRoster();
        }
      } else if (this.network._hostConn) {
        this.network._send(this.network._hostConn, { t: 'hello', name: clean });
      }
    }
    this.ui.showToast(clean ? `ПОЗЫВНОЙ: ${clean}` : 'ПОЗЫВНОЙ СБРОШЕН', 'info', 2400);
  }

  // ---------------------------------------------------------------------------
  // Лобби
  // ---------------------------------------------------------------------------

  async createLobby(options = {}) {
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

    this._createToken = (this._createToken || 0) + 1;
    const token = this._createToken;

    this.audio.init();
    this.voice.init();
    this._menuEnteredAt = performance.now();

    this.state = STATE.LOBBY;
    this.ui.showLobby({ code: '', mode: 'host' });

    const result = await this.network.hostLobby();

    if (token !== this._createToken) return;
    if (this.state !== STATE.LOBBY) return;

    if (!result || !result.ok) {
      this.state = STATE.MENU;
      this.ui.hideLobby();
      this.ui.showMenu();
      this.ui.showToast((result && result.message) || 'НЕ УДАЛОСЬ ОТКРЫТЬ ЛОББИ.', 'error', 6500);
      this.audio.uiError();
      return;
    }

    this.session = this.network.session;
    this.ui.showLobby({ code: result.code, mode: 'host' });
    const channelName = result.transport === 'relay' && result.strategy
      ? String(result.strategy).toUpperCase()
      : null;
    // showLobby сбрасывает строку состояния — возвращаем название канала.
    this.ui.setNetworkStatus({
      status: 'hosting',
      detail: channelName ? `КАНАЛ ${channelName}` : null,
    });
    const channel = channelName ? ` // КАНАЛ ${channelName}` : '';
    this.ui.showToast(
      `ЛОББИ 06-${result.code} ОТКРЫТО${channel} // ПЕРЕДАЙТЕ КОД ЭКИПАЖУ`,
      'success',
      6500,
    );
  }

  joinSession(result) {
    if (!result || !result.ok || !result.session) return;
    this.session = result.session;
    this.state = STATE.LOBBY;
    this._menuEnteredAt = performance.now();
    this.voice.init();
    this.ui.showLobby({ code: result.session.code, mode: 'guest' });
    this.ui.setNetworkStatus({ status: 'connected' });
    this.ui.showToast(
      `ПОДКЛЮЧЕНИЕ УСТАНОВЛЕНО // ЛОББИ 06-${result.session.code}`,
      'success',
      4600,
    );
  }

  _spawnForSelf() {
    const base = this.world.spawn || CONFIG.player.spawn;
    const roster = this.network.getPlayers();
    const index = Math.max(0, roster.findIndex((player) => player.id === this.network.selfId));
    const row = Math.floor(index / 2);
    return {
      x: base.x + (index % 2 === 0 ? 0.24 : -0.24),
      z: base.z - row * 0.85 - (index % 2) * 0.25,
      yaw: Math.PI,
    };
  }

  enterCar() {
    if (this.state !== STATE.LOBBY) return;
    if (!this.network.isActive) {
      this.ui.showToast('СВЯЗЬ С ЛОББИ ПОТЕРЯНА. ВЕРНИТЕСЬ В МЕНЮ.', 'error', 5200);
      this.leaveLobby();
      return;
    }

    this._clearLockFallback();
    this.state = STATE.DEPLOYING;

    const spawn = this._spawnForSelf();
    this.player.reset(spawn);
    this.player.setEnabled(false);
    this._localInCar = true;
    this.ui.enterGame(this.session ? this.session.code : this.network.session.code);
    this.audio.setScene('game');
    this.voice.setLocalInCar(true);
    this.demon.activate();
    this.voiceWatcher.start();
    this.clock.getDelta();

    const crew = Math.max(1, this.network.getPlayers().length);
    this.ui.showToast(
      `СЕАНС 06-${this.session.code} // ЭКИПАЖ: ${crew}`,
      'info',
      4200,
    );

    this._requestPointerLock(true);
  }

  leaveLobby() {
    if (this.state !== STATE.LOBBY && this.state !== STATE.DEPLOYING
      && this.state !== STATE.PLAYING && this.state !== STATE.PAUSED) {
      return;
    }
    this._clearLockFallback();
    this._menuEnteredAt = performance.now();
    this.state = STATE.MENU;

    this.player.setEnabled(false);
    this.player.unlock();
    this._localInCar = false;
    this._demonDeath = false;
    this.demon.reset();
    this.voiceWatcher.stop();
    this.voice.leave();
    this.remotePlayers.clear();
    this.network.leave();
    this.session = null;

    this.audio.setScene('menu');
    this.ui.showMenu();
    this.player.reset();
    this._setupMenuView();
    this.clock.getDelta();
    this.bus.emit('session:ended');
  }

  _onHostLeft(reason, wasHost = false) {
    if (this.state !== STATE.LOBBY && this.state !== STATE.DEPLOYING
      && this.state !== STATE.PLAYING && this.state !== STATE.PAUSED) {
      return;
    }

    // Экран смерти уже показан: не подменяем его сообщением о выходе хоста,
    // просто тихо снимаем сеанс с учёта. Кнопка «В главное меню» всё уберёт.
    if (this._demonDeath) {
      this.demon.reset();
      this.voiceWatcher.stop();
      this.voice.leave();
      this.remotePlayers.clear();
      this.session = null;
      this.player.setEnabled(false);
      this.player.unlock();
      return;
    }

    this._clearLockFallback();
    this.state = STATE.MENU;
    this._menuEnteredAt = performance.now();
    this.player.setEnabled(false);
    this.player.unlock();
    this._localInCar = false;
    this._demonDeath = false;
    this.demon.reset();
    this.voiceWatcher.stop();
    this.voice.leave();
    this.remotePlayers.clear();
    this.session = null;
    this.audio.setScene('menu');

    let title = 'ХОСТ ПОКИНУЛ ВАГОН';
    let text = 'Двери захлопнулись, и голос в рации смолк. Лобби больше не существует — вернитесь в меню и подключитесь заново.';
    let toast = 'ХОСТ ЗАВЕРШИЛ СЕАНС';

    if (wasHost) {
      title = 'СИГНАЛЬНЫЙ УЗЕЛ ПОТЕРЯН';
      text = 'Связь с сигнальным сервером оборвалась, и пассажиры потеряли ваш вагон. Проверьте сеть и создайте лобби заново.';
      toast = 'СЕАНС ЗАВЕРШЁН: НЕТ СВЯЗИ';
    } else if (reason === 'timeout') {
      title = 'СВЯЗЬ ПОТЕРЯНА';
      text = 'Сигналы хозяина вагона стихли. Проводник закрыл сеанс — вернитесь в меню и подключитесь к новому лобби.';
      toast = 'СВЯЗЬ С ХОСТОМ ПОТЕРЯНА';
    }

    this.ui.showEnded({ title, text });
    this.ui.showToast(toast, 'warning', 5000);
    this.bus.emit('session:ended');
  }

  closeEndedScreen() {
    this.ui.hideEnded();
    this._demonDeath = false;
    // Экран смерти оставляет сеанс живым, чтобы остальные успели получить
    // весть о смерти. Выход из лобби — уже по кнопке «В главное меню».
    if (this.network.isActive || this.session) {
      if (this.state !== STATE.MENU) {
        this.leaveLobby();
        return;
      }
      this.demon.reset();
      this.voiceWatcher.stop();
      this.voice.leave();
      this.network.leave();
      this.session = null;
    }
    this.ui.showMenu();
    this.player.reset();
    this._setupMenuView();
    this.state = STATE.MENU;
    this._menuEnteredAt = performance.now();
    this.clock.getDelta();
  }

  /** Пассажир добрался до игрока: сеанс для него заканчивается. */
  _onDemonGameOver({ target, name } = {}) {
    if (this.state !== STATE.PLAYING && this.state !== STATE.PAUSED
      && this.state !== STATE.DEPLOYING) {
      return;
    }
    const isSelf = !target || target === this.network.selfId;
    this._demonDeath = true;
    this.state = STATE.PAUSED;
    this.player.setEnabled(false);
    this.player.setSpeedScale(1);
    this.player.unlock();
    this.demon.pause();
    this.voiceWatcher.pause();
    const victim = name || 'ПАССАЖИР';
    this.audio.setScene('menu');
    this.ui.showEnded({
      title: isSelf ? 'МЁРТВ' : 'СЕАНС ОКОНЧЕН',
      text: isSelf
        ? 'Поезд не остановился. Пассажир без лица добрался до вас первым: '
          + 'сигнал оборвался на полуслове, а состав идёт дальше без одного человека.'
        : `Пассажир без лица добрался до цели: ${victim}. Вагон опустел — `
          + 'двери закрыты, связь не отвечает, и поезд идёт дальше по расписанию.',
      kicker: 'ВАГОН 06 // СИГНАЛ ПАССАЖИРА ОБОРВАН',
      dead: true,
    });
    this.ui.showToast(
      isSelf ? 'ОН НАШЁЛ ВАС // ИГРА ОКОНЧЕНА' : `${victim} МЁРТВ // ИГРА ОКОНЧЕНА`,
      'error',
      6000,
    );
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
    this.demon.pause();
    this.voiceWatcher.pause();
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

    // Микрофон и пассажир оживают только когда игрок реально в салоне.
    if (!this.demon.active) this.demon.activate();
    if (!this.voiceWatcher.active) this.voiceWatcher.start();
    else this.voiceWatcher.resume();

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
    this.demon.pause();
    this.voiceWatcher.pause();
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
    this._localInCar = false;
    this._demonDeath = false;
    this.demon.reset();
    this.voiceWatcher.stop();
    this.voice.leave();
    this.remotePlayers.clear();
    this.network.leave();
    this.session = null;

    this.ui.hideEnded();
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
      // Пассажир думает после игрока: цель уже сдвинулась в этом кадре.
      this.demon.update(dt, this.elapsed);
      this.voiceWatcher.update(dt);
    } else if (this.state === STATE.MENU || this.state === STATE.LOBBY) {
      this._updateMenuCamera(this.elapsed);
      // В меню пассажир просто сидит — анимация нужна и здесь.
      this.demon.npc.update(dt, this.elapsed);
    }

    // Плавно подводим «атмосферную» усталость к цели.
    this._dread = damp(this._dread ?? 0, this._dreadTarget ?? 0, 2.6, dt);
    this.world.setDread(this._dread);

    this.world.update(dt, this.elapsed);
    this.network.update(dt);
    if (this.state !== STATE.MENU) {
      this.remotePlayers.update(dt, this.elapsed);
      this.voice.update(dt, this.elapsed);
    }
    this.audio.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    window.cancelAnimationFrame(this._raf);
    this._clearLockFallback();
    window.clearTimeout(this._micProbeTimer);
    try {
      this.demon.reset();
      this.voiceWatcher.stop();
    } catch (error) {
      /* ignore */
    }
    try {
      this.voice.leave();
    } catch (error) {
      /* ignore */
    }
    try {
      this.network.leave({ silent: true });
    } catch (error) {
      /* ignore */
    }
    this.audio.hardStopMic();
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
      RemotePlayers,
      VoiceChat,
      PassengerNPC,
      VoiceWatcher,
      DemonDirector,
      UIManager,
    },
    voice: game.voice,
    remotePlayers: game.remotePlayers,
    voiceWatcher: game.voiceWatcher,
    demon: game.demon,
  };

  window.addEventListener('pagehide', () => game.dispose(), { once: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startGame, { once: true });
} else {
  startGame();
}

  