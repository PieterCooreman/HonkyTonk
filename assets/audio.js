// audio.js — Honkytonk Stems.
// Beat-tracked, key-aware analysis. Scale-based, sustaining country synthesis.

// ============================================================================
// CONSTANTS
// ============================================================================

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const RENDER_SAMPLE_RATE = 44100;

export const STEM_LABELS = {
  drums: "Drums",
  bass: "Bass",
  piano: "Piano",
  pedalSteel: "Pedal Steel",
};

// Diatonic scale degrees (semitones from root) for major and minor.
const SCALE = {
  maj: [0, 2, 4, 5, 7, 9, 11],
  min: [0, 2, 3, 5, 7, 8, 10],   // natural minor
};

// Krumhansl-Schmuckler key profiles (correlation-based key finding).
const KRUMHANSL_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KRUMHANSL_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// ============================================================================
// CHORD TEMPLATES — 12 major + 12 minor triads as 12-vectors with weighted tones
// ============================================================================

function buildChordTemplates() {
  const out = [];
  for (let root = 0; root < 12; root++) {
    // Weighted: root strongest, third strong, fifth medium. Other PCs gently negative
    // so the template is less ambiguous between maj/min when the third is faint.
    const maj = new Array(12).fill(-0.15);
    maj[root]              = 1.0;
    maj[(root + 4) % 12]   = 0.85;  // major third
    maj[(root + 7) % 12]   = 0.6;   // perfect fifth
    out.push({ name: NOTE_NAMES[root], root, quality: "maj", vec: maj });

    const min = new Array(12).fill(-0.15);
    min[root]              = 1.0;
    min[(root + 3) % 12]   = 0.85;  // minor third
    min[(root + 7) % 12]   = 0.6;
    out.push({ name: NOTE_NAMES[root] + "m", root, quality: "min", vec: min });
  }
  return out;
}

const CHORD_TEMPLATES = buildChordTemplates();

// Diatonic chord set in a major key (I ii iii IV V vi vii°) and natural minor (i ii° III iv v VI VII).
// We treat all as triads; the "diminished" gets the minor template (closest match).
function diatonicChords(keyRoot, keyQuality) {
  // Returns array of {root, quality} expected within this key.
  if (keyQuality === "maj") {
    return [
      { root: keyRoot,                  quality: "maj" }, // I
      { root: (keyRoot + 2) % 12,       quality: "min" }, // ii
      { root: (keyRoot + 4) % 12,       quality: "min" }, // iii
      { root: (keyRoot + 5) % 12,       quality: "maj" }, // IV
      { root: (keyRoot + 7) % 12,       quality: "maj" }, // V
      { root: (keyRoot + 9) % 12,       quality: "min" }, // vi
    ];
  }
  return [
    { root: keyRoot,                quality: "min" },   // i
    { root: (keyRoot + 3) % 12,     quality: "maj" },   // III
    { root: (keyRoot + 5) % 12,     quality: "min" },   // iv
    { root: (keyRoot + 7) % 12,     quality: "min" },   // v (often V too — but stick with natural)
    { root: (keyRoot + 8) % 12,     quality: "maj" },   // VI
    { root: (keyRoot + 10) % 12,    quality: "maj" },   // VII
  ];
}

// ============================================================================
// LOW-LEVEL DSP
// ============================================================================

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

function toMonoSamples(buffer) {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const len = buffer.length;
  const out = new Float32Array(len);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < len; i++) out[i] += data[i];
  }
  for (let i = 0; i < len; i++) out[i] /= buffer.numberOfChannels;
  return out;
}

// Downsample mono signal to a target rate by averaging blocks (anti-aliased enough for chroma).
function downsample(samples, srIn, srOut) {
  if (srOut >= srIn) return { data: samples, sr: srIn };
  const ratio = srIn / srOut;
  const n = Math.floor(samples.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.floor((i + 1) * ratio);
    let s = 0;
    for (let j = start; j < end; j++) s += samples[j];
    out[i] = s / Math.max(1, end - start);
  }
  return { data: out, sr: srOut };
}

// Goertzel single-bin DFT magnitude.
function goertzelMag(samples, sampleRate, freqHz) {
  const k = Math.round(samples.length * freqHz / sampleRate);
  const w = (2 * Math.PI * k) / samples.length;
  const coeff = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2));
}

// Chroma vector with per-octave weighting. Higher octaves (where the melody and
// harmony content lives) are weighted more than the bass; the bass note alone
// shouldn't dominate when a chord is in inversion.
function chroma(samples, sampleRate, weighted = true) {
  const c = new Array(12).fill(0);
  // Octaves 2..6: corresponds to MIDI C2..B6 (~65..2000 Hz).
  // Weights de-emphasize bass (octave 2) and emphasize mids (octaves 4-5).
  const octaveWeights = weighted
    ? { 2: 0.35, 3: 0.85, 4: 1.0, 5: 0.9, 6: 0.5 }
    : { 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 };

  for (let oct = 2; oct <= 6; oct++) {
    const w = octaveWeights[oct];
    for (let pc = 0; pc < 12; pc++) {
      const midi = 12 * (oct + 1) + pc;
      const freq = 440 * Math.pow(2, (midi - 69) / 12);
      if (freq > sampleRate / 2 - 50) continue;
      c[pc] += w * goertzelMag(samples, sampleRate, freq);
    }
  }
  const peak = Math.max(...c);
  if (peak > 0) for (let i = 0; i < 12; i++) c[i] /= peak;
  return c;
}

// ============================================================================
// ONSET / BEAT TRACKING
// ============================================================================

// Build an onset-strength envelope at ~200 Hz from a mono signal.
// Combines a wideband energy derivative with a high-frequency-emphasis (HFC) channel
// for percussive transient detection.
function onsetEnvelope(mono, sr) {
  const targetSr = 200;
  const blockSize = Math.floor(sr / targetSr);
  const blocks = Math.floor(mono.length / blockSize);

  // Per-block: low-band peak (kick/bass), high-band peak (snare/hat) via cheap split.
  // We sum |x| (low) and |x[n]-x[n-1]| (high-pass via difference) per block.
  const energy = new Float32Array(blocks);
  const hfEnergy = new Float32Array(blocks);
  let prev = 0;
  for (let i = 0; i < blocks; i++) {
    const start = i * blockSize;
    let e = 0, hf = 0;
    for (let j = 0; j < blockSize; j++) {
      const v = mono[start + j];
      e += Math.abs(v);
      hf += Math.abs(v - prev);
      prev = v;
    }
    energy[i]   = e / blockSize;
    hfEnergy[i] = hf / blockSize;
  }

  // Half-wave-rectified first difference of each, summed.
  const flux = new Float32Array(blocks);
  for (let i = 1; i < blocks; i++) {
    const dE  = Math.max(0, energy[i]   - energy[i - 1]);
    const dHF = Math.max(0, hfEnergy[i] - hfEnergy[i - 1]);
    flux[i] = dE + 0.6 * dHF;
  }

  // Subtract a moving local mean (highpass) — kills slow loudness drift.
  const winLen = Math.floor(targetSr * 0.5);
  const out = new Float32Array(blocks);
  let sum = 0;
  for (let i = 0; i < blocks; i++) {
    sum += flux[i];
    if (i >= winLen) sum -= flux[i - winLen];
    const mean = sum / Math.min(i + 1, winLen);
    out[i] = Math.max(0, flux[i] - mean);
  }
  return { data: out, sr: targetSr };
}

