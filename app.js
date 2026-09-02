"use strict";

/* ---------- Constants ---------- */
const PAD_COUNT = 16;
const COLORS = [
  "#ff3e3e", "#ff8a3e", "#ffd23e", "#8aff3e",
  "#3effc4", "#3ea0ff", "#7a5cff", "#ff5cd0",
  "#ff5c7a", "#5cffb0", "#5cd0ff", "#c45cff"
];
const PADS_KEY = "spinner_pads_v1";
const VOLUME_KEY = "spinner_volume_v1";

/* ---------- IndexedDB (sound library) ---------- */
let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open("spinner-db", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("sounds")) {
        db.createObjectStore("sounds", { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function dbAdd(sound) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("sounds", "readwrite");
    const req = tx.objectStore("sounds").add(sound);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("sounds", "readonly");
    const req = tx.objectStore("sounds").getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("sounds", "readwrite");
    const req = tx.objectStore("sounds").delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbRename(id, name) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("sounds", "readwrite");
    const store = tx.objectStore("sounds");
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (!rec) return resolve();
      rec.name = name;
      const putReq = store.put(rec);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

/* ---------- State ---------- */
let library = [];               // [{id, name, blob, type}]
let pads = loadPads();          // [{label, color, soundId}] x16
let masterVolume = loadVolume();
let editMode = false;
let assignTargetPad = null;     // index of pad being edited, or "playlist-upload"
let pendingColor = null;

const decodedCache = new Map(); // soundId -> AudioBuffer
const objectUrlCache = new Map(); // soundId -> blob url

let audioCtx = null;
let masterGain = null;

function loadPads() {
  try {
    const raw = localStorage.getItem(PADS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length === PAD_COUNT) return arr;
    }
  } catch (e) {}
  return Array.from({ length: PAD_COUNT }, () => ({ label: "", color: null, soundId: null }));
}

function savePads() {
  localStorage.setItem(PADS_KEY, JSON.stringify(pads));
}

function loadVolume() {
  const v = parseFloat(localStorage.getItem(VOLUME_KEY));
  return Number.isFinite(v) ? v : 80;
}

function saveVolume() {
  localStorage.setItem(VOLUME_KEY, String(masterVolume));
}

/* ---------- Audio engine ---------- */
function ensureAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = masterVolume / 100;
    masterGain.connect(audioCtx.destination);
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function setMasterVolume(v) {
  masterVolume = v;
  if (masterGain) masterGain.gain.value = v / 100;
  if (playlistAudio) playlistAudio.volume = v / 100;
  saveVolume();
}

function getSoundById(id) {
  return library.find((s) => s.id === id) || null;
}

async function getDecodedBuffer(soundId) {
  if (decodedCache.has(soundId)) return decodedCache.get(soundId);
  const sound = getSoundById(soundId);
  if (!sound) return null;
  const ctx = ensureAudioCtx();
  const arrBuf = await sound.blob.arrayBuffer();
  const audioBuffer = await ctx.decodeAudioData(arrBuf.slice(0));
  decodedCache.set(soundId, audioBuffer);
  return audioBuffer;
}

function getObjectUrl(soundId) {
  if (objectUrlCache.has(soundId)) return objectUrlCache.get(soundId);
  const sound = getSoundById(soundId);
  if (!sound) return null;
  const url = URL.createObjectURL(sound.blob);
  objectUrlCache.set(soundId, url);
  return url;
}

const activeSources = new Map(); // padIndex -> {source, node}

async function playPad(padIndex) {
  const pad = pads[padIndex];
  if (!pad || !pad.soundId) return;
  try {
    const ctx = ensureAudioCtx();
    const buffer = await getDecodedBuffer(pad.soundId);
    if (!buffer) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(masterGain);
    source.start(0);
    setPadPlaying(padIndex, true);
    const prev = activeSources.get(padIndex);
    if (prev) prev.push(source); else activeSources.set(padIndex, [source]);
    source.onended = () => {
      const list = activeSources.get(padIndex) || [];
      const idx = list.indexOf(source);
      if (idx >= 0) list.splice(idx, 1);
      if (list.length === 0) {
        activeSources.delete(padIndex);
        setPadPlaying(padIndex, false);
      }
    };
  } catch (err) {
    console.error(err);
    showToast("Cannot play sound");
  }
}

function stopAll() {
  for (const [padIndex, sources] of activeSources.entries()) {
    sources.forEach((s) => { try { s.stop(); } catch (e) {} });
    setPadPlaying(padIndex, false);
  }
  activeSources.clear();
  stopPlaylist();
}

function setPadPlaying(padIndex, isPlaying) {
  const el = boardEl.children[padIndex];
  if (!el) return;
  el.classList.toggle("playing", isPlaying);
}

/* ---------- DOM refs ---------- */
const boardEl = document.getElementById("board");
const editModeBtn = document.getElementById("editModeBtn");
const playlistBtn = document.getElementById("playlistBtn");
const uploadBtn = document.getElementById("uploadBtn");
const volumeBtn = document.getElementById("volumeBtn");
const fileInput = document.getElementById("fileInput");

const assignSheet = document.getElementById("assignSheet");
const padLabelInput = document.getElementById("padLabelInput");
const colorSwatches = document.getElementById("colorSwatches");
const assignSoundList = document.getElementById("assignSoundList");
const assignUploadBtn = document.getElementById("assignUploadBtn");
const clearPadBtn = document.getElementById("clearPadBtn");
const savePadBtn = document.getElementById("savePadBtn");

const playlistSheet = document.getElementById("playlistSheet");
const playlistList = document.getElementById("playlistList");
const playlistUploadBtn = document.getElementById("playlistUploadBtn");
const nowPlaying = document.getElementById("nowPlaying");
const npTitle = document.getElementById("npTitle");
const npSeek = document.getElementById("npSeek");
const npCur = document.getElementById("npCur");
const npDur = document.getElementById("npDur");
const npPlayPause = document.getElementById("npPlayPause");
const npPrev = document.getElementById("npPrev");
const npNext = document.getElementById("npNext");
const npStop = document.getElementById("npStop");

const volumeSheet = document.getElementById("volumeSheet");
const masterVolumeSlider = document.getElementById("masterVolumeSlider");
const volumeValue = document.getElementById("volumeValue");
const stopAllBtn = document.getElementById("stopAllBtn");

const toastEl = document.getElementById("toast");

/* ---------- Toast ---------- */
let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 1800);
}

