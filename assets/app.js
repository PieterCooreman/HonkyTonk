// app.js — UI for Honkytonk Stems.
// Adds a multi-track mixer (original + 4 stems) with shared transport,
// per-track mute / solo / volume, and a stems-offset nudge.

import {
  analyzeSong,
  renderAllStems,
  STEM_LABELS,
  describeGroove,
  AVAILABLE_GROOVES,
} from "./audio.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  filename: null,
  busy: false,
  progress: 0,
  status: "",
  analysis: null,           // { bpm, key, chords, duration } | null
  groove: null,             // { key, label, swing } | null
  feel: "auto",             // current feel selection ("auto" | "ballad" | ...)
  stems: [],                // [{ name, blob, url, buffer }]
  originalBuffer: null,     // AudioBuffer of source file
  errorMsg: "",

  // Mixer
  playing: false,
  playheadSec: 0,           // last known playhead (seconds)
  durationSec: 0,           // mix length (== rendered stems duration)
  tracks: makeDefaultTracks(),
  offsetMs: 0,              // global stems offset relative to original
};

function makeDefaultTracks() {
  return {
    original:   { volume: 0.85, mute: false, solo: false },
    drums:      { volume: 0.85, mute: false, solo: false },
    bass:       { volume: 0.85, mute: false, solo: false },
    piano:      { volume: 0.8,  mute: false, solo: false },
    pedalSteel: { volume: 0.8,  mute: false, solo: false },
  };
}

const TRACK_ORDER = ["original", "drums", "bass", "piano", "pedalSteel"];
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

    // The "original" track plays from `offsetSec` directly.
    // Stems play offset by the user's stems-offset nudge.
    let trackOffset = offsetSec;
    if (id !== "original") {
      // stems-offset nudges the stems relative to original: positive = stems later
      // so when the user picks the playhead at offsetSec in the original, the
      // matching position inside the stem buffer is offsetSec - offsetMs/1000.
      trackOffset = offsetSec - state.offsetMs / 1000;
    }
    // Skip if outside the buffer
    if (trackOffset >= buffer.duration) continue;
    if (trackOffset < 0) {
      // schedule the source to start later by |trackOffset| seconds
      const src = new AudioBufferSourceNode(audioCtx, { buffer });
      src.connect(trackNodes[id].gain);
      src.start(ctxStart + Math.abs(trackOffset), 0);
      trackNodes[id].source = src;
    } else {
      const src = new AudioBufferSourceNode(audioCtx, { buffer });
      src.connect(trackNodes[id].gain);
      src.start(ctxStart, trackOffset);
      trackNodes[id].source = src;
    }
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
  statBpm:          $("#stat-bpm"),
  statKey:          $("#stat-key"),
  statChords:       $("#stat-chords"),
  feelSelect:       $("#feel-select"),

  chordSection:     $("#chord-section"),
  chordList:        $("#chord-list"),

  mixerSection:     $("#mixer-section"),
  mixerTracks:      $("#mixer-tracks"),
  transportPlayBtn: $("#transport-play"),
  transportTime:    $("#transport-time"),
  transportTotal:   $("#transport-total"),
  transportSeek:    $("#transport-seek"),
  offsetSlider:     $("#offset-slider"),
  offsetLabel:      $("#offset-label"),
  downloadAllBtn:   $("#download-all"),

  errorMsg:         $("#error-msg"),
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  // Dropzone vs panel
  if (state.filename) {
    els.dropzone.classList.add("hidden");
    els.panel.classList.remove("hidden");
  } else {
    els.dropzone.classList.remove("hidden");
    els.panel.classList.add("hidden");
  }

  els.fileName.textContent = state.filename ?? "";
  els.newFileBtn.disabled = state.busy;
  els.newFileBtn.style.visibility = state.busy ? "hidden" : "visible";

  const progressVisible = (state.busy || state.progress < 1) && !!state.status;
  els.progress.classList.toggle("hidden", !progressVisible);
  // Find the dedicated <span> child so this is robust against whitespace nodes
  // between siblings.
  const statusSpan = els.progressLabel.querySelector("span");
  if (statusSpan) statusSpan.textContent = state.status;
  els.spinner.style.display = state.busy ? "" : "none";
  els.progressBar.style.width = `${Math.round(state.progress * 100)}%`;

  els.errorMsg.textContent = state.errorMsg;
  els.errorMsg.classList.toggle("hidden", !state.errorMsg);

  if (state.analysis) {
    els.stats.classList.remove("hidden");
    els.statBpm.textContent    = String(state.analysis.bpm);
    els.statKey.textContent    = state.analysis.key;
    els.statChords.textContent = String(state.analysis.chords.length);
    populateFeelSelect();
  } else {
    els.stats.classList.add("hidden");
  }

  if (state.analysis && state.analysis.chords.length > 0) {
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

  // Mixer
  if (state.stems.length > 0 && state.originalBuffer) {
    els.mixerSection.classList.remove("hidden");
    renderMixerTracks();
    updateTransportUi();
  } else {
    els.mixerSection.classList.add("hidden");
  }
}