// Detect BPM and downbeat phase from an onset envelope.
// Returns { bpm, phaseSec, beats: [t1,...] } where beats are *seconds in the
// original timeline*.
function detectBpmAndBeats(onsetEnv) {
  const { data: env, sr } = onsetEnv;
  const minBpm = 60, maxBpm = 200;
  const minLag = Math.floor((60 / maxBpm) * sr);
  const maxLag = Math.floor((60 / minBpm) * sr);

  // Score each lag by autocorrelation, then re-score by how well its grid lines up.
  const autocorr = new Float64Array(maxLag - minLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < env.length; i++) acc += env[i] * env[i + lag];
    autocorr[lag - minLag] = acc;
  }
  const normalize = Math.max(...autocorr) || 1;
  for (let i = 0; i < autocorr.length; i++) autocorr[i] /= normalize;

  // Get a few candidate lags (top 10) and consider 2x / 0.5x for each (octave correction).
  const indexed = Array.from(autocorr).map((v, i) => ({ lag: i + minLag, score: v }));
  indexed.sort((a, b) => b.score - a.score);
  const topCandidates = indexed.slice(0, 10);

  const candidateLags = new Set();
  for (const c of topCandidates) {
    candidateLags.add(c.lag);
    if (c.lag * 2 <= maxLag) candidateLags.add(c.lag * 2);
    if (c.lag * 2 <= maxLag) candidateLags.add(Math.round(c.lag * 1.5));
    if (c.lag >= minLag * 2) candidateLags.add(Math.round(c.lag / 2));
  }

  // For each candidate compute phase-aligned onset score, normalized by the
  // number of beats in the song (so faster grids don't win just by having more
  // sample points). Also weight by BPM preference (mild — only edge penalties).
  const scored = [];
  for (const lag of candidateLags) {
    if (lag < minLag || lag > maxLag) continue;
    const bpm = (60 * sr) / lag;

    let bestPhaseLag = 0, bestSum = -Infinity, bestCount = 0;
    for (let phase = 0; phase < lag; phase++) {
      let s = 0, count = 0;
      for (let p = phase; p < env.length; p += lag) { s += env[p]; count++; }
      if (s > bestSum) {
        bestSum = s; bestCount = count; bestPhaseLag = phase;
      }
    }
    // Normalize by number of beats so a 2x-faster grid doesn't trivially win.
    const meanOnset = bestCount > 0 ? bestSum / bestCount : 0;
    const combined = meanOnset * bpmPreference(bpm);
    scored.push({ lag, bpm, phase: bestPhaseLag / sr, score: combined });
  }
  scored.sort((a, b) => b.score - a.score);

  // Octave correction: among the top candidates (within 92% of best score),
  // prefer the SLOWER tempo. This collapses the common "x2" error: if 95 and
  // 190 both score well, we pick 95.
  if (scored.length === 0) {
    return { bpm: 100, phaseSec: 0, beats: [] };
  }
  const topScore = scored[0].score;
  const cohort = scored.filter((s) => s.score >= topScore * 0.92);
  cohort.sort((a, b) => a.bpm - b.bpm);
  const chosen = cohort[0];
  const bestBpm = chosen.bpm;
  const bestPhase = chosen.phase;

  // Build the beat grid.
  const beats = [];
  const secondsPerBeat = 60 / bestBpm;
  for (let t = bestPhase; t < (env.length / sr); t += secondsPerBeat) {
    beats.push(t);
  }

  return { bpm: bestBpm, phaseSec: bestPhase, beats };
}

// BPM preference curve: gently disfavors *only* the extremes (half/double-tempo
// errors). Doesn't pull toward a center. A Gaussian centered at a single tempo
// like 110 ends up dragging 95-BPM songs toward 110 and breaking ground truth.
function bpmPreference(bpm) {
  // Flat in the realistic country range; soft penalties at the edges so the
  // octave-correction candidate set picks correctly between e.g. 80 vs 160.
  if (bpm < 55)  return 0.40;
  if (bpm < 70)  return 0.75;
  if (bpm < 75)  return 0.90;
  if (bpm <= 160) return 1.00;
  if (bpm <= 180) return 0.90;
  if (bpm <= 200) return 0.70;
  return 0.50;
}

// ============================================================================
// KEY DETECTION (Krumhansl-Schmuckler)
// ============================================================================

// Whole-song chroma summary: average chroma across one-second windows.
function songChroma(mono, sr, progress) {
  const winSec = 1.0;
  const winLen = Math.floor(winSec * sr);
  const numWins = Math.max(1, Math.floor(mono.length / winLen));
  const agg = new Array(12).fill(0);
  for (let w = 0; w < numWins; w++) {
    const chunk = mono.subarray(w * winLen, (w + 1) * winLen);
    const c = chroma(chunk, sr, true);
    for (let i = 0; i < 12; i++) agg[i] += c[i];
    if (progress && (w & 7) === 0) progress(w / numWins);
  }
  // Normalize
  const peak = Math.max(...agg);
  if (peak > 0) for (let i = 0; i < 12; i++) agg[i] /= peak;
  return agg;
}

// Returns { root: 0..11, quality: "maj"|"min", name, score }.
function detectKey(songChromaVec) {
  let best = { root: 0, quality: "maj", score: -Infinity };
  for (let r = 0; r < 12; r++) {
    // Major profile rotated to root r
    const maj = KRUMHANSL_MAJ.slice();
    const min = KRUMHANSL_MIN.slice();
    const rotMaj = new Array(12);
    const rotMin = new Array(12);
    for (let i = 0; i < 12; i++) {
      rotMaj[(i + r) % 12] = maj[i];
      rotMin[(i + r) % 12] = min[i];
    }
    const sMaj = pearson(songChromaVec, rotMaj);
    const sMin = pearson(songChromaVec, rotMin);
    if (sMaj > best.score) best = { root: r, quality: "maj", score: sMaj };
    if (sMin > best.score) best = { root: r, quality: "min", score: sMin };
  }
  best.name = NOTE_NAMES[best.root] + (best.quality === "min" ? "m" : "");
  return best;
}

