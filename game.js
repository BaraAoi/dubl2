/* ============================================================================
   ПОЛУНОЧНЫЙ ЭКСПРЕСС — Часть V
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
     DemonDirector     — пробуждение, погоня, падение, переноска и сброс с поезда
     TicketInspector   — проверка билетов у четырёх пассажиров
     MissionDirector   — инструктаж и сюжетные цели смены
     ZoneDirector      — салон → тамбур (буферная зона) → соседний вагон
     BrakeDirector     — тормозной кран как способ спастись
     LobbyDirectory    — каталог открытых лобби в обход ручного кода
     Inventory         — фонарик, бинт, шокер и верёвка
     VendingMachine    — торговый автомат в тамбуре
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
  version: '0.5.0',
  part: 5,
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
    radioGain: 0.68,
  },
  // ---------------------------------------------------------------------
  // Часть III. «Пассажир», который едет в вагоне.
  // ---------------------------------------------------------------------
  npc: {
    // Сиденье у левой стены: скамья z=3.2…6.7, сиденье на высоте ~0.47 м.
    seat: { x: -1.44, y: 0.47, z: 5.55 },
    lookDistance: 4.4,
    grabDistance: 3.0,
    // Волочение тяжёлого тела. В одиночку — почти ползком, вдвоём — заметно
    // быстрее: тело действительно тяжёлое, а не «как за двоих».
    dragScale: 0.24,
    dragScaleTwo: 0.5,
    dragScaleHelper: 0.5,
    dragOffset: 0.92,
    dragLerp: 9.5,
    // Сколько секунд тело остаётся обмякшим после захвата.
    stunTime: 8.0,
    // Билеты четырёх пассажиров (места в салоне).
    seats: [
      { x: -1.44, z: -4.95, yaw: Math.PI / 2, name: 'ГУСЕВ А. П.', seat: '02', serial: 'А-0441' },
      { x: 1.44, z: -9.9, yaw: -Math.PI / 2, name: 'РЯБИНИНА М. С.', seat: '07', serial: 'Б-1180' },
      { x: 1.44, z: 0, yaw: -Math.PI / 2, name: 'КОРНЕЕВ Д. В.', seat: '08', serial: 'В-0927' },
      { x: -1.44, z: 9.9, yaw: Math.PI / 2, name: 'ШТЕРН Ф. А.', seat: '11', serial: 'Г-0063' },
    ],
  },
  demon: {
    huntSpeed: 4.15,
    wakeDelay: 1.3,
    killDistance: 0.92,
    aisleX: 0.05,
    bodyRadius: 0.3,
    standTime: 0.9,
    stateInterval: 0.05,
    // Через сколько секунд демон поймёт, что цель ушла в соседний вагон.
    transferDelay: 2.4,
  },
  mission: {
    interactDistance: 2.7,
    brakeHold: 2.4,
    // Порог перехода между зонами: тамбур начинается за дверью вагона.
    vestibuleZ: -16.0,
    carExitZ: -15.35,
    vestibuleBackZ: -16.35,
    vestibuleNextZ: -21.5,
    vestibuleSpawnZ: -16.85,
    // Сброс демона за борт: удержание E у ограждения.
    dumpHold: 1.8,
    dumpDistance: 2.8,
    // Даун и бинты.
    reviveHold: 1.4,
    bleedout: 70,
  },
  items: {
    flashlight: { price: 150, name: 'ФОНАРИК' },
    bandage: { price: 400, name: 'БИНТ' },
    taser: { price: 300, name: 'ШОКЕР', charges: 3, recharge: 20, stun: 8 },
    rope: { price: 220, name: 'ВЕРЁВКА', bonus: 32 },
  },
  skins: ['conductor', 'schoolgirl', 'furry', 'tv', 'engineer', 'inspector'],
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
  // Внешность члена экипажа: тип и цветовой акцент.
  skin: 'conductor',
  skinAccent: 0,
  // Антиэхо: приглушать чужой голос, когда ваш микрофон слышит динамики.
  echoGuard: true,
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
      if (CONFIG.skins.includes(parsed.skin)) {
        this.values.skin = parsed.skin;
      }
      if (Number.isInteger(parsed.skinAccent)) {
        this.values.skinAccent = clamp(parsed.skinAccent, 0, 3);
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
      // Южнее двери — тамбур (буферная зона между вагонами).
      minZ: -this.halfL - 6.8,
      maxZ: this.halfL,
      minY: 0,
      maxY: height,
    };
    this.spawn = { ...CONFIG.player.spawn };
    this.colliders = [];
    // Копия коллизий нужна, чтобы служебный вагон мог убрать скамьи
    // и вернуть их при возвращении обратно.
    this._baseColliders = null;
    this._serviceColliders = [];
    this.variant = 0;
    this.zone = 'car';
    this._carBounds = { ...this.bounds };
    this._serviceProps = null;
    // Дверь в тамбур: створки разъезжаются, когда игрок подходит.
    this._doorLeafs = null;
    this._doorSlide = 0;
    this._doorSlideTarget = 0;

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
    // Тамбур строится после батчинга: его детали не сливаются со статикой,
    // а стена с дверью остаётся коллизией.
    this._buildVestibule();
  }

  /**
   * Тамбур — буферная зона между вагонами. Сюда можно вытащить демона
   * и сбросить его за борт. Дверь вагона остаётся между зонами.
   */
  _buildVestibule() {
    const group = new THREE.Group();
    group.name = 'Тамбур';
    this.group.add(group);
    this.vestibule = group;

    const m = this.materials;
    const startZ = -this.halfL;
    const endZ = -this.halfL - 6.6;
    const centerZ = (startZ + endZ) / 2;
    const width = this.halfW * 2;

    const grateMaterial = new THREE.MeshStandardMaterial({
      color: 0x2a2c27,
      roughness: 0.92,
      metalness: 0.35,
    });
    const railMaterial = new THREE.MeshStandardMaterial({
      color: 0x3a3a32,
      roughness: 0.55,
      metalness: 0.7,
    });

    // Пол-решётка.
    this._box({
      w: width, h: 0.1, d: Math.abs(endZ - startZ),
      material: grateMaterial,
      x: 0, y: -0.02, z: centerZ,
      parent: group,
    });
    for (let i = 0; i <= 14; i += 1) {
      this._box({
        w: width - 0.12, h: 0.02, d: 0.05,
        material: railMaterial,
        x: 0, y: 0.04, z: startZ - 0.25 - i * 0.46,
        parent: group,
      });
    }

    // Нижние борта и ограждение по бокам; слева оставляем лаз для сброса.
    for (const side of [-1, 1]) {
      this._box({
        w: 0.08, h: 0.9, d: Math.abs(endZ - startZ),
        material: m.darkMetal,
        x: side * (this.halfW - 0.04), y: 0.45, z: centerZ,
        parent: group,
      });
      const dumpGap = side < 0;
      for (let i = 0; i <= 12; i += 1) {
        const z = startZ - 0.2 - i * 0.5;
        if (dumpGap && z < -18.4 && z > -20.7) continue;
        this._box({
          w: 0.05, h: 1.0, d: 0.05,
          material: railMaterial,
          x: side * (this.halfW - 0.06), y: 1.42, z,
          parent: group,
        });
      }
      // Верхний поручень.
      for (const [zA, zB] of dumpGap ? [[startZ, -18.4], [-20.7, endZ]] : [[startZ, endZ]]) {
        this._box({
          w: 0.06, h: 0.06, d: Math.abs(zB - zA),
          material: railMaterial,
          x: side * (this.halfW - 0.06), y: 1.92, z: (zA + zB) / 2,
          parent: group,
        });
      }
    }

    // Козырёк над входом и торцевая стена с дверью в соседний вагон.
    this._box({
      w: width, h: 0.12, d: 2.0,
      material: m.darkMetal,
      x: 0, y: 2.56, z: startZ - 1.0,
      parent: group,
    });
    this._box({
      w: width, h: 2.6, d: 0.14,
      material: m.trim,
      x: 0, y: 1.3, z: endZ,
      parent: group,
    });
    this._box({
      w: 1.02, h: 2.0, d: 0.08,
      material: new THREE.MeshStandardMaterial({ color: 0x14170f, roughness: 0.9 }),
      x: 0, y: 1.0, z: endZ + 0.08,
      parent: group,
    });
    // Щель холодного света в двери соседнего вагона.
    const doorGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.92, 1.9),
      new THREE.MeshBasicMaterial({ color: 0x1c3b34, transparent: true, opacity: 0.55 }),
    );
    doorGlow.position.set(0, 1.0, endZ + 0.14);
    group.add(doorGlow);

    // Фонарь тамбура и красный аварийный.
    const lampMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.1, 0.18),
      new THREE.MeshStandardMaterial({ color: 0xffe6b0, emissive: 0xffc978, emissiveIntensity: 2.2 }),
    );
    lampMesh.position.set(0, 2.44, startZ - 1.1);
    group.add(lampMesh);
    const lamp = new THREE.PointLight(0xffcf8c, 34, 13, 2);
    lamp.position.set(0, 2.3, startZ - 1.2);
    group.add(lamp);
    this.vestibuleLight = lamp;

    // Плафон над серединой тамбура: раньше здесь была чёрная дыра.
    // Потолок тамбура: без него над головой чернота.
    this._box({
      w: width + 0.2, h: 0.08, d: Math.abs(endZ - startZ) + 0.2,
      material: m.ceiling || m.darkMetal,
      x: 0, y: 2.9, z: centerZ,
      parent: group,
    });
    for (let i = 0; i < 7; i += 1) {
      this._box({
        w: 0.1, h: 0.06, d: Math.abs(endZ - startZ),
        material: railMaterial,
        x: -this.halfW + 0.35 + i * 0.52, y: 2.84, z: centerZ,
        parent: group,
      });
    }

    const midLampMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.09, 0.16),
      new THREE.MeshStandardMaterial({ color: 0xffe6b0, emissive: 0xffc978, emissiveIntensity: 2 }),
    );
    midLampMesh.position.set(0, 2.44, -18.0);
    group.add(midLampMesh);
    const midLamp = new THREE.PointLight(0xffcf8c, 26, 11, 2);
    midLamp.position.set(0, 2.28, -18.0);
    group.add(midLamp);
    this.vestibuleMidLight = midLamp;

    // Второй плафон у лаза: без него борт для сброса тонет в темноте.
    const gapLamp = new THREE.PointLight(0xffb070, 22, 9, 2);
    gapLamp.position.set(-0.8, 2.05, -19.6);
    group.add(gapLamp);
    this.vestibuleGapLight = gapLamp;

    // Ночь за бортом: в лазе не должно быть чёрной пустоты.
    // Берём ту же текстуру, что и в окнах, но растягиваем её на панораму.
    const nightMap = m.window.map.clone();
    nightMap.needsUpdate = true;
    nightMap.wrapS = THREE.RepeatWrapping;
    nightMap.wrapT = THREE.RepeatWrapping;
    nightMap.repeat.set(5, 2.4);
    const nightBackdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(22, 10),
      new THREE.MeshBasicMaterial({ map: nightMap, color: 0x8195a3, fog: true }),
    );
    nightBackdrop.rotation.y = Math.PI / 2;
    nightBackdrop.position.set(-6.8, 2.2, -19.55);
    nightBackdrop.name = 'Ночь за бортом';
    group.add(nightBackdrop);

    const redLamp = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0x5a0d08, emissive: 0xff2a12, emissiveIntensity: 2.6 }),
    );
    redLamp.position.set(0.95, 2.32, endZ + 0.5);
    group.add(redLamp);

    // Табличка «ВЫХОД К СОСЕДНЕМУ ВАГОНУ».
    const signCanvas = document.createElement('canvas');
    signCanvas.width = 512;
    signCanvas.height = 128;
    const ctx = signCanvas.getContext('2d');
    ctx.fillStyle = '#0d1109';
    ctx.fillRect(0, 0, 512, 128);
    ctx.strokeStyle = '#b9f7a4';
    ctx.lineWidth = 5;
    ctx.strokeRect(6, 6, 500, 116);
    ctx.fillStyle = '#d6f4c8';
    ctx.font = '600 46px "Cascadia Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('СОСЕДНИЙ ВАГОН', 256, 52);
    ctx.fillStyle = '#8fbf85';
    ctx.font = '500 30px "Cascadia Mono", monospace';
    ctx.fillText('ТАМБУР // БУФЕРНАЯ ЗОНА', 256, 96);
    const signTexture = new THREE.CanvasTexture(signCanvas);
    signTexture.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 0.38),
      new THREE.MeshStandardMaterial({
        map: signTexture,
        emissive: 0xffffff,
        emissiveMap: signTexture,
        emissiveIntensity: 0.5,
        roughness: 0.8,
      }),
    );
    // Над дверным проёмом: ниже табличку срезала перекладина двери.
    sign.position.set(0, 2.43, endZ + 0.12);
    group.add(sign);

    // Разметка на полу: куда идти.
    const arrow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 1.4),
      new THREE.MeshBasicMaterial({ color: 0xb9f7a4, transparent: true, opacity: 0.2 }),
    );
    arrow.rotation.x = -Math.PI / 2;
    arrow.position.set(0, 0.06, -20.2);
    group.add(arrow);

    // Опасная зона у лаза: жёлто-чёрная разметка и красный фонарь.
    const hazardCanvas = document.createElement('canvas');
    hazardCanvas.width = 256;
    hazardCanvas.height = 64;
    const hctx = hazardCanvas.getContext('2d');
    hctx.fillStyle = '#1a1508';
    hctx.fillRect(0, 0, 256, 64);
    for (let i = -2; i < 10; i += 1) {
      hctx.fillStyle = i % 2 === 0 ? '#d8b23c' : '#231c0a';
      hctx.save();
      hctx.translate(i * 32, 0);
      hctx.rotate(-0.4);
      hctx.fillRect(0, -30, 18, 130);
      hctx.restore();
    }
    const hazardTexture = new THREE.CanvasTexture(hazardCanvas);
    hazardTexture.colorSpace = THREE.SRGBColorSpace;
    hazardTexture.wrapS = THREE.RepeatWrapping;
    hazardTexture.wrapT = THREE.RepeatWrapping;
    hazardTexture.repeat.set(1, 4);
    const hazard = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 2.25),
      new THREE.MeshBasicMaterial({ map: hazardTexture, transparent: true, opacity: 0.8 }),
    );
    hazard.rotation.set(-Math.PI / 2, 0, 0);
    hazard.position.set(-1.34, 0.055, -19.55);
    group.add(hazard);

    const dumpSignCanvas = document.createElement('canvas');
    dumpSignCanvas.width = 384;
    dumpSignCanvas.height = 128;
    const dctx = dumpSignCanvas.getContext('2d');
    dctx.fillStyle = '#1a0806';
    dctx.fillRect(0, 0, 384, 128);
    dctx.strokeStyle = '#ff6a4a';
    dctx.lineWidth = 5;
    dctx.strokeRect(6, 6, 372, 116);
    dctx.fillStyle = '#ffc0b0';
    dctx.font = '600 44px "Cascadia Mono", monospace';
    dctx.textAlign = 'center';
    dctx.textBaseline = 'middle';
    dctx.fillText('СБРОС', 192, 50);
    dctx.fillStyle = '#c98a78';
    dctx.font = '500 26px "Cascadia Mono", monospace';
    dctx.fillText('ДЕРЖИТЕ E У БОРТА', 192, 96);
    const dumpSignTexture = new THREE.CanvasTexture(dumpSignCanvas);
    dumpSignTexture.colorSpace = THREE.SRGBColorSpace;
    const dumpSign = new THREE.Mesh(
      new THREE.PlaneGeometry(0.74, 0.26),
      new THREE.MeshStandardMaterial({
        map: dumpSignTexture,
        emissive: 0xffffff,
        emissiveMap: dumpSignTexture,
        emissiveIntensity: 0.6,
        roughness: 0.7,
        side: THREE.DoubleSide,
      }),
    );
    dumpSign.rotation.y = Math.PI / 2;
    // Выше уровня глаз: вплотную к ограждению табличка не должна
    // занимать весь экран — сброс показывает подсказка в центре.
    dumpSign.position.set(-1.68, 2.26, -19.5);
    group.add(dumpSign);

    const gapBulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.075, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0x3a0a06, emissive: 0xff3a1c, emissiveIntensity: 2.8 }),
    );
    gapBulb.position.set(-1.62, 2.12, -19.55);
    group.add(gapBulb);
    this.vestibuleGapLamp = gapBulb;

    this.vestibuleColliders = [
      // Стена вагона: проход только через дверь-переход (телепорт).
      { minX: -this.halfW, maxX: this.halfW, minZ: -this.halfL - 0.35, maxZ: -this.halfL + 0.05, type: 'wall' },
      // Торцевая стена.
      { minX: -this.halfW, maxX: this.halfW, minZ: endZ - 0.2, maxZ: endZ + 0.1, type: 'wall' },
    ];
    this.colliders.push(...this.vestibuleColliders);
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

    // Дверное полотно из двух створок. Створки — отдельные группы,
    // чтобы дверь в тамбур могла разъехаться перед игроком.
    const leafs = [];
    for (const x of [-0.3, 0.3]) {
      const leaf = new THREE.Group();
      leaf.position.x = 0;
      group.add(leaf);
      leafs.push({ leaf, side: Math.sign(x) });
      this._box({
        w: 0.58,
        h: 2.08,
        d: 0.06,
        material: m.darkMetal,
        x,
        y: 1.06,
        z: 0.035,
        parent: leaf,
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
        parent: leaf,
      });
      this._box({
        w: 0.5,
        h: 0.12,
        d: 0.07,
        material: m.trim,
        x,
        y: 1.98,
        z: 0.05,
        parent: leaf,
      });
      this._box({
        w: 0.24,
        h: 0.18,
        d: 0.005,
        material: m.paper,
        x,
        y: 1.32,
        z: 0.07,
        parent: leaf,
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
          parent: leaf,
        });
      }
    }
    if (direction < 0) {
      this._doorLeafs = leafs;
      this._doorSlide = 0;
      this._doorSlideTarget = 0;

      // Табличка над дверью: игрок должен видеть, куда идти, даже в темноте.
      const signCanvas = document.createElement('canvas');
      signCanvas.width = 512;
      signCanvas.height = 144;
      const sctx = signCanvas.getContext('2d');
      sctx.fillStyle = 'rgba(4, 10, 6, 0.94)';
      sctx.fillRect(0, 0, 512, 144);
      sctx.strokeStyle = 'rgba(185, 247, 164, 0.62)';
      sctx.lineWidth = 4;
      sctx.strokeRect(6, 6, 500, 132);
      sctx.textAlign = 'center';
      sctx.textBaseline = 'middle';
      sctx.fillStyle = '#d9ffcb';
      sctx.font = '600 56px "Cascadia Mono", "Courier New", monospace';
      sctx.fillText('ТАМБУР', 236, 52);
      sctx.fillStyle = '#b9f7a4';
      sctx.font = '500 28px "Cascadia Mono", "Courier New", monospace';
      sctx.fillText('АВТОМАТ · СБРОС', 236, 106);
      sctx.strokeStyle = '#b9f7a4';
      sctx.lineWidth = 7;
      sctx.beginPath();
      sctx.moveTo(432, 52);
      sctx.lineTo(474, 72);
      sctx.lineTo(432, 92);
      sctx.stroke();
      const signTexture = new THREE.CanvasTexture(signCanvas);
      signTexture.colorSpace = THREE.SRGBColorSpace;
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(0.98, 0.275),
        new THREE.MeshBasicMaterial({ map: signTexture, transparent: true, toneMapped: false }),
      );
      sign.position.set(0, 2.62, 0.12);
      group.add(sign);

      // Зелёные маркеры на полу ведут к двери.
      const markerMaterial = new THREE.MeshBasicMaterial({ color: 0x9be3dc, transparent: true, opacity: 0.34 });
      for (const z of [-12.2, -13.4, -14.6]) {
        for (const x of [-1.55, 1.55]) {
          const marker = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.34), markerMaterial);
          marker.rotation.x = -Math.PI / 2;
          marker.position.set(x, 0.045, z);
          this.group.add(marker);
        }
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
    this._updateDoor(dt);
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
      const serviceDim = this.variant === 1 ? 0.42 : 1;
      this.centralLight.intensity = this.centralBaseIntensity
        * this._flickerValue * (1 - dread * 0.52) * power * serviceDim;
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

  /**
   * Логический вагон: 0 — пассажирский, 1 — служебный.
   * Служебный: скамьи убраны, вдоль стен ящики и мешки, свет приглушён.
   */
  /**
   * Игровая зона: 'car' — салон/соседний вагон, 'vestibule' — тамбур.
   *
   * Раньше границы мира оставались [-15, 15] и после перехода в тамбур
   * (z ≈ −17) игрок оказывался вне bounds: _isBlocked() возвращал true
   * для любого шага, и из тамбура было невозможно выйти. Теперь границы
   * и коллизии переключаются вместе с зоной.
   */
  setZone(zone) {
    const next = zone === 'vestibule' ? 'vestibule' : 'car';
    if (this.zone === next) return;
    this.zone = next;
    if (next === 'vestibule') {
      const endZ = -this.halfL - 6.6;
      this.bounds = {
        minX: -this.halfW + 0.24,
        maxX: this.halfW - 0.24,
        minZ: endZ + 0.22,
        maxZ: -this.halfL - 0.3,
        minY: 0,
        maxY: this.height,
      };
      this.colliders = (this.vestibuleColliders || []).slice();
    } else {
      this.bounds = { ...this._carBounds };
      if (!this._baseColliders) this._baseColliders = this.colliders.slice();
      this.colliders = this.variant === 1
        ? this._baseColliders.concat(this._serviceColliders)
        : this._baseColliders.slice();
    }
    if (this.renderer) this.renderer.shadowMap.needsUpdate = true;
  }

  /** 0 — створки закрыты, 1 — разъехались. */
  setDoorOpen(on) {
    this._doorSlideTarget = on ? 1 : 0;
  }

  _updateDoor(dt) {
    const target = this._doorSlideTarget || 0;
    const next = damp(this._doorSlide, target, 9, dt);
    if (Math.abs(next - this._doorSlide) < 0.0005) {
      this._doorSlide = target;
    } else {
      this._doorSlide = next;
    }
    if (!this._doorLeafs) return;
    for (const entry of this._doorLeafs) {
      entry.leaf.position.x = entry.side * 0.64 * this._doorSlide;
    }
  }

  setCarVariant(index) {
    const next = index === 1 ? 1 : 0;
    if (this.variant === next) return;
    if (!this._baseColliders) this._baseColliders = this.colliders.slice();
    this.variant = next;
    if (next === 1) {
      this._ensureServiceProps();
      // Скамьи остаются под брезентом — коллизии сохраняем.
      this.colliders = this._baseColliders.concat(this._serviceColliders);
    } else {
      this.colliders = this._baseColliders.slice();
    }
    for (const child of this.group.children) {
      if (child.name === 'Скамья') child.visible = next === 0;
    }
    if (this._serviceProps) this._serviceProps.visible = next === 1;
    if (this.renderer) this.renderer.shadowMap.needsUpdate = true;
  }

  _ensureServiceProps() {
    if (this._serviceProps) return;
    const group = new THREE.Group();
    group.name = 'Служебный вагон';
    this.group.add(group);

    const crateMat = new THREE.MeshStandardMaterial({ color: 0x4a3a26, roughness: 0.93 });
    const crateEdge = new THREE.MeshStandardMaterial({ color: 0x2a2015, roughness: 0.9 });
    const sackMat = new THREE.MeshStandardMaterial({ color: 0x3e3b32, roughness: 0.99 });

    const addCrate = (x, z, size, yaw) => {
      const crate = new THREE.Group();
      crate.position.set(x, 0, z);
      crate.rotation.y = yaw;
      const box = new THREE.Mesh(new THREE.BoxGeometry(size, size * 0.82, size * 0.86), crateMat);
      box.position.y = size * 0.41;
      box.castShadow = true;
      crate.add(box);
      for (const offset of [-0.14, 0.14]) {
        const band = new THREE.Mesh(
          new THREE.BoxGeometry(size * 1.02, size * 0.05, size * 0.88),
          crateEdge,
        );
        band.position.y = size * (0.5 + offset);
        crate.add(band);
      }
      group.add(crate);
      this._serviceColliders.push({
        minX: x - size * 0.55,
        maxX: x + size * 0.55,
        minZ: z - size * 0.5,
        maxZ: z + size * 0.5,
        type: 'cargo',
      });
    };

    // Брезент поверх скамей: вагон читается как служебный, без перестройки мира.
    const tarpMat = new THREE.MeshStandardMaterial({ color: 0x33372e, roughness: 0.99 });
    const strapMat = new THREE.MeshStandardMaterial({ color: 0x1d1f19, roughness: 0.9 });
    for (const side of [-1, 1]) {
      for (const centerZ of [-9.9, -4.95, 0, 4.95, 9.9]) {
        const tarp = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.5, 3.42), tarpMat);
        tarp.position.set(side * 1.43, 0.62, centerZ);
        tarp.castShadow = true;
        group.add(tarp);
        for (const offset of [-1.12, 0, 1.12]) {
          const strap = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.04, 0.07), strapMat);
          strap.position.set(side * 1.43, 0.88, centerZ + offset);
          group.add(strap);
        }
        const tag = new THREE.Mesh(
          new THREE.PlaneGeometry(0.2, 0.12),
          new THREE.MeshStandardMaterial({ color: 0xcfc6a6, roughness: 0.95, emissive: 0x2a2618, emissiveIntensity: 0.2 }),
        );
        tag.position.set(side * 1.08, 0.7, centerZ + 1.2);
        tag.rotation.y = side * -Math.PI / 2;
        group.add(tag);
      }
    }

    addCrate(-1.28, -12.4, 0.62, 0.12);
    addCrate(-1.3, -11.3, 0.5, -0.3);
    addCrate(1.3, 4.8, 0.66, 0.2);
    addCrate(1.28, 6.0, 0.54, -0.06);
    addCrate(-1.25, 7.4, 0.58, 0.34);

    for (const [x, z, s] of [[1.26, -3.2, 0.5], [1.3, -2.1, 0.42], [-1.3, 1.2, 0.46]]) {
      const sack = new THREE.Mesh(new THREE.CapsuleGeometry(s * 0.44, s * 0.5, 4, 10), sackMat);
      sack.position.set(x, s * 0.5, z);
      sack.rotation.z = 0.12;
      sack.castShadow = true;
      group.add(sack);
      this._serviceColliders.push({
        minX: x - s * 0.5,
        maxX: x + s * 0.5,
        minZ: z - s * 0.5,
        maxZ: z + s * 0.5,
        type: 'cargo',
      });
    }

    // Служебный фонарь над тормозным краном.
    const lampShade = new THREE.Mesh(
      new THREE.ConeGeometry(0.14, 0.16, 12, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x2b2b26, roughness: 0.8, metalness: 0.4, side: THREE.DoubleSide }),
    );
    lampShade.position.set(0.85, 2.35, -15.05);
    group.add(lampShade);
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xff6a3d, emissive: 0xff3a10, emissiveIntensity: 2.4 }),
    );
    bulb.position.set(0.85, 2.26, -15.05);
    group.add(bulb);
    const lamp = new THREE.PointLight(0xff5a2a, 2.4, 6.5, 2);
    lamp.position.set(0.85, 2.2, -15.0);
    group.add(lamp);

    group.visible = false;
    if (this.renderer) this.renderer.shadowMap.needsUpdate = true;
    this._serviceProps = group;
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
    // Упавший игрок лежит: камера у пола, движение выключено.
    this.downed = false;
    this._standEyeHeight = CONFIG.player.eyeHeight;
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

  /** Падение: камера падает на пол, движение и предметы недоступны. */
  setDowned(on) {
    const next = Boolean(on);
    if (this.downed === next) return;
    this.downed = next;
    this.eyeHeight = next ? 0.34 : this._standEyeHeight;
    this.velocity.set(0, 0, 0);
    this.keys.clear();
    this._releaseInteract();
    if (next) {
      this.sprinting = false;
      this.bus.emit('player:interact', { held: false });
    }
    this._syncCamera(0);
  }

  /** Развернуть взгляд (после переноса через дверь). */
  setYaw(yaw) {
    const next = Number(yaw);
    if (!Number.isFinite(next)) return;
    this.camera.rotation.set(this.camera.rotation.x, next, 0, 'YXZ');
    this._syncCamera(0);
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

    if (this.downed) {
      // Лежим: смотрим по сторонам, но не двигаемся.
      this.velocity.set(0, 0, 0);
      this.stamina = Math.min(CONFIG.player.staminaMax, this.stamina + CONFIG.player.staminaRegen * dt);
      this._syncCamera(elapsed);
      this._emitStamina(false);
      return;
    }

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
    if (this.downed) this.camera.rotation.z = 0.62;
    else if (this.camera.rotation.z) this.camera.rotation.z = 0;
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

/**
 * Набор деталей для сборки члена экипажа.
 *
 * Общая база (торс, голова, руки, ноги) одна, скины добавляют характер:
 * китель, матроску, мех, корпус телевизора или кожаное пальто. Так экипаж
 * выглядит как пассажиры в салоне, а не как набор капсул.
 */
function kit_headMat(kit, palette) {
  return kit._mat(palette.head, { roughness: 0.75, emissive: new THREE.Color(palette.head).multiplyScalar(0.3).getHex(), emissiveIntensity: 0.7 });
}

class CrewKit {
  static create(owner, model, look, accent) {
    return new CrewKit(owner, model, look, accent);
  }

  static PALETTE = {
    conductor: { coat: 0x46553c, sleeve: 0x2c3726, trim: 0x1b2118, legs: 0x262b23, head: 0xd8bb9b, build: 1.02 },
    schoolgirl: { coat: 0x39466e, sleeve: 0x27304d, trim: 0xf4f6fa, legs: 0x232941, head: 0xf0d2b5, build: 0.88 },
    furry: { coat: 0xb47d47, sleeve: 0x8d5f34, trim: 0xe8d4b4, legs: 0x6b4a2e, head: 0xb47d47, build: 1.0 },
    tv: { coat: 0x3d4457, sleeve: 0x2a3040, trim: 0x191d26, legs: 0x22262f, head: 0xb4b4b4, build: 0.98 },
    engineer: { coat: 0x49637a, sleeve: 0x33475a, trim: 0x263140, legs: 0x36485a, head: 0xc99d78, build: 1.05 },
    inspector: { coat: 0x3d3024, sleeve: 0x2b2118, trim: 0x1c1611, legs: 0x201a15, head: 0xded3c2, build: 0.96 },
  };

  constructor(owner, model, look, accent) {
    this.owner = owner;
    this.model = model;
    this.look = look;
    this.accent = accent;
    this.shoulders = [];
    this.legs = [];
    this.materials = [];

    const palette = CrewKit.PALETTE[look.skin] || CrewKit.PALETTE.conductor;
    this.palette = palette;
    this.headColor = palette.head;
    this.legsColor = palette.legs;
    this.build = (look.build || 1) * (palette.build || 1);
    this.front = null;

    const cache = new Map();
    // В вагоне темно, поэтому у каждой ткани есть чуть-чуть собственного
    // свечения: иначе лица и детали формы читаются как чёрные пятна.
    const selfLit = (color) => new THREE.Color(color).multiplyScalar(0.22).getHex();
    this._mat = (color, opts = {}) => {
      const key = `${color}|${opts.roughness ?? 0.9}|${opts.metalness ?? 0.05}|${opts.emissive ?? 0}|${opts.emissiveIntensity ?? 0}|${opts.side ?? 0}`;
      if (cache.has(key)) return cache.get(key);
      const emissive = opts.emissive ?? selfLit(color);
      const material = new THREE.MeshStandardMaterial({
        color,
        roughness: opts.roughness ?? 0.9,
        metalness: opts.metalness ?? 0.05,
        emissive,
        emissiveIntensity: opts.emissiveIntensity ?? 0.55,
        side: opts.side ?? THREE.FrontSide,
      });
      cache.set(key, material);
      this.materials.push(material);
      return material;
    };
    this.mat = this._mat;

    this.add = (geometry, material, parent, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.rotation.set(rx, ry, rz);
      parent.add(mesh);
      return mesh;
    };

    // Основа: узкий торс-«пальто» с плечами. Всё декоративное лежит на
    // поверхности (z ≈ 0.12…0.2), поэтому матроска, ремни и экран видны.
    const body = new THREE.Group();
    body.position.y = 0.82;
    model.add(body);
    this.body = body;

    this.torsoMat = this._mat(palette.coat, { emissive: 0x141c14, emissiveIntensity: 0.4 });
    const torso = this.add(new THREE.BoxGeometry(0.36 * this.build, 0.5, 0.23), this.torsoMat, body, 0, 0.14, 0);
    torso.scale.set(1, 1, 1);
    // Скруглённые бока: не даёт силуэту стать «доской».
    this.add(new THREE.CapsuleGeometry(0.12 * this.build, 0.34, 3, 10), this.torsoMat, body, 0, 0.16, 0);
    this.add(new THREE.BoxGeometry(0.46 * this.build, 0.1, 0.25), this.torsoMat, body, 0, 0.42, 0);
    this.add(new THREE.BoxGeometry(0.4 * this.build, 0.1, 0.22), this.torsoMat, body, 0, -0.12, 0);

    // Шея и голова-заготовка; детали лица и причёску добавляют скины.
    this.add(new THREE.CylinderGeometry(0.056, 0.062, 0.08, 10), kit_headMat(this, palette), body, 0, 0.55, 0);
    this.headGroup = new THREE.Group();
    this.headGroup.position.y = 0.58;
    this.headGroup.scale.setScalar(1.16);
    body.add(this.headGroup);

    // Невидимая метка «лицо»: по ней тесты и отладка понимают, куда смотрит
    // модель. Все скины обязаны держать её в +Z.
    const frontMarker = new THREE.Object3D();
    frontMarker.position.set(0, 1.06, 0.26);
    frontMarker.name = 'лицо';
    model.add(frontMarker);
    this.frontMarker = frontMarker;
    this.front = frontMarker;
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

  /** Детерминированный «характер» члена экипажа по id: цвет, рост, шапка. */
  static _crewLook(id, name) {
    const seed = String(`${id}|${name || ''}`);
    let hash = 2166136261;
    for (let i = 0; i < seed.length; i += 1) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const looks = [
      { coat: 0x3b4a44, trim: 0x1f2a26, skin: 0xc9ad8f, hat: 'cap', scarf: 0x6d2f28, gear: 'lantern' },
      { coat: 0x4a3f34, trim: 0x2b241b, skin: 0x8d6a4c, hat: 'beanie', scarf: 0x5a6b52, gear: 'satchel' },
      { coat: 0x2f3d4d, trim: 0x1c2531, skin: 0xd8bd9d, hat: 'hood', scarf: 0x8b6b3a, gear: 'radio' },
      { coat: 0x4a3540, trim: 0x2a1e26, skin: 0xb08a68, hat: 'none', scarf: 0x77604a, gear: 'lantern' },
      { coat: 0x37472f, trim: 0x212c1c, skin: 0x9b7355, hat: 'cap', scarf: 0xa0632f, gear: 'satchel' },
      { coat: 0x3c3c46, trim: 0x23232b, skin: 0xe0c8ab, hat: 'beanie', scarf: 0x6a4a5a, gear: 'radio' },
    ];
    const look = looks[hash % looks.length];
    return {
      ...look,
      height: 0.96 + ((hash >>> 8) % 11) / 100,
      build: 0.92 + ((hash >>> 16) % 19) / 100,
    };
  }

  static ACCENTS = [0x9be3dc, 0xb9f7a4, 0xff6a4a, 0xc9a0ff];
  static SKINS = ['conductor', 'schoolgirl', 'furry', 'tv', 'engineer', 'inspector'];

  _createAvatar(player) {
    const group = new THREE.Group();
    group.name = `Пассажир: ${player.name}`;
    group.visible = false;
    this._group.add(group);

    const look = RemotePlayers._crewLook(player.id, player.name);
    const skin = player.skin || 'conductor';
    const accent = Number.isInteger(player.accent) ? player.accent : 0;
    const model = new THREE.Group();
    // Модель собрана лицом в +Z, а сетевой yaw считает вперёд по −Z.
    model.rotation.y = Math.PI;
    group.add(model);
    const parts = this._buildCrewModel(model, skin, accent, look);
    group.scale.setScalar(look.height);

    const ringMaterial = new THREE.MeshBasicMaterial({
      color: RemotePlayers.ACCENTS[accent] || RemotePlayers.ACCENTS[0],
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
    tag.position.y = 2.18 * look.height;
    group.add(tag);

    const avatar = {
      id: player.id,
      player,
      name: player.name,
      group,
      model,
      parts,
      body: parts.body,
      bodyMaterial: parts.bodyMaterial,
      visor: parts.visor,
      visorMaterial: parts.visorMaterial,
      ring,
      ringMaterial,
      tag,
      tagMaterial,
      samples: [],
      speaking: false,
      stale: false,
      downed: false,
      inCar: false,
      lastTagState: '',
      hasState: false,
      look,
      skin,
      accent,
      kit: parts.kit,
    };

    if (this.voice) this.voice.attachAvatar(player.id, group);
    return avatar;
  }

  /**
   * Модель члена экипажа — как пассажиры в салоне, только по пояс заметнее
   * и с характером. Все модели собираются лицом в +Z, а группа разворачивается
   * на π: сетевой yaw считает «вперёд» по −Z, поэтому так никто не идёт спиной.
   */
  _buildCrewModel(model, skin, accentIndex, look) {
    const accent = RemotePlayers.ACCENTS[accentIndex] || RemotePlayers.ACCENTS[0];
    const kit = CrewKit.create(this, model, { ...look, skin }, accent);
    const { add, body, mat } = kit;
    const torsoMat = kit.torsoMat;

    if (skin === 'schoolgirl') this._skinSchoolgirl(kit);
    else if (skin === 'furry') this._skinFurry(kit);
    else if (skin === 'tv') this._skinTv(kit);
    else if (skin === 'engineer') this._skinEngineer(kit);
    else if (skin === 'inspector') this._skinInspector(kit);
    else this._skinConductor(kit);

    // Руки: у фури лапы, у телевизора перчатки, у остальных кисти.
    const paw = skin === 'furry';
    const glove = skin === 'tv' ? mat(0xcfcfcf, { roughness: 0.55 }) : null;
    const sleeveMat = mat(kit.palette.sleeve, { roughness: 0.94 });
    for (const side of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.265 * kit.build, 0.4, 0);
      body.add(shoulder);
      add(new THREE.CapsuleGeometry(paw ? 0.075 : 0.056, 0.42, 3, 8), sleeveMat, shoulder, 0, -0.24, 0);
      if (paw) {
        add(new THREE.SphereGeometry(0.078, 10, 8), mat(kit.headColor, { roughness: 0.99 }), shoulder, 0, -0.47, 0.02);
        for (let f = 0; f < 3; f += 1) {
          add(new THREE.CapsuleGeometry(0.013, 0.045, 2, 5), mat(0x1b1512, { roughness: 0.9 }), shoulder, (f - 1) * 0.028, -0.53, 0.045);
        }
      } else if (glove) {
        add(new THREE.SphereGeometry(0.058, 10, 8), glove, shoulder, 0, -0.47, 0.01);
      } else {
        add(new THREE.SphereGeometry(0.052, 9, 7), mat(kit.headColor, { roughness: 0.75 }), shoulder, 0, -0.47, 0.01);
      }
      shoulder.rotation.z = side * -0.07;
      kit.shoulders.push({ shoulder, side });
    }

    // Ноги и обувь: своя у школьницы, лапы у фури, сапоги у остальных.
    for (const side of [-1, 1]) {
      const leg = new THREE.Group();
      leg.position.set(side * 0.1 * kit.build, 0.66, 0);
      model.add(leg);
      add(new THREE.CapsuleGeometry(paw ? 0.085 : 0.068, 0.48, 3, 8), mat(kit.legsColor, { roughness: 0.94 }), leg, 0, -0.27, 0);
      if (skin === 'schoolgirl') {
        add(new THREE.CylinderGeometry(0.058, 0.054, 0.24, 10), mat(0xeef0f4, { roughness: 0.9 }), leg, 0, -0.4, 0);
        add(new THREE.BoxGeometry(0.11, 0.06, 0.21), mat(0x1d1a16, { roughness: 0.45, metalness: 0.25 }), leg, 0, -0.57, 0.05);
      } else if (paw) {
        add(new THREE.BoxGeometry(0.14, 0.08, 0.26), mat(kit.headColor, { roughness: 0.99 }), leg, 0, -0.57, 0.05);
      } else {
        add(new THREE.BoxGeometry(0.12, 0.09, 0.24), mat(0x241f1a, { roughness: 0.65, metalness: 0.1 }), leg, 0, -0.57, 0.035);
      }
      kit.legs.push(leg);
    }

    if (skin === 'tv') this._headTv(kit);
    else if (skin === 'furry') this._headFurry(kit);
    else if (skin === 'schoolgirl') this._headSchoolgirl(kit);
    else this._headHuman(kit, skin);

    const visorMaterial = new THREE.MeshStandardMaterial({
      color: 0x0a1410,
      emissive: accent,
      emissiveIntensity: 1.4,
      roughness: 0.4,
    });
    const visor = add(new THREE.BoxGeometry(0.08, 0.026, 0.02), visorMaterial, body, 0, 0.25, 0.13);

    model.traverse((object) => {
      if (object.isMesh) object.castShadow = false;
    });

    return {
      body,
      bodyMaterial: torsoMat,
      visor,
      visorMaterial,
      model,
      kit,
      front: kit.front,
      frontMarker: kit.frontMarker,
    };
  }

  // --- Проводник: форменный китель, погоны, фуражка ---------------------

  _skinConductor(kit) {
    const { add, body, mat, accent, build } = kit;
    const brass = mat(0x8a7a48, { metalness: 0.85, roughness: 0.32 });
    const dark = mat(0x171c14, { roughness: 0.88 });
    const shirt = mat(0xd9d4c4, { roughness: 0.85 });
    // Борт кителя, воротник, рубашка.
    add(new THREE.BoxGeometry(0.075, 0.46, 0.02), dark, body, 0, 0.14, 0.118);
    add(new THREE.BoxGeometry(0.3 * build, 0.11, 0.05), shirt, body, 0, 0.38, 0.09);
    add(new THREE.BoxGeometry(0.34 * build, 0.07, 0.2), dark, body, 0, 0.44, 0);
    // Погоны.
    for (const side of [-1, 1]) {
      add(new THREE.BoxGeometry(0.12, 0.02, 0.08), brass, body, side * 0.14 * build, 0.44, 0);
    }
    // Ремень, бляха, компостер, нашивка.
    add(new THREE.BoxGeometry(0.38 * build, 0.05, 0.25), dark, body, 0, -0.04, 0);
    add(new THREE.BoxGeometry(0.06, 0.04, 0.02), brass, body, 0, -0.04, 0.13);
    const punch = add(new THREE.BoxGeometry(0.05, 0.08, 0.03), mat(0x30302a, { metalness: 0.7, roughness: 0.4 }), body, 0.13, -0.1, 0.12);
    punch.rotation.z = -0.2;
    add(new THREE.BoxGeometry(0.018, 0.075, 0.055), mat(accent, { emissive: accent, emissiveIntensity: 0.6 }), body, -0.21 * build, 0.06, 0.04);
    for (let i = 0; i < 3; i += 1) add(new THREE.SphereGeometry(0.013, 7, 5), brass, body, 0.035, 0.28 - i * 0.11, 0.125);
    kit.front = punch;
  }

  // --- Японская школьница: матроска, юбка, гольфы, два хвоста -----------

  _skinSchoolgirl(kit) {
    const { add, body, mat } = kit;
    const navy = mat(0x27304d, { roughness: 0.88 });
    const white = mat(0xeef0f4, { roughness: 0.85 });
    const red = mat(0xa8202f, { roughness: 0.8 });

    // Матроска: воротник-«парус», полосы, галстук.
    add(new THREE.BoxGeometry(0.38, 0.1, 0.24), white, body, 0, 0.42, 0);
    for (const side of [-1, 1]) {
      const flap = add(new THREE.BoxGeometry(0.13, 0.12, 0.015), white, body, side * 0.12, 0.33, 0.125);
      flap.rotation.z = side * 0.3;
      add(new THREE.BoxGeometry(0.1, 0.01, 0.01), navy, body, side * 0.12, 0.35, 0.135).rotation.z = side * 0.3;
      add(new THREE.BoxGeometry(0.09, 0.008, 0.01), navy, body, side * 0.12, 0.32, 0.135).rotation.z = side * 0.3;
    }
    add(new THREE.BoxGeometry(0.07, 0.14, 0.025), red, body, 0, 0.27, 0.13);
    const knot = add(new THREE.BoxGeometry(0.11, 0.06, 0.03), red, body, 0, 0.21, 0.135);
    knot.rotation.z = 0.08;

    // Плиссированная юбка: клинья от пояса вниз и наружу.
    const skirt = new THREE.Group();
    skirt.position.y = -0.16;
    body.add(skirt);
    for (let i = 0; i < 14; i += 1) {
      const angle = (i / 14) * Math.PI * 2;
      const panel = add(new THREE.BoxGeometry(0.085, 0.34, 0.025), navy, skirt,
        Math.sin(angle) * 0.16, -0.12, Math.cos(angle) * 0.13, 0.2, angle, 0.09);
      panel.scale.set(1, 1, 1);
    }
    add(new THREE.CylinderGeometry(0.17, 0.24, 0.34, 14, 1, true), mat(0x232c48, { roughness: 0.9, side: THREE.DoubleSide }), skirt, 0, -0.1, 0);

    // Сумка через плечо и бант на груди.
    const strap = add(new THREE.BoxGeometry(0.035, 0.46, 0.015), mat(0x4a3a2a, { roughness: 0.9 }), body, -0.1, 0.18, 0.125);
    strap.rotation.z = 0.38;
    add(new THREE.BoxGeometry(0.17, 0.14, 0.07), mat(0x3a2e22, { roughness: 0.88 }), body, 0.17, -0.18, 0.02);
    add(new THREE.BoxGeometry(0.05, 0.025, 0.015), mat(kit.accent, { emissive: kit.accent, emissiveIntensity: 1 }), body, 0.17, -0.15, 0.06);
    kit.front = knot;
  }

  /** Волосы: шапка сверху и «затылок», чтобы лицо всегда оставалось открытым. */
  _hair(kit, color, { radius = 0.142, drop = 0.4, back = 0.62 } = {}) {
    const { add, headGroup: head, mat } = kit;
    const hairMat = mat(color, { roughness: 0.9, emissive: new THREE.Color(color).multiplyScalar(0.22).getHex(), emissiveIntensity: 0.7 });
    const cap = add(new THREE.SphereGeometry(radius, 18, 12, 0, Math.PI * 2, 0, Math.PI * drop), hairMat, head, 0, 0.16, 0);
    cap.scale.set(0.97, 1.02, 1.03);
    const backPanel = add(new THREE.SphereGeometry(radius, 18, 12, Math.PI, Math.PI, Math.PI * drop, Math.PI * (back - drop)), hairMat, head, 0, 0.16, 0);
    backPanel.scale.set(0.97, 1.02, 1.03);
    return hairMat;
  }

  _headSchoolgirl(kit) {
    const { add, headGroup: head, mat, accent } = kit;
    this._headSphere(kit, 'schoolgirl', 0.134);
    const hairMat = this._hair(kit, 0x3a2b28, { radius: 0.146, drop: 0.34, back: 0.82 });
    // Чёлка и два хвоста с лентами.
    add(new THREE.BoxGeometry(0.23, 0.05, 0.035), hairMat, head, 0, 0.256, 0.106);
    add(new THREE.BoxGeometry(0.06, 0.16, 0.03), hairMat, head, -0.122, 0.15, 0.082).rotation.z = 0.14;
    add(new THREE.BoxGeometry(0.06, 0.16, 0.03), hairMat, head, 0.122, 0.15, 0.082).rotation.z = -0.14;
    for (const side of [-1, 1]) {
      const tail = add(new THREE.CapsuleGeometry(0.042, 0.28, 3, 8), hairMat, head, side * 0.16, 0.12, -0.04);
      tail.rotation.z = side * 0.5;
      tail.rotation.x = 0.22;
      add(new THREE.BoxGeometry(0.08, 0.045, 0.028), mat(0xa8202f, { roughness: 0.7 }), head, side * 0.14, 0.24, -0.01);
    }
  }

  // --- Фури: лиса в форме -------------------------------------------------

  _skinFurry(kit) {
    const { add, body, model, mat, accent } = kit;
    const fur = mat(0x9a6a3c, { roughness: 0.99 });
    const furLight = mat(0xd9c3a1, { roughness: 0.99 });
    // Меховой воротник, грудь, хвост.
    add(new THREE.TorusGeometry(0.16, 0.05, 8, 16), furLight, body, 0, 0.44, 0, Math.PI / 2);
    add(new THREE.SphereGeometry(0.14, 12, 10), furLight, body, 0, 0.3, 0.1).scale.set(1, 0.9, 0.5);
    const tail = add(new THREE.CapsuleGeometry(0.085, 0.48, 4, 10), fur, model, 0, 0.68, -0.26);
    tail.rotation.x = -1.0;
    tail.rotation.z = 0.18;
    add(new THREE.SphereGeometry(0.11, 10, 8), furLight, model, 0, 0.5, -0.58);
    add(new THREE.BoxGeometry(0.06, 0.04, 0.012), mat(accent, { emissive: accent, emissiveIntensity: 0.9 }), body, 0.11, 0.22, 0.125);
  }

  _headFurry(kit) {
    const { add, headGroup: head, mat, accent } = kit;
    const fur = mat(0x9a6a3c, { roughness: 0.99 });
    const light = mat(0xd9c3a1, { roughness: 0.99 });
    const dark = mat(0x241814, { roughness: 0.7 });
    this._headSphere(kit, 'furry', 0.138);
    head.children[0].position.y = 0.18;
    add(new THREE.CapsuleGeometry(0.045, 0.03, 3, 8), light, head, 0, 0.132, 0.132).rotation.x = Math.PI / 2;
    add(new THREE.SphereGeometry(0.019, 10, 8), dark, head, 0, 0.138, 0.172);
    for (const side of [-1, 1]) {
      const ear = add(new THREE.ConeGeometry(0.068, 0.19, 6), fur, head, side * 0.085, 0.34, -0.01);
      ear.rotation.z = side * -0.16;
      add(new THREE.ConeGeometry(0.036, 0.12, 6), light, head, side * 0.085, 0.34, 0.012).rotation.z = side * -0.16;
      add(new THREE.BoxGeometry(0.055, 0.006, 0.004), light, head, side * 0.045, 0.128, 0.178).rotation.z = side * 0.2;
    }
    add(new THREE.CylinderGeometry(0.145, 0.145, 0.065, 14), mat(0x22281f, { roughness: 0.9 }), head, 0, 0.29, 0);
    add(new THREE.BoxGeometry(0.25, 0.015, 0.12), mat(0x14170f, { roughness: 0.9 }), head, 0, 0.26, 0.13);
  }

  // --- Телевизор на голове -----------------------------------------------

  _skinTv(kit) {
    const { add, body, mat, accent } = kit;
    add(new THREE.BoxGeometry(0.38, 0.18, 0.26), mat(0x232838, { roughness: 0.7, metalness: 0.3 }), body, 0, 0.3, 0);
    const cable = add(new THREE.TorusGeometry(0.09, 0.015, 6, 12, Math.PI * 1.3), mat(0x14161a, { roughness: 0.6 }), body, 0.17, 0.02, -0.1);
    cable.rotation.y = Math.PI / 2;
    add(new THREE.BoxGeometry(0.05, 0.4, 0.015), mat(0x1a1d26, { roughness: 0.9 }), body, -0.12, 0.12, 0.125).rotation.z = 0.3;
    add(new THREE.BoxGeometry(0.04, 0.04, 0.015), mat(accent, { emissive: accent, emissiveIntensity: 1.2 }), body, 0.12, 0.22, 0.125);
  }

  _headTv(kit) {
    const { add, headGroup: head, mat, accent } = kit;
    const shell = mat(0x333a4a, { roughness: 0.5, metalness: 0.35 });
    const trim = mat(0x14171f, { roughness: 0.6, metalness: 0.2 });
    add(new THREE.BoxGeometry(0.34, 0.3, 0.31), shell, head, 0, 0.19, 0);
    add(new THREE.BoxGeometry(0.37, 0.035, 0.33), trim, head, 0, 0.35, 0);
    const screenMat = new THREE.MeshBasicMaterial({ map: this._tvNoise(accent), toneMapped: false });
    const screen = add(new THREE.PlaneGeometry(0.22, 0.18), screenMat, head, -0.03, 0.19, 0.157);
    screen.userData.tvScreen = true;
    add(new THREE.BoxGeometry(0.018, 0.18, 0.015), trim, head, 0.135, 0.19, 0.158);
    for (let i = 0; i < 3; i += 1) add(new THREE.CylinderGeometry(0.015, 0.015, 0.018, 8), mat(0x8a8a86, { metalness: 0.7, roughness: 0.4 }), head, 0.135, 0.25 - i * 0.055, 0.158).rotation.x = Math.PI / 2;
    add(new THREE.CylinderGeometry(0.005, 0.005, 0.28, 5), mat(0x2a2a2a, { metalness: 0.7, roughness: 0.4 }), head, -0.08, 0.48, 0).rotation.z = 0.32;
    add(new THREE.CylinderGeometry(0.005, 0.005, 0.24, 5), mat(0x2a2a2a, { metalness: 0.7, roughness: 0.4 }), head, 0.07, 0.48, 0).rotation.z = -0.2;
    add(new THREE.SphereGeometry(0.011, 6, 5), mat(accent, { emissive: accent, emissiveIntensity: 1.4 }), head, -0.14, 0.48, 0);
    kit.tvScreen = screen;
    kit.front = screen;
  }

  _tvNoise(accent) {
    if (!this._tvNoiseCache) this._tvNoiseCache = new Map();
    const key = Number(accent) || 0;
    if (this._tvNoiseCache.has(key)) return this._tvNoiseCache.get(key);
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(size, size);
    const tint = new THREE.Color(key);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = (y * size + x) * 4;
        const scan = y % 3 === 0 ? 0.55 : 1;
        const value = (0.35 + Math.random() * 0.65) * scan;
        image.data[i] = Math.round(255 * value * (0.25 + tint.r * 0.75));
        image.data[i + 1] = Math.round(255 * value * (0.25 + tint.g * 0.75));
        image.data[i + 2] = Math.round(255 * value * (0.35 + tint.b * 0.65));
        image.data[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    this._tvNoiseCache.set(key, texture);
    return texture;
  }

  // --- Машинист: комбинезон, лямки, каска --------------------------------

  _skinEngineer(kit) {
    const { add, body, mat, accent, build } = kit;
    const denim = mat(0x374a5c, { roughness: 0.95 });
    const strap = mat(0x1f2730, { roughness: 0.9 });
    add(new THREE.BoxGeometry(0.3 * build, 0.3, 0.03), denim, body, 0, 0.1, 0.115);
    for (const side of [-1, 1]) {
      add(new THREE.BoxGeometry(0.05, 0.34, 0.015), strap, body, side * 0.1 * build, 0.26, 0.125);
      add(new THREE.BoxGeometry(0.085, 0.06, 0.018), mat(0x7a2a20, { roughness: 0.9 }), body, side * 0.1 * build, 0.38, 0.125);
    }
    add(new THREE.BoxGeometry(0.12, 0.1, 0.025), mat(0x2a3642, { roughness: 0.9 }), body, -0.09, -0.02, 0.115);
    add(new THREE.CylinderGeometry(0.01, 0.01, 0.12, 6), mat(0xb0b0a8, { metalness: 0.8, roughness: 0.35 }), body, -0.09, 0.08, 0.13);
    add(new THREE.SphereGeometry(0.04, 8, 6), mat(0xffe1a0, { emissive: 0xffc169, emissiveIntensity: 2.2 }), body, 0.13, 0.12, 0.12);
    add(new THREE.BoxGeometry(0.03, 0.05, 0.012), mat(accent, { emissive: accent, emissiveIntensity: 0.7 }), body, 0.16, 0.2, 0.122);
  }

  // --- Ревизор: кожаное пальто, шляпа, лампа -----------------------------

  _skinInspector(kit) {
    const { add, body, mat, accent, build } = kit;
    const leather = mat(0x2a2118, { roughness: 0.72, metalness: 0.12 });
    const leatherDark = mat(0x17110d, { roughness: 0.8 });
    const brass = mat(0x8a7a48, { metalness: 0.85, roughness: 0.32 });
    // Полы пальто до колен, лацканы, пояс.
    add(new THREE.BoxGeometry(0.4 * build, 0.5, 0.2), leather, body, 0, -0.16, -0.01);
    for (const side of [-1, 1]) {
      const lapel = add(new THREE.BoxGeometry(0.1, 0.22, 0.015), leatherDark, body, side * 0.1, 0.3, 0.125);
      lapel.rotation.z = side * 0.22;
    }
    add(new THREE.BoxGeometry(0.4 * build, 0.05, 0.22), leatherDark, body, 0, -0.05, 0);
    add(new THREE.BoxGeometry(0.06, 0.04, 0.02), brass, body, 0, -0.05, 0.12);
    // Часы на цепочке — акцент.
    add(new THREE.TorusGeometry(0.026, 0.005, 6, 10), brass, body, 0.11, 0.02, 0.125);
    add(new THREE.CylinderGeometry(0.025, 0.025, 0.007, 12), mat(accent, { emissive: accent, emissiveIntensity: 0.5, metalness: 0.4, roughness: 0.3 }), body, 0.11, 0.02, 0.132).rotation.x = Math.PI / 2;
    // Керосиновая лампа в левой руке.
    const lamp = new THREE.Group();
    lamp.position.set(-0.27 * build, 0.1, 0.1);
    body.add(lamp);
    add(new THREE.CylinderGeometry(0.035, 0.045, 0.085, 10), brass, lamp, 0, -0.02, 0);
    add(new THREE.CylinderGeometry(0.028, 0.028, 0.055, 10), mat(0xffe1a0, { emissive: 0xffc169, emissiveIntensity: 2.4 }), lamp, 0, 0.05, 0);
    add(new THREE.CylinderGeometry(0.018, 0.044, 0.045, 10), brass, lamp, 0, 0.1, 0);
    kit.front = lamp;
  }

  /**
   * Лицо рисуется на текстуре головы: глаза, брови, рот читаются с двух
   * метров, чего не добиться от мелких шариков в тёмном вагоне.
   * Сфера Three.js кладёт +Z на u = 0.25, поэтому лицо рисуем у x = 128/512.
   */
  _faceTexture(kind, headColor, accent) {
    if (!this._faceCache) this._faceCache = new Map();
    const key = `${kind}|${headColor}|${accent}`;
    if (this._faceCache.has(key)) return this._faceCache.get(key);

    const width = 512;
    const height = 256;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const hex = (value) => `#${value.toString(16).padStart(6, '0')}`;
    const shade = (value, factor) => {
      const c = new THREE.Color(value).multiplyScalar(factor);
      return `#${c.getHexString()}`;
    };

    ctx.fillStyle = hex(headColor);
    ctx.fillRect(0, 0, width, height);
    // Мягкая тень к вискам и подбородку.
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(0,0,0,0.22)');
    gradient.addColorStop(0.42, 'rgba(0,0,0,0)');
    gradient.addColorStop(0.78, 'rgba(0,0,0,0.05)');
    gradient.addColorStop(1, 'rgba(0,0,0,0.3)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = shade(headColor, 0.82);
    ctx.fillRect(0, 0, 54, height);
    ctx.fillRect(width - 54, 0, 54, height);

    const cx = 128;
    const eyeY = 104;
    const eyeDx = 27;
    const ink = '#1b1512';
    const glow = hex(accent);

    // Черты растянуты по горизонтали и слегка по вертикали: 512 px текстуры
    // натянуты на полный оборот сферы, иначе лицо выглядит крошечным.
    // По вертикали глаза ставим чуть выше «экватора» — там, где их видно
    // из-под фуражки, каски или шляпы.
    ctx.save();
    ctx.translate(cx, 114);
    ctx.scale(1.55, 1.1);
    ctx.translate(-cx, -104);

    const drawEye = (x, radius, pupilRadius, iris) => {
      ctx.fillStyle = 'rgba(255,252,244,0.95)';
      ctx.beginPath();
      ctx.ellipse(x, eyeY, radius, radius * 0.85, 0, 0, Math.PI * 2);
      ctx.fill();
      if (iris) {
        ctx.fillStyle = iris;
        ctx.beginPath();
        ctx.arc(x, eyeY + 1, pupilRadius * 1.75, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.arc(x, eyeY + 1, pupilRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.beginPath();
      ctx.arc(x - pupilRadius * 0.45, eyeY - pupilRadius * 0.45, Math.max(1.4, pupilRadius * 0.36), 0, Math.PI * 2);
      ctx.fill();
    };

    if (kind === 'schoolgirl') {
      // Большие аниме-глаза с ресницами и румянец.
      ctx.fillStyle = 'rgba(214,120,120,0.35)';
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(cx + side * 46, 128, 20, 9, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      for (const side of [-1, 1]) drawEye(cx + side * eyeDx, 16, 5, glow);
      ctx.strokeStyle = ink;
      ctx.lineWidth = 4;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(cx + side * eyeDx, eyeY - 2, 17, Math.PI * 1.12, Math.PI * 1.88);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx + side * (eyeDx + 14), eyeY - 10);
        ctx.lineTo(cx + side * (eyeDx + 22), eyeY - 14);
        ctx.stroke();
      }
      ctx.fillStyle = '#a8202f';
      ctx.beginPath();
      ctx.ellipse(cx, 139, 7, 5, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'inspector') {
      // Запавшие глаза и тонкие губы: лицо человека, который слишком много видел.
      for (const side of [-1, 1]) {
        ctx.fillStyle = 'rgba(30,24,20,0.55)';
        ctx.beginPath();
        ctx.ellipse(cx + side * eyeDx, eyeY + 2, 19, 14, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      // Пенсне-ободки под глазами.
      ctx.strokeStyle = 'rgba(236,226,204,0.9)';
      ctx.lineWidth = 2.4;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(cx + side * eyeDx, eyeY, 18, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(cx - eyeDx + 18, eyeY - 1);
      ctx.quadraticCurveTo(cx, eyeY - 8, cx + eyeDx - 18, eyeY - 1);
      ctx.stroke();
      for (const side of [-1, 1]) drawEye(cx + side * eyeDx, 9, 3.6, glow);
      ctx.strokeStyle = 'rgba(40,32,26,0.85)';
      ctx.lineWidth = 3;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(cx + side * (eyeDx - 16), eyeY - 16);
        ctx.quadraticCurveTo(cx + side * eyeDx, eyeY - 23, cx + side * (eyeDx + 16), eyeY - 14);
        ctx.stroke();
      }
      ctx.strokeStyle = '#3a2a24';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(cx - 11, 143);
      ctx.quadraticCurveTo(cx, 146, cx + 11, 143);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(60,48,40,0.5)';
      ctx.lineWidth = 2;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(cx + side * 34, 96);
        ctx.lineTo(cx + side * 44, 90);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx + side * 30, 132);
        ctx.lineTo(cx + side * 42, 136);
        ctx.stroke();
      }
    } else if (kind === 'furry') {
      // Морда: акцентные глаза и тёмный нос.
      for (const side of [-1, 1]) {
        ctx.fillStyle = 'rgba(232,212,180,0.55)';
        ctx.beginPath();
        ctx.ellipse(cx + side * eyeDx, eyeY + 4, 20, 15, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      for (const side of [-1, 1]) drawEye(cx + side * eyeDx, 12, 4.2, glow);
      ctx.fillStyle = '#241814';
      ctx.beginPath();
      ctx.ellipse(cx, 136, 9, 6.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#241814';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(cx, 142);
      ctx.lineTo(cx - 10, 150);
      ctx.moveTo(cx, 142);
      ctx.lineTo(cx + 10, 150);
      ctx.stroke();
      // Усы-щётки.
      ctx.strokeStyle = 'rgba(232,212,180,0.75)';
      ctx.lineWidth = 1.6;
      for (const side of [-1, 1]) {
        for (let i = 0; i < 3; i += 1) {
          ctx.beginPath();
          ctx.moveTo(cx + side * 12, 134 + i * 5);
          ctx.lineTo(cx + side * 34, 130 + i * 7);
          ctx.stroke();
        }
      }
    } else {
      // Люди: проводник и машинист.
      for (const side of [-1, 1]) drawEye(cx + side * eyeDx, 13, 4.4, null);
      ctx.strokeStyle = 'rgba(38,30,24,0.9)';
      ctx.lineWidth = 4;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(cx + side * (eyeDx - 15), eyeY - 17);
        ctx.lineTo(cx + side * (eyeDx + 15), eyeY - 20);
        ctx.stroke();
      }
      if (kind === 'conductor') {
        ctx.strokeStyle = '#4a3a2c';
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(cx - 17, 133);
        ctx.quadraticCurveTo(cx, 128, cx + 17, 133);
        ctx.stroke();
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(cx - 10, 146);
        ctx.quadraticCurveTo(cx, 149, cx + 10, 146);
        ctx.stroke();
      } else {
        ctx.strokeStyle = 'rgba(58,42,32,0.9)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(cx - 12, 146);
        ctx.quadraticCurveTo(cx, 143, cx + 12, 146);
        ctx.stroke();
        // Щетина и пятно мазута.
        ctx.fillStyle = 'rgba(42,34,26,0.22)';
        ctx.beginPath();
        ctx.ellipse(cx, 160, 30, 20, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(20,18,16,0.5)';
        ctx.beginPath();
        ctx.ellipse(cx + 38, 120, 9, 5, 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    this._faceCache.set(key, texture);
    return texture;
  }

  /** Голова-сфера с нарисованным лицом (общая для людей, школьницы и фури). */
  _headSphere(kit, kind, radius = 0.132) {
    const { add, headGroup: head } = kit;
    // Лицо слегка светится собственной текстурой: в вагоне лампа сверху,
    // и без подсветки белки глаз и рот пропадают в тени под козырьком.
    const texture = this._faceTexture(kind, kit.headColor, kit.accent);
    const material = new THREE.MeshStandardMaterial({
      map: texture,
      color: 0xd8d2c8,
      roughness: 0.86,
      metalness: 0.02,
      emissive: 0xffffff,
      emissiveMap: texture,
      emissiveIntensity: 0.34,
    });
    const sphere = add(new THREE.SphereGeometry(radius, 24, 18), material, head, 0, 0.16, 0);
    sphere.scale.set(0.95, 1.03, 1);
    return sphere;
  }

  _headHuman(kit, skin) {
    const { add, headGroup: head, mat, accent, look } = kit;
    const hairMat = mat(skin === 'inspector' ? 0x2f2a24 : 0x2b2e29, { roughness: 0.9 });
    this._headSphere(kit, skin === 'inspector' ? 'inspector' : (skin === 'engineer' ? 'engineer' : 'conductor'));
    if (skin === 'conductor') {
      add(new THREE.CylinderGeometry(0.152, 0.148, 0.09, 16), mat(0x1d241c, { roughness: 0.9 }), head, 0, 0.3, 0);
      add(new THREE.CylinderGeometry(0.15, 0.15, 0.034, 16), mat(0x14180f, { roughness: 0.9 }), head, 0, 0.252, 0);
      add(new THREE.BoxGeometry(0.29, 0.016, 0.15), mat(0x0f120c, { roughness: 0.8 }), head, 0, 0.242, 0.135);
      add(new THREE.CylinderGeometry(0.022, 0.022, 0.008, 10), mat(0x8a7a48, { metalness: 0.8, roughness: 0.3 }), head, 0, 0.312, 0.15).rotation.x = Math.PI / 2;
    } else if (skin === 'inspector') {
      add(new THREE.CylinderGeometry(0.195, 0.195, 0.014, 18), mat(0x1d1913, { roughness: 0.9 }), head, 0, 0.285, 0);
      add(new THREE.CylinderGeometry(0.1, 0.124, 0.115, 14), mat(0x241d15, { roughness: 0.9 }), head, 0, 0.345, 0);
      add(new THREE.TorusGeometry(0.106, 0.012, 6, 14), mat(0x14100c, { roughness: 0.9 }), head, 0, 0.298, 0, Math.PI / 2);
    } else if (skin === 'engineer') {
      // Каска машиниста с фонарём.
      add(new THREE.SphereGeometry(0.148, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.52), mat(0xc9a227, { roughness: 0.45, metalness: 0.2, emissive: 0x4a3a08, emissiveIntensity: 0.8 }), head, 0, 0.2, 0);
      add(new THREE.TorusGeometry(0.148, 0.016, 8, 20), mat(0xa8861c, { roughness: 0.5 }), head, 0, 0.215, 0, Math.PI / 2);
      add(new THREE.BoxGeometry(0.075, 0.05, 0.045), mat(0x2b2b26, { roughness: 0.5 }), head, 0, 0.315, 0.11);
      add(new THREE.CylinderGeometry(0.026, 0.026, 0.016, 10), mat(0xffe6a0, { emissive: 0xffc169, emissiveIntensity: 3 }), head, 0, 0.315, 0.14).rotation.x = Math.PI / 2;
    } else if (look.hat === 'beanie') {
      add(new THREE.SphereGeometry(0.14, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), mat(look.scarf, { roughness: 0.95 }), head, 0, 0.21, 0);
      add(new THREE.TorusGeometry(0.132, 0.02, 8, 18), mat(look.scarf, { roughness: 0.95 }), head, 0, 0.21, 0, Math.PI / 2);
    } else if (look.hat === 'cap') {
      add(new THREE.CylinderGeometry(0.137, 0.137, 0.075, 14), mat(0x232a22, { roughness: 0.9 }), head, 0, 0.27, 0);
      add(new THREE.BoxGeometry(0.26, 0.016, 0.14), mat(0x1b1c19, { roughness: 0.85 }), head, 0, 0.24, 0.12);
    } else {
      this._hair(kit, skin === 'inspector' ? 0x2f2a24 : 0x2b2e29, { drop: 0.42, back: 0.66 });
    }
  }

  /** Смена скина на лету: пересобираем тело, не трогая табличку и кольцо. */
  _restyleAvatar(avatar, skin, accent) {
    if (avatar.skin === skin && avatar.accent === accent) return;
    avatar.skin = skin;
    avatar.accent = accent;
    avatar.group.remove(avatar.model);
    avatar.model.traverse((object) => {
      if (!object.isMesh) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) if (material) material.dispose();
    });
    const model = new THREE.Group();
    model.rotation.y = Math.PI;
    avatar.group.add(model);
    const parts = this._buildCrewModel(model, skin, accent, avatar.look);
    avatar.kit = parts.kit;
    if (avatar.downed) {
      model.rotation.set(-Math.PI / 2 * 0.94, Math.PI, 0);
      model.position.set(0, 0.19, 0.62);
    }
    avatar.model = model;
    avatar.body = parts.body;
    avatar.bodyMaterial = parts.bodyMaterial;
    avatar.visor = parts.visor;
    avatar.visorMaterial = parts.visorMaterial;
    avatar.ringMaterial.color.setHex(RemotePlayers.ACCENTS[accent] || RemotePlayers.ACCENTS[0]);
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
    avatar.downed = state.d === 1 || state.d === true;
    if (state.skin && (state.skin !== avatar.skin || state.accent !== avatar.accent)) {
      this._restyleAvatar(avatar, state.skin, Number.isInteger(state.accent) ? state.accent : 0);
    }
    if (avatar.downed !== avatar._downedApplied) {
      avatar._downedApplied = avatar.downed;
      if (avatar.downed) {
        avatar.model.rotation.set(-Math.PI / 2 * 0.94, Math.PI, 0);
        avatar.model.position.set(0, 0.19, 0.62);
      } else {
        avatar.model.rotation.set(0, Math.PI, 0);
        avatar.model.position.set(0, 0, 0);
      }
    }
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
        avatar.ringMaterial.color.setHex(stale
          ? 0xff5a4e
          : (RemotePlayers.ACCENTS[avatar.accent] || RemotePlayers.ACCENTS[0]));
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

      // Лёгкое «дыхание»: плечи поднимаются, когда пассажир говорит.
      if (!avatar.downed) {
        avatar.body.position.y = 0.82 + (speaking ? Math.sin(elapsed * 6) * 0.012 : 0);
        avatar.body.position.x = Math.sin(elapsed * 1.7 + avatar.group.position.z) * 0.006;
      }

      // Телевизор: экран «шумит», а голос качает яркость.
      if (avatar.kit && avatar.kit.tvScreen) {
        const map = avatar.kit.tvScreen.material.map;
        if (map) {
          map.offset.x = (elapsed * 0.37) % 1;
          map.offset.y = (elapsed * 0.21) % 1;
        }
        avatar.kit.tvScreen.material.color.setScalar(speaking ? 1 : 0.82);
      }

      // Лёжа табличку держим выше, чтобы она не тонула в полу.
      avatar.tag.position.y = (avatar.downed ? 1.15 : 2.18) * (avatar.look ? avatar.look.height : 1);
    }
  }

  clear() {
    for (const avatar of this.avatars.values()) this._removeAvatar(avatar);
    this.avatars.clear();
  }

  setNetwork(network) {
    this.network = network;
  }

  // ---------------------------------------------------------------------------
  // Витрина гардероба
  // ---------------------------------------------------------------------------

  /**
   * Показывает выбранный образ в меню (камера смотрит в вагон с севера).
   * Модель собирается тем же кодом, что и удалённые игроки, поэтому
   * в гардеробе видно ровно то, что увидят напарники.
   */
  showSkinPreview(skin, accent = 0) {
    // На узких экранах гардероб занимает всё окно, и витрина была бы скрыта
    // панелью: там образ показывают карточки.
    if (window.innerWidth < 900) return;
    const nextSkin = RemotePlayers.SKINS.includes(skin) ? skin : 'conductor';
    const nextAccent = Number.isInteger(accent) ? clamp(accent, 0, 3) : 0;
    if (this._preview) {
      if (this._preview.skin === nextSkin && this._preview.accent === nextAccent) return;
      this.hideSkinPreview();
    }

    const group = new THREE.Group();
    group.position.set(-1.05, 0, 10.9);
    group.name = 'Витрина гардероба';
    const model = new THREE.Group();
    // Лицом к камере меню: модель собрана в +Z, камера смотрит с +Z.
    model.rotation.y = 0;
    group.add(model);

    const look = RemotePlayers._crewLook(`preview|${nextSkin}|${nextAccent}`, 'preview');
    const parts = this._buildCrewModel(model, nextSkin, nextAccent, look);
    group.scale.setScalar(look.height);

    // Мягкий свет витрины: в салоне темно, без него видны только силуэты.
    const key = new THREE.PointLight(0xdfe9d6, 7, 4.6, 2);
    key.position.set(0.55, 2.25, 2.2);
    group.add(key);
    const rim = new THREE.PointLight(RemotePlayers.ACCENTS[nextAccent] || 0x9be3dc, 4.2, 3.4, 2);
    rim.position.set(-0.7, 1.5, -1.4);
    group.add(rim);

    this.scene.add(group);
    this._preview = {
      group,
      model,
      body: parts.body,
      kit: parts.kit,
      skin: nextSkin,
      accent: nextAccent,
      baseY: 0,
    };
  }

  hideSkinPreview() {
    if (!this._preview) return;
    const { group } = this._preview;
    group.traverse((object) => {
      if (!object.isMesh) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) if (material) material.dispose();
    });
    this.scene.remove(group);
    this._preview = null;
  }

  get previewActive() {
    return Boolean(this._preview);
  }

  updatePreview(elapsed) {
    if (!this._preview) return;
    const { group, body, kit } = this._preview;
    // Медленный полуоборот: видно и лицо, и силуэт со спины.
    group.rotation.y = Math.sin(elapsed * 0.45) * 0.42;
    if (body) body.position.y = 0.82 + Math.sin(elapsed * 1.6) * 0.01;
    if (kit && kit.tvScreen) {
      kit.tvScreen.material.emissiveIntensity = 0.7 + Math.abs(Math.sin(elapsed * 9.3)) * 1.1;
    }
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
    this.echoGuard = this.store.values.echoGuard !== false;
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
    if (this.localStream) {
      this._buildOutgoing();
      return this.outgoingStream || this.localStream;
    }
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
      // Наружу — только поток с гейтом: иначе рация и «голос выключен»
      // всё равно передавали бы сырой микрофон.
      if (this.localStream) {
        this._buildOutgoing();
        this.network.publishVoiceStream(this.outgoingStream || this.localStream);
      }
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
    presence.gain.value = 2;

    // Грит убран: нелинейность после среза частот рождала гармоники выше
    // 3.4 кГц, и тихий шум чужого микрофона превращался в «писк».
    // Характер рации дают фильтры, а не перегрузка.
    const postLowpass = ctx.createBiquadFilter();
    postLowpass.type = 'lowpass';
    postLowpass.frequency.value = 2900;
    postLowpass.Q.value = 0.5;

    const hissShelf = ctx.createBiquadFilter();
    hissShelf.type = 'highshelf';
    hissShelf.frequency.value = 2600;
    hissShelf.gain.value = -9;

    // Лимитер — страховка от «воя» и перегруза, когда два игрока на динамиках.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -18;
    limiter.knee.value = 8;
    limiter.ratio.value = 14;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.18;

    const voiceGain = ctx.createGain();
    voiceGain.gain.value = CONFIG.voice.radioGain;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.4;

    source.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(presence);
    presence.connect(postLowpass);
    postLowpass.connect(hissShelf);
    hissShelf.connect(voiceGain);
    voiceGain.connect(limiter);
    voiceGain.connect(analyser);

    // Один-единственный путь: limiter → PositionalAudio → listener.
    // Раньше gain подключался ещё и напрямую к panner/listener, из-за чего
    // голос шёл двойным трактом и мог «заводиться» в петлю.
    const audio = new THREE.PositionalAudio(this.listener);
    audio.setDistanceModel('inverse');
    audio.setRefDistance(CONFIG.voice.refDistance);
    audio.setRolloffFactor(CONFIG.voice.rolloff);
    audio.setMaxDistance(CONFIG.voice.maxDistance);
    audio.setVolume(1);
    audio.setNodeSource(limiter);

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
    entry.limiter = limiter;
    entry.source = source;
    entry.nodes = [highpass, lowpass, presence, postLowpass, hissShelf, voiceGain, limiter];
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

  /**
   * Переключает только параметры затухания. Никаких дополнительных
   * соединений: цепочка собрана один раз в _buildAudio, поэтому звук
   * не может пойти по двум трактам и «завестись».
   */
  _applyRouting(entry) {
    if (!entry.audio) return;
    const flat = !this.enabled || !this.localInCar || !entry.inCar;
    if (entry.flat === flat) return;
    entry.flat = flat;
    try {
      if (flat) {
        // Вне салона голос слышен как рация: без затухания по расстоянию.
        entry.audio.setDistanceModel('linear');
        entry.audio.setRefDistance(1);
        entry.audio.setRolloffFactor(0);
        entry.audio.setMaxDistance(1000);
      } else {
        entry.audio.setDistanceModel('inverse');
        entry.audio.setRefDistance(CONFIG.voice.refDistance);
        entry.audio.setRolloffFactor(CONFIG.voice.rolloff);
        entry.audio.setMaxDistance(CONFIG.voice.maxDistance);
      }
    } catch (error) {
      /* ignore */
    }
    entry.volume = null;
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
      if (entry.analyser) this._checkHowl(entry, dt);
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
          const staticLevel = entry.speaking ? 0.0015 + entry.level * 0.004 : 0.00012;
          entry.staticGain.gain.setTargetAtTime(staticLevel, this.listener.context.currentTime, 0.08);
        }
      }

      if (entry.audio) {
        const flat = !this.enabled || !this.localInCar || !entry.inCar;
        if (entry.flat !== flat) this._applyRouting(entry);
        let volume = 0;
        if (this.enabled) {
          if (flat) {
            volume = 1;
          } else if (entry.object3D) {
            const distance = this.camera.position.distanceTo(entry.object3D.position);
            const fade = 1 - clamp(
              (distance - CONFIG.voice.fadeStart) / (CONFIG.voice.fadeEnd - CONFIG.voice.fadeStart),
              0,
              1,
            );
            volume = fade * fade;
          }
          // Эхо-защита: когда локальный микрофон слышит громкий звук
          // (скорее всего — собственные динамики), приглушаем чужой голос.
          // Это рвёт акустическую петлю, из-за которой возникает «писк».
          if (this.echoGuard) {
            const hot = clamp((this.localLevel - 0.2) / 0.3, 0, 1);
            volume *= 1 - hot * 0.9;
          }
        }
        if (entry.duck) volume *= 1 - entry.duck * 0.82;
        if (Math.abs(volume - (entry.volume ?? -1)) > 0.01) {
          entry.volume = volume;
          entry.audio.setVolume(volume);
        }
      }
    }

    this._emitStatus(false);
  }

  /**
   * Защита от «писка»: узкий устойчивый тон в высоких частотах — это
   * акустическая петля на стороне другого игрока, а не голос.
   * Приглушаем такой канал, пока тон не исчезнет.
   */
  _checkHowl(entry, dt) {
    const analyser = entry.analyser;
    if (!analyser) return;
    if (!entry.spectrum || entry.spectrum.length !== analyser.frequencyBinCount) {
      entry.spectrum = new Uint8Array(analyser.frequencyBinCount);
      entry.howlFrames = 0;
      entry.howlBin = 0;
      entry.duck = 0;
    }
    const bins = entry.spectrum;
    analyser.getByteFrequencyData(bins);
    const binHz = this.listener.context.sampleRate / analyser.fftSize;
    let peak = 0;
    let peakBin = 0;
    let total = 0;
    let counted = 0;
    for (let i = 3; i < bins.length; i += 1) {
      const value = bins[i];
      total += value;
      counted += 1;
      if (value > peak) {
        peak = value;
        peakBin = i;
      }
    }
    const hz = peakBin * binHz;
    const average = counted ? total / counted : 0;
    const tone = peak > 148 && peak > average * 3.4 && hz > 900 && hz < 4200;

    if (tone) {
      if (entry.howlBin && Math.abs(peakBin - entry.howlBin) <= 2) entry.howlFrames = (entry.howlFrames || 0) + 1;
      else {
        entry.howlBin = peakBin;
        entry.howlFrames = 1;
      }
    } else if (entry.howlFrames > 0) {
      entry.howlFrames -= 1;
      if (entry.howlFrames === 0) entry.howlBin = 0;
    }

    if ((entry.howlFrames || 0) > 9) {
      entry.duck = 1;
      if (!entry.howlWarned) {
        entry.howlWarned = true;
        this.bus.emit('voice:howl', { id: entry.id, hz: Math.round(hz) });
      }
    } else if (entry.duck) {
      entry.duck = Math.max(0, entry.duck - dt * 0.55);
      if (entry.duck === 0) entry.howlWarned = false;
    }
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
      // hipY подобран под высоту скамьи (0.47 м): бёдра лежат на сиденье,
      // а не висят над ним, как в присяде.
      hipY: 0.47, bodyX: 0.16, bodyZ: 0.02, headX: 0.52, headY: 0,
      armX: -0.3, armZ: 0.06, elbowX: -1.2,
      thighX: -1.44, kneeX: 1.42, footX: 0.12,
    },
    waking: {
      hipY: 0.47, bodyX: 0.02, bodyZ: 0.05, headX: 0.06, headY: 0,
      armX: -0.52, armZ: 0.08, elbowX: -1.32,
      thighX: -1.44, kneeX: 1.42, footX: 0.12,
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
    // Пятый пассажир собран из тех же деталей, что и обычные пассажиры:
    // пальто, шапка, шарф. Он просто выше и шире — и лицо у него не такое.
    const coat = this._material(0x585a52, { roughness: 0.96, weight: 1, glow: 0.5 });
    const coatDark = this._material(0x393b35, { roughness: 0.94, weight: 1, glow: 0.36 });
    const trousers = this._material(0x31332d, { roughness: 0.97, weight: 1, glow: 0.3 });
    const porcelain = this._material(0xd8d1bd, { roughness: 0.46, metalness: 0.02, weight: 1, glow: 0.8 });
    const hair = this._material(0x242723, { roughness: 0.9, weight: 1, glow: 0.2 });
    const leather = this._material(0x26221e, { roughness: 0.62, metalness: 0.12, weight: 1, glow: 0.24 });
    const brass = this._material(0x8a7a48, { roughness: 0.35, metalness: 0.85, weight: 0.6, glow: 0.3 });
    const scarf = this._material(0x6a2c26, { roughness: 0.94, weight: 1, glow: 0.3 });

    // Он заметно крупнее пассажиров — но всё ещё человек в пальто.
    this.root.scale.setScalar(1.12);

    this.hips = new THREE.Group();
    this.hips.position.y = this.seat.y + 0.06;
    this.root.add(this.hips);

    this.body = new THREE.Group();
    this.hips.add(this.body);

    // Торс, полы пальто, воротник.
    this._add(new THREE.CapsuleGeometry(0.25, 0.42, 4, 12), coat, this.body, 0, 0.33, 0);
    const tail = this._add(new THREE.BoxGeometry(0.46, 0.4, 0.08), coatDark, this.body, 0, -0.05, -0.15);
    tail.rotation.x = -0.16;
    this._add(new THREE.BoxGeometry(0.52, 0.1, 0.28), coat, this.body, 0, 0.55, 0);
    this._add(new THREE.TorusGeometry(0.17, 0.05, 8, 16), scarf, this.body, 0, 0.62, 0, Math.PI / 2);
    // Борт и пуговицы.
    this._add(new THREE.BoxGeometry(0.06, 0.44, 0.02), coatDark, this.body, 0.01, 0.3, 0.2);
    for (let i = 0; i < 3; i += 1) {
      this._add(new THREE.SphereGeometry(0.016, 7, 5), brass, this.body, 0.05, 0.18 + i * 0.13, 0.205);
    }
    this._add(new THREE.BoxGeometry(0.13, 0.07, 0.02), coatDark, this.body, -0.1, 0.42, 0.2);

    // Голова.
    this.head = new THREE.Group();
    this.head.position.set(0, 0.66, 0);
    this.body.add(this.head);
    this._add(new THREE.CylinderGeometry(0.06, 0.065, 0.1, 8), porcelain, this.head, 0, 0.02, 0);
    this._add(new THREE.SphereGeometry(0.138, 16, 12), porcelain, this.head, 0, 0.2, 0);
    // Лицо-маска: гладкая пластина без рта, глаза — щели.
    this._add(
      new THREE.CylinderGeometry(0.122, 0.108, 0.11, 16, 1, false, 0, Math.PI * 2),
      porcelain,
      this.head,
      0, 0.2, 0.058,
      Math.PI / 2,
    );
    this._add(new THREE.BoxGeometry(0.052, 0.016, 0.02), leather, this.head, -0.05, 0.222, 0.118);
    this._add(new THREE.BoxGeometry(0.052, 0.016, 0.02), leather, this.head, 0.05, 0.222, 0.118);
    // Кепка проводника с кокардой: он ведь тоже ехал в этом поезде.
    this._add(new THREE.SphereGeometry(0.145, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), hair, this.head, 0, 0.235, -0.005);
    this._add(new THREE.CylinderGeometry(0.16, 0.16, 0.024, 16), hair, this.head, 0, 0.3, 0.015);
    this._add(new THREE.BoxGeometry(0.26, 0.02, 0.13), leather, this.head, 0, 0.29, 0.15);
    this._add(
      new THREE.CylinderGeometry(0.026, 0.026, 0.01, 10),
      brass,
      this.head,
      0, 0.33, 0.11,
      Math.PI / 2,
    );

    // Глаза: в личине погашены, после пробуждения — красные.
    this.eyeMaterial = new THREE.MeshStandardMaterial({
      color: 0x120504,
      emissive: 0xff2408,
      emissiveIntensity: 0,
      roughness: 0.3,
    });
    this._add(new THREE.SphereGeometry(0.018, 8, 6), this.eyeMaterial, this.head, -0.05, 0.223, 0.122);
    this._add(new THREE.SphereGeometry(0.018, 8, 6), this.eyeMaterial, this.head, 0.05, 0.223, 0.122);

    // Руки. Кисти с шестью пальцами — та самая деталь.
    const buildArm = (side) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.27, 0.52, 0);
      this.body.add(shoulder);
      this._add(new THREE.CapsuleGeometry(0.06, 0.26, 3, 8), coat, shoulder, 0, -0.16, 0);
      const elbow = new THREE.Group();
      elbow.position.set(0, -0.32, 0);
      shoulder.add(elbow);
      this._add(new THREE.CapsuleGeometry(0.05, 0.22, 3, 8), coatDark, elbow, 0, -0.14, 0);
      this._add(new THREE.CylinderGeometry(0.052, 0.056, 0.04, 10), coatDark, elbow, 0, -0.26, 0.005);
      const palm = this._add(new THREE.SphereGeometry(0.056, 12, 9), porcelain, elbow, 0, -0.3, 0.012);
      palm.scale.set(1, 0.78, 1.15);
      for (let finger = 0; finger < 6; finger += 1) {
        const spread = (finger - 2.5) * 0.02;
        this._add(
          new THREE.CapsuleGeometry(0.009, 0.06, 2, 5),
          porcelain,
          elbow,
          spread, -0.34, 0.04,
          0.5, 0, spread * 1.6,
        );
      }
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
      hip.position.set(side * 0.11, 0, 0);
      this.hips.add(hip);
      this._add(new THREE.CapsuleGeometry(0.08, 0.28, 3, 8), trousers, hip, 0, -0.2, 0);
      const knee = new THREE.Group();
      knee.position.set(0, -0.42, 0);
      hip.add(knee);
      this._add(new THREE.CapsuleGeometry(0.066, 0.32, 3, 8), trousers, knee, 0, -0.24, 0);
      const foot = this._add(new THREE.BoxGeometry(0.14, 0.08, 0.27), leather, knee, 0, -0.47, 0.07);
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

    // Тень под телом.
    const shadowMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    this.shadow = new THREE.Mesh(new THREE.CircleGeometry(0.42, 20), shadowMaterial);
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.012;
    this.root.add(this.shadow);

    // Метка захвата.
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.32, 0.38, 26),
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

    // Красное свечение после пробуждения.
    this.aura = new THREE.PointLight(0xff2a12, 0, 4.6, 2);
    this.aura.position.set(0, 1.15, 0);
    this.root.add(this.aura);

    // Объём для захвата и проверки билета: тонкие детали оставляют зазоры.
    const grabBox = new THREE.Mesh(
      new THREE.BoxGeometry(0.78, 1.6, 0.72),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    grabBox.position.set(0, 0.86, 0.05);
    this.root.add(grabBox);
    this.hitMeshes.push(grabBox);
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

  /** Верёвка на теле: видно, что он связан. */
  setRope(on) {
    if (on && !this.rope) {
      this.rope = new THREE.Mesh(
        new THREE.TorusGeometry(0.26, 0.03, 7, 18),
        new THREE.MeshStandardMaterial({ color: 0x8a7448, roughness: 0.95 }),
      );
      this.rope.rotation.x = Math.PI / 2;
      this.rope.position.y = 0.34;
      this.body.add(this.rope);
      this.rope2 = this.rope.clone();
      this.rope2.position.y = 0.46;
      this.body.add(this.rope2);
    } else if (!on && this.rope) {
      this.body.remove(this.rope);
      this.body.remove(this.rope2);
      this.rope.geometry.dispose();
      this.rope.material.dispose();
      this.rope = null;
      this.rope2 = null;
    }
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
    this._dragHelpers = new Set();
    this._dragStartedAt = 0;
    this._deadIds = new Set();
    this._downedIds = new Set();
    this._killed = false;
    this._guestHuntAnnounced = false;
    this._selfPos = new THREE.Vector3();
    this._euler = new THREE.Euler();

    // Вагоны: 0 — пассажирский, 1 — служебный. Координаты общие, различается
    // только видимость и то, кто в каком вагоне находится.
    this.carIndex = 0;
    this.localCar = 0;
    this.localZone = 'car';
    this._transferTimer = 0;
    this._escaping = false;
    this._stuckTime = 0;
    this._lastHuntPos = { x: 0, z: 0 };
    this._escapeSent = false;

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
    this.carIndex = 0;
    this.localCar = 0;
    this._wakeTimer = 0;
    this._stunTimer = 0;
    this._huntTime = 0;
    this._stateClock = 0;
    this._draggingId = null;
    this._dragHelpers.clear();
    this._deadIds.clear();
    this._downedIds.clear();
    this._killed = false;
    this._guestHuntAnnounced = false;
    this._rayTarget = null;
    this._npcDistance = Infinity;
    this._transferTimer = 0;
    this._escaping = false;
    this._stuckTime = 0;
    this._escapeSent = false;
    this._thrown = false;
    this.player.setSpeedScale(1);
    this.world.setBlackout(false);
    this.ui.setScare(false);
    this.ui.hidePrompt(999);
    this._syncVisibility();
  }

  reset() {
    this.active = false;
    this.phase = DEMON_PHASE.IDLE;
    this.carIndex = 0;
    this.localCar = 0;
    this._draggingId = null;
    this._dragHelpers.clear();
    this._deadIds.clear();
    this._killed = false;
    this._rayTarget = null;
    this._npcDistance = Infinity;
    this._wakeTimer = 0;
    this._stunTimer = 0;
    this._transferTimer = 0;
    this._escaping = false;
    this._stuckTime = 0;
    this._escapeSent = false;
    this._thrown = false;
    this.player.setSpeedScale(1);
    this.world.setBlackout(false);
    this.ui.setScare(false);
    this.ui.hidePrompt(999);
    this.npc.reset();
    this._syncVisibility();
  }

  /** Локальный вагон игрока: демон виден только в своём. */
  setLocalCar(index) {
    const next = index === 1 ? 1 : 0;
    if (this.localCar === next) return;
    this.localCar = next;
    this._syncVisibility();
    this._rayTarget = null;
    this.npc.setHighlight(false);
    this.ui.hidePrompt(20);
  }

  /** Игрок ушёл в тамбур: демон не может туда зайти. */
  setLocalZone(zone) {
    this.localZone = zone === 'vestibule' ? 'vestibule' : 'car';
  }

  _syncVisibility() {
    if (!this.npc || !this.npc.root) return;
    // В меню carIndex и localCar совпадают, в игре — виден только в своём вагоне.
    const visible = this.carIndex === this.localCar;
    this.npc.root.visible = visible;
  }

  /** Пауза: отпускаем тело, чтобы замедление не «залипло» после возврата. */
  pause() {
    this._endDrag({ silent: true, all: true });
    this._rayTarget = null;
    this.npc.setHighlight(false);
    this.ui.hidePrompt(999);
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

  /** Проверка билета: пассажир оказывается без билета. */
  wakeFromTicket() {
    if (!this.active || this.phase !== DEMON_PHASE.INCOGNITO) return false;
    if (this._isHost()) return this._beginReveal('ticket', true);
    this.network.sendDemon({ kind: 'wake', source: 'ticket', stun: true });
    return true;
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
    this._transferTimer = 0;

    // Маска слетает мгновенно: кровь, глаза, свечение.
    this.npc.setBlood(1);
    this.npc.setPose(stun ? 'ragdoll' : 'waking');
    this.npc.setHighlight(false);
    this.ui.hidePrompt(999);
    this.ui.setScare(true);
    this.world.setBlackout(true);
    this.audio.screech();
    this._syncVisibility();

    const target = this._closestPlayer();
    if (target) {
      const dx = target.x - this.npc.root.position.x;
      const dz = target.z - this.npc.root.position.z;
      this.npc.setYaw(Math.atan2(dx, dz), true);
    }

    const message = source === 'scream'
      ? 'КРИК РАЗБУДИЛ ЕГО // СВЕТ ПОГАС'
      : source === 'ticket'
        ? 'БИЛЕТА НЕТ // ОН СМОТРИТ НА ВАС'
        : source === 'grab'
          ? 'ВЫ ПРИКОСНУЛИСЬ К НЕМУ // СВЕТ ПОГАС'
          : 'ОН УСЛЫШАЛ ВАС // СВЕТ ПОГАС';
    this.ui.showToast(message, 'error', 6200);
    this.bus.emit('demon:awakened', { source });
    this.bus.emit('demon:phase', { phase: this.phase });
  }

  _startHunt() {
    if (this.phase === DEMON_PHASE.HUNTING || this.phase === DEMON_PHASE.DEAD) return;
    this.phase = DEMON_PHASE.HUNTING;
    this._huntTime = 0;
    this._wakeTimer = 0;
    this._stunTimer = 0;
    this._endDrag({ silent: true, all: true });
    this.npc.setPose('hunt');
    this.ui.hidePrompt(999);
    this._escaping = Math.abs(this.npc.root.position.x) > 0.55;
    this._stuckTime = 0;
    this._lastHuntPos = {
      x: this.npc.root.position.x,
      z: this.npc.root.position.z,
    };
    if (!this._guestHuntAnnounced) {
      this._guestHuntAnnounced = true;
      this.ui.showToast('ОН ВСТАЛ // БЕГИТЕ', 'error', 3600);
    }
    this.bus.emit('demon:phase', { phase: this.phase });
  }

  /** Попытка аварийного торможения: победа для всего экипажа. */
  requestEscape() {
    if (this._escapeSent || this.phase === DEMON_PHASE.DEAD) return;
    this._escapeSent = true;
    if (this._isHost()) {
      this.network.sendDemon({ kind: 'escape' });
      this._finishEscape();
    } else {
      this.network.sendDemon({ kind: 'brake' });
    }
  }

  _finishEscape() {
    if (this.phase === DEMON_PHASE.DEAD) return;
    this.phase = DEMON_PHASE.DEAD;
    this._killed = true;
    this.npc.setHighlight(false);
    this.ui.hidePrompt(999);
    this.ui.setScare(false);
    this.world.setBlackout(false);
    this.bus.emit('demon:escape', {});
  }

  // ---------------------------------------------------------------------------
  // Кадр
  // ---------------------------------------------------------------------------

  update(dt, elapsed) {
    if (!this.active) return;
    this.npc.update(dt, elapsed);
    this._syncVisibility();

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
      this.ui.hidePrompt(20);
    }

    if (this.phase === DEMON_PHASE.STUNNED) this._updateDragging(dt);
    if (this.phase === DEMON_PHASE.HUNTING && this._isHost()) {
      this._updateCarTransfer(dt);
      this._updateHunt(dt);
    }
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
    const owner = 'demon';
    if (this.phase === DEMON_PHASE.STUNNED) {
      const selfId = this._selfId();
      if (this._draggingId === selfId) {
        const help = this._dragHelpers.size ? ' // ВДВОЁМ БЫСТРЕЕ' : '';
        this.ui.setHint(owner, { text: `ОТПУСТИТЕ E — БРОСИТЬ ТЕЛО${help}`, key: 'E', tone: 'danger', priority: 20 });
      } else if (this._draggingId && this._npcDistance <= CONFIG.npc.grabDistance + 0.8) {
        this.ui.setHint(owner, { text: 'УДЕРЖИВАЙТЕ E — ПОМОЧЬ НЕСТИ', key: 'E', tone: 'normal', priority: 20 });
      } else if (!this._draggingId && this._npcDistance <= CONFIG.npc.grabDistance + 0.5) {
        this.ui.setHint(owner, { text: 'УДЕРЖИВАЙТЕ E — ТАЩИТЬ ТЕЛО', key: 'E', tone: 'danger', priority: 20 });
      } else {
        this.ui.clearHint(owner);
      }
      return;
    }
    if (!this._rayTarget) {
      this.ui.clearHint(owner);
      return;
    }
    if (this.phase === DEMON_PHASE.INCOGNITO) {
      if (this._npcDistance <= CONFIG.npc.grabDistance) {
        this.ui.setHint(owner, { text: 'ПРОВЕРИТЬ БИЛЕТ ПАССАЖИРА', key: 'E', tone: 'normal', priority: 20 });
      } else {
        this.ui.setHint(owner, { text: 'ПОДОЙДИТЕ БЛИЖЕ', key: '', tone: 'normal', priority: 20 });
      }
      return;
    }
    this.ui.clearHint(owner);
  }

  // ---------------------------------------------------------------------------
  // Взаимодействие
  // ---------------------------------------------------------------------------

  _onInteract({ held } = {}) {
    if (!this.active) return;
    if (this.phase !== DEMON_PHASE.INCOGNITO && this.phase !== DEMON_PHASE.STUNNED) return;

    if (!held) {
      if (this._draggingId === this._selfId() || this._dragHelpers.has(this._selfId())) {
        this._endDrag();
      }
      return;
    }

    if (this.phase === DEMON_PHASE.STUNNED) {
      if (this._npcDistance <= CONFIG.npc.grabDistance + 0.8) this._beginDrag();
      return;
    }

    if (!this._rayTarget) return;
    if (this._npcDistance > CONFIG.npc.grabDistance) return;
    if (this._isHost()) {
      this._beginReveal('ticket', true);
    } else {
      this.network.sendDemon({ kind: 'wake', source: 'ticket', stun: true });
      this.ui.showToast('СИГНАЛ УШЁЛ В ВАГОН…', 'warning', 1200);
    }
  }

  _beginDrag() {
    if (this.phase !== DEMON_PHASE.STUNNED) return;
    const selfId = this._selfId();
    if (this._draggingId === selfId || this._dragHelpers.has(selfId)) return;

    if (!this._draggingId) {
      this._draggingId = selfId;
      this._dragStartedAt = performance.now();
      this._stateClock = 0;
      this.ui.showToast('ТЕЛО СЛУШАЕТСЯ // ВЫ ЕДВА ИДЁТЕ', 'warning', 2600);
      if (!this._isHost()) this.network.sendDemon({ kind: 'drag', active: true });
    } else {
      if (this._dragHelpers.size >= 1) return;
      this._dragHelpers.add(selfId);
      this._stateClock = 0;
      this.ui.showToast('ВЫ ПОДХВАТИЛИ ТЕЛО // ТЕПЕРЬ ЛЕГЧЕ', 'warning', 2600);
      if (!this._isHost()) this.network.sendDemon({ kind: 'drag', active: true, helper: true });
    }
    this._applyDragSpeed();
    this._updatePrompt();
  }

  _applyDragSpeed() {
    const selfId = this._selfId();
    let scale = 1;
    if (this._draggingId === selfId) {
      scale = this._dragHelpers.size > 0 ? CONFIG.npc.dragScaleTwo : CONFIG.npc.dragScale;
    } else if (this._dragHelpers.has(selfId)) {
      scale = CONFIG.npc.dragScaleHelper;
    }
    this.player.setSpeedScale(scale);
    this.bus.emit('player:drag', { active: scale < 1, scale });
  }

  _endDrag({ silent = false, all = false } = {}) {
    const selfId = this._selfId();
    const wasOwner = this._draggingId === selfId;
    const wasHelper = this._dragHelpers.has(selfId);
    if (!this._draggingId && this._dragHelpers.size === 0) return;

    if (all) {
      this._draggingId = null;
      this._dragHelpers.clear();
      this.player.setSpeedScale(1);
      if (!this._isHost()) this.network.sendDemon({ kind: 'drag', active: false });
      return;
    }

    if (wasHelper) {
      this._dragHelpers.delete(selfId);
      if (!this._isHost()) this.network.sendDemon({ kind: 'drag', active: false, helper: true });
      if (wasOwner) {
        this._draggingId = null;
        this._dragHelpers.clear();
        if (!this._isHost()) this.network.sendDemon({ kind: 'drag', active: false });
      }
      this._applyDragSpeed();
      if (!silent && wasHelper) this.ui.showToast('ВЫ ОТПУСТИЛИ ТЕЛО', 'warning', 1800);
      this._updatePrompt();
      return;
    }

    if (wasOwner) {
      this._draggingId = null;
      this._dragHelpers.clear();
      this.player.setSpeedScale(1);
      if (!this._isHost()) this.network.sendDemon({ kind: 'drag', active: false });
      if (!silent) this.ui.showToast('ТЕЛО ОСТАЛОСЬ НА ПОЛУ', 'warning', 2200);
      if (this.active && this.phase === DEMON_PHASE.STUNNED) this._updatePrompt();
      return;
    }

    this._dragHelpers.clear();
    this.player.setSpeedScale(1);
  }

  _updateDragging(dt) {
    if (!this._draggingId) return;
    const pose = this._playerPose(this._draggingId);
    if (!pose) {
      this._endDrag({ silent: true, all: true });
      return;
    }
    this._placeBody(pose, dt);
  }

  /** Тело в руках переезжает вместе с проводником (переход через дверь). */
  followLocalPlayer() {
    if (!this._draggingId) return;
    const pose = this._playerPose(this._draggingId);
    if (!pose) return;
    const forwardX = -Math.sin(pose.yaw);
    const forwardZ = -Math.cos(pose.yaw);
    const bounds = this.world.bounds;
    this.npc.root.position.set(
      clamp(pose.x + forwardX * CONFIG.npc.dragOffset, bounds.minX + CONFIG.demon.bodyRadius, bounds.maxX - CONFIG.demon.bodyRadius),
      0,
      clamp(pose.z + forwardZ * CONFIG.npc.dragOffset, bounds.minZ + CONFIG.demon.bodyRadius, bounds.maxZ - CONFIG.demon.bodyRadius),
    );
    this.npc.setYaw(pose.yaw + Math.PI, true);
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

  _updateCarTransfer(dt) {
    if (this.phase !== DEMON_PHASE.HUNTING) return;
    const players = this._allPlayers().filter((p) => !this._deadIds.has(p.id));
    const same = players.filter((p) => (p.car ?? 0) === this.carIndex);
    if (same.length || !players.length) {
      this._transferTimer = 0;
      return;
    }
    this._transferTimer += dt;
    if (this._transferTimer < CONFIG.demon.transferDelay) return;
    const target = this._closestPlayer();
    if (!target) return;
    this.carIndex = target.car ?? 0;
    this._transferTimer = 0;
    this._escaping = true;
    this._stuckTime = 0;
    this.npc.root.position.set(0, 0, -14.35);
    this.npc.setYaw(Math.PI, true);
    this._syncVisibility();
    this._stateClock = 0;
    this.ui.showToast('ДВЕРЬ ХЛОПНУЛА // ОН УЖЕ ЗДЕСЬ', 'error', 4200);
    this.bus.emit('demon:changedCar', { car: this.carIndex });
  }

  _updateHunt(dt) {
    this._huntTime += dt;
    const target = this._closestPlayer();
    if (!target) return;
    if ((target.car ?? 0) !== this.carIndex) return;

    const npc = this.npc.root.position;
    const dx = target.x - npc.x;
    const dz = target.z - npc.z;
    const distance = Math.hypot(dx, dz);
    if (distance <= CONFIG.demon.killDistance) {
      this._catch(target);
      return;
    }

    this.npc.setYaw(Math.atan2(dx, dz), false);
    const ramp = clamp(0.55 + (this._huntTime / Math.max(0.01, CONFIG.demon.standTime)) * 0.45, 0.55, 1);
    const step = CONFIG.demon.huntSpeed * ramp * dt;
    this._advance(target, step);

    const moved = Math.hypot(npc.x - this._lastHuntPos.x, npc.z - this._lastHuntPos.z);
    this._lastHuntPos = { x: npc.x, z: npc.z };
    if (moved < step * 0.15) {
      this._stuckTime += dt;
      if (this._stuckTime > 0.7) {
        // Застрял в мебели — выбираемся к проходу, игнорируя коллизии.
        this._escaping = true;
        this._stuckTime = 0;
      }
    } else {
      this._stuckTime = 0;
    }

    const after = Math.hypot(target.x - npc.x, target.z - npc.z);
    if (after <= CONFIG.demon.killDistance) this._catch(target);
  }

  _advance(target, step) {
    const npc = this.npc.root.position;
    const aisle = CONFIG.demon.aisleX;

    // 1. Выход из-за скамьи. Тело стартует внутри мебели, поэтому здесь
    //    коллизии намеренно игнорируются: иначе демон навсегда застревает
    //    на краю сиденья и «стоит», пока игрок сам не подойдёт.
    if (this._escaping || Math.abs(npc.x) > 0.9) {
      this._escaping = true;
      const dir = Math.sign(aisle - npc.x) || 1;
      npc.x += dir * step * 0.9;
      if (Math.abs(target.z - npc.z) > 1.2) {
        npc.z += Math.sign(target.z - npc.z) * step * 0.3;
      }
      if (Math.abs(npc.x - aisle) <= 0.16) {
        npc.x = aisle;
        this._escaping = false;
      }
      return;
    }

    // 2. Погоня по проходу: целимся в игрока, при дальней дистанции
    //    слегка прижимаемся к центру, чтобы не цеплять скамьи.
    let dx = target.x - npc.x;
    let dz = target.z - npc.z;
    if (Math.abs(dz) > 3.2) dx = (aisle - npc.x) * 0.8 + dx * 0.2;
    const length = Math.hypot(dx, dz) || 1;
    const stepX = (dx / length) * step;
    const stepZ = (dz / length) * step;

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
    // Скользим вдоль препятствия.
    const slideZ = clamp(step * 0.7, 0.008, 0.2);
    for (const sign of [Math.sign(dz) || 1, -(Math.sign(dz) || 1)]) {
      if (!blocked(npc.x, npc.z + slideZ * sign)) {
        npc.z += slideZ * sign;
        return;
      }
    }
    for (const sign of [Math.sign(dx) || 1, -(Math.sign(dx) || 1)]) {
      if (!blocked(npc.x + slideZ * sign, npc.z)) {
        npc.x += slideZ * sign;
        return;
      }
    }
    // Совсем зажало — пробиваемся к центру прохода.
    npc.x += Math.sign(aisle - npc.x || 1) * step * 0.5;
  }

  /** Касание: игрок падает и лежит на полу, пока его не поднимут бинтом. */
  _catch(target) {
    if (this.phase === DEMON_PHASE.DEAD) return;
    if (this._downedIds.has(target.id)) return;
    this._downedIds.add(target.id);
    this.network.sendDemon({ kind: 'downed', target: target.id, name: target.name });
    this._applyDowned(target.id);
    this._endDrag({ silent: true, all: true });
    this._stateClock = 0;

    // Демон не добивает: он идёт за следующим. Если упали все — смена проиграна.
    const alive = this._allPlayers().filter((player) => !this._downedIds.has(player.id)
      && !this._deadIds.has(player.id) && player.zone !== 'vestibule');
    if (!alive.length) {
      this.phase = DEMON_PHASE.DEAD;
      this.npc.setPose('hunt');
      this.onGameOver({ all: true });
      this.bus.emit('demon:phase', { phase: this.phase });
    }
  }

  /** Общий обработчик падения: и для гостя, и для локального игрока. */
  _applyDowned(id) {
    if (!id) return;
    this._downedIds.add(id);
    if (id === this._selfId()) {
      this.player.setSpeedScale(1);
      this.bus.emit('player:downed', {});
    }
  }

  /** Подъём бинтом: себя или напарника. */
  reviveTarget(id) {
    if (!id) return;
    this._downedIds.delete(id);
    this.network.sendDemon({ kind: 'revive', target: id });
    if (id === this._selfId()) this.bus.emit('player:revived', {});
  }

  /** Шокер: падение на несколько секунд. */
  taserHit() {
    if (this.phase !== DEMON_PHASE.HUNTING && this.phase !== DEMON_PHASE.INCOGNITO) return false;
    if (this._isHost()) {
      this._hostStun(CONFIG.items.taser.stun, 'taser');
      this.network.sendDemon({ kind: 'stun', seconds: CONFIG.items.taser.stun, source: 'taser' });
      return true;
    }
    this.network.sendDemon({ kind: 'taser' });
    return true;
  }

  _hostStun(seconds, source) {
    if (this.phase === DEMON_PHASE.DEAD) return;
    if (this.phase === DEMON_PHASE.INCOGNITO) this._applyReveal(source || 'ticket', true);
    this.phase = DEMON_PHASE.STUNNED;
    this._stunTimer = Math.max(this._stunTimer, seconds);
    this._killed = false;
    this.npc.setPose('ragdoll');
    this.ui.setScare(true);
    this.world.setBlackout(true);
    this._stateClock = 0;
    this.bus.emit('demon:phase', { phase: this.phase });
  }

  /** Верёвка: продлевает беспамятство, чтобы успеть дотащить тело. */
  applyRope() {
    if (this.phase !== DEMON_PHASE.STUNNED) return;
    this._stunTimer += CONFIG.items.rope.bonus;
    this.npc.setRope(true);
    this.network.sendDemon({ kind: 'rope' });
    this.ui.showToast('ОН СВЯЗАН // ТЕЛО ТЯЖЕЛЕЕ, НО ВРЕМЕНИ БОЛЬШЕ', 'success', 3000);
  }

  /** Сброс за борт из тамбура — победа. */
  throwOut() {
    if (this.phase === DEMON_PHASE.DEAD || this._thrown) return;
    this._thrown = true;
    this.phase = DEMON_PHASE.DEAD;
    this._endDrag({ silent: true, all: true });
    this.npc.setRope(false);
    this.npc.setPose('ragdoll');
    this.npc.root.visible = false;
    this.network.sendDemon({ kind: 'thrown' });
    this.bus.emit('demon:thrown', {});
    this.bus.emit('demon:phase', { phase: this.phase });
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

  _carOf(id) {
    if (id === this._selfId()) return this.localCar;
    const entry = this.network.remoteStates && this.network.remoteStates.get(id);
    return (entry && entry.s && Number(entry.s.car)) || 0;
  }

  _playerPose(id) {
    if (id === this._selfId()) {
      return {
        id,
        x: this.player.position.x,
        z: this.player.position.z,
        yaw: this._cameraYaw(),
        car: this.localCar,
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
      car: Number(entry.s.car) || 0,
      name: this._nameOf(id),
    };
  }

  _allPlayers() {
    const list = [{
      id: this._selfId(),
      x: this.player.position.x,
      z: this.player.position.z,
      yaw: this._cameraYaw(),
      car: this.localCar,
      zone: this.localZone,
      downed: this._downedIds.has(this._selfId()),
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
        car: Number(entry.s.car) || 0,
        zone: entry.s.zone === 'vestibule' ? 'vestibule' : 'car',
        downed: Boolean(entry.s.d),
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
      if (this._deadIds.has(player.id) || this._downedIds.has(player.id)) continue;
      // В тамбуре игрока не достать: демон ждёт у двери.
      if (player.zone === 'vestibule') continue;
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
      car: this.carIndex,
      x: Number(position.x.toFixed(3)),
      z: Number(position.z.toFixed(3)),
      yaw: Number(this.npc.yaw.toFixed(3)),
      blood: Number(this.npc.blood.toFixed(2)),
      drag: this._draggingId || null,
      helpers: Array.from(this._dragHelpers),
    });
  }

  _onPeerJoined(player) {
    if (!this._isHost() || !this.active || !player) return;
    if (this.phase === DEMON_PHASE.IDLE || this.phase === DEMON_PHASE.INCOGNITO) return;
    const position = this.npc.root.position;
    this.network.sendDemon({
      kind: 'sync',
      phase: this.phase,
      car: this.carIndex,
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
        this._hostGuestDrag(data.from, Boolean(data.active), Boolean(data.helper));
      } else if (data.kind === 'brake') {
        this._finishEscape();
        this.network.sendDemon({ kind: 'escape' });
      } else if (data.kind === 'ticket') {
        // Гость проверил билет — раздаём всем, чтобы счётчик совпадал.
        this.network.sendDemon({ kind: 'ticket', index: data.index, from: data.from });
      } else if (data.kind === 'taser') {
        this._hostStun(CONFIG.items.taser.stun, 'taser');
        this.network.sendDemon({ kind: 'stun', seconds: CONFIG.items.taser.stun, source: 'taser' });
      } else if (data.kind === 'rope') {
        this._stunTimer += CONFIG.items.rope.bonus;
        this.npc.setRope(true);
        this.network.sendDemon({ kind: 'rope' });
      } else if (data.kind === 'revive') {
        this.network.sendDemon({ kind: 'revive', target: data.target, from: data.from });
        if (data.target === this._selfId()) this.bus.emit('player:revived', {});
      } else if (data.kind === 'thrown') {
        this.throwOut();
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
    if (data.kind === 'ticket') {
      this.bus.emit('ticket:remote', { index: data.index });
      return;
    }
    if (data.kind === 'escape') {
      this._finishEscape();
      return;
    }
    if (data.kind === 'stun') {
      if (this.phase === DEMON_PHASE.DEAD) return;
      if (this.phase === DEMON_PHASE.INCOGNITO) this._applyReveal('taser', true);
      this.phase = DEMON_PHASE.STUNNED;
      this._stunTimer = Math.max(this._stunTimer, Number(data.seconds) || CONFIG.items.taser.stun);
      this.npc.setPose('ragdoll');
      this.ui.setScare(true);
      this.world.setBlackout(true);
      return;
    }
    if (data.kind === 'rope') {
      this._stunTimer += CONFIG.items.rope.bonus;
      this.npc.setRope(true);
      return;
    }
    if (data.kind === 'downed') {
      this._applyDowned(data.target);
      return;
    }
    if (data.kind === 'revive') {
      if (data.target === this._selfId()) this.bus.emit('player:revived', {});
      return;
    }
    if (data.kind === 'thrown') {
      this.phase = DEMON_PHASE.DEAD;
      this.npc.root.visible = false;
      this.bus.emit('demon:thrown', {});
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
    const helpers = Array.isArray(data.helpers) ? data.helpers : [];
    const selfId = this._selfId();
    const wasHelper = this._dragHelpers.has(selfId);

    if (incoming !== DEMON_PHASE.STUNNED) {
      if (this._draggingId || this._dragHelpers.size) this._endDrag({ silent: true, all: true });
    } else {
      if (this._draggingId && this._draggingId !== data.drag
        && performance.now() - (this._dragStartedAt || 0) > 700) {
        // Хост отпустил тело раньше нас (но не в первые кадры запроса).
        this._endDrag({ silent: true, all: true });
      }
      this._dragHelpers = new Set(helpers.filter((id) => id && id !== selfId));
      if (wasHelper !== this._dragHelpers.has(selfId)) this._applyDragSpeed();
      if (this._draggingId === selfId || this._dragHelpers.has(selfId)) this._applyDragSpeed();
    }

    this.phase = incoming;
    if (typeof data.car === 'number') this.carIndex = data.car === 1 ? 1 : 0;
    this.npc.setBlood(typeof data.blood === 'number' ? data.blood : 1);
    this.npc.setPose(
      incoming === DEMON_PHASE.HUNTING
        ? 'hunt'
        : incoming === DEMON_PHASE.STUNNED || incoming === DEMON_PHASE.DEAD
          ? 'ragdoll'
          : 'waking',
    );
    if (typeof data.x === 'number') {
      const isLocalDrag = this._draggingId === selfId;
      if (!isLocalDrag) this.npc.root.position.set(data.x, 0, Number(data.z) || 0);
    }
    if (typeof data.yaw === 'number') this.npc.setYaw(data.yaw, true);
    if (incoming === DEMON_PHASE.HUNTING && !this._guestHuntAnnounced) {
      this._guestHuntAnnounced = true;
      this.ui.showToast('ОН ВСТАЛ // БЕГИТЕ', 'error', 3600);
    }
    this.ui.setScare(true);
    this.world.setBlackout(true);
    this._syncVisibility();
  }

  _hostGuestGrab(fromId) {
    if (!fromId || this.phase !== DEMON_PHASE.INCOGNITO) return;
    const pose = this._playerPose(fromId);
    if (!pose) return;
    const npc = this.npc.root.position;
    const distance = Math.hypot(pose.x - npc.x, pose.z - npc.z);
    if (distance > CONFIG.npc.grabDistance + 0.7) return;
    this._beginReveal('ticket', true);
  }

  _hostGuestDrag(fromId, active, helper = false) {
    if (!fromId) return;
    if (!active) {
      if (helper) {
        this._dragHelpers.delete(fromId);
      } else if (this._draggingId === fromId) {
        this._draggingId = null;
        this._dragHelpers.clear();
      }
      this._stateClock = 0;
      return;
    }
    if (this.phase !== DEMON_PHASE.STUNNED) return;
    const pose = this._playerPose(fromId);
    if (!pose) return;
    const npc = this.npc.root.position;
    const distance = Math.hypot(pose.x - npc.x, pose.z - npc.z);
    if (distance > CONFIG.npc.grabDistance + 1.4) return;
    if (!this._draggingId) {
      this._draggingId = fromId;
    } else if (helper && this._dragHelpers.size < 1 && this._draggingId !== fromId) {
      this._dragHelpers.add(fromId);
    }
    this._stateClock = 0;
  }
}


// =============================================================================
// ПАССАЖИРЫ С БИЛЕТАМИ, ПРОВЕРКА, ДВЕРИ И ТОРМОЗ
// =============================================================================

/**
 * Обычный пассажир на скамье: та же школа, что и у «пассажира без лица»,
 * но попроще и с вариациями — пальто, шапка, шарф, поза.
 */
class SeatPassenger {
  static PALETTES = [
    { coat: 0x4a4f45, trousers: 0x33352f, scarf: 0x7a3f2f, hat: 0x2b2f2a, skin: 0xc7ab8d },
    { coat: 0x3d4148, trousers: 0x2c2f33, scarf: 0x5a6d5a, hat: 0x1f2320, skin: 0xd2b79a },
    { coat: 0x51413a, trousers: 0x3a342c, scarf: 0x8a7a4a, hat: 0x3b2a22, skin: 0xb39073 },
    { coat: 0x2f3a33, trousers: 0x272b26, scarf: 0x6a4a5a, hat: 0x242a2c, skin: 0xc9b49c },
  ];

  constructor({ scene, parent, seat, index = 0 }) {
    this.scene = scene;
    this.seat = seat;
    this.index = index;
    this.root = new THREE.Group();
    this.root.name = `Пассажир ${seat.seat}`;
    this.root.position.set(seat.x, 0, seat.z);
    this.root.rotation.y = seat.yaw;
    (parent || scene).add(this.root);

    this.hitMeshes = [];
    this._mats = [];
    this._time = index * 1.7;
    this.checked = false;
    this._targetYaw = seat.yaw;
    const palette = SeatPassenger.PALETTES[index % SeatPassenger.PALETTES.length];
    this._build(palette);
  }

  _mat(color, opts = {}) {
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: opts.roughness ?? 0.9,
      metalness: opts.metalness ?? 0.03,
      emissive: opts.emissive ?? 0x000000,
      emissiveIntensity: opts.emissiveIntensity ?? 0,
    });
    this._mats.push(material);
    return material;
  }

  _add(geometry, material, parent, x=0, y=0, z=0, rx=0, ry=0, rz=0) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    parent.add(mesh);
    this.hitMeshes.push(mesh);
    return mesh;
  }

  _build(palette) {
    const coat = this._mat(palette.coat, { roughness: 0.96 });
    const dark = this._mat(0x2e312c, { roughness: 0.94 });
    const trousers = this._mat(palette.trousers, { roughness: 0.97 });
    const skin = this._mat(palette.skin, { roughness: 0.7 });
    const scarf = this._mat(palette.scarf, { roughness: 0.9 });
    const hat = this._mat(palette.hat, { roughness: 0.92 });
    const leather = this._mat(0x241f1a, { roughness: 0.62, metalness: 0.1 });

    this.hips = new THREE.Group();
    this.hips.position.y = this.seat.y || 0.5;
    this.root.add(this.hips);
    this.body = new THREE.Group();
    this.hips.add(this.body);

    // Пальто и воротник.
    this._add(new THREE.BoxGeometry(0.4, 0.58, 0.28), coat, this.body, 0, 0.3, 0);
    this._add(new THREE.BoxGeometry(0.44, 0.1, 0.26), coat, this.body, 0, 0.56, 0);
    this._add(new THREE.BoxGeometry(0.26, 0.09, 0.23), scarf, this.body, 0, 0.6, 0.01);
    this._add(new THREE.BoxGeometry(0.06, 0.34, 0.02), dark, this.body, 0, 0.28, 0.145);

    // Голова, шапка и лицо (без пугающих деталей — это обычные люди).
    this.head = new THREE.Group();
    this.head.position.set(0, 0.62, 0.01);
    this.body.add(this.head);
    this._add(new THREE.SphereGeometry(0.125, 14, 10), skin, this.head, 0, 0.16, 0);
    this._add(new THREE.CylinderGeometry(0.132, 0.132, 0.09, 14), hat, this.head, 0, 0.26, 0);
    this._add(new THREE.CylinderGeometry(0.15, 0.15, 0.02, 14), hat, this.head, 0, 0.22, 0.02);
    this._add(new THREE.BoxGeometry(0.05, 0.014, 0.012), leather, this.head, -0.045, 0.17, 0.115);
    this._add(new THREE.BoxGeometry(0.05, 0.014, 0.012), leather, this.head, 0.045, 0.17, 0.115);

    // Руки: предплечья лежат на коленях.
    const arm = (side) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.235, 0.5, 0);
      this.body.add(shoulder);
      this._add(new THREE.CapsuleGeometry(0.052, 0.22, 3, 8), coat, shoulder, 0, -0.13, 0.01);
      const elbow = new THREE.Group();
      elbow.position.set(0, -0.26, 0);
      shoulder.add(elbow);
      this._add(new THREE.CapsuleGeometry(0.045, 0.19, 3, 8), coat, elbow, 0, -0.08, 0.11, -1.15, 0, 0);
      this._add(new THREE.SphereGeometry(0.05, 9, 7), skin, elbow, 0, -0.08, 0.22);
      return shoulder;
    };
    arm(-1); arm(1);

    // Ноги: бедро вперёд, голень вниз.
    const leg = (side) => {
      const hip = new THREE.Group();
      hip.position.set(side * 0.1, 0, 0);
      this.hips.add(hip);
      this._add(new THREE.CapsuleGeometry(0.07, 0.24, 3, 8), trousers, hip, 0, -0.06, 0.2, -1.45, 0, 0);
      const knee = new THREE.Group();
      knee.position.set(0, -0.06, 0.42);
      hip.add(knee);
      this._add(new THREE.CapsuleGeometry(0.058, 0.26, 3, 8), trousers, knee, 0, -0.18, 0);
      this._add(new THREE.BoxGeometry(0.12, 0.07, 0.23), leather, knee, 0, -0.34, 0.06);
      return hip;
    };
    leg(-1); leg(1);

    // Кольцо-подсветка.
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.28, 0.33, 22),
      new THREE.MeshBasicMaterial({
        color: 0xd9ffcb,
        transparent: true,
        opacity: 0.4,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.marker.rotation.x = -Math.PI / 2;
    this.marker.position.y = 0.012;
    this.marker.visible = false;
    this.root.add(this.marker);

    // Невидимый объём для наведения: между деталями тела есть щели,
    // и без него E иногда «не видит» пассажира.
    this.interactBox = new THREE.Mesh(
      new THREE.BoxGeometry(0.78, 1.15, 0.86),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    this.interactBox.position.set(0, 0.95, 0.12);
    this.root.add(this.interactBox);
    this.hitMeshes.push(this.interactBox);
  }

  setHighlight(on) {
    if (this.marker) this.marker.visible = Boolean(on);
  }

  update(dt, elapsed) {
    this._time += dt;
    const breathe = Math.sin(elapsed * 1.35 + this.index) * 0.006;
    this.body.rotation.x = 0.12 + breathe;
    this.head.rotation.y = Math.sin(elapsed * 0.17 + this.index * 2.1) * 0.18;
    this.head.rotation.x = 0.06 + breathe * 0.8;
    if (this.marker && this.marker.visible) {
      this.marker.material.opacity = 0.3 + Math.sin(this._time * 3.6) * 0.14;
    }
  }
}

/** Луч из камеры по пассажирам, проверка билета и подсказки. */
class TicketInspector {
  constructor({ camera, player, ui, bus, passengers, onCheck }) {
    this.camera = camera;
    this.player = player;
    this.ui = ui;
    this.bus = bus;
    this.passengers = passengers;
    this.onCheck = onCheck;
    this.suppressed = false;
    this._ray = new THREE.Raycaster();
    this._center = new THREE.Vector2(0, 0);
    this._target = null;
    this._targetDistance = Infinity;

    this.bus.on('player:interact', (payload) => this._onInteract(payload));
  }

  setActive(active) {
    this.active = Boolean(active);
    if (!this.active && this._target) {
      this._target.setHighlight(false);
      this._target = null;
    }
  }

  update(dt, elapsed, { enabled = true } = {}) {
    for (const passenger of this.passengers) passenger.update(dt, elapsed);
    this.active = Boolean(enabled);
    if (!enabled) {
      if (this._target) this._target.setHighlight(false);
      this._target = null;
      this.ui.clearHint('ticket');
      return;
    }

    this.camera.updateMatrixWorld(true);
    this._ray.setFromCamera(this._center, this.camera);
    let closest = null;
    let closestDistance = Infinity;
    let hit = null;
    for (const passenger of this.passengers) {
      if (!passenger.root.visible) continue;
      passenger.root.updateMatrixWorld(true);
      const hits = this._ray.intersectObjects(passenger.hitMeshes, false);
      if (!hits.length) continue;
      if (hits[0].distance < closestDistance) {
        closestDistance = hits[0].distance;
        closest = passenger;
        hit = hits[0];
      }
    }
    const distance = closest
      ? Math.hypot(this.player.position.x - closest.root.position.x, this.player.position.z - closest.root.position.z)
      : Infinity;
    if (closest && (closestDistance > CONFIG.npc.lookDistance + 1.2 || distance > CONFIG.mission.interactDistance + 0.8)) {
      closest = null;
    }
    if (closest !== this._target) {
      if (this._target) this._target.setHighlight(false);
      this._target = closest;
      if (closest) closest.setHighlight(true);
    }
    this._targetDistance = distance;

    if (!closest) {
      this.ui.clearHint('ticket');
      return;
    }
    if (closest.checked) {
      this.ui.setHint('ticket', { text: `БИЛЕТ ПРОВЕРЕН // ${closest.seat.name}`, key: '', priority: 15 });
      return;
    }
    if (distance > CONFIG.mission.interactDistance) {
      this.ui.setHint('ticket', { text: 'ПОДОЙДИТЕ К ПАССАЖИРУ', key: '', priority: 15 });
      return;
    }
    this.ui.setHint('ticket', { text: 'ПРОВЕРИТЬ БИЛЕТ', key: 'E', priority: 15 });
  }

  _onInteract({ held } = {}) {
    if (!held || !this.active || !this._target) return;
    const passenger = this._target;
    if (passenger.checked) return;
    if (this._targetDistance > CONFIG.mission.interactDistance) return;
    passenger.checked = true;
    passenger.setHighlight(false);
    this._target = null;
    this.ui.showTicket({
      name: passenger.seat.name,
      seat: `№ ${passenger.seat.seat}`,
      serial: passenger.seat.serial,
      status: 'ДЕЙСТВИТЕЛЕН',
      note: 'Штамп проводника поставлен. Смена идёт по расписанию.',
      invalid: false,
    });
    this.ui.clearHint('ticket');
    this.bus.emit('ticket:checked', { index: passenger.index, name: passenger.seat.name, seat: passenger.seat.seat });
    if (this.onCheck) this.onCheck(passenger);
  }
}

/** Тормозной кран в служебном вагоне — единственный путь к спасению. */
class BrakeValve {
  constructor({ parent, position = { x: 0.85, y: 1.15, z: -15.15 } }) {
    this.root = new THREE.Group();
    this.root.position.set(position.x, position.y, position.z);
    this.hitMeshes = [];
    (parent || this.root).add(this.root);

    const metal = new THREE.MeshStandardMaterial({ color: 0x3c403a, roughness: 0.55, metalness: 0.55 });
    const red = new THREE.MeshStandardMaterial({
      color: 0x6e130d,
      roughness: 0.5,
      metalness: 0.2,
      emissive: 0x2a0502,
      emissiveIntensity: 0.7,
    });

    // Труба и колесо.
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.1, 10), metal);
    pipe.rotation.z = Math.PI / 2;
    pipe.position.set(0, -0.55, 0);
    this.root.add(pipe);
    this.wheel = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.035, 10, 26), red);
    this.root.add(this.wheel);
    this.hitMeshes.push(this.wheel);
    for (let i = 0; i < 3; i += 1) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.03, 0.03), metal);
      spoke.rotation.z = (i * Math.PI) / 3;
      this.wheel.add(spoke);
    }
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.34), red);
    handle.position.set(0.0, 0, 0.2);
    this.root.add(handle);
    this.hitMeshes.push(handle);
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(0.34, 0.16),
      new THREE.MeshStandardMaterial({ color: 0xd9d2b4, roughness: 0.9, emissive: 0x3a3320, emissiveIntensity: 0.2 }),
    );
    plate.position.set(0, 0.36, 0.02);
    this.root.add(plate);

    // Объём наведения: колесо — полый тор, луч проходит сквозь него.
    const hitbox = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.6, 0.3),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    hitbox.position.set(0, 0, 0.05);
    this.root.add(hitbox);
    this.hitMeshes.push(hitbox);
    this._baseY = position.y;
  }

  setHighlight(on, progress = 0) {
    this.wheel.material.emissiveIntensity = on ? 0.9 + progress * 1.8 : 0.7;
  }

  update(elapsed, active) {
    this.wheel.rotation.z += 0.008 + (active ? 0.05 : 0);
    this.root.position.y = this._baseY + Math.sin(elapsed * 1.4) * 0.006;
  }
}

/**
 * Смена: инструктаж, проверка билетов, побег и тормоз.
 * Держит только сюжетное состояние; физикой занимаются другие системы.
 */
class MissionDirector {
  constructor({ bus, ui, network, demon, tickets, selfId }) {
    this.bus = bus;
    this.ui = ui;
    this.network = network;
    this.demon = demon;
    this.tickets = tickets;
    this.selfId = selfId;
    this.checked = new Set();
    this.total = tickets.length;
    this.step = 0;
    this.started = false;
    this.briefingOpen = false;
    this._briefingBound = false;

    this.bus.on('ticket:checked', ({ index } = {}) => this._markTicket(index));
    this.bus.on('ticket:remote', ({ index } = {}) => this._markTicket(index));
    this.bus.on('demon:awakened', ({ source } = {}) => this._onAwakened(source));
    this.bus.on('demon:phase', ({ phase } = {}) => this._onDemonPhase(phase));
    this.bus.on('zone:changed', ({ zone } = {}) => this._onZone(zone));
    this.bus.on('demon:thrown', () => this._onThrown());
    this.bus.on('demon:escape', () => this._onThrown());
  }

  begin() {
    this.started = true;
    this.checked.clear();
    this.step = 0;
    this.won = false;
    this._render();
    this.openBriefing();
  }

  openBriefing() {
    if (!this.started || this.briefingOpen) return;
    this.briefingOpen = true;
    this.ui.showBriefing();
    if (!this._briefingBound) {
      this._briefingBound = true;
      this._onKey = (event) => {
        if (!this.briefingOpen) return;
        if (event.code !== 'KeyE' && event.code !== 'Enter' && event.code !== 'Space') return;
        event.preventDefault();
        this.acceptBriefing();
      };
      window.addEventListener('keydown', this._onKey, { capture: true });
    }
  }

  acceptBriefing() {
    if (!this.briefingOpen) return;
    this.briefingOpen = false;
    this.ui.hideBriefing();
    this.bus.emit('mission:briefingAccepted', {});
  }

  _markTicket(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.total) return;
    if (this.checked.has(index)) return;
    this.checked.add(index);
    if (this.checked.size >= this.total && this.step < 1) this.step = 1;
    this._render();
  }

  _onAwakened(source) {
    if (source === 'ticket') {
      this.ui.showTicket({
        name: 'ПАССАЖИР БЕЗ ЛИЦА',
        seat: '№ 05',
        serial: '—',
        status: 'НЕТ БИЛЕТА',
        note: 'Штампа нет. На левой руке шесть пальцев. Он падает — но ненадолго.',
        invalid: true,
        seconds: 6.5,
      });
    }
    if (this.step < 2) this.step = 2;
    this._render();
  }

  _onDemonPhase(phase) {
    if (phase === 'stunned' && this.step === 2) {
      this.step = 3;
      this._render();
    }
    if (phase === 'dead' && this.step >= 2 && this.step < 5) {
      // Победа приходит отдельным событием demon:thrown.
    }
  }

  _onZone(zone) {
    if (zone === 'vestibule' && this.step >= 2 && this.step < 5) {
      this.step = 4;
      this._render();
    }
  }

  /** Переход в соседний вагон: задача меняется на «донести тело до тамбура». */
  onCarChanged(car) {
    if (!this.started) return;
    if (car === 1 && this.step === 2) {
      this.step = 3;
      this._render();
    }
  }

  _onThrown() {
    this.step = 5;
    this.won = true;
    this._render();
  }

  update() {
    if (this.started) this._render();
  }

  _render() {
    if (!this.started) return;
    if (this.step === 0) {
      this.ui.setObjective({
        text: 'ПРОВЕРЬТЕ БИЛЕТЫ ПАССАЖИРОВ',
        progress: `${this.checked.size} / ${this.total}`,
        danger: false,
      });
      return;
    }
    if (this.step === 1) {
      this.ui.setObjective({
        text: 'ПАССАЖИР НА МЕСТЕ 05 НЕ ПРЕДЪЯВИЛ БИЛЕТ',
        progress: 'НАЙДИТЕ ЕГО',
        danger: false,
      });
      return;
    }
    if (this.step === 2) {
      this.ui.setObjective({
        text: 'ОН ОГЛУШЁН // ДЕРЖИТЕ E',
        progress: 'ВЕРЁВКА (3) ДАЁТ +32 С НА ПЕРЕНОСКУ',
        danger: true,
      });
      return;
    }
    if (this.step === 3) {
      this.ui.setObjective({
        text: 'ДОТАЩИТЕ ЕГО В ТАМБУР',
        progress: 'ДВЕРЬ В КОНЦЕ САЛОНА, ДАЛЬШЕ — НАЛЕВО К ЛАЗУ',
        danger: true,
      });
      return;
    }
    if (this.step === 4) {
      this.ui.setObjective({
        text: 'СБРОСЬТЕ ЕГО С ПОЕЗДА',
        progress: 'У БОРТА ТАМБУРА ДЕРЖИТЕ E',
        danger: true,
      });
      return;
    }
    this.ui.setObjective({
      text: 'ОН ЗА БОРТОМ // СМЕНА ОКОНЧЕНА',
      progress: '',
      danger: false,
    });
  }
}

