// ---- Constants (must match firmware mlr.h) ----
const MLR_NUM_TRACKS = 6;
const MLR_MAGIC = 0x4D4C5234;  // 'MLR4'
const MLR_HEADER_SIZE = 4096;
const MLR_TRACK_FLASH_SIZE = 312 * 1024;
const MLR_AUDIO_SIZE = MLR_TRACK_FLASH_SIZE - MLR_HEADER_SIZE;
const MLR_MAX_SAMPLES = MLR_AUDIO_SIZE * 2;
const MLR_KEYFRAME_INTERVAL = 1024;
const MLR_MAX_KEYFRAMES = Math.floor(MLR_MAX_SAMPLES / MLR_KEYFRAME_INTERVAL) + 1;
const MLR_KEYFRAME_OFFSET = 20;  // bytes before keyframes[] in header

function getMaxSamples() {
  return MLR_MAX_SAMPLES;
}

const SPEEDS = [
  { name: '0.25×', ratio: 0.25,  frac: 64,   shift: -3 },
  { name: '0.5×',  ratio: 0.5,   frac: 128,  shift: -2 },
  { name: '0.67×', ratio: 171/256, frac: 171, shift: -1 },
  { name: '1×',    ratio: 1.0,   frac: 256,  shift:  0 },
];
function speedShiftToRatio(shift) {
  const clamped = Math.max(-3, Math.min(3, shift | 0));
  switch (clamped) {
    case -3: return 64 / 256;
    case -2: return 128 / 256;
    case -1: return 171 / 256;
    case  1: return 384 / 256;
    case  2: return 512 / 256;
    case  3: return 1024 / 256;
    default: return 1.0;
  }
}
function speedShiftToLabel(shift) {
  const clamped = Math.max(-3, Math.min(3, shift | 0));
  switch (clamped) {
    case -3: return '0.25×';
    case -2: return '0.5×';
    case -1: return '0.67×';
    case  1: return '1.5×';
    case  2: return '2×';
    case  3: return '4×';
    default: return '1×';
  }
}
function speedShiftToIdx(shift) {
  if (shift > 0) shift = 0;  // clamp faster-than-1x to 1x
  return Math.max(0, Math.min(SPEEDS.length - 1, shift + 3));
}
/** Recording target rate follows the selected varispeed directly. */
function recTargetRate(speed) {
  return 48000 * speed.ratio;
}

// ---- IMA-ADPCM encoder (matches firmware adpcm.h) ----
const IMA_STEP_TABLE = [
  7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,
  50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,
  337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,
  1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,
  6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,
  22385,24623,27086,29794,32767
];
const IMA_INDEX_TABLE = [-1,-1,-1,-1,2,4,6,8,-1,-1,-1,-1,2,4,6,8];

function adpcmEncode(samples16) {
  const nSamples = samples16.length;
  const adpcmBytes = new Uint8Array(Math.ceil(nSamples / 2));
  const keyframes = [];
  let predictor = 0, stepIndex = 0;

  for (let i = 0; i < nSamples; i++) {
    // Save keyframe
    if ((i % MLR_KEYFRAME_INTERVAL) === 0) {
      keyframes.push({ predictor, stepIndex });
    }

    const sample = samples16[i];
    const step = IMA_STEP_TABLE[stepIndex];
    let diff = sample - predictor;
    let nybble = 0;
    if (diff < 0) { nybble = 8; diff = -diff; }
    if (diff >= step)     { nybble |= 4; diff -= step; }
    if (diff >= step/2)   { nybble |= 2; diff -= step/2; }
    if (diff >= step/4)   { nybble |= 1; }

    // Reconstruct
    let delta = step >> 3;
    if (nybble & 4) delta += step;
    if (nybble & 2) delta += step >> 1;
    if (nybble & 1) delta += step >> 2;
    predictor += (nybble & 8) ? -delta : delta;
    if (predictor > 32767) predictor = 32767;
    if (predictor < -32768) predictor = -32768;
    stepIndex += IMA_INDEX_TABLE[nybble & 0xF];
    if (stepIndex < 0) stepIndex = 0;
    if (stepIndex > 88) stepIndex = 88;

    // Pack nybbles: low nybble first, then high
    const byteIdx = i >> 1;
    if ((i & 1) === 0) {
      adpcmBytes[byteIdx] = nybble & 0xF;
    } else {
      adpcmBytes[byteIdx] |= (nybble & 0xF) << 4;
    }
  }

  return { adpcmBytes: adpcmBytes.slice(0, Math.ceil(nSamples / 2)), keyframes, sampleCount: nSamples };
}

function buildTrackBlob(encoded, recordSpeedShift = 0, recordedChannel = 0, cv1PitchEnabled = false) {
  const { adpcmBytes, keyframes, sampleCount } = encoded;
  const headerBuf = new ArrayBuffer(MLR_HEADER_SIZE);
  const hdr = new DataView(headerBuf);
  const hdrU8 = new Uint8Array(headerBuf);
  hdrU8.fill(0xFF);

  hdr.setUint32(0, MLR_MAGIC, true);
  hdr.setUint32(4, sampleCount, true);
  hdr.setUint32(8, adpcmBytes.length, true);
  hdr.setUint32(12, keyframes.length, true);
  hdr.setInt8(16, recordSpeedShift);
  hdr.setUint8(17, recordedChannel & 0x01);
  hdr.setUint8(18, 0);
  hdr.setUint8(19, cv1PitchEnabled ? 0 : 1);

  for (let i = 0; i < keyframes.length && i < MLR_MAX_KEYFRAMES; i++) {
    const off = MLR_KEYFRAME_OFFSET + i * 4;
    hdr.setInt16(off, keyframes[i].predictor, true);
    hdr.setInt8(off + 2, keyframes[i].stepIndex);
    hdr.setUint8(off + 3, 0);
  }

  const total = new Uint8Array(MLR_HEADER_SIZE + adpcmBytes.length);
  total.set(hdrU8, 0);
  total.set(adpcmBytes, MLR_HEADER_SIZE);
  return total;
}

// ---- Transient detection ----
function detectTransients(audioBuffer, threshold = 0.15, channelIndex = 0) {
  const ch = Math.max(0, Math.min(audioBuffer.numberOfChannels - 1, channelIndex | 0));
  const data = audioBuffer.getChannelData(ch);
  const sr = audioBuffer.sampleRate;
  const windowSize = Math.floor(sr * 0.01); // 10ms windows
  const transients = [0]; // always include start

  let prevEnergy = 0;
  for (let i = 0; i < data.length - windowSize; i += windowSize) {
    let energy = 0;
    for (let j = 0; j < windowSize; j++) {
      energy += data[i + j] * data[i + j];
    }
    energy /= windowSize;

    const diff = energy - prevEnergy;
    if (diff > threshold * threshold && i > 0) {
      // Don't add transients too close together (< 50ms)
      const lastT = transients[transients.length - 1];
      if ((i - lastT) > sr * 0.05) {
        transients.push(i);
      }
    }
    prevEnergy = energy;
  }

  transients.push(data.length); // always include end
  return transients;
}

function snapToTransient(sample, transients) {
  let closest = transients[0];
  let minDist = Math.abs(sample - closest);
  for (const t of transients) {
    const d = Math.abs(sample - t);
    if (d < minDist) { minDist = d; closest = t; }
  }
  return closest;
}

// ---- Resampling ----
function resampleBuffer(audioBuffer, targetRate, gain = 1.0) {
  const srcRate = audioBuffer.sampleRate;
  const srcData = audioBuffer.getChannelData(0); // mono
  const ratio = targetRate / srcRate;
  const outLen = Math.floor(srcData.length * ratio);
  const out = new Int16Array(outLen);

  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const s0 = srcData[Math.min(idx, srcData.length - 1)];
    const s1 = srcData[Math.min(idx + 1, srcData.length - 1)];
    const val = (s0 + (s1 - s0) * frac) * gain;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(val * 32767)));
  }
  return out;
}

// ---- Serial communication ----
let port = null;
let reader = null;
let writer = null;
let readBuffer = new Uint8Array(0);
let readBufferWaiters = [];
let isDisconnecting = false;
let selectedPort = null;
let selectedPortInfo = null;
let autoReconnectEnabled = false;
let autoReconnectTimer = null;
let isManualDisconnect = false;
let reconnectInProgress = false;
let firmwareVersion = null;
const reconnectDelayMs = 900;
const READ_CHUNK_SIZE = 1024;
const READ_CHUNK_ACK = 0x41; // 'A'

function notifyReadBufferWaiters() {
  if (readBufferWaiters.length === 0) return;
  const waiters = readBufferWaiters;
  readBufferWaiters = [];
  for (const resolve of waiters) resolve();
}