function pearson(a, b) {
  const n = a.length;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  return cov / Math.sqrt(va * vb + 1e-12);
}

// ============================================================================
// CHORD DETECTION (beat-aligned windows + key bias + smoothing)
// ============================================================================

function matchChordWithKeyBias(chromaVec, keyRoot, keyQuality) {
  const diatonic = diatonicChords(keyRoot, keyQuality);
  const inKey = (root, quality) =>
    diatonic.some((d) => d.root === root && d.quality === quality);

  let best = CHORD_TEMPLATES[0];
  let bestScore = -Infinity;
  for (const tpl of CHORD_TEMPLATES) {
    let score = cosineSimilarity(chromaVec, tpl.vec);
    // Bonus for being in-key (common chords). Tuned so a clearly out-of-key
    // match still wins when the chroma evidence is strong.
    if (inKey(tpl.root, tpl.quality)) score += 0.07;
    // Extra small bonus for tonic / V / IV (i.e. the I-IV-V backbone).
    if (tpl.root === keyRoot && tpl.quality === keyQuality) score += 0.04;
    const fifthRoot = (keyRoot + 7) % 12;
    if (tpl.root === fifthRoot && keyQuality === "maj" && tpl.quality === "maj") score += 0.02;
    const fourthRoot = (keyRoot + 5) % 12;
    if (tpl.root === fourthRoot && keyQuality === "maj" && tpl.quality === "maj") score += 0.02;

    if (score > bestScore) {
      bestScore = score;
      best = tpl;
    }
  }
  return { name: best.name, root: best.root, quality: best.quality, score: bestScore };
}

