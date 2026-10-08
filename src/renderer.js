const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

let settings = null;
let hotkeyErrors = [];
let activePage = 'library';
let saveTimer = null;
let recordingTarget = null;
let openMenuId = null;

const colors = ['violet', 'cyan', 'amber', 'rose', 'lime'];
const playIcon = '<svg viewBox="0 0 24 24"><path d="m8 5 11 7-11 7V5Z"/></svg>';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
}

function displayHotkey(accelerator, empty = 'Not set') {
  if (!accelerator) return empty;
  return accelerator
    .replace('CommandOrControl', 'Ctrl')
    .replaceAll('+', ' + ')
    .replace('num', 'Num ');
}

function toast(message, type = '') {
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.textContent = message;
  $('#toastStack').append(element);
  setTimeout(() => element.remove(), 3200);
}

function scheduleSave(immediate = false) {
  clearTimeout(saveTimer);
  const save = async () => {
    try {
      const result = await window.micdrop.saveSettings(settings);
      settings = result.settings;
      hotkeyErrors = result.hotkeyErrors;
      renderHotkeyState();
    } catch (error) {
      toast(`Could not save settings: ${error.message}`, 'error');
    }
  };
  if (immediate) save();
  else saveTimer = setTimeout(save, 180);
}

class AudioEngine {
  constructor() {
    this.context = null;
    this.destination = null;
    this.outputElement = null;
    this.monitorDestination = null;
    this.monitorElement = null;
    this.micStream = null;
    this.micSource = null;
    this.micBus = null;
    this.soundBus = null;
    this.analyser = null;
    this.bufferCache = new Map();
    this.playCounts = new Map();
    this.state = 'offline';
    this.meterFrame = null;
    this.recoveryPromise = null;
    this.recoveryTimer = null;
    this.recoveryFailures = 0;
    this.lastOutputTime = null;
    this.lastMonitorTime = null;
    this.healthTimer = setInterval(() => this.checkHealth(), 2500);
  }

  async initialize(withMic = false) {
    if (!this.context) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.context = new AudioContextClass({ latencyHint: 'interactive' });
      this.destination = this.context.createMediaStreamDestination();
      this.monitorDestination = this.context.createMediaStreamDestination();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.72;
      this.micBus = this.context.createGain();
      this.soundBus = this.context.createGain();
      this.micBus.connect(this.analyser);
      this.soundBus.connect(this.analyser);
      this.soundBus.connect(this.monitorDestination);
      this.analyser.connect(this.destination);

      this.outputElement = new Audio();
      this.outputElement.autoplay = true;
      this.outputElement.srcObject = this.destination.stream;
      this.monitorElement = new Audio();
      this.monitorElement.autoplay = true;
      this.monitorElement.srcObject = this.monitorDestination.stream;
      this.context.addEventListener('statechange', () => {
        if (this.context.state !== 'running') this.scheduleRecovery();
      });
      for (const element of [this.outputElement, this.monitorElement]) {
        for (const eventName of ['stalled', 'error', 'emptied']) {
          element.addEventListener(eventName, () => this.scheduleRecovery());
        }
      }
    }

    if (this.context.state === 'suspended') await this.context.resume();
    await this.setOutput(settings.outputDeviceId, false);
    await this.setMonitorOutput(settings.monitorDeviceId, false);
    this.applyGains();
    await this.outputElement.play();
    await this.monitorElement.play();