/* ---------- Board rendering ---------- */
function renderBoard() {
  boardEl.innerHTML = "";
  pads.forEach((pad, i) => {
    const btn = document.createElement("button");
    btn.className = "pad" + (pad.soundId ? "" : " empty") + (editMode ? " edit-mode" : "");
    const label = document.createElement("span");
    label.className = "pad-label";
    const sound = pad.soundId ? getSoundById(pad.soundId) : null;
    label.textContent = pad.label || (sound ? sound.name : `PAD ${i + 1}`);
    btn.appendChild(label);
    if (pad.color) {
      btn.style.background = pad.color + "33";
      btn.style.borderColor = pad.color;
      btn.style.color = pad.color;
      label.style.color = "#fff";
    }
    attachPadEvents(btn, i);
    boardEl.appendChild(btn);
  });
}

function attachPadEvents(btn, index) {
  let longPressTimer = null;
  let longPressed = false;
  let startX = 0, startY = 0;

  const start = (x, y) => {
    longPressed = false;
    startX = x; startY = y;
    longPressTimer = setTimeout(() => {
      longPressed = true;
      openAssignSheet(index);
    }, 480);
  };
  const move = (x, y) => {
    if (Math.hypot(x - startX, y - startY) > 12 && longPressTimer) {
      clearTimeout(longPressTimer);
    }
  };
  const end = () => {
    clearTimeout(longPressTimer);
    if (longPressed) return;
    if (editMode) {
      openAssignSheet(index);
    } else if (pads[index].soundId) {
      playPad(index);
    } else {
      openAssignSheet(index);
    }
  };

  btn.addEventListener("touchstart", (e) => start(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
  btn.addEventListener("touchmove", (e) => move(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
  btn.addEventListener("touchend", (e) => { e.preventDefault(); end(); });

  btn.addEventListener("mousedown", (e) => start(e.clientX, e.clientY));
  btn.addEventListener("mousemove", (e) => move(e.clientX, e.clientY));
  btn.addEventListener("mouseup", (e) => end());
}

/* ---------- Assign sheet ---------- */
function openAssignSheet(padIndex) {
  assignTargetPad = padIndex;
  const pad = pads[padIndex];
  padLabelInput.value = pad.label || "";
  pendingColor = pad.color;
  renderColorSwatches();
  renderAssignSoundList();
  openSheet(assignSheet);
}

function renderColorSwatches() {
  colorSwatches.innerHTML = "";
  COLORS.forEach((c) => {
    const sw = document.createElement("button");
    sw.className = "swatch" + (pendingColor === c ? " selected" : "");
    sw.style.background = c;
    sw.addEventListener("click", () => {
      pendingColor = pendingColor === c ? null : c;
      renderColorSwatches();
    });
    colorSwatches.appendChild(sw);
  });
}

function renderAssignSoundList() {
  assignSoundList.innerHTML = "";
  if (library.length === 0) {
    assignSoundList.innerHTML = '<div class="empty-hint">No sounds yet. Upload one below.</div>';
    return;
  }
  const pad = pads[assignTargetPad];
  library.forEach((sound) => {
    const row = document.createElement("div");
    row.className = "sound-row" + (pad.soundId === sound.id ? " selected" : "");
    const name = document.createElement("div");
    name.className = "sound-name";
    name.textContent = sound.name;
    row.appendChild(name);
    row.addEventListener("click", () => {
      pad.soundId = sound.id;
      renderAssignSoundList();
    });
    assignSoundList.appendChild(row);
  });
}

assignUploadBtn.addEventListener("click", () => {
  triggerUpload("assign");
});

savePadBtn.addEventListener("click", () => {
  const pad = pads[assignTargetPad];
  pad.label = padLabelInput.value.trim();
  pad.color = pendingColor;
  savePads();
  renderBoard();
  closeSheet(assignSheet);
});

clearPadBtn.addEventListener("click", () => {
  const pad = pads[assignTargetPad];
  pad.soundId = null;
  pad.label = "";
  pad.color = null;
  savePads();
  renderBoard();
  closeSheet(assignSheet);
});

/* ---------- Edit mode toggle ---------- */
editModeBtn.addEventListener("click", () => {
  editMode = !editMode;
  editModeBtn.classList.toggle("active", editMode);
  editModeBtn.textContent = editMode ? "Done" : "Edit";
  renderBoard();
});

/* ---------- Upload flow ---------- */
let uploadContext = "library"; // "library" | "assign" | "playlist"
function triggerUpload(context) {
  uploadContext = context;
  fileInput.value = "";
  fileInput.click();
}

uploadBtn.addEventListener("click", () => triggerUpload("library"));
playlistUploadBtn.addEventListener("click", () => triggerUpload("playlist"));

fileInput.addEventListener("change", async () => {
  const files = Array.from(fileInput.files || []);
  if (files.length === 0) return;
  let lastId = null;
  for (const file of files) {
    if (!file.type.startsWith("audio/") && !/\.(mp3|wav|m4a|ogg|oga|aac|flac|opus|wma|aiff)$/i.test(file.name)) {
      continue;
    }
    const name = file.name.replace(/\.[^/.]+$/, "");
    const id = await dbAdd({ name, blob: file, type: file.type });
    library.push({ id, name, blob: file, type: file.type });
    lastId = id;
  }
  if (lastId === null) {
    showToast("No valid audio files");
    return;
  }
  showToast(files.length > 1 ? `${files.length} sounds added` : "Sound added");

  if (uploadContext === "assign" && assignTargetPad !== null) {
    pads[assignTargetPad].soundId = lastId;
    renderAssignSoundList();
  } else if (uploadContext === "playlist") {
    renderPlaylistList();
  }
});

/* ---------- Playlist ---------- */
let playlistAudio = null;
let playlistCurrentIndex = -1;

function ensurePlaylistAudio() {
  if (!playlistAudio) {
    playlistAudio = new Audio();
    playlistAudio.volume = masterVolume / 100;
    playlistAudio.addEventListener("timeupdate", updateNowPlayingProgress);
    playlistAudio.addEventListener("loadedmetadata", updateNowPlayingProgress);
    playlistAudio.addEventListener("ended", () => playNextInPlaylist());
    playlistAudio.addEventListener("play", () => { npPlayPause.textContent = "⏸"; });
    playlistAudio.addEventListener("pause", () => { npPlayPause.textContent = "▶"; });
  }
  return playlistAudio;
}

function renderPlaylistList() {
  playlistList.innerHTML = "";
  if (library.length === 0) {
    playlistList.innerHTML = '<div class="empty-hint">No songs yet. Add some below.</div>';
    return;
  }
  library.forEach((sound, idx) => {
    const row = document.createElement("div");
    row.className = "sound-row" + (playlistCurrentIndex === idx ? " selected" : "");
    const name = document.createElement("div");
    name.className = "sound-name";
    name.textContent = sound.name;
    row.appendChild(name);

    const renameBtn = document.createElement("button");
    renameBtn.textContent = "✎";
    renameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const newName = prompt("Rename sound", sound.name);
      if (newName && newName.trim()) {
        sound.name = newName.trim();
        dbRename(sound.id, sound.name);
        renderPlaylistList();
        renderBoard();
      }
    });

    const delBtn = document.createElement("button");
    delBtn.textContent = "🗑";
    delBtn.className = "del-btn";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${sound.name}"?`)) return;
      deleteSound(sound.id);
    });

    row.appendChild(renameBtn);
    row.appendChild(delBtn);

    row.addEventListener("click", () => playPlaylistIndex(idx));
    playlistList.appendChild(row);
  });
}