// Per-beat chord detection, then mode-smoothed and merged.
async function detectChordsOnGrid(mono, sr, beats, keyRoot, keyQuality, onProgress) {
  // Per-beat windows: each window spans beat i to beat i+2 (a 2-beat hop for stability,
  // but stepping by 1 beat — so every beat has a chord assignment).
  const perBeat = [];
  const numBeats = beats.length;

  for (let i = 0; i < numBeats - 1; i++) {
    const tStart = beats[i];
    const tEnd   = beats[Math.min(numBeats - 1, i + 2)];
    const s0 = Math.floor(tStart * sr);
    const s1 = Math.min(mono.length, Math.floor(tEnd * sr));
    if (s1 - s0 < sr * 0.05) {            // window too short
      perBeat.push({ root: keyRoot, quality: keyQuality, score: 0 });
      continue;
    }
    const chunk = mono.subarray(s0, s1);
    const c = chroma(chunk, sr, true);
    perBeat.push(matchChordWithKeyBias(c, keyRoot, keyQuality));

    if (i % 8 === 0) {
      onProgress?.(0.4 + 0.5 * (i / numBeats), `Detecting chords (${i}/${numBeats})…`);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // 3-beat mode smoothing (majority vote in a window of 3).
  const smoothed = perBeat.map((b, i) => {
    if (i === 0 || i === perBeat.length - 1) return b;
    const window = [perBeat[i - 1], perBeat[i], perBeat[i + 1]];
    const counts = {};
    for (const w of window) {
      const k = `${w.root}:${w.quality}`;
      counts[k] = (counts[k] || 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const [topKey, topCount] = sorted[0];
    if (topCount >= 2) {
      const [r, q] = topKey.split(":");
      return { root: parseInt(r), quality: q, score: b.score };
    }
    return b;
  });

  // Merge consecutive identical assignments into segments aligned to the beat grid.
  const segments = [];
  for (let i = 0; i < smoothed.length; i++) {
    const s = smoothed[i];
    const start = beats[i];
    const end = beats[i + 1] ?? (beats[beats.length - 1] + (beats[1] - beats[0]));
    const last = segments[segments.length - 1];
    if (last && last.root === s.root && last.quality === s.quality) {
      last.end = end;
    } else {
      const label = NOTE_NAMES[s.root] + (s.quality === "min" ? "m" : "");
      segments.push({
        start,
        end,
        root: s.root,
        quality: s.quality,
        chord: label,   // back-compat field the UI reads
        name: label,
      });
    }
  }

  return segments;
}

// ============================================================================
// PUBLIC: ANALYSIS PIPELINE
// ============================================================================

export async function analyzeSong(buffer, onProgress) {
  onProgress?.(0.03, "Computing onsets…");
  const mono = toMonoSamples(buffer);
  const sr = buffer.sampleRate;

  // Downsample for chord analysis (the original sr is fine for the bass freqs we need).
  const analysisSr = Math.min(sr, 22050);
  const ds = downsample(mono, sr, analysisSr);
  const monoLow = ds.data;
  const lowSr = ds.sr;

  // 1. Onset / beat tracking
  const onsetEnv = onsetEnvelope(mono, sr);
  const { bpm: bpmRaw, beats: beatsRaw } = detectBpmAndBeats(onsetEnv);
  const bpm = Math.round(bpmRaw);

  onProgress?.(0.18, "Estimating key…");
  // 2. Key detection
  const sChroma = songChroma(monoLow, lowSr);
  const key = detectKey(sChroma);

  // 3. Chord detection on beat-aligned windows
  onProgress?.(0.4, "Detecting chords…");
  const chordSegments = await detectChordsOnGrid(
    monoLow, lowSr, beatsRaw, key.root, key.quality, onProgress,
  );

  onProgress?.(1, "Done");
  return {
    bpm,
    key: key.name,
    keyRoot: key.root,
    keyQuality: key.quality,
    beats: beatsRaw,
    chords: chordSegments,
    duration: buffer.duration,
  };
}

// ============================================================================
// WAV ENCODING
// ============================================================================

export function encodeWav(buffer) {
  const channels = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const bytes = buffer.length * channels * 2 + 44;
  const ab = new ArrayBuffer(bytes);
  const view = new DataView(ab);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); view.setUint32(4, bytes - 8, true); ws(8, "WAVE"); ws(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, sr, true); view.setUint32(28, sr * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  ws(36, "data"); view.setUint32(40, bytes - 44, true);
  const chs = []; for (let c = 0; c < channels; c++) chs.push(buffer.getChannelData(c));
  let cur = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let c = 0; c < channels; c++) {
      const x = Math.max(-1, Math.min(1, chs[c][i]));
      view.setInt16(cur, x < 0 ? x * 32768 : x * 32767, true);
      cur += 2;
    }
  }
  return new Blob([ab], { type: "audio/wav" });
}

// ============================================================================
// SYNTHESIS UTILITIES
// ============================================================================

function makeRng(seed = 1234) {
  let s = seed >>> 0;
  return function rng() {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
function jitter(rng, amount) { return (rng() * 2 - 1) * amount; }
function midiToHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

function safeTime(t, totalDuration) {
  return Math.min(Math.max(0, t), Math.max(0.001, totalDuration - 0.001));
}

function makeNoiseBuffer(ctx, seconds = 1) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

// Choose triad voicing close to previous voicing — for smooth voice leading.
function voiceLedTriad(rootPc, quality, previousVoicing) {
  const third = quality === "maj" ? 4 : 3;
  const intervals = [0, third, 7];
  if (!previousVoicing || previousVoicing.length === 0) {
    const base = 12 * 5 + rootPc;
    return intervals.map((iv) => base + iv);
  }
  return intervals.map((iv) => {
    const pc = (rootPc + iv) % 12;
    let bestMidi = 12 * 5 + pc;
    let bestDist = Infinity;
    for (let oct = 3; oct <= 6; oct++) {
      const m = 12 * (oct + 1) + pc;
      const d = Math.min(...previousVoicing.map((p) => Math.abs(p - m)));
      if (d < bestDist) { bestDist = d; bestMidi = m; }
    }
    return bestMidi;
  }).sort((a, b) => a - b);
}

// ============================================================================
// SCALE HELPERS
// ============================================================================

// Pick a scale to use for melodic motion over a given chord, given the song's key.
// Strategy: use the chord's own scale (maj/min) but choose the *mode of the key*
// that contains the chord's third — keeps everything in-key.
function scaleForChord(chordRoot, chordQuality, keyRoot, keyQuality) {
  // Default: chord's own pentatonic-friendly major or minor scale.
  return SCALE[chordQuality].map((d) => (chordRoot + d) % 12);
}

// Find the closest MIDI note in a given pitch-class set to a target MIDI note.
function nearestInScale(targetMidi, scalePcs) {
  let best = targetMidi, bestDist = Infinity;
  for (let off = -6; off <= 6; off++) {
    const m = targetMidi + off;
    if (scalePcs.includes(m % 12 < 0 ? (m % 12) + 12 : m % 12)) {
      const d = Math.abs(off);
      if (d < bestDist) { bestDist = d; best = m; }
    }
  }
  return best;
}

// Walking-bass line from chordRoot to nextChordRoot through `steps` notes,
// staying within the given scale where possible.
function walkingLine(fromMidi, toMidi, steps, scalePcs) {
  const line = [fromMidi];
  if (steps <= 1) return line;
  // Move stepwise toward the target. Each step pick the nearest scale tone in the
  // right direction. Final step lands on `toMidi`.
  for (let i = 1; i < steps; i++) {
    const t = fromMidi + ((toMidi - fromMidi) * i) / steps;
    const candidate = nearestInScale(Math.round(t), scalePcs);
    line.push(candidate);
  }
  line[line.length - 1] = toMidi;
  return line;
}

// ============================================================================
// VOICES
// ============================================================================

function playKick(ctx, dest, t, velocity = 1) {
  const start = safeTime(t, ctx.length / ctx.sampleRate);
  const osc = new OscillatorNode(ctx, { type: "sine", frequency: 150 });
  const sub = new OscillatorNode(ctx, { type: "sine", frequency: 60 });
  const g = new GainNode(ctx, { gain: 0 });
  const sg = new GainNode(ctx, { gain: 0 });
  osc.connect(g).connect(dest);
  sub.connect(sg).connect(dest);
  osc.frequency.setValueAtTime(150, start);
  osc.frequency.exponentialRampToValueAtTime(48, start + 0.18);
  g.gain.setValueAtTime(1e-4, start);
  g.gain.exponentialRampToValueAtTime(0.95 * velocity, start + 0.002);
  g.gain.exponentialRampToValueAtTime(1e-4, start + 0.22);
  sg.gain.setValueAtTime(1e-4, start);
  sg.gain.exponentialRampToValueAtTime(0.55 * velocity, start + 0.005);
  sg.gain.exponentialRampToValueAtTime(1e-4, start + 0.18);
  osc.start(start); sub.start(start);
  osc.stop(start + 0.24); sub.stop(start + 0.2);
}

function playFilteredNoise(ctx, dest, noiseBuf, t, durSec, peakGain, filterType, filterFreq, Q = 0.7) {
  const start = safeTime(t, ctx.length / ctx.sampleRate);
  const src = new AudioBufferSourceNode(ctx, { buffer: noiseBuf });
  const filt = new BiquadFilterNode(ctx, { type: filterType, frequency: filterFreq, Q });
  const g = new GainNode(ctx, { gain: 0 });
  src.connect(filt).connect(g).connect(dest);
  g.gain.setValueAtTime(1e-4, start);
  g.gain.exponentialRampToValueAtTime(peakGain, start + 0.0015);
  g.gain.exponentialRampToValueAtTime(1e-4, start + durSec);
  src.start(start);
  src.stop(start + durSec + 0.01);
}

function playSnare(ctx, dest, noiseBuf, t, velocity = 1) {
  const start = safeTime(t, ctx.length / ctx.sampleRate);
  playFilteredNoise(ctx, dest, noiseBuf, start, 0.18, 0.45 * velocity, "highpass", 1800);
  playFilteredNoise(ctx, dest, noiseBuf, start, 0.10, 0.20 * velocity, "bandpass", 4000, 1.2);
  const body = new OscillatorNode(ctx, { type: "triangle", frequency: 220 });
  const bg = new GainNode(ctx, { gain: 0 });
  body.connect(bg).connect(dest);
  body.frequency.setValueAtTime(220, start);
  body.frequency.exponentialRampToValueAtTime(140, start + 0.08);
  bg.gain.setValueAtTime(1e-4, start);
  bg.gain.exponentialRampToValueAtTime(0.28 * velocity, start + 0.002);
  bg.gain.exponentialRampToValueAtTime(1e-4, start + 0.13);
  body.start(start);
  body.stop(start + 0.15);
}

function playRim(ctx, dest, t, velocity = 1) {
  const start = safeTime(t, ctx.length / ctx.sampleRate);
  const osc = new OscillatorNode(ctx, { type: "square", frequency: 900 });
  const bpf = new BiquadFilterNode(ctx, { type: "bandpass", frequency: 1500, Q: 6 });
  const g = new GainNode(ctx, { gain: 0 });
  osc.connect(bpf).connect(g).connect(dest);
  g.gain.setValueAtTime(1e-4, start);
  g.gain.exponentialRampToValueAtTime(0.35 * velocity, start + 0.001);
  g.gain.exponentialRampToValueAtTime(1e-4, start + 0.03);
  osc.start(start);
  osc.stop(start + 0.04);
}

function playHat(ctx, dest, noiseBuf, t, velocity = 1) {
  playFilteredNoise(ctx, dest, noiseBuf, t, 0.05, 0.16 * velocity, "highpass", 7000);
}

function playBrush(ctx, dest, noiseBuf, t, durSec, velocity = 1) {
  const start = safeTime(t, ctx.length / ctx.sampleRate);
  const src = new AudioBufferSourceNode(ctx, { buffer: noiseBuf });
  const bpf = new BiquadFilterNode(ctx, { type: "bandpass", frequency: 2500, Q: 0.5 });
  const g = new GainNode(ctx, { gain: 0 });
  src.connect(bpf).connect(g).connect(dest);
  g.gain.setValueAtTime(1e-4, start);
  g.gain.exponentialRampToValueAtTime(0.10 * velocity, start + 0.03);
  g.gain.exponentialRampToValueAtTime(0.06 * velocity, start + durSec * 0.6);
  g.gain.exponentialRampToValueAtTime(1e-4, start + durSec);
  src.start(start);
  src.stop(start + durSec + 0.02);
}

function playTom(ctx, dest, noiseBuf, t, freq = 110, velocity = 1) {
  const start = safeTime(t, ctx.length / ctx.sampleRate);
  const osc = new OscillatorNode(ctx, { type: "sine", frequency: freq });
  const g = new GainNode(ctx, { gain: 0 });
  osc.connect(g).connect(dest);
  osc.frequency.setValueAtTime(freq, start);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.6, start + 0.18);
  g.gain.setValueAtTime(1e-4, start);
  g.gain.exponentialRampToValueAtTime(0.7 * velocity, start + 0.004);
  g.gain.exponentialRampToValueAtTime(1e-4, start + 0.22);
  osc.start(start); osc.stop(start + 0.25);
  playFilteredNoise(ctx, dest, noiseBuf, start, 0.08, 0.12 * velocity, "bandpass", freq * 3, 2);
}

function playBassNote(ctx, dest, midi, t, durSec, velocity = 1) {
  const start = safeTime(t, ctx.length / ctx.sampleRate);
  const end = Math.min(start + durSec, ctx.length / ctx.sampleRate - 0.001);
  const osc = new OscillatorNode(ctx, { type: "triangle", frequency: midiToHz(midi) });
  const sub = new OscillatorNode(ctx, { type: "sine", frequency: midiToHz(midi - 12) });
  const lpf = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 620, Q: 1.0 });
  const g = new GainNode(ctx, { gain: 0 });
  const sg = new GainNode(ctx, { gain: 0 });
  osc.connect(lpf).connect(g).connect(dest);
  sub.connect(sg).connect(dest);
  const peak = 0.5 * velocity;
  g.gain.setValueAtTime(1e-4, start);
  g.gain.exponentialRampToValueAtTime(peak, start + 0.012);
  g.gain.exponentialRampToValueAtTime(peak * 0.45, Math.min(end, start + 0.15));
  g.gain.exponentialRampToValueAtTime(1e-4, end);
  sg.gain.setValueAtTime(1e-4, start);
  sg.gain.exponentialRampToValueAtTime(peak * 0.35, start + 0.015);
  sg.gain.exponentialRampToValueAtTime(1e-4, end);
  osc.start(start); sub.start(start);
  osc.stop(end + 0.02); sub.stop(end + 0.02);
}

function playPianoNote(ctx, dest, midi, t, durSec, velocity = 1, sustain = false) {
  const start = safeTime(t, ctx.length / ctx.sampleRate);
  const end = Math.min(start + durSec, ctx.length / ctx.sampleRate - 0.001);
  const f = midiToHz(midi);
  const fund = new OscillatorNode(ctx, { type: "triangle", frequency: f });
  const oct  = new OscillatorNode(ctx, { type: "sine",     frequency: f * 2 });
  const dtu  = new OscillatorNode(ctx, { type: "triangle", frequency: f * 1.006 });
  const gFund = new GainNode(ctx, { gain: 0 });
  const gOct  = new GainNode(ctx, { gain: 0 });
  const gDtu  = new GainNode(ctx, { gain: 0 });
  fund.connect(gFund).connect(dest);
  oct.connect(gOct).connect(dest);
  dtu.connect(gDtu).connect(dest);
  // Sustained pad-style if sustain=true: longer release, lower peak.
  const a = 0.006;
  const peak = (sustain ? 0.16 : 0.22) * velocity;
  const sustainLevel = sustain ? 0.13 * velocity : 0.07 * velocity;
  const sustainAt = start + (sustain ? 0.25 : 0.15);
  gFund.gain.setValueAtTime(1e-4, start);
  gFund.gain.exponentialRampToValueAtTime(peak, start + a);
  gFund.gain.exponentialRampToValueAtTime(sustainLevel, Math.min(end, sustainAt));
  gFund.gain.exponentialRampToValueAtTime(1e-4, end);
  gOct.gain.setValueAtTime(1e-4, start);
  gOct.gain.exponentialRampToValueAtTime(0.07 * velocity, start + a);
  gOct.gain.exponentialRampToValueAtTime(1e-4, Math.min(end, start + 0.3));
  gDtu.gain.setValueAtTime(1e-4, start);
  gDtu.gain.exponentialRampToValueAtTime(0.10 * velocity, start + a);
  gDtu.gain.exponentialRampToValueAtTime(1e-4, end);
  fund.start(start); oct.start(start); dtu.start(start);
  fund.stop(end + 0.02); oct.stop(end + 0.02); dtu.stop(end + 0.02);
}

function playPianoChord(ctx, dest, midiArr, t, durSec, velocity = 1, sustain = false) {
  midiArr.forEach((m, i) => {
    playPianoNote(ctx, dest, m, t + i * 0.006, durSec, velocity, sustain);
  });
}

// Pedal-steel voice with portamento (frequency ramp) and continuous sustain.
// `glide` array: [{atTime, toMidi}] for tied notes — gives the voice a sustained
// pad that bends from chord to chord without re-attacking.
function playPedalSteelVoice(ctx, dest, glide, opts = {}) {
  if (!glide || glide.length === 0) return;
  const { pan = 0, velocity = 1, attackTime = 0.25 } = opts;
  const first = glide[0];
  const last  = glide[glide.length - 1];
  const startT = safeTime(first.atTime, ctx.length / ctx.sampleRate);
  const endT   = Math.min(last.atTime + (last.releaseAfter ?? 0.5), ctx.length / ctx.sampleRate - 0.001);
  if (endT <= startT) return;

  const osc = new OscillatorNode(ctx, { type: "sawtooth", frequency: midiToHz(first.toMidi) });
  const lpf = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 2400, Q: 0.7 });
  const g = new GainNode(ctx, { gain: 0 });
  const vib = new OscillatorNode(ctx, { type: "sine", frequency: 5.4 });
  const vibAmt = new GainNode(ctx, { gain: 9 });
  const panner = new StereoPannerNode(ctx, { pan });
  vib.connect(vibAmt).connect(osc.detune);
  osc.connect(lpf).connect(g).connect(panner).connect(dest);

  // Schedule frequency glides between each waypoint.
  for (let i = 1; i < glide.length; i++) {
    const prev = glide[i - 1];
    const curr = glide[i];
    const t0 = safeTime(prev.atTime, ctx.length / ctx.sampleRate);
    const t1 = safeTime(curr.atTime, ctx.length / ctx.sampleRate);
    osc.frequency.setValueAtTime(midiToHz(prev.toMidi), t0);
    osc.frequency.exponentialRampToValueAtTime(midiToHz(curr.toMidi), Math.max(t1, t0 + 0.05));
  }

  const peak = 0.10 * velocity;
  g.gain.setValueAtTime(1e-4, startT);
  g.gain.exponentialRampToValueAtTime(peak, startT + attackTime);
  // Gently swell up and down through the duration
  const mid = (startT + endT) / 2;
  g.gain.exponentialRampToValueAtTime(peak * 1.05, mid);
  g.gain.exponentialRampToValueAtTime(peak * 0.7, endT - 0.4);
  g.gain.exponentialRampToValueAtTime(1e-4, endT);

  vib.start(startT); osc.start(startT);
  vib.stop(endT + 0.05); osc.stop(endT + 0.05);
}