    if (withMic && !settings.micMuted) await this.connectMic();
    this.setState('online');
    this.recoveryFailures = 0;
    this.drawMeter();
  }

  scheduleRecovery(refreshSinks = false) {
    if (!this.context) return;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = setTimeout(() => this.recover(true, refreshSinks), 250);
  }

  async checkHealth() {
    if (!this.context || this.context.state === 'closed' || this.recoveryPromise) return;
    const micTrack = this.micStream?.getAudioTracks()[0];
    const micHealthy = settings.micMuted || (micTrack && micTrack.readyState === 'live' && !micTrack.muted);
    const outputAdvancing = this.lastOutputTime === null || this.outputElement.currentTime > this.lastOutputTime + 0.05;
    const monitorAdvancing = this.lastMonitorTime === null || this.monitorElement.currentTime > this.lastMonitorTime + 0.05;
    const outputHealthy = this.context.state === 'running' &&
      this.outputElement && !this.outputElement.paused && !this.outputElement.ended && !this.outputElement.error && outputAdvancing;
    const monitorHealthy = this.monitorElement && !this.monitorElement.paused && !this.monitorElement.ended && !this.monitorElement.error && monitorAdvancing;
    this.lastOutputTime = this.outputElement.currentTime;
    this.lastMonitorTime = this.monitorElement.currentTime;
    if (!micHealthy || !outputHealthy || !monitorHealthy) {
      await this.recover(true, true);
    }
  }

  async recover(silent = true, refreshSinks = false) {
    if (!this.context || this.context.state === 'closed') return;
    if (this.recoveryPromise) return this.recoveryPromise;
    this.setState('recovering');
    this.recoveryPromise = (async () => {
      try {
        if (this.context.state !== 'running') await this.context.resume();
        if (refreshSinks) {
          await this.setOutput(settings.outputDeviceId, false);
          await this.setMonitorOutput(settings.monitorDeviceId, false);
        }
        const micTrack = this.micStream?.getAudioTracks()[0];
        if (!settings.micMuted && (!micTrack || micTrack.readyState !== 'live')) await this.connectMic();
        this.applyGains();
        await this.outputElement.play();
        await this.monitorElement.play();
        this.lastOutputTime = null;
        this.lastMonitorTime = null;
        this.recoveryFailures = 0;
        this.setState('online');
      } catch (error) {
        this.recoveryFailures += 1;
        this.setState('error');
        if (!silent || this.recoveryFailures === 3) {
          toast(`Audio connection needs attention: ${error.message}`, 'error');
        }
      } finally {
        this.recoveryPromise = null;
      }
    })();
    return this.recoveryPromise;
  }

  async connectMic() {
    this.disconnectMic();
    const deviceId = settings.inputDeviceId || 'default';
    const audio = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1
    };
    if (deviceId !== 'default') audio.deviceId = { exact: deviceId };

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      this.micSource = this.context.createMediaStreamSource(this.micStream);
      this.micSource.connect(this.micBus);
      this.micStream.getAudioTracks()[0]?.addEventListener('mute', () => this.scheduleRecovery(true));
      this.applyGains();
    } catch (error) {
      this.setState('error');
      throw new Error(`Microphone unavailable: ${error.message}`);
    }
  }

  disconnectMic() {
    try { this.micSource?.disconnect(); } catch { /* already disconnected */ }
    this.micStream?.getTracks().forEach((track) => track.stop());
    this.micSource = null;
    this.micStream = null;
  }

  async setOutput(deviceId, announce = true) {
    if (!this.outputElement) return;
    if (typeof this.outputElement.setSinkId !== 'function') {
      if (deviceId !== 'default') throw new Error('Audio output selection is not supported on this Windows build.');
      return;
    }
    try {
      await this.outputElement.setSinkId(deviceId || 'default');
      if (announce) toast('Mixed output device updated.', 'success');
    } catch (error) {
      throw new Error(`Could not use that output device: ${error.message}`);
    }
  }

  async setMonitorOutput(deviceId, announce = true) {
    if (!this.monitorElement) return;
    if (typeof this.monitorElement.setSinkId !== 'function') {
      if (deviceId !== 'default') throw new Error('Audio output selection is not supported on this Windows build.');
      return;
    }
    try {
      await this.monitorElement.setSinkId(deviceId || 'default');
      if (announce) toast('Headphone monitoring output updated.', 'success');
    } catch (error) {
      throw new Error(`Could not use that monitoring device: ${error.message}`);
    }
  }

  applyGains() {
    if (!this.context) return;
    const now = this.context.currentTime;
    this.micBus.gain.setTargetAtTime(settings.micMuted ? 0 : Number(settings.micGain), now, 0.012);
    this.soundBus.gain.setTargetAtTime(Number(settings.soundGain), now, 0.012);
    if (this.monitorElement) this.monitorElement.muted = !settings.monitorEnabled;
  }

  async play(sound) {
    try {
      if (!this.context) await this.initialize(false);
      if (this.context.state === 'suspended') await this.context.resume();

      let buffer = this.bufferCache.get(sound.id);
      if (!buffer) {
        const payload = await window.micdrop.readAudio(sound.path);
        const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
        const copied = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        buffer = await this.context.decodeAudioData(copied);
        this.bufferCache.set(sound.id, buffer);
      }

      const source = this.context.createBufferSource();
      const clipGain = this.context.createGain();
      source.buffer = buffer;
      clipGain.gain.value = Number(sound.volume ?? 1);
      source.connect(clipGain);
      clipGain.connect(this.soundBus);
      source.start();

      const count = (this.playCounts.get(sound.id) || 0) + 1;
      this.playCounts.set(sound.id, count);
      setPlaying(sound.id, true);
      source.onended = () => {
        source.disconnect();
        clipGain.disconnect();
        const remaining = Math.max(0, (this.playCounts.get(sound.id) || 1) - 1);
        this.playCounts.set(sound.id, remaining);
        if (!remaining) setPlaying(sound.id, false);
      };
    } catch (error) {
      toast(`Could not play “${sound.name}”: ${error.message}`, 'error');
    }
  }

  setState(state) {
    this.state = state;
    renderEngineState();
  }

  drawMeter() {
    cancelAnimationFrame(this.meterFrame);
    const draw = () => {
      const canvas = $('#levelMeter');
      if (!canvas || !this.analyser) return;
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(rect.width * ratio)) {
        canvas.width = Math.round(rect.width * ratio);
        canvas.height = Math.round(rect.height * ratio);
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const data = new Uint8Array(this.analyser.fftSize);
      this.analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const value of data) {
        const sample = (value - 128) / 128;
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / data.length);
      const db = rms ? Math.max(-60, 20 * Math.log10(rms)) : -60;
      const level = Math.max(0, Math.min(1, (db + 60) / 60));
      ctx.clearRect(0, 0, rect.width, rect.height);
      const segments = 30;
      const gap = 3;
      const width = (rect.width - gap * (segments + 1)) / segments;
      for (let index = 0; index < segments; index++) {
        const active = index / segments < level;
        const position = index / segments;
        ctx.fillStyle = !active ? '#18212c' : position > .82 ? '#fb7185' : position > .65 ? '#f59e0b' : '#8b5cf6';
        ctx.fillRect(gap + index * (width + gap), 7, width, 20);
      }
      $('#levelDb').textContent = rms ? `${Math.round(db)} dB` : '−∞ dB';
      this.meterFrame = requestAnimationFrame(draw);
    };
    draw();
  }
}