async function waitForIncomingData(timeoutMs = 10000) {
  if (readBuffer.length > 0) return;
  if (!port || !reader) throw new Error('Disconnected');

  await new Promise((resolve, reject) => {
    const onData = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      readBufferWaiters = readBufferWaiters.filter(fn => fn !== onData);
      reject(new Error('Timeout waiting for data'));
    }, Math.max(1, timeoutMs));
    readBufferWaiters.push(onData);
  });
}

function isSerialConnected() {
  return !!port && !!writer && !!reader;
}

function updateConnectButton() {
  const btn = document.getElementById('connect-btn');
  const connected = isSerialConnected();
  if (btn) btn.textContent = connected ? 'Disconnect' : 'Connect';

  for (let t = 0; t < MLR_NUM_TRACKS; t++) {
    const cvSel = document.getElementById(`cv1pitch-${t}`);
    const info = getDeviceTrackInfo(t);
    const hasContent = !!(info && info.sampleCount > 0);
    if (cvSel) cvSel.disabled = !connected || !hasContent;
  }
}

function getPortInfo(serialPort) {
  try {
    return serialPort?.getInfo?.() || null;
  } catch (_) {
    return null;
  }
}

function isSamePort(portA, portB, preferredInfo = null) {
  if (!portA || !portB) return false;
  if (portA === portB) return true;

  const infoA = getPortInfo(portA);
  const infoB = preferredInfo || getPortInfo(portB);
  if (!infoA || !infoB) return false;

  return infoA.usbVendorId === infoB.usbVendorId &&
         infoA.usbProductId === infoB.usbProductId;
}

function findMatchingPort(ports, preferredPort, preferredInfo = null) {
  if (!Array.isArray(ports) || ports.length === 0) return null;

  const exactMatch = ports.find(serialPort => serialPort === preferredPort);
  if (exactMatch) return exactMatch;

  if (!preferredInfo) return null;

  return ports.find(serialPort => {
    const info = getPortInfo(serialPort);
    if (!info) return false;
    return info.usbVendorId === preferredInfo.usbVendorId &&
           info.usbProductId === preferredInfo.usbProductId;
  }) || null;
}

function clearAutoReconnectTimer() {
  if (!autoReconnectTimer) return;
  clearTimeout(autoReconnectTimer);
  autoReconnectTimer = null;
}

function scheduleAutoReconnect(delay = reconnectDelayMs) {
  if (!autoReconnectEnabled || isSerialConnected() || !selectedPort || autoReconnectTimer || reconnectInProgress) {
    return;
  }

  autoReconnectTimer = setTimeout(async () => {
    autoReconnectTimer = null;
    if (!autoReconnectEnabled || isSerialConnected() || reconnectInProgress) return;
    await reconnectToSelectedPort();
  }, delay);
}

async function serialDisconnect(showStatusMessage = true) {
  isDisconnecting = true;

  const currentPort = port;
  const currentReader = reader;
  const currentWriter = writer;

  port = null;
  reader = null;
  writer = null;
  readBuffer = new Uint8Array(0);
  firmwareVersion = null;
  notifyReadBufferWaiters();
  updateFirmwareVersionLabel();
  updateConnectButton();

  try {
    if (currentReader) await currentReader.cancel();
  } catch (_) {}

  try {
    if (currentReader) currentReader.releaseLock();
  } catch (_) {}

  try {
    if (currentWriter) currentWriter.releaseLock();
  } catch (_) {}

  try {
    if (currentPort) await currentPort.close();
  } catch (_) {}

  isDisconnecting = false;
  if (showStatusMessage) setStatus('Disconnected');
}

async function manualSerialDisconnect() {
  isManualDisconnect = true;
  autoReconnectEnabled = false;
  clearAutoReconnectTimer();
  await serialDisconnect();
}

function clearDeviceVisualsAndBuffers() {
  deviceTrackInfo = [];
  stopAllPreviews();

  for (let t = 0; t < MLR_NUM_TRACKS; t++) {
    const st = trackState[t];
    if (st) {
      st.audioBuffer = null;
      st.transients = [];
      st.cropStart = 0;
      st.cropEnd = 0;
      st.recordSpeedShift = 0;
      st.cv1PitchEnabled = false;
    }

    const info = document.getElementById(`info-${t}`);
    if (info) info.textContent = 'empty';

    const pbar = document.getElementById(`pbar-${t}`);
    if (pbar) pbar.style.width = '0%';

    const fileInput = document.getElementById(`file-${t}`);
    if (fileInput) fileInput.value = '';

    const cvSel = document.getElementById(`cv1pitch-${t}`);
    if (cvSel) cvSel.checked = false;

    const ph = document.getElementById(`playhead-${t}`);
    if (ph) ph.style.display = 'none';

    drawWaveform(t);
  }
}

async function handleUnexpectedDisconnect(message) {
  await serialDisconnect(false);
  clearDeviceVisualsAndBuffers();
  setStatus(message);
  if (autoReconnectEnabled && !isManualDisconnect && selectedPort) {
    scheduleAutoReconnect();
  }
}

async function chooseReconnectPort() {
  if (!selectedPort) return null;

  if (navigator.serial && typeof navigator.serial.getPorts === 'function') {
    try {
      const availablePorts = await navigator.serial.getPorts();
      const matchingPort = findMatchingPort(availablePorts, selectedPort, selectedPortInfo);
      if (matchingPort) return matchingPort;
    } catch (_) {}
  }

  return selectedPort;
}

async function openSerialPort(nextPort, auto = false) {
  port = nextPort;
  await port.open({ baudRate: 115200 });
  writer = port.writable.getWriter();
  const r = port.readable.getReader();
  reader = r;
  readBuffer = new Uint8Array(0);
  notifyReadBufferWaiters();
  readLoop(r);
  if (!auto) setStatus('Connected — preparing device...');
  updateConnectButton();
}

async function serialConnect(options = {}) {
  const { auto = false } = options;

  if (isSerialConnected()) {
    await serialDisconnect(false);
  }

  const rememberedPort = await chooseReconnectPort();
  if (rememberedPort) {
    try {
      await openSerialPort(rememberedPort, auto);
      return;
    } catch (e) {
      if (port || reader || writer) {
        await serialDisconnect(false);
      }
      if (auto) throw e;
    }
  }

  if (auto) throw new Error('No previously permitted serial port found');

  const requestedPort = await navigator.serial.requestPort();
  await openSerialPort(requestedPort, false);
}

async function rememberConnectedPort() {
  selectedPort = port;
  selectedPortInfo = getPortInfo(port);
  autoReconnectEnabled = true;
  isManualDisconnect = false;
  clearAutoReconnectTimer();
}

async function reconnectToSelectedPort() {
  if (reconnectInProgress || isSerialConnected()) return;

  reconnectInProgress = true;
  try {
    setStatus('Attempting to reconnect...');
    await serialConnect({ auto: true });
    await initialiseDeviceConnection();
    await rememberConnectedPort();
  } catch (e) {
    if (port || reader || writer) {
      await serialDisconnect(false);
    }
    if (autoReconnectEnabled && selectedPort) {
      setStatus('Attempting to reconnect...');
    }
  } finally {
    reconnectInProgress = false;
    if (autoReconnectEnabled && !isSerialConnected() && selectedPort) {
      scheduleAutoReconnect();
    }
  }
}

async function readLoop(r) {
  try {
    while (true) {
      const { value, done } = await r.read();
      if (done) break;
      if (value) {
        const merged = new Uint8Array(readBuffer.length + value.length);
        merged.set(readBuffer);
        merged.set(value, readBuffer.length);
        readBuffer = merged;
        notifyReadBufferWaiters();
      }
    }
  } catch (e) {
    if (!isDisconnecting) {
      await handleUnexpectedDisconnect('Disconnected: ' + e.message);
      return;
    }
  } finally {
    try { r.releaseLock(); } catch (_) {}
    if (!isDisconnecting && reader === r) {
      await handleUnexpectedDisconnect('Disconnected');
    }
  }
}

async function serialWrite(data) {
  if (typeof data === 'string') {
    await writer.write(new TextEncoder().encode(data));
  } else {
    await writer.write(data);
  }
}

async function waitForBytes(n, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (readBuffer.length < n) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Timeout waiting for data');
    await waitForIncomingData(remaining);
  }
  const result = readBuffer.slice(0, n);
  readBuffer = readBuffer.slice(n);
  return result;
}

async function waitForLine(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const idx = readBuffer.indexOf(10); // newline
    if (idx >= 0) {
      const line = new TextDecoder().decode(readBuffer.slice(0, idx)).trim();
      readBuffer = readBuffer.slice(idx + 1);
      return line;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Timeout waiting for line');
    await waitForIncomingData(remaining);
  }
}

async function yieldToUi() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