/**
 * Переходы: салон → тамбур → соседний вагон.
 * Работают автоматически, когда игрок входит в дверной проём: никаких
 * «нажмите E, глядя точно в дверь». Экран на миг затемняется, чтобы
 * переход читался как шаг через тамбур, а не как телепорт.
 */
/**
 * Салон ↔ тамбур ↔ соседний вагон.
 *
 * Переход — это дверь, а не невидимая линия: игрок видит подсказку «E»,
 * створки разъезжаются, и только после нажатия происходит перенос.
 * Тамбур — буферная зона: там не достаёт демон, стоит автомат и есть лаз,
 * через который тело сбрасывают с поезда.
 */
class ZoneDirector {
  // Точки появления. Обе двери ведут на южный конец вагона: тамбур один
  // и всегда «между» двумя вагонами.
  static SPAWN = {
    vestibule: { x: 0, z: -17.35, yaw: 0 },          // вошли из вагона, лицом в тамбур (−Z)
    car: { x: 0, z: -14.15, yaw: Math.PI },          // вернулись в вагон, лицом в салон (+Z)
    nextCar: { x: 0, z: -13.55, yaw: Math.PI },      // вошли в соседний вагон
  };

  constructor({ player, ui, bus, getCar, onSwitchCar, onEnterVestibule, onLeaveVestibule }) {
    this.player = player;
    this.ui = ui;
    this.bus = bus;
    this.getCar = getCar;
    this.onSwitchCar = onSwitchCar;
    this.onEnterVestibule = onEnterVestibule;
    this.onLeaveVestibule = onLeaveVestibule;
    this.zone = 'car';
    this._cooldown = 0;
    this._fading = false;
    this._armed = true;
    this._armTimer = 0;
    this._autoDragTimer = 0;
    this._hint = '';
  }