const engine = new AudioEngine();

function setPlaying(id, playing) {
  $$(`[data-sound-id="${CSS.escape(id)}"]`).forEach((element) => element.classList.toggle('playing', playing));
}

function renderEngineState() {
  const online = engine.state === 'online';
  const error = engine.state === 'error';
  const recovering = engine.state === 'recovering';
  const badge = $('#engineBadge');
  badge.className = `engine-badge ${online ? 'online' : error ? 'error' : recovering ? 'recovering' : 'offline'}`;
  $('b', badge).textContent = online ? 'Engine online' : error ? 'Engine needs attention' : recovering ? 'Reconnecting…' : 'Engine offline';
  $('#routingCard').classList.toggle('online', online);
  $('#sidebarEngineStatus').textContent = online ? (settings.micMuted ? 'Clips only · mic off' : 'Mic + clips live') : recovering ? 'Reconnecting…' : 'Not running';
  $('.overlay-status').classList.toggle('online', online);
  $('#overlayEngineText').textContent = online ? (settings.micMuted ? 'Clips only' : 'Live') : recovering ? 'Reconnecting' : 'Offline';
  $('#startEngineButton').textContent = online ? 'Restart engine' : 'Start engine';
}

function renderLibrary() {
  const query = $('#searchInput').value.trim().toLowerCase();
  const filtered = settings.sounds.filter((sound) => sound.name.toLowerCase().includes(query));
  $('#soundCount').textContent = settings.sounds.length;
  const grid = $('#soundGrid');
  grid.classList.toggle('hidden', settings.sounds.length === 0 && !query);
  grid.innerHTML = filtered.map((sound, index) => `
    <article class="sound-card" data-sound-id="${sound.id}" data-color="${sound.color || colors[index % colors.length]}">
      <div class="sound-card-top">
        <button class="play-button" data-action="play" title="Play ${escapeHtml(sound.name)}">${playIcon}</button>
        <button class="card-menu" data-action="menu" aria-label="Sound options">•••</button>
      </div>
      <div class="sound-name" title="${escapeHtml(sound.name)}">${escapeHtml(sound.name)}</div>
      <div class="sound-meta">
        <span class="sound-key ${sound.hotkey ? '' : 'unset'}">${escapeHtml(displayHotkey(sound.hotkey, 'NO HOTKEY'))}</span>
        <span class="volume-mini">${Math.round((sound.volume ?? 1) * 100)}%</span>
      </div>
      ${openMenuId === sound.id ? `<div class="card-popover">
        <button data-action="rename">Rename</button>
        <button data-action="assign">Assign hotkey</button>
        <button data-action="volume">Set volume</button>
        <button class="danger" data-action="remove">Remove sound</button>
      </div>` : ''}
    </article>`).join('');
}