// ---- Protocol sync ----
function findByteSequence(haystack, needle) {
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { match = false; break; }
    }
    if (match) return i;
  }
  return -1;
}

/**
 * Send 'X' sync/cancel command and wait for firmware to respond with "SYNC\n".
 * Drains any stale data (e.g. from a stuck read stream) in the process.
 * Falls back gracefully if firmware is older and doesn't support 'X'.
 */
async function cmdSync(required = true) {
  if (!port || !writer) return;
  readBuffer = new Uint8Array(0);
  await serialWrite('X');
  const syncMarker = new TextEncoder().encode('SYNC\n');
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const idx = findByteSequence(readBuffer, syncMarker);
    if (idx >= 0) {
      readBuffer = readBuffer.slice(idx + syncMarker.length);
      // Brief drain to catch duplicate SYNCs from pipelined requests
      await new Promise(r => setTimeout(r, 30));
      readBuffer = new Uint8Array(0);
      return true;
    }
    try {
      await waitForIncomingData(Math.max(10, deadline - Date.now()));
    } catch (_) {
      break;
    }
  }
  readBuffer = new Uint8Array(0);
  if (required) throw new Error('Device did not acknowledge command sync');
  return false;
}

async function requireInitialSync(timeoutMs = 5000) {
  if (!port || !writer) throw new Error('Disconnected');

  const syncMarker = new TextEncoder().encode('SYNC\n');
  const deadline = Date.now() + timeoutMs;
  readBuffer = new Uint8Array(0);

  while (Date.now() < deadline) {
    await serialWrite('X');
    const attemptDeadline = Math.min(Date.now() + 500, deadline);

    while (Date.now() < attemptDeadline) {
      const idx = findByteSequence(readBuffer, syncMarker);
      if (idx >= 0) {
        readBuffer = readBuffer.slice(idx + syncMarker.length);
        await new Promise(r => setTimeout(r, 30));
        readBuffer = new Uint8Array(0);
        return;
      }

      try {
        await waitForIncomingData(Math.max(10, attemptDeadline - Date.now()));
      } catch (_) {
        break;
      }
    }
  }

  readBuffer = new Uint8Array(0);
  throw new Error('Device did not enter sample-manager mode');
}

async function initialiseDeviceConnection() {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      console.debug(`Connection init attempt ${attempt + 1}/5: waking sample manager`);
      setStatus('Waking sample manager...');
      await requireInitialSync();
      setStatus('Reading device metadata...');
      await refreshInfo({ skipSync: true });
      updateUIForDeviceMode();
      setStatus('Loading tracks from device...');
      await readAllTracks();
      console.debug(`Connection init attempt ${attempt + 1}/5 succeeded`);
      return;
    } catch (e) {
      lastError = e;
      console.warn(`Connection init attempt ${attempt + 1}/5 failed:`, e);
      readBuffer = new Uint8Array(0);
      if (attempt < 4) {
        setStatus('Waiting for device to settle...');
        await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
      }
    }
  }
  throw lastError || new Error('Unable to initialise device connection');
}

let deviceTrackInfo = [];

// ---- Track commands ----
async function cmdInfo(options = {}) {
  const { skipSync = false } = options;
  if (!skipSync) await cmdSync();
  await serialWrite('I');

  let infoBytes;
  try {
    const lenBytes = await waitForBytes(4, 2500);
    const infoLen = new DataView(lenBytes.buffer, lenBytes.byteOffset, 4).getUint32(0, true);
    if (infoLen === 0 || infoLen > 512) throw new Error('Invalid metadata length: ' + infoLen);
    infoBytes = await waitForBytes(infoLen, 2500);
  } catch (e) {
    throw new Error('Timed out waiting for metadata frame');
  }

  const lines = new TextDecoder().decode(infoBytes).trim().split('\n');
  const header = lines.shift() || '';
  const headerParts = header.split(' ');
  if (headerParts[0] !== 'MLR1') throw new Error('Bad info response: ' + header);

  firmwareVersion = '1.0';
  const firmwareTokenIndex = headerParts.indexOf('FW');
  if (firmwareTokenIndex >= 0 && headerParts[firmwareTokenIndex + 1]) {
    firmwareVersion = headerParts[firmwareTokenIndex + 1];
  }
  updateFirmwareVersionLabel();

  const tracks = [];
  let sawEnd = false;
  for (const line of lines) {
    if (line === 'END') {
      sawEnd = true;
      break;
    }

    const parts = line.split(' ');
    if (!/^T\d+$/.test(parts[0]) || parts.length < 4) {
      throw new Error('Bad track line: ' + line);
    }

    tracks.push({
      index: parseInt(parts[0].substring(1), 10),
      sampleCount: parseInt(parts[1], 10),
      adpcmBytes: parseInt(parts[2], 10),
      numKeyframes: parseInt(parts[3], 10),
      recordSpeedShift: parts.length > 4 ? parseInt(parts[4], 10) : 0,
      recordedChannel: parts.length > 5 ? (parseInt(parts[5], 10) & 0x01) : null,
      cv1PitchEnabled: parts.length > 6 ? (parseInt(parts[6], 10) !== 0) : true,
    });
  }

  if (!sawEnd) {
    throw new Error('Metadata frame missing END');
  }

  deviceTrackInfo = tracks;
  return tracks;
}

async function cmdErase(track) {
  await cmdSync();
  await serialWrite(new Uint8Array([0x45, track])); // 'E' + track
  const resp = await waitForLine();
  if (resp !== 'OK') throw new Error('Erase failed: ' + resp);
}

async function cmdSetCv1Pitch(track, enabled) {
  await cmdSync();
  await serialWrite(new Uint8Array([0x50, track, enabled ? 1 : 0])); // 'P' + track + enabled
  const resp = await waitForLine();
  if (resp !== 'OK') throw new Error('CV output update failed: ' + resp);
}

async function syncCv1PitchSetting(track, enabled) {
  let lastError = null;
  setStatus('Syncing metadata...');

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await cmdSetCv1Pitch(track, enabled);
      await refreshInfo({ quietErrors: true });
      setStatus('Metadata synced successfully');
      return;
    } catch (err) {
      lastError = err;
      console.warn(`CV output metadata sync attempt ${attempt + 1}/5 failed:`, err);
      readBuffer = new Uint8Array(0);
      if (attempt < 4) {
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }

  throw lastError || new Error('Metadata sync failed');
}

async function cmdWrite(track, blob, progressCb) {
  await cmdSync();
  const lenBuf = new Uint8Array(4);
  new DataView(lenBuf.buffer).setUint32(0, blob.length, true);

  await serialWrite(new Uint8Array([0x57, track])); // 'W' + track
  await serialWrite(lenBuf);

  // Wait for write-ready ACK before streaming data
  const ack = await waitForLine(5000);
  if (ack === 'BUSY') throw new Error('Device busy');
  if (ack === 'ERR') throw new Error('Write rejected by device');
  if (ack !== 'OK') throw new Error('Unexpected write response: ' + ack);

  // Send in chunks
  const chunkSize = 256;
  for (let i = 0; i < blob.length; i += chunkSize) {
    const end = Math.min(i + chunkSize, blob.length);
    await serialWrite(blob.slice(i, end));
    if (progressCb) progressCb(end / blob.length);
    // Small delay every 4KB to let device process
    if ((i & 0xFFF) === 0 && i > 0) {
      await new Promise(r => setTimeout(r, 5));
    }
  }

  const resp = await waitForLine(60000);
  if (resp !== 'OK') throw new Error('Write failed: ' + resp);
}