// ============================================================================
// GROOVE SELECTION
// ============================================================================

// Named groove definitions. Each is a complete pattern blueprint that the
// renderer consumes. Adding a new feel = adding an entry here.
const GROOVES = {
  ballad: {
    name: "ballad", label: "Ballad", swing: 0,
    kickPattern:  [0.9, 0, 0, 0, 0.8, 0, 0, 0],
    snarePattern: [0, 0, 0.7, 0, 0, 0, 0.7, 0],
    hatPattern:   [0, 0, 0, 0, 0, 0, 0, 0],
    brushPattern: [0.5, 0.3, 0.5, 0.3, 0.5, 0.3, 0.5, 0.3],
    bassFeel: "two", pianoFeel: "ballad", steelFeel: "swells",
    fillProbability: 0.4,
  },
  "two-step": {
    name: "two-step", label: "Two-step", swing: 0,
    kickPattern:  [1.0, 0, 0, 0, 0.9, 0, 0, 0],
    snarePattern: [0, 0, 0.85, 0, 0, 0, 0.9, 0],
    hatPattern:   [0.4, 0.3, 0.45, 0.3, 0.4, 0.3, 0.45, 0.3],
    brushPattern: null,
    bassFeel: "two", pianoFeel: "honkytonk", steelFeel: "sustain",
    fillProbability: 0.55,
  },
  train: {
    name: "train", label: "Train beat", swing: 0.12,
    kickPattern:  [1.0, 0, 0, 0, 1.0, 0, 0, 0],
    snarePattern: [0.25, 0.25, 0.95, 0.25, 0.25, 0.25, 0.95, 0.25],
    hatPattern:   [0.35, 0.3, 0.35, 0.3, 0.35, 0.3, 0.35, 0.3],
    brushPattern: null,
    bassFeel: "walk", pianoFeel: "honkytonk", steelFeel: "swells",
    fillProbability: 0.7,
  },
  shuffle: {
    name: "shuffle", label: "Shuffle", swing: 0.16,
    kickPattern:  [1.0, 0, 0, 0, 0.95, 0, 0, 0],
    snarePattern: [0, 0.2, 0.9, 0.2, 0, 0.2, 0.95, 0.2],
    hatPattern:   [0.45, 0.3, 0.45, 0.3, 0.45, 0.3, 0.45, 0.3],
    brushPattern: null,
    bassFeel: "walk", pianoFeel: "honkytonk", steelFeel: "sustain",
    fillProbability: 0.6,
  },
};