function renderOverlay() {
  const query = $('#overlaySearch').value.trim().toLowerCase();
  const filtered = settings.sounds.filter((sound) => sound.name.toLowerCase().includes(query));
  $('#overlayGrid').innerHTML = filtered.map((sound, index) => `
    <button class="overlay-card" data-sound-id="${sound.id}" data-color="${sound.color || colors[index % colors.length]}">
      <div class="overlay-card-head"><span class="overlay-play">${playIcon}</span><span class="sound-key ${sound.hotkey ? '' : 'unset'}">${escapeHtml(displayHotkey(sound.hotkey, 'CLICK'))}</span></div>
      <h3>${escapeHtml(sound.name)}</h3>
    </button>`).join('');
  $('#overlayGrid').classList.toggle('hidden', filtered.length === 0);
  $('#overlayEmpty').classList.toggle('hidden', filtered.length > 0);
}

function renderHotkeys() {
  $('#overlayHotkeyButton').textContent = displayHotkey(settings.overlayHotkey);
  const list = $('#hotkeyList');
  if (!settings.sounds.length) {
    list.innerHTML = '<div class="hotkey-empty">Add sounds to the library, then assign shortcuts here.</div>';
    return;
  }
  list.innerHTML = settings.sounds.map((sound, index) => `
    <div class="hotkey-row" data-sound-id="${sound.id}" style="--accent: var(--${sound.color || colors[index % colors.length]})">
      <div class="hotkey-description"><div class="sound-dot"></div><div><h3>${escapeHtml(sound.name)}</h3><p>Play this clip</p></div></div>
      <button class="key-recorder ${hotkeyErrors.some((item) => item.startsWith(`${sound.name}:`)) ? 'conflict' : ''}" data-record-sound="${sound.id}">${escapeHtml(displayHotkey(sound.hotkey))}</button>
    </div>`).join('');
}

function renderHotkeyState() {
  const notice = $('#hotkeyNotice');
  notice.classList.toggle('hidden', hotkeyErrors.length === 0);
  $('#hotkeyNoticeText').textContent = hotkeyErrors.length ? `${hotkeyErrors.length} shortcut${hotkeyErrors.length === 1 ? '' : 's'} could not be registered because another app is using them.` : '';
  renderHotkeys();
}

function renderAll() {
  renderLibrary();
  renderOverlay();
  renderHotkeyState();
  $('#micGain').value = Math.round(settings.micGain * 100);
  $('#soundGain').value = Math.round(settings.soundGain * 100);
  $('#micGainValue').textContent = `${Math.round(settings.micGain * 100)}%`;
  $('#soundGainValue').textContent = `${Math.round(settings.soundGain * 100)}%`;
  renderMicToggle();
  renderMonitorToggle();
  renderEngineState();
}

function switchPage(page) {
  activePage = page;
  $$('.page').forEach((element) => element.classList.toggle('active', element.id === `page-${page}`));
  $$('.nav-item').forEach((element) => element.classList.toggle('active', element.dataset.page === page));
}

function applyImportResult(result) {
  const imported = Array.isArray(result) ? result : result?.imported || [];
  const skipped = Array.isArray(result) ? 0 : result?.skipped || 0;

  if (imported.length) {
    settings.sounds.push(...imported);
    renderAll();
    const skippedText = skipped ? ` ${skipped} unsupported or unreadable file${skipped === 1 ? ' was' : 's were'} skipped.` : '';
    toast(`Added ${imported.length} sound${imported.length === 1 ? '' : 's'}.${skippedText}`, skipped ? '' : 'success');
  } else if (skipped) {
    toast(`No sounds were added. ${skipped} file${skipped === 1 ? ' is' : 's are'} unsupported or unreadable.`, 'error');
  }
}

async function importSounds() {
  try {
    applyImportResult(await window.micdrop.importSounds());
  } catch (error) {
    toast(`Import failed: ${error.message}`, 'error');
  }
}

async function importDroppedSounds(files) {
  if (!files.length) return;
  try {
    applyImportResult(await window.micdrop.importDroppedSounds(files));
  } catch (error) {
    toast(`Drop failed: ${error.message}`, 'error');
  }
}

