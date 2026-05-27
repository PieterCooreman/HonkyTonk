// app.js — UI for Honkytonk Stems.
// Adds a multi-track mixer (original + 4 stems) with shared transport,
// per-track mute / solo / volume, and a stems-offset nudge.

import {
  analyzeSong,
  renderAllStems,
  STEM_LABELS,
} from "./audio.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Lifecycle phases the app moves through.
//   empty       — no file loaded; show dropzone
//   decoding    — file loaded, audio is being decoded
//   analyzing   — BPM/key/chords being detected
//   reviewing   — analysis done; waiting for user to confirm and click Generate
//   rendering   — synthesizing stems
//   ready       — stems exist; mixer visible
const state = {
  filename: null,
  phase: "empty",
  progress: 0,
  status: "",

  // Detected analysis (what the analyzer returned, unmodified).
  analysis: null,           // { bpm, key, keyRoot, keyQuality, chords, beats, duration }

  // User overrides applied on top of the detected analysis.
  bpmOverride: null,        // number | null
  keyRootOverride: null,    // 0..11 | null
  keyQualityOverride: null, // "maj"|"min" | null

  // Most-recent render's "frozen" values. Used to detect staleness.
  lastRender: null,         // { bpm, keyRoot, keyQuality } | null

  stems: [],                // [{ name, blob, url, buffer }]
  originalBuffer: null,
  errorMsg: "",

  // Mixer
  playing: false,
  playheadSec: 0,
  durationSec: 0,
  tracks: makeDefaultTracks(),
};

// Convenience: "busy" means we shouldn't accept user input that triggers work.
function isBusy() {
  return state.phase === "decoding" || state.phase === "analyzing" || state.phase === "rendering";
}

// Effective values shown in the UI and used when generating: detected values
// overridden by any user edits.
function effectiveBpm() {
  if (state.bpmOverride != null) return state.bpmOverride;
  return state.analysis?.bpm ?? 0;
}
function effectiveKeyRoot() {
  return state.keyRootOverride ?? state.analysis?.keyRoot ?? 0;
}
function effectiveKeyQuality() {
  return state.keyQualityOverride ?? state.analysis?.keyQuality ?? "maj";
}
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function effectiveKeyLabel() {
  return NOTE_NAMES[effectiveKeyRoot()] + (effectiveKeyQuality() === "min" ? "m" : "");
}

// Is the current set of stems out of date relative to the user's choices?
function isStale() {
  if (!state.lastRender) return false;     // no stems yet, nothing to be stale
  return (
    state.lastRender.bpm        !== effectiveBpm()        ||
    state.lastRender.keyRoot    !== effectiveKeyRoot()    ||
    state.lastRender.keyQuality !== effectiveKeyQuality()
  );
}

function makeDefaultTracks() {
  return {
    original: { volume: 0.85, mute: false, solo: false },
    drums:    { volume: 0.85, mute: false, solo: false },
    bass:     { volume: 0.85, mute: false, solo: false },
  };
}

const TRACK_ORDER = ["original", "drums", "bass"];
const TRACK_LABELS = { original: "Original", ...STEM_LABELS };

// ---------------------------------------------------------------------------
// Web Audio mixer (lives once for the page lifetime)
// ---------------------------------------------------------------------------

let audioCtx = null;
let masterGain = null;
const trackNodes = {};       // { trackId: { gain: GainNode, source: AudioBufferSourceNode|null } }
let scheduledStartTime = 0;  // AudioContext time at which playback began
let playheadOffset = 0;      // where in the song "start" maps to (sec)
let rafId = null;

function ensureAudioCtx() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    masterGain = new GainNode(audioCtx, { gain: 0.9 });
    masterGain.connect(audioCtx.destination);
    for (const t of TRACK_ORDER) {
      const g = new GainNode(audioCtx, { gain: state.tracks[t].volume });
      g.connect(masterGain);
      trackNodes[t] = { gain: g, source: null };
    }
  }
}

function getTrackBuffer(trackId) {
  if (trackId === "original") return state.originalBuffer;
  const stem = state.stems.find((s) => s.name === trackId);
  return stem?.buffer ?? null;
}

function effectiveVolume(trackId) {
  const t = state.tracks[trackId];
  if (!t) return 0;
  const anySolo = Object.values(state.tracks).some((tr) => tr.solo);
  if (t.mute) return 0;
  if (anySolo && !t.solo) return 0;
  return t.volume;
}