  reset() {
    this.zone = 'car';
    this._cooldown = 0;
    this._fading = false;
    this._armed = true;
    this._armTimer = 0;
    this._autoDragTimer = 0;
    this.ui.fadeCar(false);
    this.ui.clearHint('zone');
  }

  /** Ближайшая дверь: null или { kind: 'vestibule' | 'car' | 'next', label }. */
  _doorAt(position) {
    const x = Math.abs(position.x);
    const z = position.z;
    if (x > 1.45) return null;
    if (this.zone === 'car') {
      if (z < -12.5 && z > -16.2) {
        return { kind: 'vestibule', label: 'ОТКРЫТЬ ДВЕРЬ В ТАМБУР' };
      }
      return null;
    }
    if (z > -18.15) return { kind: 'car', label: 'ВЕРНУТЬСЯ В ВАГОН' };
    if (z < -20.85) return { kind: 'next', label: 'ПЕРЕЙТИ В СОСЕДНИЙ ВАГОН' };
    return null;
  }

  _fadeTo(action) {
    if (this._fading) return;
    this._fading = true;
    this._cooldown = 1.3;
    this.player.setEnabled(false);
    this.ui.clearHint('zone');
    this.ui.fadeCar(true);
    this.audio?.hitch?.();
    window.setTimeout(() => {
      action();
      window.setTimeout(() => {
        this.ui.fadeCar(false);
        this._fading = false;
        if (!this.player.downed) this.player.setEnabled(true);
      }, 300);
    }, 320);
  }