function getSoundFromElement(element) {
  const card = element.closest('[data-sound-id]');
  return settings.sounds.find((sound) => sound.id === card?.dataset.soundId);
}

function showDialog({ title, text, inputValue = null, confirmText = 'Save', danger = false }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'dialog-backdrop';
    backdrop.innerHTML = `<form class="dialog" method="dialog">
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(text)}</p>
      ${inputValue !== null ? `<input class="dialog-input" value="${escapeHtml(inputValue)}" maxlength="80">` : ''}
      <div class="dialog-actions"><button value="cancel" class="ghost-button">Cancel</button><button value="confirm" class="primary-button ${danger ? 'danger-button' : ''}">${escapeHtml(confirmText)}</button></div>
    </form>`;
    document.body.append(backdrop);
    const form = $('.dialog', backdrop);
    const input = $('.dialog-input', backdrop);
    if (input) { input.focus(); input.select(); }
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const submitter = event.submitter?.value;
      backdrop.remove();
      resolve(submitter === 'confirm' ? (input ? input.value.trim() : true) : null);
    });
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) { backdrop.remove(); resolve(null); }
    });
  });
}

function showVolumeDialog(sound) {
  return new Promise((resolve) => {
    const current = Math.round((sound.volume ?? 1) * 100);
    const backdrop = document.createElement('div');
    backdrop.className = 'dialog-backdrop';
    backdrop.innerHTML = `<form class="dialog volume-dialog">
      <h2>Clip volume</h2><p>Adjust “${escapeHtml(sound.name)}” relative to the master soundboard level.</p>
      <label class="slider-label"><span>Volume</span><output>${current}%</output></label>
      <input class="range" type="range" min="0" max="150" value="${current}">
      <div class="dialog-actions"><button value="cancel" class="ghost-button">Cancel</button><button value="confirm" class="primary-button">Save</button></div>
    </form>`;
    document.body.append(backdrop);
    const range = $('.range', backdrop);
    range.addEventListener('input', () => $('output', backdrop).textContent = `${range.value}%`);
    $('form', backdrop).addEventListener('submit', (event) => {
      event.preventDefault();
      const confirmed = event.submitter?.value === 'confirm';
      backdrop.remove();
      resolve(confirmed ? Number(range.value) / 100 : null);
    });
  });
}

function renderMicToggle() {
  const button = $('#micMuteToggle');
  button.classList.toggle('muted', settings.micMuted);
  button.setAttribute('aria-checked', String(!settings.micMuted));
  $('b', button).textContent = settings.micMuted ? 'Mic off' : 'Mic on';
}

function renderMonitorToggle() {
  const button = $('#monitorToggle');
  button.classList.toggle('muted', !settings.monitorEnabled);
  button.setAttribute('aria-checked', String(settings.monitorEnabled));
  $('b', button).textContent = settings.monitorEnabled ? 'Monitor on' : 'Monitor off';
  if (engine.monitorElement) engine.monitorElement.muted = !settings.monitorEnabled;
  renderRoutingWarnings();
}

function renderRoutingWarnings() {
  $('#feedbackWarning').classList.toggle('hidden', settings.outputDeviceId !== 'default' || settings.micMuted);
  const duplicate = settings.monitorEnabled && settings.outputDeviceId === settings.monitorDeviceId;
  $('#duplicateOutputWarning').classList.toggle('hidden', !duplicate);
}

function deviceIsAvailable(devices, deviceId) {
  return !deviceId || deviceId === 'default' || devices.some((device) => device.deviceId === deviceId);
}

function findCableOutput(outputs) {
  return outputs.find((device) => /^CABLE Input\b/i.test(device.label || ''));
}