// Public list of all available feels (for UI rendering).
// The "auto" pseudo-feel means "pick by BPM" — handled by chooseGroove().
export const AVAILABLE_GROOVES = [
  { key: "auto",     label: "Auto (by BPM)" },
  { key: "ballad",   label: GROOVES.ballad.label },
  { key: "two-step", label: GROOVES["two-step"].label },
  { key: "train",    label: GROOVES.train.label },
  { key: "shuffle",  label: GROOVES.shuffle.label },
];

// Pick groove by name; falls back to BPM-based auto-select.
function chooseGroove(bpm, override) {
  if (override && override !== "auto" && GROOVES[override]) return GROOVES[override];
  // Auto-pick by BPM
  if (bpm < 90)  return GROOVES.ballad;
  if (bpm < 115) return GROOVES["two-step"];
  if (bpm < 145) return GROOVES.train;
  return GROOVES.shuffle;
}

// Compute time within a 2-beat phrase for slot index 0..7 (8 eighth slots).
function slotTime(slot, secondsPerBeat, swing) {
  const beat = Math.floor(slot / 2);
  const sub  = slot % 2;
  const half = secondsPerBeat / 2;
  const andOff = half + swing * half;
  return beat * secondsPerBeat + (sub === 0 ? 0 : andOff);
}

// ============================================================================
// STEM RENDERERS — now beat-grid aware (use `beats` array)
// ============================================================================