  /** Переход выполняется по нажатию E: подсказка → створки → тамбур/вагон. */
  _useDoor(kind) {
    const spawn = kind === 'vestibule'
      ? ZoneDirector.SPAWN.vestibule
      : kind === 'next' ? ZoneDirector.SPAWN.nextCar : ZoneDirector.SPAWN.car;
    const nextZone = kind === 'vestibule' ? 'vestibule' : 'car';
    const car = kind === 'next' ? (this.getCar() === 0 ? 1 : 0) : this.getCar();
    this._fadeTo(() => {
      this.zone = nextZone;
      this.player.position.set(spawn.x, 0, spawn.z);
      this.player.velocity.set(0, 0, 0);
      this.player.feetY = 0;
      this.player.setYaw?.(spawn.yaw);
      this.player._syncCamera(0);
      if (this.onSwitchCar) this.onSwitchCar(car, { teleported: true });
      if (nextZone === 'vestibule') {
        if (this.onEnterVestibule) this.onEnterVestibule();
        this.bus.emit('zone:enteredVestibule', {});
      } else {
        if (this.onLeaveVestibule) this.onLeaveVestibule();
        this.bus.emit('zone:leftVestibule', {});
      }
      this.bus.emit('zone:changed', { zone: this.zone });
      // Дверь «защёлкивается» на мгновение. Игрок, вернувшийся из тамбура,
      // не должен влететь обратно тем же зажатым E, но и стоять в проёме
      // с мёртвой дверью нельзя: через секунду подсказка возвращается.
      this._armed = false;
      this._armTimer = 0.9;
      const banner = kind === 'vestibule'
        ? 'ТАМБУР // БУФЕРНАЯ ЗОНА'
        : kind === 'next' ? `ВАГОН ${car === 1 ? '07 // СЛУЖЕБНЫЙ' : '06 // ПАССАЖИРСКИЙ'}` : 'САЛОН';
      this.ui.showToast(banner, 'info', 2400);
    });
  }