function applyAllTrackVolumes() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  for (const id of TRACK_ORDER) {
    const v = effectiveVolume(id);
    const node = trackNodes[id]?.gain;
    if (node) node.gain.setTargetAtTime(v, now, 0.02);
  }
}

function stopAllSources() {
  for (const id of TRACK_ORDER) {
    const node = trackNodes[id];
    if (node && node.source) {
      try { node.source.stop(); } catch {}
      try { node.source.disconnect(); } catch {}
      node.source = null;
    }
  }
}

function startAllSources(offsetSec) {
  if (!audioCtx) return;
  ensureAudioCtx();
  stopAllSources();

  // We can't move sample-accurately backward without re-creating sources, so
  // each play call re-creates and re-schedules them all.
  const ctxStart = audioCtx.currentTime + 0.06; // tiny lookahead

  for (const id of TRACK_ORDER) {
    const buffer = getTrackBuffer(id);
    if (!buffer) continue;
    if (offsetSec >= buffer.duration) continue;
    const src = new AudioBufferSourceNode(audioCtx, { buffer });
    src.connect(trackNodes[id].gain);
    src.start(ctxStart, offsetSec);
    trackNodes[id].source = src;
  }

  scheduledStartTime = ctxStart;
  playheadOffset = offsetSec;
  state.playing = true;
  applyAllTrackVolumes();
  startPlayheadAnim();
}

function currentPlayheadSec() {
  if (!state.playing || !audioCtx) return state.playheadSec;
  return playheadOffset + (audioCtx.currentTime - scheduledStartTime);
}