function renderDrums(ctx, master, { chords, beats, duration, groove, rng }) {
  const noise = makeNoiseBuffer(ctx, 1);
  if (beats.length === 0) return;
  const spb = (beats[beats.length - 1] - beats[0]) / Math.max(1, beats.length - 1);

  // Process in 2-beat phrases anchored on the actual detected beats.
  const chordChangeTimes = new Set(chords.slice(1).map((c) => c.start));
  const isApproachingChange = (phraseStart, phraseSec) => {
    for (const t of chordChangeTimes) {
      if (t > phraseStart && t <= phraseStart + phraseSec) return true;
    }
    return false;
  };

  for (let i = 0; i < beats.length - 1; i += 2) {
    const phraseStart = beats[i];
    const nextBeat = beats[i + 1] ?? (phraseStart + spb);
    const beatAfter = beats[i + 2] ?? (nextBeat + spb);
    const phraseSec = beatAfter - phraseStart;
    if (phraseStart >= duration) break;

    const doFill = isApproachingChange(phraseStart, phraseSec) && rng() < groove.fillProbability;

    if (doFill) {
      // 6-note tom & snare fill across the 2-beat phrase
      const fillNotes = 6;
      const step = phraseSec / fillNotes;
      const toms = [180, 150, 120, 110, 95, 80];
      for (let n = 0; n < fillNotes; n++) {
        const ft = phraseStart + n * step + jitter(rng, 0.008);
        if (n === fillNotes - 1) {
          playKick(ctx, master, ft, 0.85);
          playSnare(ctx, master, noise, ft, 0.9);
        } else if (n % 2 === 0) {
          playTom(ctx, master, noise, ft, toms[n % toms.length], 0.75 + jitter(rng, 0.1));
        } else {
          playSnare(ctx, master, noise, ft, 0.55 + jitter(rng, 0.15));
        }
      }
      continue;
    }

    // Normal 2-beat pattern across 8 eighth-note slots
    for (let slot = 0; slot < 8; slot++) {
      const slotT = phraseStart + slotTime(slot, spb, groove.swing);
      if (slotT >= duration) break;
      const kv = groove.kickPattern[slot];
      const sv = groove.snarePattern[slot];
      const hv = groove.hatPattern[slot];
      const bv = groove.brushPattern ? groove.brushPattern[slot] : 0;
      const jit = jitter(rng, 0.005);
      if (kv > 0) playKick(ctx, master, slotT + jit, kv * (0.9 + jitter(rng, 0.1)));
      if (sv > 0) {
        if (groove.name === "ballad" && sv < 0.8) playRim(ctx, master, slotT + jit, sv);
        else playSnare(ctx, master, noise, slotT + jit, sv * (0.9 + jitter(rng, 0.1)));
      }
      if (hv > 0) playHat(ctx, master, noise, slotT + jit, hv * (0.85 + jitter(rng, 0.15)));
      if (bv > 0) playBrush(ctx, master, noise, slotT, spb / 2 * 0.95, bv);
    }
  }
}

function renderBass(ctx, master, { chords, beats, duration, groove, rng, keyRoot, keyQuality }) {
  if (beats.length === 0) return;
  const spb = (beats[beats.length - 1] - beats[0]) / Math.max(1, beats.length - 1);

  // Build a chord lookup per beat index
  const chordAtBeat = beats.map((tb) => {
    for (const c of chords) if (tb >= c.start - 0.01 && tb < c.end - 0.01) return c;
    return chords[0];
  });

  for (let bi = 0; bi < beats.length; bi++) {
    const t = beats[bi];
    if (t >= duration) break;
    const seg = chordAtBeat[bi];
    if (!seg) continue;
    const nextSeg = chordAtBeat[bi + 1] ?? seg;
    const isLastBeatOfChord = (nextSeg !== seg) || bi === beats.length - 1;

    const rootPc = seg.root;
    const fifthPc = (rootPc + 7) % 12;
    const scalePcs = scaleForChord(seg.root, seg.quality, keyRoot, keyQuality);

    let pc;
    let approachJitter = 0;

    if (isLastBeatOfChord && nextSeg !== seg) {
      // Approach: stepwise scalar approach to next chord root from above or below.
      const targetPc = nextSeg.root;
      const fromMidi = 36 + rootPc;
      const toMidi = 36 + targetPc;
      const approach = nearestInScale(toMidi - (toMidi > fromMidi ? 2 : -2), scalePcs);
      pc = approach % 12;
    } else if (groove.bassFeel === "two") {
      // Root on odd, fifth on even (or root on 1+3, fifth on 2+4 depending on local count)
      const localBeat = (bi - beats.findIndex((tb) => tb >= seg.start - 0.005));
      pc = localBeat % 2 === 0 ? rootPc : fifthPc;
    } else {
      // walking: cycle through 1-3-5-6 scale degrees
      const localBeat = bi - beats.findIndex((tb) => tb >= seg.start - 0.005);
      const scaleDegrees = [0, 2, 4, 5];  // R-3-5-6 by index into scalePcs
      const idx = scaleDegrees[localBeat % scaleDegrees.length] ?? 0;
      pc = scalePcs[idx];
    }

    const midi = 36 + pc;                   // C2 = 36; pc adjusts within an octave
    const noteDur = spb * (0.88 + jitter(rng, 0.05));
    const vel = 0.85 + jitter(rng, 0.12);
    playBassNote(ctx, master, midi, t + jitter(rng, 0.004), noteDur, vel);
  }
}

function renderPiano(ctx, master, { chords, beats, duration, groove, rng, keyRoot, keyQuality }) {
  if (beats.length === 0) return;
  const spb = (beats[beats.length - 1] - beats[0]) / Math.max(1, beats.length - 1);

  let prevVoicing = null;
  // For each chord segment, lay out a sustained voicing and add per-beat decoration.
  for (let ci = 0; ci < chords.length; ci++) {
    const seg = chords[ci];
    if (seg.start >= duration) break;
    const segEnd = Math.min(seg.end, duration);
    const segDur = segEnd - seg.start;

    const voicing = voiceLedTriad(seg.root, seg.quality, prevVoicing);
    prevVoicing = voicing;

    if (groove.pianoFeel === "ballad") {
      // Held voicing for the whole chord, plus a soft re-strike halfway through.
      playPianoChord(ctx, master, voicing, seg.start, segDur, 0.75, true);
      if (segDur > spb * 3) {
        playPianoChord(ctx, master, voicing, seg.start + segDur / 2, segDur / 2, 0.5, true);
      }
      // Scalar fill on the last beat before chord change
      addScalarFill(ctx, master, voicing, seg, chords[ci + 1], spb, rng, keyRoot, keyQuality);
      continue;
    }

    // Honky-tonk: left-hand boom-chick + right-hand sustained voicing + stab on 2 & 4
    const lhRoot = 12 * 4 + seg.root;
    const lhFifth = lhRoot + 7;

    // Sustained right-hand pad (quiet) under the rhythm
    playPianoChord(ctx, master, voicing, seg.start, segDur, 0.4, true);

    // Find which beats fall within this segment
    const segBeats = beats
      .map((tb, idx) => ({ tb, idx }))
      .filter((b) => b.tb >= seg.start - 0.005 && b.tb < segEnd - 0.005);

    segBeats.forEach((b, localIdx) => {
      const t = b.tb;
      // Left-hand boom on beats 1 and 3 of each chord (i.e. localIdx 0, 2, 4, ...)
      if (localIdx % 2 === 0) {
        const m = localIdx % 4 === 0 ? lhRoot : lhFifth;
        playPianoNote(ctx, master, m, t + jitter(rng, 0.005), spb * 0.9, 0.55 + jitter(rng, 0.08));
      }
      // Right-hand stab on 2 and 4
      if (localIdx % 2 === 1) {
        playPianoChord(ctx, master, voicing, t + jitter(rng, 0.005), spb * 0.4, 0.55 + jitter(rng, 0.12), false);
      }
    });

    // Scalar fill at end of chord (going into the change)
    addScalarFill(ctx, master, voicing, seg, chords[ci + 1], spb, rng, keyRoot, keyQuality);
  }
}