  update(dt, enabled = true) {
    this._cooldown = Math.max(0, this._cooldown - dt);
    this._armTimer = Math.max(0, this._armTimer - dt);
    if (!enabled || this._fading) {
      this.ui.clearHint('zone');
      return;
    }
    const door = this._doorAt(this.player.position);
    const dragging = this.bus && this._isDragging && this._isDragging();
    if (!this._armed) {
      // Вернулись в дверной проём: даём подсказке вернуться, но только
      // когда игрок не тащит тело — иначе двери будут хлопать туда-сюда.
      const canArm = !dragging && this._armTimer <= 0;
      if (canArm || !door) this._armed = true;
      if (!this._armed) {
        this.ui.clearHint('zone');
        return;
      }
    }
    if (this._cooldown > 0 || !door) {
      this._autoDragTimer = 0;
      this.ui.clearHint('zone');
      return;
    }
    this.ui.setHint('zone', { text: door.label, key: 'E', tone: 'normal', priority: 24 });
    if (dragging) {
      // С телом в руках E уже зажата — дверь открывается сама, иначе
      // переноска через тамбур превращается в пляску с клавишами.
      this._autoDragTimer += dt;
      if (this._autoDragTimer > 0.35) {
        this._autoDragTimer = 0;
        this._useDoor(door.kind);
      }
    } else {
      this._autoDragTimer = 0;
    }
  }
}