async function refreshDevices(requestPermission = false, { autoConfigure = false, announce = requestPermission } = {}) {
  let temporaryStream = null;
  let permissionError = null;
  try {
    if (requestPermission) {
      try {
        temporaryStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        permissionError = error;
      }
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((item) => item.kind === 'audioinput');
    const outputs = devices.filter((item) => item.kind === 'audiooutput');
    let settingsChanged = false;

    if (autoConfigure) {
      const cableOutput = findCableOutput(outputs);
      const outputAvailable = deviceIsAvailable(outputs, settings.outputDeviceId);

      if (cableOutput && (!settings.routingInitialized || !outputAvailable)) {
        settings.outputDeviceId = cableOutput.deviceId;
        settings.routingInitialized = true;
        settingsChanged = true;
      } else if (!outputAvailable) {
        settings.outputDeviceId = 'default';
        settings.routingInitialized = false;
        settings.micMuted = true;
        settingsChanged = true;
      }

      if (!deviceIsAvailable(inputs, settings.inputDeviceId)) {
        settings.inputDeviceId = 'default';
        settings.micMuted = true;
        settingsChanged = true;
      }

      if (!deviceIsAvailable(outputs, settings.monitorDeviceId)) {
        settings.monitorDeviceId = 'default';
        settingsChanged = true;
      }

      if (settingsChanged) {
        if (settings.micMuted && engine.context) engine.disconnectMic();
        const result = await window.micdrop.saveSettings(settings);
        settings = result.settings;
        hotkeyErrors = result.hotkeyErrors;
        renderHotkeyState();
        renderMicToggle();
      }
    }

    fillDeviceSelect($('#inputDevice'), inputs, settings.inputDeviceId, 'Default microphone', 'Microphone');
    fillDeviceSelect($('#outputDevice'), outputs, settings.outputDeviceId, 'Default speakers', 'Output');
    fillDeviceSelect($('#monitorDevice'), outputs, settings.monitorDeviceId, 'Default speakers / headphones', 'Output');
    renderRoutingWarnings();

    if (announce && permissionError) toast(`Devices refreshed, but microphone permission was unavailable: ${permissionError.message}`, 'error');
    else if (announce) toast(`Found ${inputs.length} input and ${outputs.length} output devices.`, 'success');

    return { inputs, outputs };
  } catch (error) {
    toast(`Could not scan audio devices: ${error.message}`, 'error');
    return { inputs: [], outputs: [] };
  } finally {
    temporaryStream?.getTracks().forEach((track) => track.stop());
  }
}

function fillDeviceSelect(select, devices, selectedId, defaultLabel, fallbackLabel) {
  const seen = new Set();
  const options = [{ deviceId: 'default', label: defaultLabel }];
  for (const device of devices) {
    if (!device.deviceId || device.deviceId === 'default' || seen.has(device.deviceId)) continue;
    seen.add(device.deviceId);
    options.push({ deviceId: device.deviceId, label: device.label || `${fallbackLabel} ${options.length}` });
  }
  if (selectedId && !options.some((option) => option.deviceId === selectedId)) {
    options.push({ deviceId: selectedId, label: 'Previously selected device (currently unavailable)' });
  }
  select.innerHTML = options.map((option) => `<option value="${escapeHtml(option.deviceId)}">${escapeHtml(option.label)}</option>`).join('');
  select.value = selectedId || 'default';
}

function normalizeHotkey(event) {
  const key = event.key;
  if (key === 'Escape') return { action: 'cancel' };
  if (key === 'Backspace' || key === 'Delete') return { action: 'clear' };
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return { action: 'wait' };
  const modifiers = [];
  if (event.ctrlKey) modifiers.push('CommandOrControl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push('Super');

  let mainKey = key;
  if (key === ' ') mainKey = 'Space';
  else if (key === 'ArrowUp') mainKey = 'Up';
  else if (key === 'ArrowDown') mainKey = 'Down';
  else if (key === 'ArrowLeft') mainKey = 'Left';
  else if (key === 'ArrowRight') mainKey = 'Right';
  else if (key.length === 1) mainKey = key.toUpperCase();
  else if (/^F\d{1,2}$/i.test(key)) mainKey = key.toUpperCase();
  else if (!['Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Tab'].includes(key)) return { action: 'invalid' };

  if (!modifiers.length && !/^F\d{1,2}$/i.test(mainKey)) return { action: 'invalid' };
  return { action: 'set', value: [...new Set(modifiers), mainKey].join('+') };
}

function beginRecording(target, button) {
  recordingTarget = { target, button };
  $$('.key-recorder').forEach((item) => item.classList.remove('recording'));
  button.classList.add('recording');
  button.textContent = 'Press shortcut…';
}

function finishRecording(value = undefined) {
  if (!recordingTarget) return;
  const { target } = recordingTarget;
  if (value !== undefined) {
    if (target === 'overlay') settings.overlayHotkey = value;
    else {
      const sound = settings.sounds.find((item) => item.id === target);
      if (sound) sound.hotkey = value;
    }
    scheduleSave(true);
  }
  recordingTarget = null;
  renderHotkeys();
}

document.addEventListener('keydown', (event) => {
  if (recordingTarget) {
    event.preventDefault();
    event.stopPropagation();
    const result = normalizeHotkey(event);
    if (result.action === 'set') finishRecording(result.value);
    else if (result.action === 'clear') finishRecording('');
    else if (result.action === 'cancel') finishRecording();
    else if (result.action === 'invalid') toast('Use a modifier key (Ctrl, Alt, or Shift), or choose an F-key.', 'error');
    return;
  }
  if (event.key === 'Escape' && document.body.classList.contains('overlay-mode')) {
    window.micdrop.windowAction('hide');
  }
});

document.addEventListener('click', async (event) => {
  const pageButton = event.target.closest('[data-page], [data-page-link]');
  if (pageButton) switchPage(pageButton.dataset.page || pageButton.dataset.pageLink);

  const external = event.target.closest('[data-external]');
  if (external) window.micdrop.openExternal(external.dataset.external);

  const libraryAction = event.target.closest('#soundGrid [data-action]');
  if (libraryAction) {
    const sound = getSoundFromElement(libraryAction);
    if (!sound) return;
    const action = libraryAction.dataset.action;
    if (action === 'play') engine.play(sound);
    if (action === 'menu') {
      openMenuId = openMenuId === sound.id ? null : sound.id;
      renderLibrary();
    }
    if (action === 'rename') {
      openMenuId = null;
      const name = await showDialog({ title: 'Rename sound', text: 'Choose a short name that is easy to spot in the overlay.', inputValue: sound.name });
      if (name) { sound.name = name; scheduleSave(true); renderAll(); }
    }
    if (action === 'assign') {
      openMenuId = null;
      switchPage('hotkeys');
      renderHotkeys();
      const button = $(`[data-record-sound="${CSS.escape(sound.id)}"]`);
      if (button) beginRecording(sound.id, button);
    }
    if (action === 'volume') {
      openMenuId = null;
      const volume = await showVolumeDialog(sound);
      if (volume !== null) { sound.volume = volume; scheduleSave(); renderLibrary(); }
    }
    if (action === 'remove') {
      openMenuId = null;
      const confirmed = await showDialog({ title: 'Remove sound?', text: `“${sound.name}” will be removed from MicDrop’s library.`, confirmText: 'Remove', danger: true });
      if (confirmed) {
        await window.micdrop.removeSound(sound.id);
        settings.sounds = settings.sounds.filter((item) => item.id !== sound.id);
        engine.bufferCache.delete(sound.id);
        renderAll();
        toast('Sound removed.');
      } else renderLibrary();
    }
    return;
  }

  const overlayCard = event.target.closest('.overlay-card');
  if (overlayCard) {
    const sound = settings.sounds.find((item) => item.id === overlayCard.dataset.soundId);
    if (sound) engine.play(sound);
  }

  const recorder = event.target.closest('[data-record-sound]');
  if (recorder) beginRecording(recorder.dataset.recordSound, recorder);

  if (!event.target.closest('.sound-card')) {
    openMenuId = null;
    if (activePage === 'library') renderLibrary();
  }
});

const libraryDropZone = $('#libraryDropZone');
libraryDropZone.addEventListener('click', importSounds);
libraryDropZone.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  importSounds();
});
libraryDropZone.addEventListener('dragenter', (event) => {
  if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
  event.preventDefault();
  libraryDropZone.classList.add('drag-active');
});
libraryDropZone.addEventListener('dragover', (event) => {
  if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  libraryDropZone.classList.add('drag-active');
});
libraryDropZone.addEventListener('dragleave', (event) => {
  if (!libraryDropZone.contains(event.relatedTarget)) libraryDropZone.classList.remove('drag-active');
});
libraryDropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  libraryDropZone.classList.remove('drag-active');
  importDroppedSounds(event.dataTransfer?.files || []);
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());
$('#minimizeButton').addEventListener('click', () => window.micdrop.windowAction('minimize'));
$('#closeButton').addEventListener('click', () => window.micdrop.windowAction('close'));
$('#hideOverlayButton').addEventListener('click', () => window.micdrop.windowAction('hide'));
$('#leaveOverlayButton').addEventListener('click', () => window.micdrop.windowAction('exit-overlay'));
$('#searchInput').addEventListener('input', renderLibrary);
$('#overlaySearch').addEventListener('input', renderOverlay);
$('#routingCard').addEventListener('click', () => switchPage('audio'));
$('#openSoundSettingsButton').addEventListener('click', () => window.micdrop.openExternal('ms-settings:sound'));
$('#refreshDevicesButton').addEventListener('click', () => refreshDevices(true, { autoConfigure: true }));
$('#overlayHotkeyButton').addEventListener('click', (event) => beginRecording('overlay', event.currentTarget));

