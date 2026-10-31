"use strict";

/* ---------- Constants ---------- */
const PAD_COUNT = 64; // 8 columns x 8 rows
const COLORS = [
  "#ff3e3e", "#ff8a3e", "#ffd23e", "#8aff3e",
  "#3effc4", "#3ea0ff", "#7a5cff", "#ff5cd0",
  "#ff5c7a", "#5cffb0", "#5cd0ff", "#c45cff"
];
const PADS_KEY = "spinner_pads_v1";
const VOLUME_KEY = "spinner_volume_v1";
const TEMPLATES_KEY = "spinner_templates_v1";

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
let masterPaused = false;
let assignTargetPad = null;     // index of pad being edited
let pendingColor = null;
let templatesData = loadTemplates(); // { categories: [{id, name, subcategories: [{id, name, pads}]}] }

const decodedCache = new Map(); // soundId -> AudioBuffer

let audioCtx = null;
let masterGain = null;

function loadPads() {
  try {
    const raw = localStorage.getItem(PADS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        if (arr.length === PAD_COUNT) return arr;
        // grid size changed since last save (e.g. 4x4 -> 8x8): keep existing
        // pad assignments in place rather than wiping them out
        return Array.from({ length: PAD_COUNT }, (_, i) => arr[i] || { label: "", color: null, soundId: null });
      }
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

function loadTemplates() {
  try {
    const raw = localStorage.getItem(TEMPLATES_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.categories)) return data;
    }
  } catch (e) {}
  return { categories: [] };
}

function saveTemplates() {
  localStorage.setItem(TEMPLATES_KEY, JSON.stringify(templatesData));
}

function genId() {
  return window.crypto && crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
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
  if (audioCtx.state === "suspended" && !masterPaused) audioCtx.resume();
  return audioCtx;
}

function setMasterVolume(v) {
  masterVolume = v;
  if (masterGain) masterGain.gain.value = v / 100;
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
  if (masterPaused) setPaused(false);
  for (const [padIndex, sources] of activeSources.entries()) {
    sources.forEach((s) => { try { s.stop(); } catch (e) {} });
    setPadPlaying(padIndex, false);
  }
  activeSources.clear();
}

function setPaused(paused) {
  masterPaused = paused;
  if (paused) {
    if (audioCtx && audioCtx.state === "running") audioCtx.suspend();
    pauseBtn.textContent = "Resume";
    pauseBtn.classList.add("active");
  } else {
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    pauseBtn.textContent = "Pause";
    pauseBtn.classList.remove("active");
  }
}

function setPadPlaying(padIndex, isPlaying) {
  const el = boardEl.children[padIndex];
  if (!el) return;
  el.classList.toggle("playing", isPlaying);
}

/* ---------- DOM refs ---------- */
const boardEl = document.getElementById("board");
const templatesBtn = document.getElementById("templatesBtn");
const editModeBtn = document.getElementById("editModeBtn");
const newProjectHeaderBtn = document.getElementById("newProjectHeaderBtn");
const quickSaveTemplateBtn = document.getElementById("quickSaveTemplateBtn");
const uploadBtn = document.getElementById("uploadBtn");
const pauseBtn = document.getElementById("pauseBtn");
const stopBtn = document.getElementById("stopBtn");
const volumeBtn = document.getElementById("volumeBtn");
const fileInput = document.getElementById("fileInput");

const assignSheet = document.getElementById("assignSheet");
const padLabelInput = document.getElementById("padLabelInput");
const colorSwatches = document.getElementById("colorSwatches");
const assignSoundList = document.getElementById("assignSoundList");
const assignUploadBtn = document.getElementById("assignUploadBtn");
const clearPadBtn = document.getElementById("clearPadBtn");
const savePadBtn = document.getElementById("savePadBtn");

const librarySheet = document.getElementById("librarySheet");
const libraryList = document.getElementById("libraryList");
const libraryUploadBtn = document.getElementById("libraryUploadBtn");

const templatesSheet = document.getElementById("templatesSheet");
const templatesList = document.getElementById("templatesList");
const saveTemplateBtn = document.getElementById("saveTemplateBtn");
const newProjectBtn = document.getElementById("newProjectBtn");

const startSheet = document.getElementById("startSheet");
const startNewBtn = document.getElementById("startNewBtn");
const startOpenBtn = document.getElementById("startOpenBtn");
const startLiveBtn = document.getElementById("startLiveBtn");

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
let uploadContext = "library"; // "library" | "assign"
function triggerUpload(context) {
  uploadContext = context;
  fileInput.value = "";
  fileInput.click();
}

uploadBtn.addEventListener("click", () => {
  renderLibraryList();
  openSheet(librarySheet);
});
libraryUploadBtn.addEventListener("click", () => triggerUpload("library"));

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
  } else if (uploadContext === "library") {
    renderLibraryList();
  }
});