/** Тормозной кран: удержание E до победы. */
class BrakeDirector {
  constructor({ camera, player, ui, bus, demon, brake, getCar }) {
    this.camera = camera;
    this.player = player;
    this.ui = ui;
    this.bus = bus;
    this.demon = demon;
    this.brake = brake;
    this.getCar = getCar;
    this._ray = new THREE.Raycaster();
    this._center = new THREE.Vector2(0, 0);
    this._held = false;
    this._progress = 0;
    this._visible = false;
    this.bus.on('player:interact', ({ held } = {}) => { this._held = Boolean(held); if (!held) this._progress = 0; });
  }

  update(dt, elapsed, enabled = true) {
    const active = enabled && this.getCar() === 1 && this.demon.phase !== DEMON_PHASE.INCOGNITO
      && this.demon.phase !== DEMON_PHASE.DEAD;
    this.brake.update(elapsed, this._visible);
    if (!active) {
      this._visible = false;
      this._progress = 0;
      this.brake.setHighlight(false);
      this.ui.clearHint('brake');
      return;
    }

    this.camera.updateMatrixWorld(true);
    this._ray.setFromCamera(this._center, this.camera);
    const hits = this._ray.intersectObjects(this.brake.hitMeshes, false);
    const distance = Math.hypot(
      this.player.position.x - this.brake.root.position.x,
      this.player.position.z - this.brake.root.position.z,
    );
    this._visible = Boolean(hits.length && hits[0].distance < 3.4 && distance < 3.0);
    if (!this._visible) {
      this._progress = 0;
      this.brake.setHighlight(false);
      this.ui.clearHint('brake');
      return;
    }

    if (this._held) this._progress += dt;
    const ratio = clamp(this._progress / CONFIG.mission.brakeHold, 0, 1);
    this.brake.setHighlight(true, ratio);
    const percent = Math.round(ratio * 100);
    this.ui.setHint('brake', {
      text: ratio > 0 ? `СРЫВАЕТЕ ТОРМОЗ… ${percent}%` : 'УДЕРЖИВАЙТЕ E — СОРВАТЬ ТОРМОЗ',
      key: 'E',
      tone: 'danger',
      priority: 24,
    });
    if (this._progress >= CONFIG.mission.brakeHold) {
      this._progress = 0;
      this._held = false;
      this.ui.clearHint('brake');
      this.demon.requestEscape();
    }
  }
}

/**
 * Каталог открытых лобби. Хост объявляет код в общем relay-канале,
 * игроки в меню видят список и входят без кода.
 */
class LobbyDirectory {
  constructor({ store, bus }) {
    this.store = store;
    this.bus = bus;
    this.ready = false;
    this.room = null;
    this.action = null;
    this.local = null;
    this.entries = new Map();
    this.lastError = null;
    this._starting = null;
    this._timer = 0;
    this._announceTimer = 0;
  }