$('#inputDevice').addEventListener('change', async (event) => {
  settings.inputDeviceId = event.target.value;
  scheduleSave();
  if (engine.context && !settings.micMuted) {
    try { await engine.connectMic(); toast('Microphone input updated.', 'success'); }
    catch (error) { toast(error.message, 'error'); }
  }
});

$('#outputDevice').addEventListener('change', async (event) => {
  settings.outputDeviceId = event.target.value;
  settings.routingInitialized = true;
  scheduleSave();
  renderRoutingWarnings();
  if (engine.context) {
    try { await engine.setOutput(event.target.value); }
    catch (error) { toast(error.message, 'error'); }
  }
});

$('#monitorDevice').addEventListener('change', async (event) => {
  settings.monitorDeviceId = event.target.value;
  scheduleSave();
  renderRoutingWarnings();
  if (engine.context) {
    try { await engine.setMonitorOutput(event.target.value); }
    catch (error) { toast(error.message, 'error'); }
  }
});

$('#monitorToggle').addEventListener('click', () => {
  settings.monitorEnabled = !settings.monitorEnabled;
  engine.applyGains();
  renderMonitorToggle();
  scheduleSave();
});

$('#micGain').addEventListener('input', (event) => {
  settings.micGain = Number(event.target.value) / 100;
  $('#micGainValue').textContent = `${event.target.value}%`;
  engine.applyGains();
  scheduleSave();
});