function populateFeelSelect() {
  // Rebuild options if structure differs from what's there now.
  const sel = els.feelSelect;
  if (sel.options.length !== AVAILABLE_GROOVES.length) {
    sel.replaceChildren(...AVAILABLE_GROOVES.map((g) => {
      const opt = document.createElement("option");
      opt.value = g.key;
      opt.textContent = g.label;
      return opt;
    }));
  }
  // Annotate the "Auto" label with what it would pick for this BPM.
  if (state.analysis) {
    const autoGroove = describeGroove(state.analysis.bpm, "auto");
    sel.options[0].textContent = `Auto (${autoGroove.label})`;
  }
  sel.value = state.feel;
  sel.disabled = state.busy;
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
  els.offsetLabel.textContent = `${state.offsetMs > 0 ? "+" : ""}${state.offsetMs} ms`;
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

// Synthesize stems from the current analysis using the current feel.
// Used both as the second phase of handleFile() and standalone when the user
// changes the feel selector.
async function renderStemsFromAnalysis() {
  const analysis = state.analysis;
  if (!analysis) return;
  const renderDuration = Math.min(analysis.duration, 120);
  const stems = await renderAllStems(
    analysis,
    renderDuration,
    (stemName, i, n) => {
      state.progress = (i + 0.5) / n;
      state.status = `Rendering ${STEM_LABELS[stemName] ?? stemName}…`;
      render();
    },
    state.feel,
  );
  state.stems = stems;
  previousStemUrls = stems.map((s) => s.url);
  state.durationSec = renderDuration;
  state.groove = describeGroove(analysis.bpm, state.feel);
}

async function rerenderStemsWithCurrentFeel() {
  if (!state.analysis || state.busy) return;
  const wasPlaying = state.playing;
  const savedPlayhead = state.playheadSec;
  pause();
  clearPreviousStems();
  state.stems = [];
  state.busy = true;
  state.errorMsg = "";
  state.status = "Rendering stems…";
  state.progress = 0;
  render();
  try {
    await renderStemsFromAnalysis();
    state.status = "Done";
    state.progress = 1;
  } catch (err) {
    console.error(err);
    state.errorMsg = `Error: ${err && err.message ? err.message : err}`;
    state.status = "";
  } finally {
    state.busy = false;
    state.playheadSec = Math.min(savedPlayhead, state.durationSec);
    render();
    if (wasPlaying) play();
  }
}

async function handleFile(file) {
  pause();
  clearPreviousStems();

  state.filename = file.name;
  state.busy = true;
  state.errorMsg = "";
  state.analysis = null;
  state.groove = null;
  state.stems = [];
  state.originalBuffer = null;
  state.playheadSec = 0;
  state.durationSec = 0;
  state.tracks = makeDefaultTracks();
  state.offsetMs = 0;
  if (els.offsetSlider) els.offsetSlider.value = "0";
  state.status = "Decoding audio…";
  state.progress = 0.02;
  render();

  try {
    ensureAudioCtx();
    const arr = await file.arrayBuffer();
    const buffer = await audioCtx.decodeAudioData(arr.slice(0));
    state.originalBuffer = buffer;

    const analysis = await analyzeSong(buffer, (p, msg) => {
      state.progress = p; state.status = msg; render();
    });
    state.analysis = analysis;
    state.groove = describeGroove(analysis.bpm, state.feel);
    state.status = "Rendering stems…";
    state.progress = 0;
    render();

    await renderStemsFromAnalysis();
    state.status = "Done";
    state.progress = 1;
  } catch (err) {
    console.error(err);
    state.errorMsg = `Error: ${err && err.message ? err.message : err}`;
    state.status = "";
  } finally {
    state.busy = false;
    render();
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

els.offsetSlider.addEventListener("input", () => {
  state.offsetMs = parseInt(els.offsetSlider.value, 10);
  els.offsetLabel.textContent = `${state.offsetMs > 0 ? "+" : ""}${state.offsetMs} ms`;
  // If currently playing, restart from current playhead with new offset
  if (state.playing) {
    const t = currentPlayheadSec();
    pause();
    state.playheadSec = t;
    play();
  }
});

els.downloadAllBtn.addEventListener("click", downloadAll);

els.feelSelect.addEventListener("change", () => {
  const newFeel = els.feelSelect.value;
  if (newFeel === state.feel) return;
  state.feel = newFeel;
  // Re-render stems only — no re-analysis. Analysis (bpm/chords) doesn't change.
  rerenderStemsWithCurrentFeel();
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