  async _pickRelay() {
    const custom = String(this.store.values.relayCustom || '').trim();
    if (/^wss?:\/\/\S+$/i.test(custom)) return custom;
    const urls = CONFIG.network.relay.transports.mqtt.slice(0, 3);
    for (const url of urls) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await probeSocket(url, { mqtt: true, timeout: 2500 });
      if (ok.ok) return url;
    }
    return null;
  }

  async start() {
    if (this.ready) return true;
    if (this._starting) return this._starting;
    this._starting = (async () => {
      try {
        const mod = await loadRelayModule();
        const url = await this._pickRelay();
        if (!url) throw new Error('NO_RELAY');
        const cfg = CONFIG.network.relay;
        const room = mod.joinMqtt({
          appId: cfg.appId,
          password: cfg.password,
          relayConfig: { urls: [url], redundancy: 1 },
          rtcConfig: { iceServers: CONFIG.network.iceServers },
        }, `${CONFIG.network.prefix}directory`, {});
        this.room = room;
        this.action = room.makeAction('dir');
        this.action.onMessage = (data, context) => this._onMessage(data, context);
        room.onPeerLeave = (id) => this._dropPeer(id);
        this.ready = true;
        this._timer = window.setInterval(() => this._tick(), 2000);
        this._announceTimer = window.setInterval(() => this._announce(), 4000);
        this._announce();
        this.bus.emit('directory:update', this.snapshot());
        return true;
      } catch (error) {
        this.lastError = error;
        this._starting = null;
        this.bus.emit('directory:error', { message: error && error.message });
        return false;
      }
    })();
    return this._starting;
  }

  setLocal(info) {
    this.local = info ? { ...info, part: CONFIG.part } : null;
    this._announce();
  }

  clearLocal() {
    this.local = null;
  }

  _announce() {
    if (!this.ready || !this.local || !this.action) return;
    try {
      const pending = this.action.send({
        kind: 'lobby',
        ...this.local,
        ts: Date.now(),
      });
      if (pending && pending.catch) pending.catch(() => {});
    } catch (error) {
      /* ignore */
    }
  }

  _onMessage(data, context) {
    if (!data || data.kind !== 'lobby' || !data.code) return;
    const id = context && context.peerId;
    if (!id) return;
    const existing = this.entries.get(id);
    this.entries.set(id, {
      id,
      code: String(data.code).toUpperCase().slice(0, 5),
      host: String(data.host || 'ПРОВОДНИК').slice(0, 28),
      crew: Math.max(1, Number(data.crew) || 1),
      max: Math.max(2, Number(data.max) || 6),
      part: Number(data.part) || 0,
      seen: Date.now(),
      created: existing ? existing.created : Date.now(),
    });
    this.bus.emit('directory:update', this.snapshot());
  }

  _dropPeer(id) {
    if (!this.entries.has(id)) return;
    this.entries.delete(id);
    this.bus.emit('directory:update', this.snapshot());
  }

  _tick() {
    const now = Date.now();
    let changed = false;
    for (const [id, entry] of this.entries) {
      if (now - entry.seen > 12000) {
        this.entries.delete(id);
        changed = true;
      }
    }
    if (changed) this.bus.emit('directory:update', this.snapshot());
  }

  snapshot() {
    return Array.from(this.entries.values())
      .sort((a, b) => b.seen - a.seen)
      .slice(0, 20);
  }

  stop() {
    window.clearInterval(this._timer);
    window.clearInterval(this._announceTimer);
    this._timer = 0;
    this._announceTimer = 0;
    this.entries.clear();
    if (this.room && this.room.leave) {
      try {
        this.room.leave();
      } catch (error) {
        /* ignore */
      }
    }
    this.room = null;
    this.action = null;
    this.ready = false;
    this._starting = null;
  }
}

// =============================================================================
// ПРЕДМЕТЫ, МАГАЗИН И ПАДЕНИЕ
// =============================================================================

/**
 * Инвентарь проводника: фонарик, бинт, шокер и верёвка.
 * Всё покупается в автомате; валюта пока бесконечная, поэтому цена —
 * только антураж, а ограничение — количество предметов в руках.
 */
class Inventory {
  constructor({ camera, scene, audio, bus, ui, player, demon, network, onRevive }) {
    this.camera = camera;
    this.scene = scene;
    this.audio = audio;
    this.bus = bus;
    this.ui = ui;
    this.player = player;
    this.demon = demon;
    this.network = network;
    this.onRevive = onRevive;

    this.counts = { flashlight: 0, bandage: 0, taser: 0, rope: 0 };
    this.charges = 0;
    this.recharge = 0;
    this.flashlightOn = false;
    this._hudTimer = 0;
    this._ray = new THREE.Raycaster();
    this._center = new THREE.Vector2(0, 0);

    this._buildLight();
    this._onKeyDown = this._onKeyDown.bind(this);
    window.addEventListener('keydown', this._onKeyDown);
    this.syncHud();
  }

  _buildLight() {
    const light = new THREE.SpotLight(0xfff1cf, 0, 17, Math.PI / 7.5, 0.42, 1.1);
    light.position.set(0, 0, 0);
    light.visible = false;
    this.scene.add(light);
    this.scene.add(light.target);
    // Небольшой «блик» у объектива.
    const beam = new THREE.Mesh(
      new THREE.CircleGeometry(0.055, 12),
      new THREE.MeshBasicMaterial({ color: 0xfff4d0, transparent: true, opacity: 0 }),
    );
    beam.position.set(0.16, -0.14, -0.42);
    this.scene.add(beam);
    this.light = light;
    this.beam = beam;
    this._dir = new THREE.Vector3();
  }

  reset() {
    this.counts = { flashlight: 0, bandage: 0, taser: 0, rope: 0 };
    this.charges = 0;
    this.recharge = 0;
    this.flashlightOn = false;
    if (this.light) {
      this.light.visible = false;
      this.light.intensity = 0;
    }
    if (this.beam) this.beam.material.opacity = 0;
    this.syncHud();
  }

  give(kind, amount = 1) {
    if (!(kind in this.counts)) return;
    this.counts[kind] += amount;
    if (kind === 'taser' && this.charges === 0) this.charges = CONFIG.items.taser.charges;
    this.syncHud();
  }

  syncHud() {
    this.ui.setItems({
      flashlight: this.counts.flashlight,
      bandage: this.counts.bandage,
      taser: this.counts.taser,
      rope: this.counts.rope,
      charges: this.charges,
      recharge: this.recharge,
      taserMax: CONFIG.items.taser.charges,
      flashlightOn: this.flashlightOn,
    });
  }

  _onKeyDown(event) {
    if (event.repeat) return;
    const game = this.player;
    if (!game || !game.enabled) return;
    if (this.ui.shopOpen) return;
    if (event.code === 'KeyF') {
      event.preventDefault();
      this.toggleFlashlight();
    } else if (event.code === 'Digit1') {
      event.preventDefault();
      this.useBandage();
    } else if (event.code === 'Digit2') {
      event.preventDefault();
      this.useTaser();
    } else if (event.code === 'Digit3') {
      event.preventDefault();
      this.useRope();
    }
  }

  update(dt) {
    if (this.recharge > 0) {
      this.recharge = Math.max(0, this.recharge - dt);
      if (this.recharge === 0 && this.counts.taser > 0 && this.charges < CONFIG.items.taser.charges) {
        this.charges += 1;
        this.audio.uiClick();
        if (this.charges < CONFIG.items.taser.charges) this.recharge = CONFIG.items.taser.recharge;
      }
      this._hudTimer += dt;
      if (this._hudTimer > 0.2) {
        this._hudTimer = 0;
        this.syncHud();
      }
    }

    if (this.light) {
      const active = this.flashlightOn && this.counts.flashlight > 0 && !this.player.downed;
      this.light.visible = active;
      this.light.intensity = active ? 26 : 0;
      if (this.beam) this.beam.material.opacity = active ? 0.5 : 0;
      if (active) {
        this.camera.updateMatrixWorld(true);
        this.camera.getWorldDirection(this._dir);
        this.light.position.copy(this.camera.position);
        this.light.target.position.copy(this.camera.position).addScaledVector(this._dir, 12);
        this.light.target.updateMatrixWorld();
        if (this.beam) {
          this.beam.position.copy(this.camera.position).addScaledVector(this._dir, 0.5);
          this.beam.lookAt(this.light.target.position);
        }
      }
    }
  }

  toggleFlashlight() {
    if (this.counts.flashlight < 1) {
      this.ui.showToast('ФОНАРИКА НЕТ // КУПИТЕ В АВТОМАТЕ', 'warning', 2400);
      return;
    }
    this.flashlightOn = !this.flashlightOn;
    this.audio.uiClick();
    this.syncHud();
  }

  useBandage() {
    if (this.counts.bandage < 1) {
      this.ui.showToast('БИНТОВ НЕТ // АВТОМАТ В ТАМБУРЕ', 'warning', 2400);
      return;
    }
    if (this.player.downed) {
      this.counts.bandage -= 1;
      this.syncHud();
      this.onRevive({ target: 'self' });
      return;
    }
    const target = this._downedNeighbour();
    if (!target) {
      this.ui.showToast('РЯДОМ НЕТ УПАВШЕГО', 'warning', 1800);
      return;
    }
    this.counts.bandage -= 1;
    this.syncHud();
    this.onRevive({ target: target.id, name: target.name });
  }

  _downedNeighbour() {
    if (!this.network) return null;
    for (const [id, entry] of this.network.remoteStates) {
      if (!entry || !entry.s || !entry.s.d) continue;
      const dx = (Number(entry.s.x) || 0) - this.player.position.x;
      const dz = (Number(entry.s.z) || 0) - this.player.position.z;
      if (Math.hypot(dx, dz) <= 2.6) {
        const player = this.network.roster && this.network.roster.get(id);
        return { id, name: player ? player.name : 'НАПАРНИК' };
      }
    }
    return null;
  }

  useTaser() {
    if (this.charges < 1) {
      this.ui.showToast('ШОКЕР РАЗРЯЖЕН // ПОДОЖДИТЕ', 'warning', 2200);
      return;
    }
    this.camera.updateMatrixWorld(true);
    this._ray.setFromCamera(this._center, this.camera);
    this.demon.npc.root.updateMatrixWorld(true);
    const hits = this._ray.intersectObject(this.demon.npc.root, true);
    const npc = this.demon.npc.root.position;
    const distance = Math.hypot(npc.x - this.player.position.x, npc.z - this.player.position.z);
    if (!hits.length && distance > 2.2) {
      this.ui.showToast('ШОКЕР: ЦЕЛЬ НЕ В ПРИЦЕЛЕ', 'warning', 1600);
      return;
    }
    if (distance > 5.5) {
      this.ui.showToast('ШОКЕР: СЛИШКОМ ДАЛЕКО', 'warning', 1600);
      return;
    }
    this.charges -= 1;
    if (this.recharge <= 0) this.recharge = CONFIG.items.taser.recharge;
    this.audio.uiError();
    this.demon.taserHit();
    this.ui.showToast('РАЗРЯД // ОН ПАДАЕТ', 'success', 2200);
    this.syncHud();
  }

  useRope() {
    if (this.counts.rope < 1) {
      this.ui.showToast('ВЕРЁВКИ НЕТ // КУПИТЕ В АВТОМАТЕ', 'warning', 2400);
      return;
    }
    const npc = this.demon.npc.root.position;
    const distance = Math.hypot(npc.x - this.player.position.x, npc.z - this.player.position.z);
    if (this.demon.phase !== DEMON_PHASE.STUNNED) {
      this.ui.showToast('НУЖНО СНАЧАЛА УРОНИТЬ ЕГО', 'warning', 2000);
      return;
    }
    if (distance > 3.8) {
      this.ui.showToast('ПОДОЙДИТЕ К ТЕЛУ', 'warning', 1800);
      return;
    }
    this.counts.rope -= 1;
    this.syncHud();
    this.demon.applyRope();
    this.ui.showToast(`ВЕРЁВКА ЗАТЯНУТА // +${CONFIG.items.rope.bonus} СЕК`, 'success', 2600);
  }
}