function startPlayheadAnim() {
  cancelAnimationFrame(rafId);
  const tick = () => {
    if (!state.playing) return;
    const t = currentPlayheadSec();
    state.playheadSec = t;
    updateTransportUi();
    if (t >= state.durationSec) {
      pause();
      // Snap to end
      state.playheadSec = state.durationSec;
      updateTransportUi();
      return;
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

function play() {
  if (state.stems.length === 0 || !state.originalBuffer) return;
  ensureAudioCtx();
  if (audioCtx.state === "suspended") audioCtx.resume();
  const startAt = state.playheadSec >= state.durationSec - 0.05 ? 0 : state.playheadSec;
  startAllSources(startAt);
  updateTransportUi();
}

function pause() {
  if (!state.playing) return;
  state.playheadSec = currentPlayheadSec();
  state.playing = false;
  stopAllSources();
  cancelAnimationFrame(rafId);
  updateTransportUi();
}

function seek(sec) {
  const wasPlaying = state.playing;
  if (wasPlaying) {
    stopAllSources();
    state.playing = false;
    cancelAnimationFrame(rafId);
  }
  state.playheadSec = Math.max(0, Math.min(state.durationSec, sec));
  if (wasPlaying) play();
  else updateTransportUi();
}

// ---------------------------------------------------------------------------
// DOM lookups
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

const els = {
  fileInput:        $("#file-input"),
  dropzone:         $("#dropzone"),
  panel:            $("#panel"),
  fileName:         $("#file-name"),
  newFileBtn:       $("#new-file-btn"),

  progress:         $("#progress"),
  progressLabel:    $("#progress-label"),
  progressBar:      $("#progress-bar > div"),
  spinner:          $("#progress-spinner"),

  stats:            $("#stats"),
  statBpmInput:     $("#stat-bpm-input"),
  statKeyRoot:      $("#stat-key-root"),
  statKeyQuality:   $("#stat-key-quality"),
  statChords:       $("#stat-chords"),

  generateSection:  $("#generate-section"),
  generateBtn:      $("#generate-btn"),
  staleIndicator:   $("#stale-indicator"),

  chordSection:     $("#chord-section"),
  chordList:        $("#chord-list"),

  mixerSection:     $("#mixer-section"),
  mixerTracks:      $("#mixer-tracks"),
  transportPlayBtn: $("#transport-play"),
  transportTime:    $("#transport-time"),
  transportTotal:   $("#transport-total"),
  transportSeek:    $("#transport-seek"),
  downloadAllBtn:   $("#download-all"),

  errorMsg:         $("#error-msg"),
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  const phase = state.phase;
  const busy = isBusy();

  // Dropzone vs the rest of the panel.
  if (phase === "empty") {
    els.dropzone.classList.remove("hidden");
    els.panel.classList.add("hidden");
    return;        // nothing else to render before a file is loaded
  }
  els.dropzone.classList.add("hidden");
  els.panel.classList.remove("hidden");

  els.fileName.textContent = state.filename ?? "";
  els.newFileBtn.disabled = busy;
  els.newFileBtn.style.visibility = busy ? "hidden" : "visible";

  // Progress / spinner / status text
  const progressVisible = busy && !!state.status;
  els.progress.classList.toggle("hidden", !progressVisible);
  const statusSpan = els.progressLabel.querySelector("span");
  if (statusSpan) statusSpan.textContent = state.status;
  els.spinner.style.display = busy ? "" : "none";
  els.progressBar.style.width = `${Math.round(state.progress * 100)}%`;

  els.errorMsg.textContent = state.errorMsg;
  els.errorMsg.classList.toggle("hidden", !state.errorMsg);

  // Stats are visible from `reviewing` onward.
  const hasAnalysis = !!state.analysis;
  if (hasAnalysis) {
    els.stats.classList.remove("hidden");

    // Only overwrite the BPM input value when the input isn't currently focused —
    // otherwise we'd clobber the user's keystrokes mid-typing.
    if (document.activeElement !== els.statBpmInput) {
      els.statBpmInput.value = String(effectiveBpm());
    }
    els.statBpmInput.disabled = busy;

    populateKeySelects();
    els.statKeyRoot.disabled    = busy;
    els.statKeyQuality.disabled = busy;

    els.statChords.textContent = String(state.analysis.chords.length);
  } else {
    els.stats.classList.add("hidden");
  }

  // Generate / Regenerate button is visible while reviewing or after we have stems.
  const showGenerate = hasAnalysis && (phase === "reviewing" || phase === "ready" || phase === "rendering");
  els.generateSection.classList.toggle("hidden", !showGenerate);
  if (showGenerate) {
    const hasStems = state.stems.length > 0;
    els.generateBtn.textContent = hasStems ? "Regenerate stems" : "Generate stems";
    els.generateBtn.disabled = busy;
    els.staleIndicator.classList.toggle("hidden", !(hasStems && isStale()));
  }

  // Chord progression is visible from `reviewing` onward (re-uses detected chords).
  if (hasAnalysis && state.analysis.chords.length > 0) {
    els.chordSection.classList.remove("hidden");
    const chords = state.analysis.chords;
    const shown = chords.slice(0, 64);
    const moreCount = chords.length - shown.length;
    els.chordList.replaceChildren(
      ...shown.map((seg) => {
        const span = document.createElement("span");
        span.className = "chord-pill";
        span.textContent = seg.chord;
        span.title = `${seg.start.toFixed(1)}s – ${seg.end.toFixed(1)}s`;
        return span;
      }),
      ...(moreCount > 0 ? [(() => {
        const m = document.createElement("span");
        m.className = "chord-more";
        m.textContent = `+${moreCount} more`;
        return m;
      })()] : []),
    );
  } else {
    els.chordSection.classList.add("hidden");
  }

  // Mixer only after we actually have stems (phase: ready).
  if (state.stems.length > 0 && state.originalBuffer && phase === "ready") {
    els.mixerSection.classList.remove("hidden");
    renderMixerTracks();
    updateTransportUi();
  } else {
    els.mixerSection.classList.add("hidden");
  }
}

function populateKeySelects() {
  // Root select gets all 12 pitch classes once.
  if (els.statKeyRoot.options.length === 0) {
    els.statKeyRoot.replaceChildren(...NOTE_NAMES.map((n, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = n;
      return o;
    }));
  }
  els.statKeyRoot.value    = String(effectiveKeyRoot());
  els.statKeyQuality.value = effectiveKeyQuality();
}



function renderMixerTracks() {
  els.mixerTracks.replaceChildren(...TRACK_ORDER.map(trackRow));
}

function trackRow(trackId) {
  const t = state.tracks[trackId];
  const row = document.createElement("div");
  row.className = "track";
  row.dataset.track = trackId;

  // Label
  const name = document.createElement("div");
  name.className = "track-name";
  name.textContent = TRACK_LABELS[trackId] ?? trackId;
  if (trackId === "original") name.classList.add("track-name-original");
  row.appendChild(name);

  // Mute / Solo
  const buttons = document.createElement("div");
  buttons.className = "track-buttons";

  const muteBtn = document.createElement("button");
  muteBtn.type = "button";
  muteBtn.className = "track-btn" + (t.mute ? " is-on-mute" : "");
  muteBtn.title = "Mute";
  muteBtn.textContent = "M";
  muteBtn.addEventListener("click", () => {
    state.tracks[trackId].mute = !state.tracks[trackId].mute;
    applyAllTrackVolumes();
    renderMixerTracks();
  });
  buttons.appendChild(muteBtn);

  const soloBtn = document.createElement("button");
  soloBtn.type = "button";
  soloBtn.className = "track-btn" + (t.solo ? " is-on-solo" : "");
  soloBtn.title = "Solo";
  soloBtn.textContent = "S";
  soloBtn.addEventListener("click", () => {
    state.tracks[trackId].solo = !state.tracks[trackId].solo;
    applyAllTrackVolumes();
    renderMixerTracks();
  });
  buttons.appendChild(soloBtn);
  row.appendChild(buttons);

  // Volume
  const volWrap = document.createElement("div");
  volWrap.className = "track-volume";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0"; slider.max = "1.5"; slider.step = "0.01";
  slider.value = String(t.volume);
  slider.addEventListener("input", () => {
    state.tracks[trackId].volume = parseFloat(slider.value);
    applyAllTrackVolumes();
  });
  volWrap.appendChild(slider);
  row.appendChild(volWrap);

  // Per-track download (only for stems)
  if (trackId !== "original") {
    const dl = document.createElement("button");
    dl.type = "button";
    dl.className = "track-download";
    dl.title = `Download ${TRACK_LABELS[trackId]}`;
    dl.setAttribute("aria-label", `Download ${TRACK_LABELS[trackId]}`);
    dl.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>`;
    dl.addEventListener("click", () => {
      const stem = state.stems.find((s) => s.name === trackId);
      if (stem) downloadStem(stem);
    });
    row.appendChild(dl);
  } else {
    // Spacer to align rows
    const sp = document.createElement("div");
    sp.className = "track-download-placeholder";
    row.appendChild(sp);
  }

  return row;
}

function updateTransportUi() {
  if (state.stems.length === 0) return;
  els.transportPlayBtn.textContent = state.playing ? "Pause" : "Play";
  els.transportPlayBtn.classList.toggle("is-playing", state.playing);
  els.transportTime.textContent  = formatTime(state.playheadSec);
  els.transportTotal.textContent = formatTime(state.durationSec);
  // Only update slider when the user isn't dragging
  if (!seekDragging) {
    els.transportSeek.max = String(state.durationSec);
    els.transportSeek.value = String(state.playheadSec);
  }
}

function formatTime(s) {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function downloadStem(stem) {
  const baseName = (state.filename ?? "song").replace(/\.[^.]+$/, "");
  const a = document.createElement("a");
  a.href = stem.url;
  a.download = `${baseName}-${stem.name}.wav`;
  a.click();
}

function downloadAll() {
  for (const stem of state.stems) downloadStem(stem);
}

let previousStemUrls = [];
function clearPreviousStems() {
  for (const url of previousStemUrls) URL.revokeObjectURL(url);
  previousStemUrls = [];
}

// Step 1 of the flow: load + decode + analyze. Stops at the "reviewing" phase;
// the user must then click Generate to synthesize stems.
async function handleFile(file) {
  pause();
  clearPreviousStems();

  // Reset to a clean state.
  state.filename = file.name;
  state.phase = "decoding";
  state.errorMsg = "";
  state.analysis = null;
  state.bpmOverride = null;
  state.keyRootOverride = null;
  state.keyQualityOverride = null;
  state.lastRender = null;
  state.stems = [];
  state.originalBuffer = null;
  state.playheadSec = 0;
  state.durationSec = 0;
  state.tracks = makeDefaultTracks();
  state.status = "Decoding audio…";
  state.progress = 0.02;
  render();

  try {
    ensureAudioCtx();
    const arr = await file.arrayBuffer();
    const buffer = await audioCtx.decodeAudioData(arr.slice(0));
    state.originalBuffer = buffer;

    state.phase = "analyzing";
    render();

    const analysis = await analyzeSong(buffer, (p, msg) => {
      state.progress = p; state.status = msg; render();
    });
    state.analysis = analysis;

    // Stop here. User reviews / corrects, then clicks Generate.
    state.phase = "reviewing";
    state.status = "";
    state.progress = 0;
  } catch (err) {
    console.error(err);
    state.errorMsg = `Error: ${err && err.message ? err.message : err}`;
    state.status = "";
    state.phase = state.analysis ? "reviewing" : "empty";
  } finally {
    render();
  }
}

// Step 2 of the flow: synthesize stems using the user's (possibly edited)
// BPM and key. Triggered exclusively by the Generate button.
async function handleGenerate() {
  if (!state.analysis || isBusy()) return;

  const wasPlaying = state.playing;
  const savedPlayhead = state.playheadSec;
  pause();
  clearPreviousStems();
  state.stems = [];

  state.phase = "rendering";
  state.errorMsg = "";
  state.status = "Rendering stems…";
  state.progress = 0;
  render();

  // Build a synthetic analysis object reflecting the user's overrides.
  const synAnalysis = {
    ...state.analysis,
    bpm:        effectiveBpm(),
    keyRoot:    effectiveKeyRoot(),
    keyQuality: effectiveKeyQuality(),
  };

  try {
    const renderDuration = Math.min(synAnalysis.duration, 120);
    const stems = await renderAllStems(
      synAnalysis,
      renderDuration,
      (stemName, i, n) => {
        state.progress = (i + 0.5) / n;
        state.status = `Rendering ${STEM_LABELS[stemName] ?? stemName}…`;
        render();
      },
    );
    state.stems = stems;
    previousStemUrls = stems.map((s) => s.url);
    state.durationSec = renderDuration;
    state.lastRender = {
      bpm: synAnalysis.bpm,
      keyRoot: synAnalysis.keyRoot,
      keyQuality: synAnalysis.keyQuality,
    };
    state.status = "Done";
    state.progress = 1;
    state.phase = "ready";
  } catch (err) {
    console.error(err);
    state.errorMsg = `Error: ${err && err.message ? err.message : err}`;
    state.status = "";
    state.phase = "reviewing";
  } finally {
    state.playheadSec = Math.min(savedPlayhead, state.durationSec);
    render();
    if (wasPlaying && state.stems.length > 0) play();
  }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function pickFile() {
  els.fileInput.value = "";
  els.fileInput.click();
}

els.dropzone.addEventListener("click", pickFile);
els.newFileBtn.addEventListener("click", pickFile);
els.fileInput.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) handleFile(file);
});

function bindDrag(target) {
  target.addEventListener("dragover", (e) => {
    e.preventDefault();
    els.dropzone.classList.add("is-active");
  });
  target.addEventListener("dragleave", () => {
    els.dropzone.classList.remove("is-active");
  });
  target.addEventListener("drop", (e) => {
    e.preventDefault();
    els.dropzone.classList.remove("is-active");
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });
}
bindDrag(els.dropzone);
document.addEventListener("dragover", (e) => { e.preventDefault(); });
document.addEventListener("drop", (e) => {
  if (state.filename) return;
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

// Transport
els.transportPlayBtn.addEventListener("click", () => {
  if (state.playing) pause();
  else play();
});

let seekDragging = false;
els.transportSeek.addEventListener("pointerdown", () => { seekDragging = true; });
els.transportSeek.addEventListener("pointerup",   () => { seekDragging = false; seek(parseFloat(els.transportSeek.value)); });
els.transportSeek.addEventListener("input", () => {
  // Live preview the time as the user drags
  state.playheadSec = parseFloat(els.transportSeek.value);
  els.transportTime.textContent = formatTime(state.playheadSec);
});

els.downloadAllBtn.addEventListener("click", downloadAll);

// Generate / Regenerate button — the only path that triggers synthesis.
els.generateBtn.addEventListener("click", () => handleGenerate());

// BPM edit: update the override on every change. Don't re-render automatically.
// Invalid values fall back to the detected BPM.
function handleBpmEdit() {
  const raw = els.statBpmInput.value.trim();
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 40 && n <= 220) {
    state.bpmOverride = (state.analysis && n === state.analysis.bpm) ? null : n;
  } else {
    // Empty / out-of-range: fall back to detected BPM until valid.
    state.bpmOverride = null;
  }
  render();
}
els.statBpmInput.addEventListener("input", handleBpmEdit);
els.statBpmInput.addEventListener("change", handleBpmEdit);

// Key edits.
els.statKeyRoot.addEventListener("change", () => {
  const r = parseInt(els.statKeyRoot.value, 10);
  state.keyRootOverride = (state.analysis && r === state.analysis.keyRoot) ? null : r;
  render();
});
els.statKeyQuality.addEventListener("change", () => {
  const q = els.statKeyQuality.value;
  state.keyQualityOverride = (state.analysis && q === state.analysis.keyQuality) ? null : q;
  render();
});

// Keyboard shortcut: space toggles play/pause when the mixer is visible.
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
  if (state.stems.length === 0) return;
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  e.preventDefault();
  if (state.playing) pause(); else play();
});

// Initial paint
render();