$('#soundGain').addEventListener('input', (event) => {
  settings.soundGain = Number(event.target.value) / 100;
  $('#soundGainValue').textContent = `${event.target.value}%`;
  engine.applyGains();
  scheduleSave();
});

$('#micMuteToggle').addEventListener('click', async () => {
    settings.micMuted = !settings.micMuted;
    renderMicToggle();
    renderRoutingWarnings();
  renderEngineState();
  scheduleSave();
  try {
    if (!settings.micMuted) {
      if (!engine.context) await engine.initialize(false);
      await engine.connectMic();
      engine.setState('online');
      toast('Microphone is now included in the mix.', 'success');
    } else {
      engine.disconnectMic();
      engine.applyGains();
    }
  } catch (error) {
    settings.micMuted = true;
    renderMicToggle();
    scheduleSave();
    toast(error.message, 'error');
  }
});

async function startAudioEngine({ announceSuccess = false, automatic = false } = {}) {
  try {
    engine.setState('offline');
    await engine.initialize(!settings.micMuted);
    if (!settings.micMuted && !engine.micStream) await engine.connectMic();
    if (announceSuccess) {
      toast(settings.micMuted ? 'Audio engine started. Mic passthrough is off.' : 'Audio engine started. Mic and clips are live.', 'success');
    }
    return true;
  } catch (error) {
    engine.setState('error');
    toast(automatic ? `Audio engine could not start automatically: ${error.message}` : error.message, 'error');
    return false;
  }
}

$('#startEngineButton').addEventListener('click', async () => {
  await startAudioEngine({ announceSuccess: true });
});

window.micdrop.onPlaySound((id) => {
  const sound = settings?.sounds.find((item) => item.id === id);
  if (sound) engine.play(sound);
});

window.micdrop.onOverlayMode((enabled) => {
  document.body.classList.toggle('overlay-mode', enabled);
  if (enabled) {
    $('#overlaySearch').value = '';
    renderOverlay();
    setTimeout(() => $('#overlaySearch').focus(), 80);
  }
});

window.micdrop.onHotkeyStatus((errors) => {
  hotkeyErrors = errors;
  renderHotkeyState();
});

navigator.mediaDevices?.addEventListener('devicechange', async () => {
  await refreshDevices(false, { autoConfigure: true });
  engine.scheduleRecovery(true);
});

async function initialize() {
  const result = await window.micdrop.getSettings();
  settings = result.settings;
  hotkeyErrors = result.hotkeyErrors;
  renderAll();
  await refreshDevices(!settings.routingInitialized, { autoConfigure: true, announce: false });
  await startAudioEngine({ automatic: true });
}

initialize().catch((error) => toast(`MicDrop could not start: ${error.message}`, 'error'));