async function cmdRead(track, progressCb) {
  await cmdSync();

  await serialWrite(new Uint8Array([0x52, track])); // 'R' + track

  const lenBytes = await waitForBytes(4);
  const totalLen = new DataView(lenBytes.buffer, lenBytes.byteOffset, 4).getUint32(0, true);
  if (totalLen === 0) return null;
  if (totalLen > MLR_TRACK_FLASH_SIZE) {
    const looksAscii = lenBytes.every((b) => b >= 0x20 && b <= 0x7e);
    if (looksAscii) {
      const merged = new Uint8Array(lenBytes.length + readBuffer.length);
      merged.set(lenBytes, 0);
      merged.set(readBuffer, lenBytes.length);
      readBuffer = merged;
      notifyReadBufferWaiters();
      const resp = await waitForLine(2000);
      throw new Error('Read failed: ' + resp);
    }
    throw new Error('Invalid read length: ' + totalLen);
  }

  const data = new Uint8Array(totalLen);
  let received = 0;
  let nextAckAt = Math.min(READ_CHUNK_SIZE, totalLen);
  const deadline = Date.now() + 60000;
  let idleDeadline = Date.now() + 15000;
  while (received < totalLen) {
    if (Date.now() > deadline) {
      throw new Error(`Timeout waiting for track ${track + 1} data (${received}/${totalLen} bytes)`);
    }

    if (readBuffer.length === 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Timeout waiting for track ${track + 1} data (${received}/${totalLen} bytes)`);
      }
      const idleRemaining = idleDeadline - Date.now();
      if (idleRemaining <= 0) {
        throw new Error(`Stalled reading track ${track + 1} data (${received}/${totalLen} bytes)`);
      }
      try {
        await waitForIncomingData(Math.min(remaining, idleRemaining));
      } catch (_) {
        throw new Error(`Stalled reading track ${track + 1} data (${received}/${totalLen} bytes)`);
      }
      continue;
    }

    const chunk = Math.min(readBuffer.length, totalLen - received);
    data.set(readBuffer.slice(0, chunk), received);
    readBuffer = readBuffer.slice(chunk);
    received += chunk;
    idleDeadline = Date.now() + 15000;

    while (received >= nextAckAt) {
      await serialWrite(new Uint8Array([READ_CHUNK_ACK]));
      if (nextAckAt >= totalLen) break;
      nextAckAt = Math.min(nextAckAt + READ_CHUNK_SIZE, totalLen);
    }

    if (progressCb) progressCb(received / totalLen, received, totalLen);
  }

  // Verify end-of-stream marker from firmware
  try {
    const doneLine = await waitForLine(5000);
    if (doneLine !== 'DONE') {
      console.warn('Expected DONE after read, got:', doneLine);
    }
  } catch (_) {
    console.warn('No DONE marker received after read (old firmware?)');
  }

  await yieldToUi();
  return data;
}

// ---- UI ----
function setUnsupportedBrowserError(message) {
  const status = document.getElementById('status');
  if (status) {
    status.textContent = message;
    status.classList.add('error');
  }

  const btn = document.getElementById('connect-btn');
  if (btn) btn.disabled = true;
}

function assertSupportedBrowser() {
  if (!('serial' in navigator)) {
    throw new Error('Unsupported browser: Web Serial is required. Use Chrome, Edge, Brave, or another Chromium-based browser.');
  }
}

function updateFirmwareVersionLabel() {
  const el = document.getElementById('firmware-version');
  if (el) el.textContent = `Firmware: ${firmwareVersion || '--'}`;
}

function setStatus(msg) {
  const status = document.getElementById('status');
  status.textContent = msg;
  status.classList.remove('error');
}

const trackState = [];

function getRecordedChannel(t) {
  const st = trackState[t];
  return st && st.recordedChannel === 1 ? 1 : 0;
}

function getSourceChannelIndex(st) {
  if (!st || !st.audioBuffer) return 0;
  return (st.recordedChannel === 1 && st.audioBuffer.numberOfChannels > 1) ? 1 : 0;
}

function selectedSourceChannelLabel(st) {
  const sourceChannel = getSourceChannelIndex(st);
  return `source ${sourceChannel + 1}`;
}

function getSelectedChannelData(st) {
  return st.audioBuffer.getChannelData(getSourceChannelIndex(st));
}

function getDeviceTrackInfo(t) {
  return deviceTrackInfo.find(info => info.index === t) || deviceTrackInfo[t] || null;
}

function setTrackChannel(t, recordedChannel) {
  if (!trackState[t]) return;
  trackState[t].recordedChannel = recordedChannel & 0x01;
  const chSel = document.getElementById(`channel-${t}`);
  if (chSel) chSel.value = trackState[t].recordedChannel;
}

function createTrackUI() {
  const container = document.getElementById('tracks');
  container.innerHTML = '';

  for (let t = 0; t < MLR_NUM_TRACKS; t++) {
    trackState[t] = trackState[t] || {
      audioBuffer: null,
      transients: [],
      cropStart: 0,
      cropEnd: 0,
      speedIdx: 3, // normal
      recordSpeedShift: 0,
      recordedChannel: 0,
      cv1PitchEnabled: false,
    };

    const div = document.createElement('div');
    div.className = 'track';
    div.id = `track-${t}`;

    const maxSecs = (s) => (getMaxSamples() / recTargetRate(s)).toFixed(1);

    div.innerHTML = `
      <div class="track-header">
        <label>Track ${t + 1}</label>
        <select id="speed-${t}">
          ${SPEEDS.map((s, i) => `<option value="${i}" ${i === 3 ? 'selected' : ''}>${s.name} (${maxSecs(s)}s)</option>`).join('')}
        </select>
        <label class="control-label">Channel:</label>
        <select id="channel-${t}">
          <option value="0" ${trackState[t].recordedChannel === 0 ? 'selected' : ''}>1</option>
          <option value="1" ${trackState[t].recordedChannel === 1 ? 'selected' : ''}>2</option>
        </select>
        <label class="control-label">CV/pulse outputs:</label>
        <input type="checkbox" id="cv1pitch-${t}" ${trackState[t].cv1PitchEnabled ? 'checked' : ''}>
        <span id="info-${t}" class="track-info">empty</span>
      </div>
      <div class="waveform-container" id="wave-container-${t}">
        <canvas id="wave-${t}"></canvas>
        <div class="crop-region" id="crop-region-${t}"></div>
        <div class="playhead" id="playhead-${t}"></div>
      </div>
      <div class="track-actions">
        <input type="file" id="file-${t}" accept="audio/*,.aif,.aiff" style="display:none">
        <button onclick="document.getElementById('file-${t}').click()">Load Audio</button>
        <button onclick="uploadTrack(${t})">Upload</button>
        <button onclick="downloadTrack(${t})">Download</button>
        <button onclick="cropToSelection(${t})">Crop</button>
        <button onclick="eraseTrack(${t})">Clear</button>
        <button id="preview-btn-${t}" onclick="previewTrack(${t})">Preview</button>
      </div>
      <div class="progress" id="progress-${t}"><div class="progress-bar" id="pbar-${t}"></div></div>
    `;
    container.appendChild(div);

    // File input handler
    document.getElementById(`file-${t}`).addEventListener('change', (e) => loadAudioFile(t, e.target.files[0]));

    // Drag-and-drop loading
    setupTrackDropTarget(t);

    // Speed change — restart preview if playing
    document.getElementById(`speed-${t}`).addEventListener('change', (e) => {
      trackState[t].speedIdx = parseInt(e.target.value);
      if (trackState[t].audioBuffer) {
        updateCropForSpeed(t);
        drawWaveform(t);
      }
      if (previewState[t]) {
        previewTrack(t, true);
      }
    });

    document.getElementById(`channel-${t}`).addEventListener('change', (e) => {
      trackState[t].recordedChannel = parseInt(e.target.value, 10) & 0x01;
      if (trackState[t].audioBuffer) {
        trackState[t].transients = detectTransients(
          trackState[t].audioBuffer,
          0.15,
          getSourceChannelIndex(trackState[t])
        );
        updateCropForSpeed(t);
        drawWaveform(t);
      }
      if (previewState[t]) previewTrack(t, true);
    });

    document.getElementById(`cv1pitch-${t}`).addEventListener('change', async (e) => {
      if (e.target.disabled) return;
      const enabled = !!e.target.checked;
      trackState[t].cv1PitchEnabled = enabled;
      if (port) {
        try {
          await syncCv1PitchSetting(t, enabled);
        } catch (err) {
          e.target.checked = !enabled;
          trackState[t].cv1PitchEnabled = !enabled;
          setStatus('CV output update error: ' + err.message);
        }
      }
    });

    // Set up crop interaction once (handlers check for audioBuffer)
    setupCropInteraction(t);
  }
}

// ---- AIFF parser (Chrome doesn't support AIFF via decodeAudioData) ----
function parseAIFF(arrayBuf) {
  const dv = new DataView(arrayBuf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'FORM') return null;
  const form = String.fromCharCode(dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11));
  if (form !== 'AIFF' && form !== 'AIFC') return null;

  let numChannels = 0;
  let numFrames = 0;
  let bitsPerSample = 0;
  let sampleRate = 0;
  let soundDataOffset = -1;
  let soundDataSize = 0;
  let compressionType = 'NONE';

  function readChunkId(offset) {
    return String.fromCharCode(
      dv.getUint8(offset),
      dv.getUint8(offset + 1),
      dv.getUint8(offset + 2),
      dv.getUint8(offset + 3)
    );
  }

  // Parse 80-bit IEEE 754 extended precision float.
  function readExtended(offset) {
    const sign = (dv.getUint8(offset) >> 7) & 1;
    const exponent = ((dv.getUint8(offset) & 0x7F) << 8) | dv.getUint8(offset + 1);
    let mantissa = 0;
    for (let i = 0; i < 8; i++) {
      mantissa = mantissa * 256 + dv.getUint8(offset + 2 + i);
    }
    if (exponent === 0 && mantissa === 0) return 0;
    const f = mantissa / Math.pow(2, 63);
    return (sign ? -1 : 1) * Math.pow(2, exponent - 16383) * f;
  }

  function readPcmSample(offset, bytesPerSample, littleEndian) {
    switch (bytesPerSample) {
      case 1:
        return dv.getInt8(offset) / 128;
      case 2:
        return dv.getInt16(offset, littleEndian) / 32768;
      case 3: {
        let value;
        if (littleEndian) {
          value = dv.getUint8(offset) |
            (dv.getUint8(offset + 1) << 8) |
            (dv.getUint8(offset + 2) << 16);
        } else {
          value = (dv.getUint8(offset) << 16) |
            (dv.getUint8(offset + 1) << 8) |
            dv.getUint8(offset + 2);
        }
        if (value & 0x800000) value -= 0x1000000;
        return value / 8388608;
      }
      case 4:
        return dv.getInt32(offset, littleEndian) / 2147483648;
      default:
        throw new Error(`Unsupported AIFF PCM width: ${bytesPerSample * 8} bits`);
    }
  }

  // Walk chunks.
  let pos = 12;
  while (pos + 8 <= arrayBuf.byteLength) {
    const ckID = readChunkId(pos);
    const ckSize = dv.getUint32(pos + 4, false);
    const ckData = pos + 8;

    if (ckData + ckSize > arrayBuf.byteLength) break;

    if (ckID === 'COMM') {
      numChannels = dv.getUint16(ckData, false);
      numFrames = dv.getUint32(ckData + 2, false);
      bitsPerSample = dv.getUint16(ckData + 6, false);
      sampleRate = readExtended(ckData + 8);
      if (form === 'AIFC' && ckSize >= 22) {
        compressionType = readChunkId(ckData + 18);
      }
    } else if (ckID === 'SSND') {
      const dataOffset = dv.getUint32(ckData, false);
      soundDataOffset = ckData + 8 + dataOffset;
      soundDataSize = ckSize - 8 - dataOffset;
    }

    pos = ckData + ckSize;
    if (pos & 1) pos++; // chunks are 2-byte aligned
  }

  if (soundDataOffset < 0 || numFrames === 0 || numChannels === 0) return null;

  const littleEndian = compressionType === 'sowt';
  if (!['NONE', 'sowt'].includes(compressionType)) {
    throw new Error(`Unsupported AIFF compression: ${compressionType}`);
  }

  const bytesPerSample = Math.ceil(bitsPerSample / 8);
  const frameStride = numChannels * bytesPerSample;
  if (soundDataSize < numFrames * frameStride) {
    throw new Error('AIFF sound data is truncated');
  }

  const channels = Array.from({ length: numChannels }, () => new Float32Array(numFrames));
  for (let f = 0; f < numFrames; f++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const offset = soundDataOffset + (f * numChannels + ch) * bytesPerSample;
      channels[ch][f] = readPcmSample(offset, bytesPerSample, littleEndian);
    }
  }

  return { channels, sampleRate, numFrames };
}

function createAudioBufferFromChannels(channels, sampleRate) {
  const audioBuf = new AudioBuffer({
    length: channels[0].length,
    sampleRate,
    numberOfChannels: channels.length
  });
  for (let ch = 0; ch < channels.length; ch++) {
    audioBuf.getChannelData(ch).set(channels[ch]);
  }
  return audioBuf;
}

function setupTrackDropTarget(t) {
  const trackEl = document.getElementById(`track-${t}`);
  if (!trackEl) return;

  let dragDepth = 0;

  function hasFiles(e) {
    return Array.from(e.dataTransfer?.types || []).includes('Files');
  }

  function clearDragState() {
    dragDepth = 0;
    trackEl.classList.remove('drag-over');
  }

  trackEl.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    trackEl.classList.add('drag-over');
  });

  trackEl.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    trackEl.classList.add('drag-over');
  });

  trackEl.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) trackEl.classList.remove('drag-over');
  });

  trackEl.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    clearDragState();

    const [file] = Array.from(e.dataTransfer.files || []);
    if (!file) return;

    try {
      await loadAudioFile(t, file);
    } catch (err) {
      setStatus(`Load error: ${err.message}`);
    }
  });
}

async function loadAudioFile(t, file) {
  if (!file) return;
  setStatus(`Loading ${file.name}...`);
  const arrayBuf = await file.arrayBuffer();

  let audioBuf;
  // Try AIFF parser first (Chrome doesn't support AIFF via decodeAudioData)
  const aiff = parseAIFF(arrayBuf);
  if (aiff) {
    audioBuf = createAudioBufferFromChannels(aiff.channels, aiff.sampleRate);
  } else {
    const actx = new AudioContext();
    audioBuf = await actx.decodeAudioData(arrayBuf);
    actx.close();
  }

  // Peak-normalize all channels to 0 dBFS
  let peak = 0;
  for (let ch = 0; ch < audioBuf.numberOfChannels; ch++) {
    const data = audioBuf.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      const abs = Math.abs(data[i]);
      if (abs > peak) peak = abs;
    }
  }
  if (peak > 0 && peak < 1) {
    const gain = 1.0 / peak;
    for (let ch = 0; ch < audioBuf.numberOfChannels; ch++) {
      const data = audioBuf.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        data[i] *= gain;
      }
    }
  }

  trackState[t].audioBuffer = audioBuf;
  trackState[t].transients = detectTransients(audioBuf, 0.15, getSourceChannelIndex(trackState[t]));
  trackState[t].cropStart = 0;
  trackState[t].cropEnd = audioBuf.length;

  updateCropForSpeed(t);
  drawWaveform(t);

  const dur = audioBuf.duration.toFixed(2);
  const sourceNote = audioBuf.numberOfChannels > 1
    ? `, upload uses ${selectedSourceChannelLabel(trackState[t])} for selected channel`
    : '';
  setStatus(`Loaded ${file.name}: ${dur}s, ${audioBuf.sampleRate}Hz${sourceNote}`);
}

function updateCropForSpeed(t) {
  const st = trackState[t];
  if (!st.audioBuffer) return;

  const speed = SPEEDS[st.speedIdx];
  const targetRate = recTargetRate(speed);
  const maxSourceSamples = Math.floor(getMaxSamples() / targetRate * st.audioBuffer.sampleRate) - 1;

  // If audio is longer than max, snap crop end to nearest transient
  if (st.cropEnd - st.cropStart > maxSourceSamples) {
    const idealEnd = st.cropStart + maxSourceSamples;
    st.cropEnd = snapToTransient(idealEnd, st.transients);
    if (st.cropEnd <= st.cropStart) st.cropEnd = Math.min(st.cropStart + maxSourceSamples, st.audioBuffer.length);
    // Hard clamp — transient snap may overshoot
    if (st.cropEnd - st.cropStart > maxSourceSamples) {
      st.cropEnd = st.cropStart + maxSourceSamples;
    }
  }

  // Update info
  const croppedDur = ((st.cropEnd - st.cropStart) / st.audioBuffer.sampleRate).toFixed(2);
  const maxDur = (getMaxSamples() / recTargetRate(speed)).toFixed(1);
  const recLabel = `, rec ${speedShiftToLabel(st.recordSpeedShift ?? 0)}`;
  document.getElementById(`info-${t}`).textContent = `${croppedDur}s / ${maxDur}s max at ${speed.name}${recLabel}`;
}

function drawWaveform(t) {
  const canvas = document.getElementById(`wave-${t}`);
  const container = document.getElementById(`wave-container-${t}`);
  const ctx = canvas.getContext('2d');
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;
  const w = canvas.width, h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  const st = trackState[t];
  if (!st.audioBuffer) {
    ctx.fillStyle = '#eee';
    ctx.fillRect(0, 0, w, h);
    return;
  }

  const data = getSelectedChannelData(st);
  const len = data.length;

  // Draw waveform (always full width, no zoom)
  ctx.fillStyle = '#f8f8f8';
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = '#999';
  const samplesPerPixel = len / w;
  for (let x = 0; x < w; x++) {
    const start = Math.floor(x * samplesPerPixel);
    const end = Math.floor((x + 1) * samplesPerPixel);
    let min = 1, max = -1;
    for (let i = start; i < end && i < len; i++) {
      const s = data[i];
      if (s < min) min = s;
      if (s > max) max = s;
    }
    // Clamp to [-1, 1] to show clipping visually
    const y1 = ((1 - Math.min(1, max)) / 2) * h;
    const y2 = ((1 - Math.max(-1, min)) / 2) * h;
    ctx.fillRect(x, y1, 1, y2 - y1);
  }

  // Draw crop region
  const cropRegion = document.getElementById(`crop-region-${t}`);
  const startPx = (st.cropStart / len) * w;
  const endPx = (st.cropEnd / len) * w;
  cropRegion.style.left = Math.max(0, startPx) + 'px';
  cropRegion.style.width = Math.max(0, endPx - startPx) + 'px';

  // Draw transients as ticks
  ctx.fillStyle = 'rgba(255,0,0,0.3)';
  for (const tr of st.transients) {
    const x = (tr / len) * w;
    if (x >= 0 && x < w) ctx.fillRect(x, 0, 1, h);
  }
}

function setupCropInteraction(t) {
  const container = document.getElementById(`wave-container-${t}`);
  let dragging = false;
  let dragStartSample = -1;

  function pixelToSample(e) {
    const rect = container.getBoundingClientRect();
    const xRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const st = trackState[t];
    if (!st.audioBuffer) return 0;
    return Math.floor(xRatio * st.audioBuffer.length);
  }

  function findSector(sample) {
    const st = trackState[t];
    // Find surrounding transients as sector boundaries
    let sectorStart = 0, sectorEnd = st.audioBuffer.length;
    for (const tr of st.transients) {
      if (tr <= sample) sectorStart = tr;
      if (tr > sample) { sectorEnd = tr; break; }
    }
    return { start: sectorStart, end: sectorEnd };
  }

  container.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const st = trackState[t];
    if (!st.audioBuffer) return;
    const sample = pixelToSample(e);

    // Add manual sector boundary (insert into sorted transients list)
    if (!st.transients.includes(sample)) {
      st.transients.push(sample);
      st.transients.sort((a, b) => a - b);
    }
    drawWaveform(t);
  });

  container.addEventListener('mousedown', (e) => {
    const st = trackState[t];
    if (!st.audioBuffer) return;
    e.preventDefault();
    const sample = pixelToSample(e);
    const sector = findSector(sample);

    // Click selects this sector
    st.cropStart = sector.start;
    st.cropEnd = sector.end;
    dragStartSample = sample;
    dragging = true;

    updateCropForSpeed(t);
    drawWaveform(t);
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const st = trackState[t];
    if (!st.audioBuffer) return;
    const sample = pixelToSample(e);

    // Expand selection to include all sectors from drag start to current
    const sector1 = findSector(dragStartSample);
    const sector2 = findSector(sample);
    st.cropStart = Math.min(sector1.start, sector2.start);
    st.cropEnd = Math.max(sector1.end, sector2.end);

    // Enforce max length
    const speed = SPEEDS[st.speedIdx];
    const targetRate = recTargetRate(speed);
    const maxSourceSamples = Math.floor(getMaxSamples() / targetRate * st.audioBuffer.sampleRate) - 1;
    if (st.cropEnd - st.cropStart > maxSourceSamples) {
      if (sample > dragStartSample) st.cropEnd = st.cropStart + maxSourceSamples;
      else st.cropStart = st.cropEnd - maxSourceSamples;
    }

    updateCropForSpeed(t);
    drawWaveform(t);
  });

  document.addEventListener('mouseup', () => { dragging = false; });
}

function cropToSelection(t) {
  const st = trackState[t];
  if (!st.audioBuffer) { setStatus('No audio loaded'); return; }
  if (st.cropStart >= st.cropEnd) { setStatus('No selection to crop'); return; }

  const channels = [];
  for (let ch = 0; ch < st.audioBuffer.numberOfChannels; ch++) {
    channels.push(st.audioBuffer.getChannelData(ch).slice(st.cropStart, st.cropEnd));
  }

  const newBuf = createAudioBufferFromChannels(channels, st.audioBuffer.sampleRate);

  st.audioBuffer = newBuf;
  st.transients = detectTransients(newBuf, 0.15, getSourceChannelIndex(st));
  st.cropStart = 0;
  st.cropEnd = newBuf.length;

  updateCropForSpeed(t);
  drawWaveform(t);
  setStatus(`Cropped to ${newBuf.duration.toFixed(2)}s`);
}

function prepareTrackUpload(sourceBuffer, sourceChannel, speed, cropStart, cropEnd, recordedChannel, cv1PitchEnabled) {
  const targetRate = recTargetRate(speed);
  const srcData = sourceBuffer.getChannelData(sourceChannel);
  const cropped = srcData.slice(cropStart, cropEnd);
  const croppedBuf = new AudioBuffer({
    length: cropped.length,
    sampleRate: sourceBuffer.sampleRate,
    numberOfChannels: 1
  });
  croppedBuf.getChannelData(0).set(cropped);

  const samples16 = resampleBuffer(croppedBuf, targetRate, 1.0);
  const maxSamples = getMaxSamples();
  if (samples16.length > maxSamples) {
    throw new Error(`too many samples (${samples16.length} > ${maxSamples})`);
  }

  const encoded = adpcmEncode(samples16);
  const blob = buildTrackBlob(encoded, speed.shift, recordedChannel, cv1PitchEnabled);
  if (blob.length > MLR_TRACK_FLASH_SIZE) {
    throw new Error(`data too large (${blob.length} > ${MLR_TRACK_FLASH_SIZE})`);
  }

  return { blob, encoded, speed, recordedChannel, cv1PitchEnabled };
}

async function writePreparedTrack(t, prepared) {
  const { blob, encoded, speed, recordedChannel, cv1PitchEnabled } = prepared;
  setStatus(`Uploading track ${t + 1} (${blob.length} bytes)...`);
  const pbar = document.getElementById(`pbar-${t}`);
  await cmdWrite(t, blob, (pct) => { pbar.style.width = (pct * 100) + '%'; });
  pbar.style.width = '100%';

  // Update the UI from the exact blob we just wrote, instead of
  // immediately re-reading the whole track back over serial.
  if (previewState[t]) {
    stopPreview(t, false);
  }
  const decoded = decodeTrackBlob(blob);
  if (decoded) {
    const st = trackState[t];
    st.audioBuffer = decoded.audioBuf;
    st.transients = detectTransients(decoded.audioBuf);
    st.cropStart = 0;
    st.cropEnd = decoded.audioBuf.length;
    st.speedIdx = speedShiftToIdx(decoded.recordSpeedShift);
    st.recordSpeedShift = decoded.recordSpeedShift;
    st.recordedChannel = decoded.recordedChannel;
    st.cv1PitchEnabled = decoded.cv1PitchEnabled;
    document.getElementById(`speed-${t}`).value = st.speedIdx;
    document.getElementById(`channel-${t}`).value = st.recordedChannel;
    document.getElementById(`cv1pitch-${t}`).checked = st.cv1PitchEnabled;
    updateCropForSpeed(t);
    drawWaveform(t);
  }

  const dur = (encoded.sampleCount / (48000 * speed.ratio)).toFixed(2);
  document.getElementById(`info-${t}`).textContent =
    `${encoded.sampleCount} samples (${(encoded.sampleCount / 48000).toFixed(2)}s at 1x), ${encoded.adpcmBytes.length} bytes, rec ${speedShiftToLabel(speed.shift)}, ch ${recordedChannel + 1}, cv ${cv1PitchEnabled ? 'on' : 'off'}`;
  setTimeout(() => { pbar.style.width = '0%'; }, 2000);
  return { dur, encoded };
}

async function uploadTrack(t) {
  const st = trackState[t];
  if (!st.audioBuffer) { setStatus('No audio loaded'); return; }
  if (!port) { setStatus('Not connected'); return; }

  const speed = SPEEDS[st.speedIdx];
  const cropStart = st.cropStart;
  const cropEnd = st.cropEnd;

  setStatus(`Encoding track ${t + 1} at ${speed.name}...`);
  try {
    // Channel 2 uses source channel 2 when present; mono files use their only
    // channel for either output channel.
    const sourceChannel = getSourceChannelIndex(st);
    const recordedChannel = getRecordedChannel(t);
    const info = getDeviceTrackInfo(t);
    const hadContent = !!(info && info.sampleCount > 0);
    const cv1PitchEnabled = hadContent ? (st.cv1PitchEnabled === true) : false;
    const prepared = prepareTrackUpload(st.audioBuffer, sourceChannel, speed, cropStart, cropEnd, recordedChannel, cv1PitchEnabled);
    const result = await writePreparedTrack(t, prepared);

    // Refresh compact device metadata without blocking the UI.
    refreshInfo().catch(() => {});
    setStatus(`Track ${t + 1} uploaded to channel ${recordedChannel + 1}: ${result.dur}s, ${result.encoded.sampleCount} samples`);
  } catch (e) {
    setStatus('Upload error: ' + e.message);
    const pbar = document.getElementById(`pbar-${t}`);
    if (pbar) pbar.style.width = '0%';
  }
}

/** Encode an AudioBuffer as a 16-bit WAV blob. */
function audioBufferToWavBlob(audioBuf) {
  const nCh = audioBuf.numberOfChannels;
  const numFrames = audioBuf.length;
  const sampleRate = audioBuf.sampleRate;
  const dataSize = numFrames * nCh * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buf);

  dv.setUint32(0, 0x52494646);                        // 'RIFF'
  dv.setUint32(4, 36 + dataSize, true);
  dv.setUint32(8, 0x57415645);                        // 'WAVE'
  dv.setUint32(12, 0x666d7420);                       // 'fmt '
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);                          // PCM
  dv.setUint16(22, nCh, true);                        // channels
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * nCh * 2, true);       // byte rate
  dv.setUint16(32, nCh * 2, true);                    // block align
  dv.setUint16(34, 16, true);                         // bits per sample
  dv.setUint32(36, 0x64617461);                       // 'data'
  dv.setUint32(40, dataSize, true);

  const channels = [];
  for (let ch = 0; ch < nCh; ch++) channels.push(audioBuf.getChannelData(ch));

  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < nCh; ch++) {
      const s = Math.max(-1, Math.min(1, channels[ch][i]));
      dv.setInt16(44 + (i * nCh + ch) * 2, s < 0 ? s * 32768 : s * 32767, true);
    }
  }

  return new Blob([buf], { type: 'audio/wav' });
}

async function downloadTrack(t) {
  if (!port) { setStatus('Not connected'); return; }
  setStatus(`Reading track ${t + 1}...`);
  try {
    const data = await cmdRead(t);
    if (!data) { setStatus(`Track ${t + 1} is empty`); return; }

    const decoded = decodeTrackBlob(data);
    if (!decoded) { setStatus(`Track ${t + 1} decode failed`); return; }
    const audioBuf = decoded.audioBuf;

    const wavBlob = audioBufferToWavBlob(audioBuf);
    const url = URL.createObjectURL(wavBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `track${t + 1}.wav`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`Track ${t + 1} downloaded as WAV (${audioBuf.numberOfChannels}ch, ${audioBuf.length} frames)`);
  } catch (e) {
    setStatus('Download error: ' + e.message);
  }
}

async function eraseTrack(t) {
  if (!port) { setStatus('Not connected'); return; }
  if (!confirm(`Clear track ${t + 1}?`)) return;
  setStatus(`Erasing track ${t + 1}...`);
  try {
    await cmdErase(t);
    trackState[t].audioBuffer = null;
    trackState[t].cropStart = 0;
    trackState[t].cropEnd = 0;
    trackState[t].transients = [];
    trackState[t].cv1PitchEnabled = false;
    drawWaveform(t);
    document.getElementById(`info-${t}`).textContent = 'empty';
    document.getElementById(`cv1pitch-${t}`).checked = false;
    updateConnectButton();
    setStatus(`Track ${t + 1} cleared`);
  } catch (e) {
    setStatus('Erase error: ' + e.message);
  }
}

// Per-track preview state
const previewState = [];

function setPreviewButtonActive(t, active) {
  const btn = document.getElementById(`preview-btn-${t}`);
  if (!btn) return;
  btn.classList.toggle('active', active);
  btn.textContent = active ? 'Stop' : 'Preview';
}

function stopPreview(t, updateStatus = false) {
  const ps = previewState[t];
  if (!ps) return false;

  try { ps.src.onended = null; } catch (_) {}
  try { ps.src.stop(); } catch (_) {}
  try { ps.actx.close(); } catch (_) {}

  previewState[t] = null;
  const ph = document.getElementById(`playhead-${t}`);
  if (ph) ph.style.display = 'none';
  setPreviewButtonActive(t, false);
  if (updateStatus) setStatus(`Preview stopped for track ${t + 1}`);
  return true;
}

function stopAllPreviews(exceptTrack = -1) {
  for (let i = 0; i < previewState.length; i++) {
    if (i !== exceptTrack && previewState[i]) stopPreview(i, false);
  }
}

function previewTrack(t, forceRestart = false) {
  const st = trackState[t];
  if (!st.audioBuffer) { setStatus('No audio loaded'); return; }

  // Stop any existing preview on this track
  if (previewState[t]) {
    stopPreview(t, !forceRestart);
    if (!forceRestart) return;
  }

  stopAllPreviews(t);

  const speed = SPEEDS[st.speedIdx];
  const targetRate = recTargetRate(speed);
  const cropLen = st.cropEnd - st.cropStart;
  if (cropLen <= 0) { setStatus('No selection'); return; }

  const srcData = getSelectedChannelData(st);
  const cropped = srcData.slice(st.cropStart, st.cropEnd);
  const croppedBuf = new AudioBuffer({
    length: cropped.length,
    sampleRate: st.audioBuffer.sampleRate,
    numberOfChannels: 1
  });
  croppedBuf.getChannelData(0).set(cropped);
  const samples16 = resampleBuffer(croppedBuf, targetRate, 1.0);
  const enc = adpcmEncode(samples16);

  let pred = 0, si = 0;
  const decoded = new Float32Array(enc.sampleCount);
  let bi = 0, hi = false;
  for (let i = 0; i < enc.sampleCount; i++) {
    const b = enc.adpcmBytes[bi];
    const n = hi ? (b >> 4) : (b & 0xF);
    const step = IMA_STEP_TABLE[si];
    let d = step >> 3;
    if (n & 4) d += step; if (n & 2) d += step >> 1; if (n & 1) d += step >> 2;
    pred += (n & 8) ? -d : d;
    if (pred > 32767) pred = 32767; if (pred < -32768) pred = -32768;
    si += IMA_INDEX_TABLE[n & 0xF];
    if (si < 0) si = 0; if (si > 88) si = 88;
    decoded[i] = pred / 32768;
    if (hi) { bi++; hi = false; } else { hi = true; }
  }

  // Play at the TARGET rate so pitch matches the original
  const numFrames = decoded.length;
  const actx = new AudioContext({ sampleRate: Math.round(targetRate) });
  const buf = actx.createBuffer(1, numFrames, Math.round(targetRate));
  buf.getChannelData(0).set(decoded);
  const src = actx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.connect(actx.destination);
  src.onended = () => {
    actx.close();
    previewState[t] = null;
    const ph = document.getElementById(`playhead-${t}`);
    if (ph) ph.style.display = 'none';
    setPreviewButtonActive(t, false);
    setStatus('Preview ended');
  };
  const startTime = actx.currentTime;
  const duration = numFrames / targetRate;
  previewState[t] = { src, actx, startTime, duration, track: t };
  setPreviewButtonActive(t, true);
  src.start();

  // Animate playhead
  function animatePlayhead() {
    const ps = previewState[t];
    if (!ps) return;
    const elapsed = ps.actx.currentTime - ps.startTime;
    const progress = ps.duration > 0 ? ((elapsed % ps.duration) / ps.duration) : 0;
    const st2 = trackState[t];
    const len = st2.audioBuffer ? st2.audioBuffer.length : 1;
    const samplePos = st2.cropStart + progress * (st2.cropEnd - st2.cropStart);
    const container = document.getElementById(`wave-container-${t}`);
    const ph = document.getElementById(`playhead-${t}`);
    if (container && ph) {
      const px = (samplePos / len) * container.clientWidth;
      ph.style.left = px + 'px';
      ph.style.display = 'block';
    }
    requestAnimationFrame(animatePlayhead);
  }
  requestAnimationFrame(animatePlayhead);
  setStatus(`Preview ch ${getRecordedChannel(t) + 1}: ${duration.toFixed(2)}s, ADPCM at ${Math.round(targetRate)}Hz (${speed.name}, rec ${speedShiftToLabel(st.recordSpeedShift ?? 0)})`);
}

async function refreshInfo(options = {}) {
  const { quietErrors = false } = options;
  if (!port) return;
  try {
    const tracks = await cmdInfo(options);
    for (const t of tracks) {
      const el = document.getElementById(`info-${t.index}`);
      if (trackState[t.index] && t.recordedChannel !== null) {
        trackState[t.index].recordedChannel = t.recordedChannel;
        trackState[t.index].cv1PitchEnabled = t.cv1PitchEnabled !== false;
        const chSel = document.getElementById(`channel-${t.index}`);
        const cvSel = document.getElementById(`cv1pitch-${t.index}`);
        if (chSel) chSel.value = t.recordedChannel;
        if (cvSel) cvSel.checked = trackState[t.index].cv1PitchEnabled;
      }
      if (t.sampleCount > 0) {
        const dur = (t.sampleCount / 48000).toFixed(2);
        const spd = speedShiftToLabel(t.recordSpeedShift);
        const ch = trackState[t.index] ? getRecordedChannel(t.index) : (t.recordedChannel || 0);
        const cv = t.cv1PitchEnabled === false ? 'off' : 'on';
        el.textContent = `${t.sampleCount} samples (${dur}s at 1x), ${t.adpcmBytes} bytes, rec ${spd}, ch ${ch + 1}, cv ${cv}`;
      } else {
        el.textContent = 'empty';
      }
    }
    updateConnectButton();
    return tracks;
  } catch (e) {
    if (!quietErrors) setStatus('Info error: ' + e.message);
    throw e;
  }
}

/** Decode an MLR4 track blob (header + mono ADPCM) into an AudioBuffer. */
function decodeTrackBlob(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = dv.getUint32(0, true);
  if (magic !== MLR_MAGIC) return null;

  const sampleCount = dv.getUint32(4, true);
  const adpcmBytes = dv.getUint32(8, true);
  const recordSpeedShift = dv.getInt8(16);
  const recordedChannel = dv.getUint8(17) & 0x01;
  const cv1PitchEnabled = dv.getUint8(19) !== 1;
  if (sampleCount === 0) return null;

  const adpcmData = data.slice(MLR_HEADER_SIZE, MLR_HEADER_SIZE + adpcmBytes);
  const storedSampleRate = Math.max(3000, Math.round(48000 * speedShiftToRatio(recordSpeedShift)));

  let predictor = 0, stepIndex = 0;
  const pcm = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const b = adpcmData[i >> 1];
    const nybble = (i & 1) ? (b >> 4) : (b & 0xF);
    const step = IMA_STEP_TABLE[stepIndex];
    let delta = step >> 3;
    if (nybble & 4) delta += step;
    if (nybble & 2) delta += step >> 1;
    if (nybble & 1) delta += step >> 2;
    predictor += (nybble & 8) ? -delta : delta;
    if (predictor > 32767) predictor = 32767;
    if (predictor < -32768) predictor = -32768;
    stepIndex += IMA_INDEX_TABLE[nybble & 0xF];
    if (stepIndex < 0) stepIndex = 0;
    if (stepIndex > 88) stepIndex = 88;
    pcm[i] = predictor / 32768;
  }
  const buf = new AudioBuffer({ length: sampleCount, sampleRate: storedSampleRate, numberOfChannels: 1 });
  buf.getChannelData(0).set(pcm);
  return { audioBuf: buf, recordSpeedShift, recordedChannel, cv1PitchEnabled };
}

/** Read all tracks from device and populate waveform displays */
async function readAllTracks() {
  if (!port) return;
  const trackInfo = deviceTrackInfo.length === MLR_NUM_TRACKS ? deviceTrackInfo : await cmdInfo();
  const nonEmptyTracks = trackInfo.filter(t => t.sampleCount > 0);
  let nonEmptyIndex = 0;

  for (let t = 0; t < MLR_NUM_TRACKS; t++) {
    const info = trackInfo[t];
    if (!info || info.sampleCount === 0) {
      if (info && info.recordedChannel !== null) {
        trackState[t].recordedChannel = info.recordedChannel;
        trackState[t].cv1PitchEnabled = info.cv1PitchEnabled !== false;
        const chSel = document.getElementById(`channel-${t}`);
        const cvSel = document.getElementById(`cv1pitch-${t}`);
        if (chSel) chSel.value = info.recordedChannel;
        if (cvSel) cvSel.checked = trackState[t].cv1PitchEnabled;
      }
      trackState[t].audioBuffer = null;
      trackState[t].cropStart = 0;
      trackState[t].cropEnd = 0;
      trackState[t].transients = [];
      drawWaveform(t);
      continue;
    }

    nonEmptyIndex++;
    setStatus(`Reading track ${t + 1} (${nonEmptyIndex} of ${nonEmptyTracks.length})...`);
    await yieldToUi();
    let data = null;
    let lastProgressTime = 0;
    let lastProgressPercent = -1;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        data = await cmdRead(t, (pct, received, totalLen) => {
          const percent = Math.round(pct * 100);
          const now = Date.now();
          if (percent !== lastProgressPercent && (percent === 100 || now - lastProgressTime >= 150)) {
            lastProgressTime = now;
            lastProgressPercent = percent;
            if (percent % 10 === 0 || percent === 100) {
              console.debug(`Track ${t + 1} read progress: ${received}/${totalLen} bytes (${percent}%)`);
            }
            setStatus(`Reading track ${t + 1} (${nonEmptyIndex} of ${nonEmptyTracks.length})... ${percent}%`);
          }
        });
        break;
      } catch (e) {
        console.warn(`Track ${t + 1} read attempt ${attempt + 1}/3 failed:`, e);
        if (attempt < 2) {
          setStatus(`Track ${t + 1} read interrupted, retrying...`);
          await new Promise(r => setTimeout(r, 500));
        } else {
          console.error(`Track ${t + 1} read failed after 3 attempts:`, e);
          throw e;
        }
      }
    }
    if (data === null) {
      trackState[t].audioBuffer = null;
      trackState[t].cropStart = 0;
      trackState[t].cropEnd = 0;
      trackState[t].transients = [];
    } else {
      setStatus(`Processing track ${t + 1} (${nonEmptyIndex} of ${nonEmptyTracks.length})...`);
      await yieldToUi();
      const decoded = decodeTrackBlob(data);
      if (decoded) {
        trackState[t].audioBuffer = decoded.audioBuf;
        trackState[t].transients = detectTransients(decoded.audioBuf);
        trackState[t].cropStart = 0;
        trackState[t].cropEnd = decoded.audioBuf.length;
        trackState[t].speedIdx = speedShiftToIdx(decoded.recordSpeedShift);
        trackState[t].recordSpeedShift = decoded.recordSpeedShift;
        trackState[t].recordedChannel = decoded.recordedChannel;
        trackState[t].cv1PitchEnabled = decoded.cv1PitchEnabled;
        document.getElementById(`speed-${t}`).value = trackState[t].speedIdx;
        document.getElementById(`channel-${t}`).value = trackState[t].recordedChannel;
        document.getElementById(`cv1pitch-${t}`).checked = trackState[t].cv1PitchEnabled;
        updateCropForSpeed(t);
        drawWaveform(t);
      } else {
        throw new Error(`Track ${t + 1} decode failed`);
      }
    }
    drawWaveform(t);
    await yieldToUi();
  }
  setStatus('All tracks loaded');
}

/** Update speed dropdowns and heading after connection. */
function updateUIForDeviceMode() {
  document.querySelector('h1').textContent = 'MLRws Sample Manager';
  document.title = 'MLRws Sample Manager';
  for (let t = 0; t < MLR_NUM_TRACKS; t++) {
    const sel = document.getElementById(`speed-${t}`);
    if (!sel) continue;
    const maxSecs = (s) => (getMaxSamples() / recTargetRate(s)).toFixed(1);
    for (let i = 0; i < SPEEDS.length; i++) {
      sel.options[i].text = `${SPEEDS[i].name} (${maxSecs(SPEEDS[i])}s)`;
    }
    if (trackState[t] && trackState[t].audioBuffer) {
      updateCropForSpeed(t);
    }
  }
}

// ---- Init ----
let browserSupported = true;
try {
  assertSupportedBrowser();
} catch (e) {
  browserSupported = false;
  setUnsupportedBrowserError(e.message);
  console.error(e);
}

document.getElementById('connect-btn').addEventListener('click', async () => {
  if (!browserSupported) return;

  if (isSerialConnected()) {
    await manualSerialDisconnect();
    return;
  }

  try {
    isManualDisconnect = false;
    clearAutoReconnectTimer();
    await serialConnect();
    await initialiseDeviceConnection();
    await rememberConnectedPort();
  } catch (e) {
    if (port || reader || writer) {
      await serialDisconnect(false);
    }
    setStatus('Connection error: ' + e.message);
  }
});

createTrackUI();
updateConnectButton();

document.addEventListener('dragover', (e) => {
  if (Array.from(e.dataTransfer?.types || []).includes('Files')) {
    e.preventDefault();
  }
});

document.addEventListener('drop', (e) => {
  if (Array.from(e.dataTransfer?.types || []).includes('Files')) {
    e.preventDefault();
  }
});

if (navigator.serial && typeof navigator.serial.addEventListener === 'function') {
  navigator.serial.addEventListener('connect', (event) => {
    if (!autoReconnectEnabled || isSerialConnected() || !selectedPort) return;

    const eventPort = event?.port || event?.target;
    if (eventPort && !isSamePort(eventPort, selectedPort, selectedPortInfo)) return;

    scheduleAutoReconnect(150);
  });

  navigator.serial.addEventListener('disconnect', async (event) => {
    const eventPort = event?.port || event?.target;
    if (eventPort && selectedPort && !isSamePort(eventPort, selectedPort, selectedPortInfo)) return;

    if (!eventPort || eventPort === port || isSamePort(eventPort, port, selectedPortInfo)) {
      await handleUnexpectedDisconnect('Device disconnected');
    }
  });
}

window.addEventListener('resize', () => {
  for (let t = 0; t < MLR_NUM_TRACKS; t++) drawWaveform(t);
});