async function deleteSound(soundId) {
  await dbDelete(soundId);
  library = library.filter((s) => s.id !== soundId);
  pads.forEach((p) => { if (p.soundId === soundId) p.soundId = null; });
  savePads();
  decodedCache.delete(soundId);
  const url = objectUrlCache.get(soundId);
  if (url) { URL.revokeObjectURL(url); objectUrlCache.delete(soundId); }
  renderBoard();
  renderPlaylistList();
  renderAssignSoundList();
  showToast("Deleted");
}

function playPlaylistIndex(idx) {
  const sound = library[idx];
  if (!sound) return;
  playlistCurrentIndex = idx;
  const audio = ensurePlaylistAudio();
  const url = getObjectUrl(sound.id);
  audio.src = url;
  audio.play().catch(() => {});
  npTitle.textContent = sound.name;
  nowPlaying.classList.remove("hidden");
  renderPlaylistList();
}

function playNextInPlaylist() {
  if (library.length === 0) return;
  const next = (playlistCurrentIndex + 1) % library.length;
  playPlaylistIndex(next);
}

function playPrevInPlaylist() {
  if (library.length === 0) return;
  const prev = (playlistCurrentIndex - 1 + library.length) % library.length;
  playPlaylistIndex(prev);
}

function stopPlaylist() {
  if (playlistAudio) {
    playlistAudio.pause();
    playlistAudio.currentTime = 0;
  }
  playlistCurrentIndex = -1;
  nowPlaying.classList.add("hidden");
  renderPlaylistList();
}