/** Торговый автомат в тамбуре: светится и продаёт снаряжение. */
class VendingMachine {
  constructor({ parent, position = { x: 1.18, z: -18.9 } }) {
    this.root = new THREE.Group();
    this.root.position.set(position.x, 0, position.z);
    this.root.rotation.y = -Math.PI / 2;
    (parent || this.root).add(this.root);
    this.hitMeshes = [];

    const body = new THREE.MeshStandardMaterial({ color: 0x2c3a33, roughness: 0.62, metalness: 0.35 });
    const trim = new THREE.MeshStandardMaterial({ color: 0x141a16, roughness: 0.5, metalness: 0.5 });
    const glass = new THREE.MeshStandardMaterial({
      color: 0x25413a,
      emissive: 0x2f6f57,
      emissiveIntensity: 0.9,
      roughness: 0.25,
      metalness: 0.2,
    });

    const cabinet = new THREE.Mesh(new THREE.BoxGeometry(0.86, 1.9, 0.42), body);
    cabinet.position.y = 0.95;
    this.root.add(cabinet);
    this.hitMeshes.push(cabinet);

    const windowMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.68, 0.86), glass);
    windowMesh.position.set(0, 1.32, 0.215);
    this.root.add(windowMesh);

    // Полки с тусклыми коробками.
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 4; col += 1) {
        const item = new THREE.Mesh(
          new THREE.BoxGeometry(0.12, 0.14, 0.04),
          new THREE.MeshStandardMaterial({
            color: row === 0 ? 0x8a3a2a : row === 1 ? 0x3a5a8a : 0x7a6a2a,
            roughness: 0.7,
            emissive: 0x0a0a08,
            emissiveIntensity: 0.3,
          }),
        );
        item.position.set(-0.24 + col * 0.16, 1.0 + row * 0.26, 0.2);
        this.root.add(item);
      }
    }

    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.03), trim);
    panel.position.set(0.24, 0.78, 0.22);
    this.root.add(panel);
    const display = new THREE.Mesh(
      new THREE.PlaneGeometry(0.24, 0.1),
      new THREE.MeshBasicMaterial({ color: 0x9be3dc }),
    );
    display.position.set(0.24, 0.78, 0.238);
    this.root.add(display);

    const glow = new THREE.PointLight(0x66d6b0, 2.2, 4.4, 2);
    glow.position.set(0, 1.35, 0.55);
    this.root.add(glow);
    this.glow = glow;

    const signCanvas = document.createElement('canvas');
    signCanvas.width = 256;
    signCanvas.height = 64;
    const ctx = signCanvas.getContext('2d');
    ctx.fillStyle = '#08120e';
    ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = '#9be3dc';
    ctx.font = '600 30px "Cascadia Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('АВТОМАТ', 128, 34);
    const texture = new THREE.CanvasTexture(signCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(0.6, 0.15),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true }),
    );
    sign.position.set(0, 2.02, 0.22);
    this.root.add(sign);
  }

  update(elapsed) {
    this.glow.intensity = 2.0 + Math.sin(elapsed * 2.3) * 0.25;
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
    this._initHints();
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
      objective: $('#hud-objective'),
      objectiveText: $('#objective-text'),
      objectiveProgress: $('#objective-progress'),
      ticketCard: $('#ticket-card'),
      ticketStatus: $('#ticket-status'),
      ticketName: $('#ticket-name'),
      ticketSeat: $('#ticket-seat'),
      ticketSerial: $('#ticket-serial'),
      ticketNote: $('#ticket-note'),
      briefing: $('#briefing'),
      briefingAccept: $('#btn-briefing-accept'),
      carFade: $('#car-fade'),
      serverBrowser: $('#server-browser'),
      serverList: $('#server-list'),
      serverEmpty: $('#server-empty'),
      serverCount: $('#server-count'),
      refreshServers: $('#btn-refresh-servers'),
      hudItems: $('#hud-items'),
      slots: {
        flashlight: $('[data-slot="flashlight"]'),
        bandage: $('[data-slot="bandage"]'),
        taser: $('[data-slot="taser"]'),
        rope: $('[data-slot="rope"]'),
      },
      slotLabels: {
        flashlight: $('#slot-flashlight'),
        bandage: $('#slot-bandage'),
        taser: $('#slot-taser'),
        rope: $('#slot-rope'),
      },
      shop: $('#modal-shop'),
      shopGrid: $('#shop-grid'),
      shopClose: $('#btn-shop-close'),
      shopDone: $('#btn-shop-done'),
      wardrobe: $('#modal-wardrobe'),
      wardrobeButton: $('#btn-wardrobe'),
      wardrobeClose: $('#btn-wardrobe-close'),
      wardrobeDone: $('#btn-wardrobe-done'),
      downed: $('#downed-overlay'),
      downedHint: $('#downed-hint'),
      downedTimer: $('#downed-timer'),
      skinGrid: $('#skin-grid'),
      skinRandom: $('#btn-skin-random'),
      skinAccents: $('#skin-accents'),

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
    this.setSkinUI(this.store.values.skin, this.store.values.skinAccent);
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

    if (this.el.serverList) {
      this.el.serverList.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-code]');
        if (!button) return;
        this.audio.uiConfirm();
        this.bus.emit('ui:joinServer', button.dataset.code);
      });
    }
    if (this.el.refreshServers) {
      this.el.refreshServers.addEventListener('click', () => {
        this.audio.uiClick();
        this.bus.emit('ui:refreshServers');
      });
    }
    if (this.el.shopGrid) {
      this.el.shopGrid.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-buy]');
        if (!button) return;
        this.audio.uiConfirm();
        this.bus.emit('shop:buy', { kind: button.dataset.buy });
      });
    }
    if (this.el.shopClose) {
      this.el.shopClose.addEventListener('click', () => this.bus.emit('ui:shopClose', {}));
    }
    if (this.el.shopDone) {
      this.el.shopDone.addEventListener('click', () => this.bus.emit('ui:shopClose', {}));
    }
    if (this.el.wardrobeButton) {
      this.el.wardrobeButton.addEventListener('click', () => this.openWardrobe());
    }
    if (this.el.wardrobeClose) {
      this.el.wardrobeClose.addEventListener('click', () => this.closeWardrobe());
    }
    if (this.el.wardrobeDone) {
      this.el.wardrobeDone.addEventListener('click', () => this.closeWardrobe());
    }
    if (this.el.wardrobe) {
      this.el.wardrobe.addEventListener('click', (event) => {
        if (event.target === this.el.wardrobe) {
          this.audio.uiBack();
          this.closeWardrobe();
        }
      });
    }
    if (this.el.skinGrid) {
      this.el.skinGrid.addEventListener('click', (event) => {
        const card = event.target.closest('button[data-skin]');
        if (!card) return;
        this.audio.uiClick();
        this.bus.emit('settings:skin', { skin: card.dataset.skin });
      });
    }
    if (this.el.skinAccents) {
      this.el.skinAccents.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-accent]');
        if (!button) return;
        this.audio.uiClick();
        this.bus.emit('settings:skin', { accent: Number(button.dataset.accent) });
      });
    }
    if (this.el.skinRandom) {
      this.el.skinRandom.addEventListener('click', () => {
        this.audio.uiConfirm();
        this.bus.emit('settings:skin', { random: true });
      });
    }
    if (this.el.briefingAccept) {
      this.el.briefingAccept.addEventListener('click', () => {
        this.audio.uiConfirm();
        this.bus.emit('ui:acceptBriefing');
      });
    }

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
      if (this.el.wardrobe && !this.el.wardrobe.hidden) {
        event.stopPropagation();
        this.closeWardrobe();
        this.audio.uiBack();
      } else if (this._settingsOpen) {
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
    this.bus.emit('ui:joinOpened');
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
    this.hidePrompt(999);
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
    this.hidePrompt(999);
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
    this.hidePrompt(999);
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

  /**
   * Подсказки живут по владельцу и приоритету.
   *
   * Раньше каждая система показывала и прятала общий элемент в своём порядке,
   * и демон (приоритет 20) каждый кадр прятал подсказку двери (8): игрок видел,
   * что подсказки нет, и не понимал, как перейти в тамбур. Теперь системы
   * заявляют подсказку каждый кадр, а UI сам выбирает старшую и убирает
   * «протухшие» заявки, которые перестали обновляться.
   */
  _initHints() {
    this._hints = new Map();
    this._hintRendered = null;
  }

  setHint(owner, { text = '', key = 'E', tone = 'normal', priority = 10 } = {}) {
    if (!this._hints) this._initHints();
    this._hints.set(owner, {
      text,
      key,
      tone,
      priority,
      expires: performance.now() + 160,
    });
    this._renderHints();
  }

  clearHint(owner) {
    if (!this._hints) return;
    if (this._hints.delete(owner)) this._renderHints();
  }

  _renderHints() {
    if (!this.el.prompt) return;
    const now = performance.now();
    let best = null;
    for (const [owner, hint] of this._hints) {
      if (hint.expires < now) {
        this._hints.delete(owner);
        continue;
      }
      if (!hint.text) continue;
      if (!best || hint.priority > best.priority) best = hint;
    }
    if (!best) {
      if (this._hintRendered !== null) {
        this._hintRendered = null;
        this.el.prompt.hidden = true;
      }
      return;
    }
    const signature = `${best.priority}|${best.tone}|${best.key}|${best.text}`;
    if (signature === this._hintRendered) return;
    this._hintRendered = signature;
    if (this.el.promptKey) {
      this.el.promptKey.textContent = best.key || '';
      this.el.promptKey.hidden = !best.key;
    }
    if (this.el.promptText) this.el.promptText.textContent = best.text;
    this.el.prompt.dataset.tone = best.tone;
    this.el.prompt.hidden = false;
  }

  /** Совместимость: старые вызовы без владельца. */
  showPrompt(text, key = 'E', tone = 'normal', priority = 10) {
    this.setHint('legacy', { text, key, tone, priority });
  }

  hidePrompt(priority = 10) {
    const hint = this._hints && this._hints.get('legacy');
    if (!hint) return;
    if (priority < hint.priority) return;
    this.clearHint('legacy');
  }

  /** Задача смены в верхней части HUD. */
  setObjective({ text, progress = '', danger = false, hidden = false } = {}) {
    if (!this.el.objective) return;
    if (text && this.el.objectiveText) this.el.objectiveText.textContent = text;
    if (progress !== undefined && this.el.objectiveProgress) {
      this.el.objectiveProgress.textContent = progress;
      this.el.objectiveProgress.hidden = !progress;
    }
    this.el.objective.classList.toggle('is-danger', Boolean(danger));
    this.el.objective.classList.toggle('is-hidden', Boolean(hidden));
  }

  /** Билетная карточка: валидный билет или «без билета». */
  showTicket({ name, seat, serial, status, note, invalid = false, seconds = 4.6 } = {}) {
    if (!this.el.ticketCard) return;
    this.el.ticketCard.dataset.state = invalid ? 'invalid' : 'valid';
    if (this.el.ticketStatus) this.el.ticketStatus.textContent = status || (invalid ? 'НЕТ БИЛЕТА' : 'ДЕЙСТВИТЕЛЕН');
    if (this.el.ticketName) this.el.ticketName.textContent = name || '—';
    if (this.el.ticketSeat) this.el.ticketSeat.textContent = seat || '—';
    if (this.el.ticketSerial) this.el.ticketSerial.textContent = serial || '—';
    if (this.el.ticketNote) this.el.ticketNote.textContent = note || '';
    this.el.ticketCard.hidden = false;
    window.clearTimeout(this._ticketTimer);
    this._ticketTimer = window.setTimeout(() => this.hideTicket(), seconds * 1000);
  }

  hideTicket() {
    window.clearTimeout(this._ticketTimer);
    if (this.el.ticketCard) this.el.ticketCard.hidden = true;
  }

  showBriefing() {
    if (this.el.briefing) this.el.briefing.hidden = false;
  }

  hideBriefing() {
    if (this.el.briefing) this.el.briefing.hidden = true;
  }

  get briefingOpen() {
    return Boolean(this.el.briefing && !this.el.briefing.hidden);
  }

  /** Короткое затемнение для перехода между вагонами. */
  fadeCar(active) {
    if (!this.el.carFade) return;
    this.el.carFade.classList.toggle('is-active', Boolean(active));
  }

  /** Список открытых вагонов в «Подключиться». */
  setServerList(servers = [], { loading = false } = {}) {
    if (!this.el.serverList) return;
    const list = Array.isArray(servers) ? servers : [];
    if (this.el.serverCount) {
      this.el.serverCount.textContent = `${list.length} ${list.length === 1 ? 'ВАГОН' : 'ВАГОНОВ'}`;
    }
    if (!list.length) {
      this.el.serverList.innerHTML = '';
      const row = document.createElement('li');
      row.className = `server-empty${loading ? ' server-loading' : ''}`;
      row.textContent = loading ? 'ПОИСК ВАГОНОВ…' : 'ОТКРЫТЫХ ВАГОНОВ НЕ НАЙДЕНО // СОЗДАЙТЕ СВОЙ';
      this.el.serverList.appendChild(row);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const server of list) {
      const item = document.createElement('li');
      item.className = 'server-row';
      const main = document.createElement('div');
      main.className = 'server-row-main';
      const title = document.createElement('b');
      title.textContent = server.host || 'БЕЗЫМЯННЫЙ ПРОВОДНИК';
      const sub = document.createElement('small');
      const partName = server.part >= 5 ? 'ЧАСТЬ V'
        : server.part === 4 ? 'ЧАСТЬ IV'
          : server.part === 3 ? 'ЧАСТЬ III' : 'РЕЙС 06';
      sub.textContent = `КОД ${server.code} // ${partName}`;
      main.append(title, sub);
      const crew = document.createElement('span');
      crew.className = 'server-crew';
      crew.textContent = `${server.crew || 1} / ${server.max || 6}`;
      const join = document.createElement('button');
      join.type = 'button';
      join.textContent = 'ВОЙТИ';
      join.dataset.code = server.code;
      item.append(main, crew, join);
      fragment.appendChild(item);
    }
    this.el.serverList.innerHTML = '';
    this.el.serverList.appendChild(fragment);
  }

  /** Панель предметов: количество и заряды. */
  setItems({ flashlight = 0, bandage = 0, taser = 0, rope = 0, charges = 0, recharge = 0, taserMax = 3, flashlightOn = false } = {}) {
    const set = (key, label, empty, active = false) => {
      const slot = this.el.slots && this.el.slots[key];
      const text = this.el.slotLabels && this.el.slotLabels[key];
      if (!slot) return;
      slot.dataset.empty = empty ? 'true' : 'false';
      slot.dataset.active = active ? 'true' : 'false';
      if (text) text.textContent = label;
    };
    set('flashlight', flashlight ? (flashlightOn ? 'ВКЛ' : 'ВЫКЛ') : 'НЕТ', !flashlight, flashlightOn);
    set('bandage', String(bandage), bandage < 1);
    const chargeText = taser ? `${charges}/${taserMax}${recharge > 0 ? ` · ${Math.ceil(recharge)}с` : ''}` : '0';
    set('taser', chargeText, !taser);
    set('rope', String(rope), rope < 1);
  }

  openWardrobe() {
    if (!this.el.wardrobe) return;
    if (this.el.menu) this.el.menu.hidden = true;
    this.el.wardrobe.hidden = false;
    this.setSkinUI(this.store.values.skin, this.store.values.skinAccent);
    this.bus.emit('ui:wardrobeOpen', {
      skin: this.store.values.skin,
      accent: this.store.values.skinAccent,
    });
    window.setTimeout(() => this.el.wardrobeDone && this.el.wardrobeDone.focus({ preventScroll: true }), 0);
  }

  closeWardrobe() {
    if (!this.el.wardrobe || this.el.wardrobe.hidden) return;
    this.el.wardrobe.hidden = true;
    if (this.el.menu) this.el.menu.hidden = false;
    this.bus.emit('ui:wardrobeClose', {});
    if (this.el.wardrobeButton) {
      window.setTimeout(() => this.el.wardrobeButton.focus({ preventScroll: true }), 0);
    }
  }

  get wardrobeOpen() {
    return Boolean(this.el.wardrobe && !this.el.wardrobe.hidden);
  }

  openShop() {
    if (this.el.shop) this.el.shop.hidden = false;
  }

  closeShop() {
    if (this.el.shop && !this.el.shop.hidden) {
      this.el.shop.hidden = true;
      this.audio.uiBack();
    }
  }

  get shopOpen() {
    return Boolean(this.el.shop && !this.el.shop.hidden);
  }

  showDowned(hint) {
    if (this.el.downed) this.el.downed.hidden = false;
    if (hint && this.el.downedHint) this.el.downedHint.textContent = hint;
  }

  hideDowned() {
    if (this.el.downed) this.el.downed.hidden = true;
    if (this.el.downedTimer) this.el.downedTimer.textContent = '';
  }

  setDownedTimer(seconds) {
    if (!this.el.downedTimer) return;
    this.el.downedTimer.textContent = seconds > 0 ? `ДО ПОТЕРИ СОЗНАНИЯ ${Math.ceil(seconds)} С` : '';
  }

  setSkinUI(skin, accent = 0) {
    if (this.el.skinGrid) {
      for (const card of this.el.skinGrid.querySelectorAll('[data-skin]')) {
        card.setAttribute('aria-pressed', String(card.dataset.skin === skin));
      }
    }
    if (this.el.skinAccents) {
      for (const button of this.el.skinAccents.querySelectorAll('[data-accent]')) {
        button.setAttribute('aria-pressed', String(Number(button.dataset.accent) === accent));
      }
    }
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

    // Пассажиры с билетами: четыре места из CONFIG.npc.seats.
    this.passengers = CONFIG.npc.seats.map((seat, index) => new SeatPassenger({
      scene: this.scene,
      parent: this.world.group,
      seat: { ...seat, yaw: seat.x < 0 ? Math.PI / 2 : -Math.PI / 2, y: 0.52 },
      index,
    }));
    this.ticketInspector = new TicketInspector({
      camera: this.camera,
      player: this.player,
      ui: this.ui,
      bus: this.bus,
      passengers: this.passengers,
      onCheck: (passenger) => this._onTicketChecked(passenger),
    });
    this.vendingMachine = new VendingMachine({ parent: this.world.group });
    this.inventory = new Inventory({
      camera: this.camera,
      scene: this.scene,
      audio: this.audio,
      bus: this.bus,
      ui: this.ui,
      player: this.player,
      demon: this.demon,
      network: this.network,
      onRevive: (payload) => this._revive(payload),
    });
    this.brakeValve = new BrakeValve({ parent: this.world.group });
    this.brakeValve.root.visible = false;
    this.brakeDirector = new BrakeDirector({
      camera: this.camera,
      player: this.player,
      ui: this.ui,
      bus: this.bus,
      demon: this.demon,
      brake: this.brakeValve,
      getCar: () => this.demon.localCar,
    });
    this.zoneDirector = new ZoneDirector({
      player: this.player,
      ui: this.ui,
      bus: this.bus,
      audio: this.audio,
      getCar: () => this.demon.localCar,
      onSwitchCar: (car, options) => this._switchCar(car, options),
      onEnterVestibule: () => { this._inVestibule = true; },
      onLeaveVestibule: () => { this._inVestibule = false; },
    });
    this.zoneDirector._isDragging = () => Boolean(this.demon && this.demon._draggingId);
    this.mission = new MissionDirector({
      bus: this.bus,
      ui: this.ui,
      network: this.network,
      demon: this.demon,
      tickets: this.passengers,
      selfId: () => this.network.selfId,
    });
    this.directory = new LobbyDirectory({ store: this.store, bus: this.bus });
    this._switchingCar = false;
    this._carTimer = 0;

    this._localInCar = false;
    this._demonDeath = false;
    this.network.setLocalStateProvider(() => {
      const state = this.player.getNetworkState();
      state.c = this._localInCar ? 1 : 0;
      state.zone = this.zoneDirector ? this.zoneDirector.zone : 'car';
      state.d = this.player.downed ? 1 : 0;
      state.skin = this.store.values.skin;
      state.accent = this.store.values.skinAccent;
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

    // Часть IV: инструктаж, двери, тормоз и каталог вагонов.
    this.bus.on('player:interact', ({ held } = {}) => {
      if (!held || this.state !== STATE.PLAYING) return;
      if (this.player.downed) return;
      // Дверь: явное нажатие E у створок.
      if (!this.ui.shopOpen && this.zoneDirector && this.zoneDirector._cooldown <= 0) {
        const door = this.zoneDirector._armed ? this.zoneDirector._doorAt(this.player.position) : null;
        if (door) {
          this.zoneDirector._useDoor(door.kind);
          return;
        }
      }
      if (this.zoneDirector.zone === 'vestibule' && !this.ui.shopOpen) {
        // С телом в руках автомат не открываем: иначе E ведёт себя двояко.
        if (this.demon._draggingId || this.demon._dragHelpers.size) return;
        // Только со стороны автомата: у борта E сбрасывает тело, а не открывает магазин.
        if (this.player.position.x < 0.15) return;
        const dx = this.player.position.x - this.vendingMachine.root.position.x;
        const dz = this.player.position.z - this.vendingMachine.root.position.z;
        if (Math.hypot(dx, dz) <= 1.95 && !this.player.downed) this._openShop();
      }
    });
    this.bus.on('player:downed', () => this._onLocalDowned());
    this.bus.on('player:revived', () => this._onLocalRevived());
    this.bus.on('demon:thrown', () => this._onDemonThrown());
    this.bus.on('shop:buy', ({ kind } = {}) => {
      if (!kind || !CONFIG.items[kind]) return;
      this.inventory.give(kind);
      this.audio.uiConfirm();
      this.ui.showToast(`КУПЛЕНО: ${CONFIG.items[kind].name}`, 'success', 2000);
    });
    this.bus.on('settings:skin', ({ skin, accent, random } = {}) => {
      const patch = {};
      if (random) {
        const pool = CONFIG.skins.filter((entry) => entry !== this.store.values.skin);
        patch.skin = pool[Math.floor(Math.random() * pool.length)] || 'conductor';
        patch.skinAccent = Math.floor(Math.random() * 4);
      }
      if (skin && CONFIG.skins.includes(skin)) patch.skin = skin;
      if (Number.isInteger(accent)) patch.skinAccent = clamp(accent, 0, 3);
      if (!Object.keys(patch).length) return;
      this.store.save(patch);
      this.ui.setSkinUI(this.store.values.skin, this.store.values.skinAccent);
      if (this.ui.wardrobeOpen) {
        this.remotePlayers.showSkinPreview(this.store.values.skin, this.store.values.skinAccent);
      }
      this.ui.showToast('ВНЕШНОСТЬ ОБНОВЛЕНА', 'info', 1600);
    });
    this.bus.on('voice:howl', ({ hz } = {}) => {
      this.ui.showToast(
        `ПОДАВЛЕН ПИСК В КАНАЛЕ${hz ? ` // ${Math.round(hz)} ГЦ` : ''}`,
        'warning',
        3200,
      );
    });
    this.bus.on('zone:changed', ({ zone } = {}) => {
      this.demon.setLocalZone(zone);
      this.world.setZone(zone);
      this.ui.hidePrompt(12);
    });
    this.bus.on('ui:acceptBriefing', () => {
      this.mission.acceptBriefing();
      this.audio.uiConfirm();
    });
    this.bus.on('ui:shopClose', () => this._closeShop());
    this.bus.on('ui:wardrobeOpen', ({ skin, accent } = {}) => {
      if (this.state !== STATE.MENU) return;
      this.remotePlayers.showSkinPreview(skin, accent);
    });
    this.bus.on('ui:wardrobeClose', () => this.remotePlayers.hideSkinPreview());
    this.bus.on('ui:joinServer', (code) => this._joinByCode(code));
    this.bus.on('ui:refreshServers', () => this._refreshServers());
    this.bus.on('ui:joinOpened', () => {
      this.ui.setServerList([], { loading: true });
      this.directory.start().then((ok) => {
        if (ok) this.ui.setServerList(this.directory.snapshot(), { loading: false });
      });
    });
    this.bus.on('directory:update', (list) => {
      if (this.ui.el.join && !this.ui.el.join.hidden) {
        this.ui.setServerList(list, { loading: false });
      }
    });
    this.bus.on('directory:error', () => {
      if (this.ui.el.join && !this.ui.el.join.hidden) {
        this.ui.setServerList([], { loading: false });
      }
    });
    this.bus.on('network:roster', () => this._syncDirectory());

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
    window.addEventListener('keydown', (event) => {
      if (event.code === 'Escape' && this.ui.shopOpen) {
        event.preventDefault();
        this._closeShop();
      }
    });
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
    // Сохранённая внешность должна быть подсвечена в настройках сразу.
    this.ui.setSkinUI(this.store.values.skin, this.store.values.skinAccent);
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
    if (this.ui.wardrobeOpen) {
      this.ui.closeWardrobe();
      this.remotePlayers.hideSkinPreview();
    }

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
    // Хост сразу объявляет свой вагон в каталоге: игрокам не нужен код.
    this.directory.start().then(() => this._syncDirectory());
    this.directory.setLocal({
      code: result.code,
      host: this.store.values.callsign || 'ПРОВОДНИК',
      crew: Math.max(1, this.network.getPlayers().length),
      max: CONFIG.network.maxPlayers || 6,
    });
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
    if (this.ui.wardrobeOpen) {
      this.ui.closeWardrobe();
      this.remotePlayers.hideSkinPreview();
    }
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

  /** Гасим сюжетные подсказки, когда сеанс заканчивается. */
  _resetMissionSystems() {
    this.mission.started = false;
    this.mission.briefingOpen = false;
    this.mission.checked.clear();
    this.ui.hideBriefing();
    this.ui.hideTicket();
    this.ui.setObjective({ text: '', progress: '', hidden: true });
    this.ui.fadeCar(false);
    this.ui.hidePrompt(999);
    this._switchingCar = false;
    window.clearTimeout(this._carTimer);
    for (const passenger of this.passengers) {
      passenger.checked = false;
      passenger.root.visible = true;
      passenger.setHighlight(false);
    }
    this.world.setCarVariant(0);
    this.world.setZone('car');
    this.brakeValve.root.visible = false;
    this.demon.setLocalCar(0);
    this.demon.setLocalZone('car');
    this.zoneDirector.reset();
    this.inventory.reset();
    this.ui.hideDowned();
    this.ui.closeShop();
    this.player.setDowned(false);
    this._dumpProgress = 0;
    this._downedTimer = 0;
    this._demonThrown = false;
    this.directory.clearLocal();
  }

  // ---------------------------------------------------------------------------
  // Магазин и предметы
  // ---------------------------------------------------------------------------

  _openShop() {
    if (this.ui.shopOpen) return;
    // Магазин не ставит игру на паузу: пассажир в соседнем вагоне живой.
    this.ui.openShop();
    this.inventory.syncHud();
    this.player.setEnabled(false);
    this.ui.hidePrompt(999);
    this.player.unlock();
    this.audio.uiClick();
  }

  _closeShop() {
    if (!this.ui.shopOpen) return;
    this.ui.closeShop();
    this._requestPointerLock(false);
  }

  // ---------------------------------------------------------------------------
  // Падение, подъём и сброс демона
  // ---------------------------------------------------------------------------

  _onLocalDowned() {
    if (this.player.downed) return;
    this.player.setDowned(true);
    this._downedTimer = CONFIG.mission.bleedout;
    this.audio.uiError();
    const hint = this.inventory.counts.bandage > 0
      ? 'У ВАС ЕСТЬ БИНТ — НАЖМИТЕ 1, ЧТОБЫ ПОДНЯТЬСЯ'
      : 'ДРУГОЙ ПРОВОДНИК МОЖЕТ ПОДНЯТЬ ВАС БИНТОМ // ИЛИ ДОБЕРИТЕСЬ ДО АВТОМАТА';
    this.ui.showDowned(hint);
    this.ui.setDownedTimer(this._downedTimer);
    this.ui.showToast('ВЫ ПАЛИ // ОН ИДЁТ ДАЛЬШЕ', 'error', 4200);
  }

  _onLocalRevived() {
    if (!this.player.downed) return;
    this.player.setDowned(false);
    if (this.state === STATE.PLAYING) this.player.setEnabled(true);
    this._downedTimer = 0;
    this.ui.hideDowned();
    this.audio.uiConfirm();
    this.ui.showToast('БИНТ ЗАТЯНУТ // ВЫ СНОВА НА НОГАХ', 'success', 2600);
  }

  _updateDowned(dt) {
    if (!this.player.downed) {
      if (this._downedTimer) {
        this._downedTimer = 0;
        this.ui.setDownedTimer(0);
      }
      return;
    }
    this._downedTimer = Math.max(0, this._downedTimer - dt);
    if (Math.floor(this._downedTimer) !== Math.floor(this._downedTimer + dt)) {
      this.ui.setDownedTimer(this._downedTimer);
    }
    if (this._downedTimer <= 0) {
      this._downedTimer = 0;
      this.ui.hideDowned();
      this.demon.onGameOver({ target: this.network.selfId, name: this.network._displayName() });
    }
  }

  _revive({ target } = {}) {
    if (!target) return;
    if (target === 'self') {
      this.demon.reviveTarget(this.network.selfId || 'local');
      if (this.player.downed) this._onLocalRevived();
      return;
    }
    this.demon.reviveTarget(target);
    this.ui.showToast('НАПАРНИК ПОДНЯТ', 'success', 2200);
  }

  /** Автомат в тамбуре: подсказка и открытие магазина. */
  _updateVending(enabled) {
    if (!enabled || this.zoneDirector.zone !== 'vestibule') {
      this.ui.hidePrompt(13);
      return;
    }
    if (this.player.position.x < 0.15) {
      this.ui.hidePrompt(13);
      return;
    }
    const dx = this.player.position.x - this.vendingMachine.root.position.x;
    const dz = this.player.position.z - this.vendingMachine.root.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance > 1.95) {
      this.ui.hidePrompt(13);
      return;
    }
    if (this.ui.shopOpen) return;
    const dragging = this.demon._draggingId || this.demon._dragHelpers.size;
    if (dragging) {
      this.ui.showPrompt('АВТОМАТ ЗАНЯТ // ОТПУСТИТЕ ТЕЛО', '', 'normal', 13);
      return;
    }
    this.ui.showPrompt('ТОРГОВЫЙ АВТОМАТ', 'E', 'normal', 13);
  }

  /** Удержание E у борта: сброс демона с поезда. */
  _updateDump(enabled) {
    if (!enabled || this.ui.shopOpen || this.zoneDirector.zone !== 'vestibule') {
      this._dumpProgress = 0;
      return;
    }
    if (this.demon.phase !== DEMON_PHASE.STUNNED || this._demonThrown) {
      this._dumpProgress = 0;
      return;
    }
    const npc = this.demon.npc.root.position;
    const distance = Math.hypot(npc.x - this.player.position.x, npc.z - this.player.position.z);
    // Полоса сброса держится в стороне от южной двери (−20.85), иначе
    // с телом в руках игрок уезжает в соседний вагон вместо сброса.
    const nearEdge = this.player.position.x < -0.5
      && this.player.position.z < -18.3 && this.player.position.z > -21.1;
    if (distance > CONFIG.mission.dumpDistance || !nearEdge) {
      this._dumpProgress = 0;
      return;
    }
    if (this.player.interactHeld) this._dumpProgress += this.tickDt || 0.016;
    else this._dumpProgress = Math.max(0, this._dumpProgress - 0.02);
    const ratio = clamp(this._dumpProgress / CONFIG.mission.dumpHold, 0, 1);
    this.ui.showPrompt(
      ratio > 0 ? `СБРАСЫВАЕМ ЕГО ЗА БОРТ… ${Math.round(ratio * 100)}%` : 'УДЕРЖИВАЙТЕ E — СБРОСИТЬ ЕГО С ПОЕЗДА',
      'E',
      'danger',
      21,
    );
    if (this._dumpProgress >= CONFIG.mission.dumpHold) {
      this._dumpProgress = 0;
      this._demonThrown = true;
      this.ui.hidePrompt(999);
      this.demon.throwOut();
    }
  }

  _onDemonThrown() {
    if (!this.demon.active) return;
    // Смена окончена: отпускаем управление, чтобы можно было нажать «В меню».
    if (this.state === STATE.PLAYING) {
      this.state = STATE.PAUSED;
      this.player.setEnabled(false);
      this.player.unlock();
      this.voiceWatcher.pause();
      this.audio.setScene('menu');
    }
    this.audio.uiConfirm();
    this.ui.setObjective({
      text: 'ОН ЗА БОРТОМ // СМЕНА ОКОНЧЕНА',
      progress: 'ПОЕЗД ИДЁТ ДАЛЬШЕ',
      danger: false,
    });
    this.ui.showEnded({
      title: 'СМЕНА ОКОНЧЕНА',
      text: 'Тело ушло в темноту между вагонами. Дверь тамбура закрылась, '
        + 'и поезд поехал дальше без пятого пассажира. Вы выжили.',
      kicker: 'ВАГОН 06 // СИГНАЛ ВОССТАНОВЛЕН',
      dead: false,
    });
    this.ui.showToast('ВЫ СБРОСИЛИ ЕГО С ПОЕЗДА', 'success', 6000);
  }

  _onTicketChecked(passenger) {
    if (!passenger) return;
    const total = this.passengers.length;
    const checked = this.passengers.filter((entry) => entry.checked).length;
    this.network.sendDemon({ kind: 'ticket', index: passenger.index });
    if (checked >= total) {
      this.audio.uiError();
      this.demon.wakeFromTicket();
      return;
    }
    this.ui.showToast(`БИЛЕТ ПРОВЕРЕН // ${checked} ИЗ ${total}`, 'info', 2200);
  }

  /** Смена вагона: геометрия, пассажиры, краны. Переход делает ZoneDirector. */
  _switchCar(car, { teleported = false } = {}) {
    const next = car === 1 ? 1 : 0;
    const changed = next !== this.demon.localCar;
    this.demon.setLocalCar(next);
    this.world.setCarVariant(next);
    if (this.zoneDirector) this.world.setZone(this.zoneDirector.zone);
    for (const passenger of this.passengers) {
      passenger.root.visible = next === 0 && this.zoneDirector.zone === 'car';
      passenger.setHighlight(false);
    }
    this.brakeValve.root.visible = next === 1 && this.zoneDirector && this.zoneDirector.zone === 'car';
    if (changed) {
      this.mission.onCarChanged(next);
      this.bus.emit('demon:changedCar', { car: next });
    }
    // Тело в руках переезжает вместе с проводником — иначе оно остаётся
    // в закрытом вагоне, и переноска через тамбур ломается.
    if (teleported && this.demon && this.demon.followLocalPlayer) this.demon.followLocalPlayer();
  }

  _joinByCode(raw) {
    const code = this.network.sanitizeCode(typeof raw === 'string' ? raw : raw && raw.code);
    if (!code || code.length !== CONFIG.network.lobbyCodeLength) {
      this.ui.showToast('КОД ЛОББИ НЕ РАСПОЗНАН.', 'warning', 3600);
      return;
    }
    if (this.state !== STATE.MENU) return;
    if (this.ui.el.joinInput) this.ui.el.joinInput.value = code;
    this.audio.uiConfirm();
    if (this.ui.el.joinForm) {
      this.ui.el.joinForm.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  }

  async _refreshServers() {
    this.ui.setServerList([], { loading: true });
    const ok = await this.directory.start();
    if (ok) this.ui.setServerList(this.directory.snapshot(), { loading: false });
  }

  _syncDirectory() {
    if (!this.session || !this.network.isActive) return;
    const crew = Math.max(1, this.network.getPlayers().length);
    this.directory.setLocal({
      code: this.session.code,
      host: this.store.values.callsign || 'ПРОВОДНИК',
      crew,
      max: CONFIG.network.maxPlayers || 6,
    });
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
    this.demon.setLocalCar(0);
    this.world.setCarVariant(0);
    this.world.setZone('car');
    this.zoneDirector.reset();
    this.brakeValve.root.visible = false;
    for (const passenger of this.passengers) passenger.root.visible = true;
    this.mission.begin();
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
    this._resetMissionSystems();

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
    this._resetMissionSystems();
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
    if (this.state === STATE.PLAYING) {
      // Возврат из магазина: управление и микрофон снова в строю.
      this.player.setEnabled(true);
      if (!this.voiceWatcher.active) this.voiceWatcher.start();
      else this.voiceWatcher.resume();
      return;
    }
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
    // Магазин открыт намеренно: курсор нужен для кнопок, пауза не нужна.
    if (this.ui.shopOpen) return;
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
      return;
    }
    // Магазин закрылся, а курсор не захватился — уходим в обычную паузу.
    if (this.state === STATE.PLAYING) this._enterPause();
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
    this._resetMissionSystems();

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
    this.tickDt = dt;
    this.elapsed += dt;

    if (this.state === STATE.PLAYING) {
      this.player.update(dt, this.elapsed);
      // Пассажир думает после игрока: цель уже сдвинулась в этом кадре.
      this.demon.update(dt, this.elapsed);
      this.voiceWatcher.update(dt);
      const uiEnabled = !this.mission.briefingOpen && !this._switchingCar && !this.player.downed;
      this.ticketInspector.update(dt, this.elapsed, {
        enabled: uiEnabled && this.demon.localCar === 0,
      });
      this.zoneDirector.update(dt, uiEnabled);
      this.brakeDirector.update(dt, this.elapsed, uiEnabled);
      this.inventory.update(dt);
      this.vendingMachine.update(this.elapsed);
      this._updateVending(uiEnabled);
      this._updateDump(uiEnabled);
      this._updateDowned(dt);
      this.mission.update(dt);
    } else if (this.state === STATE.MENU || this.state === STATE.LOBBY) {
      this._updateMenuCamera(this.elapsed);
      // В меню пассажир просто сидит — анимация нужна и здесь.
      this.demon.npc.update(dt, this.elapsed);
    }
    if (this.remotePlayers.previewActive) this.remotePlayers.updatePreview(this.elapsed);

    // Дверь в тамбур разъезжается, когда игрок подходит с любой стороны.
    if (this.world && this.world.setDoorOpen) {
      const z = this.player.position.z;
      const zone = this.zoneDirector ? this.zoneDirector.zone : 'car';
      this.world.setDoorOpen(zone === 'vestibule' ? z > -18.2 : z < -11.4);
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

  