function addScalarFill(ctx, master, voicing, seg, nextSeg, spb, rng, keyRoot, keyQuality) {
  if (!nextSeg) return;
  if (rng() > 0.45) return;          // 45% of changes get a fill
  const fillBeats = 1;               // last beat of the chord
  const fillStart = seg.end - spb * fillBeats;
  if (fillStart <= seg.start) return;

  // Use the current chord's scale for the lick; target the next chord's root.
  const scalePcs = scaleForChord(seg.root, seg.quality, keyRoot, keyQuality);
  const topVoice = voicing[voicing.length - 1];
  const targetMidi = nearestInScale(12 * 5 + nextSeg.root, scalePcs); // around C5
  // Build a 3 or 4 note scalar descent/ascent toward target
  const notes = 4;
  const step = (spb * fillBeats) / notes;
  const line = walkingLine(topVoice, targetMidi, notes, scalePcs);
  for (let i = 0; i < line.length; i++) {
    const t = fillStart + i * step + jitter(rng, 0.005);
    playPianoNote(ctx, master, line[i], t, step * 0.85, 0.55 + jitter(rng, 0.08));
  }
}

// Pedal steel: build a continuous, tied-together set of 3 voices (low/mid/top)
// that bend across chord changes via portamento. One long voice per chord-segment-pair.
function renderPedalSteel(ctx, master, { chords, duration, groove, rng }) {
  if (chords.length === 0) return;

  // Voice leading: produce a sequence of 3-note voicings, one per chord segment.
  const voicings = [];
  let prev = null;
  for (const seg of chords) {
    const v = voiceLedTriad(seg.root, seg.quality, prev);
    // Move into pedal-steel sweet spot (G3..G5).
    const adjusted = v.map((m) => {
      while (m < 55) m += 12;
      while (m > 79) m -= 12;
      return m;
    }).sort((a, b) => a - b);
    voicings.push(adjusted);
    prev = adjusted;
  }

  // For each voice (low/mid/top), schedule ONE pedal-steel oscillator that
  // glides between the assigned MIDI notes at each chord change.
  for (let voiceIdx = 0; voiceIdx < 3; voiceIdx++) {
    const pan = -0.35 + voiceIdx * 0.35;
    const glide = [];
    for (let i = 0; i < chords.length; i++) {
      const seg = chords[i];
      if (seg.start >= duration) break;
      const midi = voicings[i][voiceIdx];
      // Slight per-chord strum: voices arrive a few ms apart.
      const t = seg.start + voiceIdx * 0.04 + jitter(rng, 0.01);
      glide.push({ atTime: t, toMidi: midi });
    }
    if (glide.length === 0) continue;
    // Tail: hold the last note for up to 1.2 s past the end of the last segment.
    const lastSegEnd = Math.min(chords[Math.min(chords.length - 1, glide.length - 1)].end, duration);
    glide[glide.length - 1].releaseAfter = Math.min(1.2, duration - glide[glide.length - 1].atTime - 0.05);
    if (glide[glide.length - 1].releaseAfter < 0.2) glide[glide.length - 1].releaseAfter = 0.2;

    const swell = groove.steelFeel === "swells";
    playPedalSteelVoice(ctx, master, glide, {
      pan,
      velocity: 0.9 + jitter(rng, 0.06),
      attackTime: swell ? 0.35 : 0.18,
    });
  }
}

// ============================================================================
// TOP-LEVEL RENDER
// ============================================================================

async function renderStem({ chords, beats, bpm, duration, stem, keyRoot, keyQuality, feel }) {
  const safeBpm = Number.isFinite(bpm) && bpm > 20 ? bpm : 100;
  const groove = chooseGroove(safeBpm, feel);
  const numSamples = Math.max(1, Math.ceil(duration * RENDER_SAMPLE_RATE));
  const ctx = new OfflineAudioContext(2, numSamples, RENDER_SAMPLE_RATE);

  const gains = { drums: 0.85, bass: 0.75, piano: 0.55, pedalSteel: 0.5 };
  const master = new GainNode(ctx, { gain: gains[stem] ?? 0.7 });

  if (stem === "drums") {
    const ws = new WaveShaperNode(ctx, { curve: softClipCurve(), oversample: "2x" });
    master.connect(ws).connect(ctx.destination);
  } else {
    master.connect(ctx.destination);
  }

  const seed = ({ drums: 11, bass: 23, piano: 37, pedalSteel: 53 })[stem] ?? 1;
  const rng = makeRng(seed + Math.round(safeBpm));
  const ctxArgs = { chords, beats, bpm: safeBpm, duration, groove, rng, keyRoot, keyQuality };

  if (stem === "drums")            renderDrums(ctx, master, ctxArgs);
  else if (stem === "bass")        renderBass(ctx, master, ctxArgs);
  else if (stem === "piano")       renderPiano(ctx, master, ctxArgs);
  else if (stem === "pedalSteel")  renderPedalSteel(ctx, master, ctxArgs);

  return ctx.startRendering();
}

function softClipCurve() {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 1.4) / Math.tanh(1.4);
  }
  return curve;
}

export async function renderAllStems(analysis, durationCap, onProgress, feel) {
  const stems = ["drums", "bass", "piano", "pedalSteel"];
  const out = [];
  for (let i = 0; i < stems.length; i++) {
    const name = stems[i];
    onProgress?.(name, i, stems.length);
    const buffer = await renderStem({
      chords: analysis.chords,
      beats: analysis.beats,
      bpm: analysis.bpm,
      duration: durationCap,
      keyRoot: analysis.keyRoot,
      keyQuality: analysis.keyQuality,
      stem: name,
      feel,
    });
    const blob = encodeWav(buffer);
    out.push({ name, blob, url: URL.createObjectURL(blob), buffer });
  }
  return out;
}

// Expose groove info so the UI can display what was chosen. `feel` may be
// "auto" or a named groove key — when "auto", the result is BPM-derived.
export function describeGroove(bpm, feel) {
  const g = chooseGroove(Number.isFinite(bpm) && bpm > 20 ? bpm : 100, feel);
  return { key: g.name, label: g.label, swing: g.swing };
}