function formatTime(sec) {
  if (!Number.isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

let seeking = false;
function updateNowPlayingProgress() {
  if (!playlistAudio || seeking) return;
  const { currentTime, duration } = playlistAudio;
  npCur.textContent = formatTime(currentTime);
  npDur.textContent = formatTime(duration);
  if (duration) npSeek.value = String((currentTime / duration) * 100);
}

npSeek.addEventListener("input", () => { seeking = true; });
npSeek.addEventListener("change", () => {
  if (playlistAudio && playlistAudio.duration) {
    playlistAudio.currentTime = (parseFloat(npSeek.value) / 100) * playlistAudio.duration;
  }
  seeking = false;
});

npPlayPause.addEventListener("click", () => {
  if (!playlistAudio) return;
  if (playlistAudio.paused) playlistAudio.play().catch(() => {});
  else playlistAudio.pause();
});
npPrev.addEventListener("click", playPrevInPlaylist);
npNext.addEventListener("click", playNextInPlaylist);
npStop.addEventListener("click", stopPlaylist);

/* ---------- Volume sheet ---------- */
masterVolumeSlider.addEventListener("input", () => {
  const v = parseInt(masterVolumeSlider.value, 10);
  setMasterVolume(v);
  volumeValue.textContent = `${v}%`;
});
stopAllBtn.addEventListener("click", stopAll);

/* ---------- Sheet open/close plumbing ---------- */
function openSheet(sheet) {
  ensureAudioCtx();
  sheet.classList.remove("hidden");
}
function closeSheet(sheet) {
  sheet.classList.add("hidden");
}
document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => closeSheet(document.getElementById(btn.dataset.close)));
});
document.querySelectorAll(".sheet").forEach((sheet) => {
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet) closeSheet(sheet);
  });
});

playlistBtn.addEventListener("click", () => {
  renderPlaylistList();
  openSheet(playlistSheet);
});
volumeBtn.addEventListener("click", () => {
  masterVolumeSlider.value = String(masterVolume);
  volumeValue.textContent = `${masterVolume}%`;
  openSheet(volumeSheet);
});

/* ---------- Init ---------- */
async function init() {
  renderBoard();
  try {
    library = await dbGetAll();
  } catch (e) {
    console.error(e);
    library = [];
  }
  renderBoard();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