/* ---------- Sound Library (rename/delete uploaded sounds) ---------- */
function renderLibraryList() {
  libraryList.innerHTML = "";
  if (library.length === 0) {
    libraryList.innerHTML = '<div class="empty-hint">No sounds yet. Upload some below.</div>';
    return;
  }
  library.forEach((sound) => {
    const row = document.createElement("div");
    row.className = "sound-row";
    const name = document.createElement("div");
    name.className = "sound-name";
    name.textContent = sound.name;
    row.appendChild(name);

    const renameBtn = document.createElement("button");
    renameBtn.textContent = "Rename";
    renameBtn.addEventListener("click", () => {
      const newName = prompt("Rename sound", sound.name);
      if (newName && newName.trim()) {
        sound.name = newName.trim();
        dbRename(sound.id, sound.name);
        renderLibraryList();
        renderBoard();
      }
    });

    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.className = "del-btn";
    delBtn.addEventListener("click", () => {
      if (!confirm(`Delete "${sound.name}"? Any pad using it will be cleared.`)) return;
      deleteSound(sound.id);
    });

    row.appendChild(renameBtn);
    row.appendChild(delBtn);
    libraryList.appendChild(row);
  });
}

async function deleteSound(soundId) {
  await dbDelete(soundId);
  library = library.filter((s) => s.id !== soundId);
  pads.forEach((p) => { if (p.soundId === soundId) p.soundId = null; });
  savePads();
  decodedCache.delete(soundId);
  renderBoard();
  renderLibraryList();
  renderAssignSoundList();
  showToast("Deleted");
}

/* ---------- Volume sheet ---------- */
masterVolumeSlider.addEventListener("input", () => {
  const v = parseInt(masterVolumeSlider.value, 10);
  setMasterVolume(v);
  volumeValue.textContent = `${v}%`;
});
stopAllBtn.addEventListener("click", stopAll);
pauseBtn.addEventListener("click", () => setPaused(!masterPaused));
stopBtn.addEventListener("click", stopAll);

/* ---------- Templates (category > sub-template presets) ---------- */
const expandedCategories = new Set();

function renderTemplatesList() {
  templatesList.innerHTML = "";
  const categories = templatesData.categories;
  if (categories.length === 0) {
    templatesList.innerHTML = '<div class="empty-hint">No templates yet. Set up your pads, then tap "Save Current Project as Template" below.</div>';
    return;
  }
  categories.forEach((cat) => {
    const hasSubs = cat.subcategories.length > 0;
    const isExpanded = expandedCategories.has(cat.id);

    const catEl = document.createElement("div");
    catEl.className = "template-category";

    const header = document.createElement("div");
    header.className = "template-category-header" + (hasSubs ? " expandable" : "") + (isExpanded ? " expanded" : "");

    if (hasSubs) {
      const chevron = document.createElement("span");
      chevron.className = "chevron";
      header.appendChild(chevron);
    }

    const nameEl = document.createElement("span");
    nameEl.className = "cat-name";
    nameEl.textContent = cat.name;
    header.appendChild(nameEl);

    const renameCatBtn = document.createElement("button");
    renameCatBtn.textContent = "Rename";
    renameCatBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const name = prompt("Rename category", cat.name);
      if (name && name.trim()) {
        cat.name = name.trim();
        saveTemplates();
        renderTemplatesList();
      }
    });
    const delCatBtn = document.createElement("button");
    delCatBtn.textContent = "Delete";
    delCatBtn.className = "del-btn";
    delCatBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!confirm(`Delete category "${cat.name}" and all its templates inside?`)) return;
      templatesData.categories = templatesData.categories.filter((c) => c.id !== cat.id);
      expandedCategories.delete(cat.id);
      saveTemplates();
      renderTemplatesList();
    });
    header.appendChild(renameCatBtn);
    header.appendChild(delCatBtn);

    if (hasSubs) {
      header.addEventListener("click", () => {
        if (expandedCategories.has(cat.id)) expandedCategories.delete(cat.id);
        else expandedCategories.add(cat.id);
        renderTemplatesList();
      });
    }
    catEl.appendChild(header);

    if (hasSubs && isExpanded) {
      cat.subcategories.forEach((sub) => {
        const row = document.createElement("div");
        row.className = "sound-row template-sub-row";
        const name = document.createElement("div");
        name.className = "sound-name";
        name.textContent = sub.name;
        row.appendChild(name);

        const renameSubBtn = document.createElement("button");
        renameSubBtn.textContent = "Rename";
        renameSubBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const name = prompt("Rename template", sub.name);
          if (name && name.trim()) {
            sub.name = name.trim();
            saveTemplates();
            renderTemplatesList();
          }
        });
        const delSubBtn = document.createElement("button");
        delSubBtn.textContent = "Delete";
        delSubBtn.className = "del-btn";
        delSubBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!confirm(`Delete template "${sub.name}"?`)) return;
          cat.subcategories = cat.subcategories.filter((s) => s.id !== sub.id);
          saveTemplates();
          renderTemplatesList();
        });
        row.appendChild(renameSubBtn);
        row.appendChild(delSubBtn);

        row.addEventListener("click", () => loadTemplate(cat, sub));
        catEl.appendChild(row);
      });
    }

    templatesList.appendChild(catEl);
  });
}

