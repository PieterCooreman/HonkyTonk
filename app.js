// app.js — UI wiring for Honkytonk Stems.
// No framework. Plain DOM, plain functions, one mutable state object.

import { analyzeSong, renderAllStems, STEM_LABELS } from "./audio.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  filename: null,        // string | null
  busy: false,           // bool
  progress: 0,           // 0..1
  status: "",            // status text
  analysis: null,        // { bpm, key, chords, duration } | null
  stems: [],             // [{ name, blob, url }]
  errorMsg: "",
};

// Stems we keep references to for revoke-on-replace.
let previousStemUrls = [];

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

  chordSection:     $("#chord-section"),
  chordList:        $("#chord-list"),

  stemsSection:     $("#stems-section"),
  stemsGrid:        $("#stems-grid"),

  errorMsg:         $("#error-msg"),
};

// ---------------------------------------------------------------------------
// Rendering: reflect `state` into the DOM
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

  // File name + "New file" button (hidden while busy)
  els.fileName.textContent = state.filename ?? "";
  els.newFileBtn.disabled = state.busy;
  els.newFileBtn.style.visibility = state.busy ? "hidden" : "visible";

  // Progress
  const progressVisible = (state.busy || state.progress < 1) && !!state.status;
  els.progress.classList.toggle("hidden", !progressVisible);
  els.progressLabel.lastChild.textContent = state.status; // last child = text node
  els.spinner.style.display = state.busy ? "" : "none";
  els.progressBar.style.width = `${Math.round(state.progress * 100)}%`;

  // Error
  els.errorMsg.textContent = state.errorMsg;
  els.errorMsg.classList.toggle("hidden", !state.errorMsg);

  // Stats
  if (state.analysis) {
    els.stats.classList.remove("hidden");
    els.statBpm.textContent    = String(state.analysis.bpm);
    els.statKey.textContent    = state.analysis.key;
    els.statChords.textContent = String(state.analysis.chords.length);
  } else {
    els.stats.classList.add("hidden");
  }

  // Chord progression
  if (state.analysis && state.analysis.chords.length > 0) {
    els.chordSection.classList.remove("hidden");
    const chords = state.analysis.chords;
    const shown = chords.slice(0, 64);
    const moreCount = chords.length - shown.length;

    // Diff would be overkill — rebuild this list each render.
    els.chordList.replaceChildren(
      ...shown.map((seg) => {
        const span = document.createElement("span");
        span.className = "chord-pill";
        span.textContent = seg.chord;
        span.title = `${seg.start.toFixed(1)}s – ${seg.end.toFixed(1)}s`;
        return span;
      }),
      ...(moreCount > 0
        ? [(() => {
            const more = document.createElement("span");
            more.className = "chord-more";
            more.textContent = `+${moreCount} more`;
            return more;
          })()]
        : []),
    );
  } else {
    els.chordSection.classList.add("hidden");
  }

  // Stems
  if (state.stems.length > 0) {
    els.stemsSection.classList.remove("hidden");
    els.stemsGrid.replaceChildren(...state.stems.map(stemNode));
  } else {
    els.stemsSection.classList.add("hidden");
  }
}

function stemNode(stem) {
  const row = document.createElement("div");
  row.className = "stem";

  const icon = document.createElement("div");
  icon.className = "stem-icon";
  icon.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M9 18V5l12-2v13"/>
      <circle cx="6" cy="18" r="3"/>
      <circle cx="18" cy="16" r="3"/>
    </svg>`;

  const body = document.createElement("div");
  body.className = "stem-body";

  const name = document.createElement("div");
  name.className = "stem-name";
  name.textContent = STEM_LABELS[stem.name] ?? stem.name;

  const audio = document.createElement("audio");
  audio.src = stem.url;
  audio.controls = true;

  body.append(name, audio);

  const dl = document.createElement("button");
  dl.className = "btn btn-secondary btn-icon";
  dl.setAttribute("aria-label", `Download ${STEM_LABELS[stem.name] ?? stem.name}`);
  dl.title = "Download";
  dl.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>`;
  dl.addEventListener("click", () => downloadStem(stem));

  row.append(icon, body, dl);
  return row;
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

function clearPreviousStems() {
  for (const url of previousStemUrls) URL.revokeObjectURL(url);
  previousStemUrls = [];
}

async function handleFile(file) {
  clearPreviousStems();

  state.filename = file.name;
  state.busy = true;
  state.errorMsg = "";
  state.analysis = null;
  state.stems = [];
  state.status = "Decoding audio…";
  state.progress = 0.02;
  render();

  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const arr = await file.arrayBuffer();
    const buffer = await ctx.decodeAudioData(arr);

    const analysis = await analyzeSong(buffer, (p, msg) => {
      state.progress = p;
      state.status = msg;
      render();
    });
    state.analysis = analysis;
    state.status = "Rendering stems…";
    state.progress = 0;
    render();

    const stems = await renderAllStems(
      analysis.chords,
      analysis.bpm,
      Math.min(analysis.duration, 120),     // cap rendered length at 2 min
      (stemName, i, n) => {
        state.progress = (i + 0.5) / n;
        state.status = `Rendering ${STEM_LABELS[stemName] ?? stemName}…`;
        render();
      },
    );

    state.stems = stems;
    previousStemUrls = stems.map((s) => s.url);
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
// Wire up DOM events
// ---------------------------------------------------------------------------

function pickFile() {
  els.fileInput.value = "";    // allow re-selecting the same file
  els.fileInput.click();
}

els.dropzone.addEventListener("click", pickFile);
els.newFileBtn.addEventListener("click", pickFile);

els.fileInput.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) handleFile(file);
});

// Optional: drag-and-drop on the dropzone (and document).
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
// Also accept drops anywhere when no file is loaded.
document.addEventListener("dragover", (e) => { e.preventDefault(); });
document.addEventListener("drop",     (e) => {
  if (state.filename) return;            // don't replace mid-session via stray drop
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

// Initial render
render();