function loadTemplate(cat, sub) {
  if (!confirm(`Load "${sub.name}" (${cat.name})? This replaces your current project.`)) return;
  let loaded = Array.isArray(sub.pads) ? JSON.parse(JSON.stringify(sub.pads)) : [];
  if (loaded.length !== PAD_COUNT) {
    loaded = Array.from({ length: PAD_COUNT }, (_, i) => loaded[i] || { label: "", color: null, soundId: null });
  }
  pads = loaded;
  savePads();
  renderBoard();
  closeSheet(templatesSheet);
  showToast(`Loaded: ${cat.name} > ${sub.name}`);
}

function saveCurrentAsTemplate() {
  const existingCatNames = templatesData.categories.map((c) => c.name).join(", ");
  const catInput = prompt(
    existingCatNames ? `Category name (existing: ${existingCatNames})` : "Category name (e.g. Birthday, Wedding)",
    ""
  );
  if (!catInput || !catInput.trim()) return;
  const catName = catInput.trim();

  const subInput = prompt('Template name within "' + catName + '" (e.g. Kids, 7th Birthday Boy)', "");
  if (!subInput || !subInput.trim()) return;
  const subName = subInput.trim();

  let cat = templatesData.categories.find((c) => c.name.toLowerCase() === catName.toLowerCase());
  if (!cat) {
    cat = { id: genId(), name: catName, subcategories: [] };
    templatesData.categories.push(cat);
  }

  const padsCopy = JSON.parse(JSON.stringify(pads));
  const existingSub = cat.subcategories.find((s) => s.name.toLowerCase() === subName.toLowerCase());
  if (existingSub) {
    if (!confirm(`"${subName}" already exists under ${cat.name}. Overwrite it?`)) return;
    existingSub.pads = padsCopy;
  } else {
    cat.subcategories.push({ id: genId(), name: subName, pads: padsCopy });
  }
  expandedCategories.add(cat.id);
  saveTemplates();
  renderTemplatesList();
  showToast(`Saved: ${cat.name} > ${subName}`);
}

templatesBtn.addEventListener("click", () => {
  renderTemplatesList();
  openSheet(templatesSheet);
});
saveTemplateBtn.addEventListener("click", saveCurrentAsTemplate);

/* ---------- Start-of-session choice ---------- */
const SESSION_STARTED_KEY = "spinner_session_started";

function markSessionStarted() {
  try { sessionStorage.setItem(SESSION_STARTED_KEY, "1"); } catch (e) {}
}

function hasSessionStarted() {
  try { return sessionStorage.getItem(SESSION_STARTED_KEY) === "1"; } catch (e) { return false; }
}

function startNewProject() {
  if (!confirm("Start a new project? This clears all 64 pads (your uploaded sounds stay in the library, nothing is deleted). Save it as a template anytime from the Templates screen.")) {
    return false;
  }
  pads = Array.from({ length: PAD_COUNT }, () => ({ label: "", color: null, soundId: null }));
  savePads();
  editMode = true;
  editModeBtn.classList.add("active");
  editModeBtn.textContent = "Done";
  renderBoard();
  return true;
}

startNewBtn.addEventListener("click", () => {
  startNewProject();
  markSessionStarted();
  closeSheet(startSheet);
});
newProjectBtn.addEventListener("click", () => {
  if (startNewProject()) closeSheet(templatesSheet);
});
newProjectHeaderBtn.addEventListener("click", () => {
  if (startNewProject()) markSessionStarted();
});

startOpenBtn.addEventListener("click", () => {
  markSessionStarted();
  closeSheet(startSheet);
  renderTemplatesList();
  openSheet(templatesSheet);
});

startLiveBtn.addEventListener("click", () => {
  markSessionStarted();
  closeSheet(startSheet);
});

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

quickSaveTemplateBtn.addEventListener("click", saveCurrentAsTemplate);
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

  if (!hasSessionStarted()) {
    renderTemplatesList(); // so "Open Template" has fresh data ready behind it
    openSheet(startSheet);
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").then((reg) => {
      reg.update(); // bypass the browser's own update-check throttle every time the app opens
    }).catch(() => {});

    let reloadedOnce = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloadedOnce) return;
      reloadedOnce = true;
      window.location.reload();
    });
  }
}

init();
