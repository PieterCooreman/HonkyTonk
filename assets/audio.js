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
};

// ----------------------------------------------------------------------------
// Country scale palette (semitone offsets from the scale's root note).
//
// These are the note pools the melodic stems pick from. Each one has a flavor:
//   - MAJOR_PENTATONIC: "safe" major — root, 2, 3, 5, 6. No half-steps. The
//     bread-and-butter for fiddle/Tele runs and bass walks over a major chord.
//   - MIXOLYDIAN:       major scale with b7. The b7 ("flat seven") is the
//     iconic country twang — think the lick at the end of every Hank Williams
//     line. Used most often for licks and fills over a major chord.
//   - MAJOR:            full diatonic major scale. Used for passing tones and
//     for the V chord (which wants the leading tone, the natural 7).
//   - BLUES:            R, b3, 4, b5, 5, b7. Sparingly — for blue-note bends.
//   - HYBRID_COUNTRY:   major scale fused with the b3 and b7 from blues —
//     gives access to "the country lick" (b3 -> 3 hammer-on, b7 -> R resolve).
//     This is what most session musicians actually play over a major chord.
//   - DORIAN:           minor with natural 6. The country-friendly minor scale
//     (e.g. for vi). Pure natural-minor sounds rock/sad; Dorian is brighter.
// ----------------------------------------------------------------------------
const SCALES = {
  major:            [0, 2, 4, 5, 7, 9, 11],
  majorPentatonic:  [0, 2, 4, 7, 9],
  mixolydian:       [0, 2, 4, 5, 7, 9, 10],     // b7
  blues:            [0, 3, 5, 6, 7, 10],         // R b3 4 b5 5 b7
  hybridCountry:    [0, 2, 3, 4, 5, 7, 9, 10],  // major + b3 + b7
  dorian:           [0, 2, 3, 5, 7, 9, 10],     // minor with natural 6
  naturalMinor:     [0, 2, 3, 5, 7, 8, 10],
};

// Legacy alias for any callers still asking by maj/min.
const SCALE = { maj: SCALES.major, min: SCALES.naturalMinor };

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
// SYNTHESIS — drums + bass only, dead-quantized to the detected beat grid.
//
// Design rules:
//   - Every hit lands on a beat from the analyzer's `beats` array.
//   - No timing jitter, no swing, no fills, no humanization. The output is
//     trivially quantizable in any DAW.
//   - Each bar = 4 beats. Pattern repeats identically every bar.
//   - No piano, no pedal steel. Just kick / snare / closed hat + bass roots.
// ============================================================================

function midiToHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

function makeNoiseBuffer(ctx, seconds = 0.4) {
  // Shared, short white-noise buffer used by snare + hi-hat. Generating once
  // and re-using is critical for render speed — calling createBuffer per hit
  // for hundreds of hits is what made the previous renderer crawl.
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

// ----- Drum voices -----------------------------------------------------------
//
// Each voice schedules a small set of WebAudio nodes for a single hit. No
// effects bus, no waveshaper, no filters on the master — that adds up across
// hundreds of hits.

function playKick(ctx, dest, t) {
  const osc  = new OscillatorNode(ctx, { type: "sine", frequency: 150 });
  const gain = new GainNode(ctx, { gain: 0 });
  osc.connect(gain).connect(dest);
  osc.frequency.setValueAtTime(150, t);
  osc.frequency.exponentialRampToValueAtTime(48, t + 0.18);
  gain.gain.setValueAtTime(1e-4, t);
  gain.gain.exponentialRampToValueAtTime(0.95, t + 0.002);
  gain.gain.exponentialRampToValueAtTime(1e-4, t + 0.22);
  osc.start(t);
  osc.stop(t + 0.24);
}

function playSnare(ctx, dest, noiseBuf, t) {
  // Noise burst (the "splash") + a short tonal body.
  const src  = new AudioBufferSourceNode(ctx, { buffer: noiseBuf });
  const hpf  = new BiquadFilterNode(ctx, { type: "highpass", frequency: 1800, Q: 0.7 });
  const ngn  = new GainNode(ctx, { gain: 0 });
  src.connect(hpf).connect(ngn).connect(dest);
  ngn.gain.setValueAtTime(1e-4, t);
  ngn.gain.exponentialRampToValueAtTime(0.45, t + 0.0015);
  ngn.gain.exponentialRampToValueAtTime(1e-4, t + 0.15);
  src.start(t);
  src.stop(t + 0.16);

  const body = new OscillatorNode(ctx, { type: "triangle", frequency: 220 });
  const bg   = new GainNode(ctx, { gain: 0 });
  body.connect(bg).connect(dest);
  body.frequency.setValueAtTime(220, t);
  body.frequency.exponentialRampToValueAtTime(140, t + 0.08);
  bg.gain.setValueAtTime(1e-4, t);
  bg.gain.exponentialRampToValueAtTime(0.28, t + 0.002);
  bg.gain.exponentialRampToValueAtTime(1e-4, t + 0.13);
  body.start(t);
  body.stop(t + 0.15);
}

function playClosedHat(ctx, dest, noiseBuf, t) {
  const src  = new AudioBufferSourceNode(ctx, { buffer: noiseBuf });
  const hpf  = new BiquadFilterNode(ctx, { type: "highpass", frequency: 7000, Q: 0.7 });
  const gn   = new GainNode(ctx, { gain: 0 });
  src.connect(hpf).connect(gn).connect(dest);
  gn.gain.setValueAtTime(1e-4, t);
  gn.gain.exponentialRampToValueAtTime(0.16, t + 0.0015);
  gn.gain.exponentialRampToValueAtTime(1e-4, t + 0.05);
  src.start(t);
  src.stop(t + 0.06);
}

// ----- Bass voice ------------------------------------------------------------

function playBassNote(ctx, dest, midi, t, durSec) {
  const osc = new OscillatorNode(ctx, { type: "triangle", frequency: midiToHz(midi) });
  const lpf = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 620, Q: 1.0 });
  const gn  = new GainNode(ctx, { gain: 0 });
  osc.connect(lpf).connect(gn).connect(dest);
  const end = t + durSec;
  gn.gain.setValueAtTime(1e-4, t);
  gn.gain.exponentialRampToValueAtTime(0.5, t + 0.012);
  gn.gain.exponentialRampToValueAtTime(0.22, Math.min(end, t + 0.15));
  gn.gain.exponentialRampToValueAtTime(1e-4, end);
  osc.start(t);
  osc.stop(end + 0.02);
}

// ----- Per-stem renderers ----------------------------------------------------

function renderDrums(ctx, master, { beats, duration }) {
  if (beats.length === 0) return;
  const noise = makeNoiseBuffer(ctx, 0.4);

  // Bar position is beat-index mod 4: 0 → beat 1, 1 → beat 2, 2 → beat 3, 3 → beat 4.
  // Pattern, identical every bar:
  //   beat 1: kick + closed hat
  //   beat 2: snare + closed hat
  //   beat 3: kick + closed hat
  //   beat 4: snare + closed hat
  for (let i = 0; i < beats.length; i++) {
    const t = beats[i];
    if (t >= duration) break;
    const posInBar = i % 4;
    if (posInBar === 0 || posInBar === 2) playKick (ctx, master, t);
    if (posInBar === 1 || posInBar === 3) playSnare(ctx, master, noise, t);
    playClosedHat(ctx, master, noise, t);
  }
}

function renderBass(ctx, master, { chords, beats, duration }) {
  if (beats.length === 0) return;
  // Average beat duration, used for note length.
  const span = beats[beats.length - 1] - beats[0];
  const avgSpb = span / Math.max(1, beats.length - 1);

  // Helper: find the chord active at time `t`.
  function chordAt(t) {
    for (let i = 0; i < chords.length; i++) {
      const c = chords[i];
      if (t >= c.start - 1e-3 && t < c.end - 1e-3) return c;
    }
    return chords[0] ?? null;
  }

  // One quarter-note bass root per beat.
  const noteDur = avgSpb * 0.92;
  for (let i = 0; i < beats.length; i++) {
    const t = beats[i];
    if (t >= duration) break;
    const seg = chordAt(t);
    if (!seg) continue;
    // Bass register: anchor on C2 (MIDI 36). pitch class = seg.root (0..11).
    const midi = 36 + seg.root;
    playBassNote(ctx, master, midi, t, noteDur);
  }
}

// ----- Top-level render ------------------------------------------------------

async function renderStem({ chords, beats, duration, stem }) {
  const numSamples = Math.max(1, Math.ceil(duration * RENDER_SAMPLE_RATE));
  const ctx = new OfflineAudioContext(2, numSamples, RENDER_SAMPLE_RATE);

  // Per-stem master gain. Tuned for rough loudness parity. No bus effects.
  const gains = { drums: 0.85, bass: 0.75 };
  const master = new GainNode(ctx, { gain: gains[stem] ?? 0.7 });
  master.connect(ctx.destination);

  if      (stem === "drums") renderDrums(ctx, master, { beats, duration });
  else if (stem === "bass")  renderBass (ctx, master, { chords, beats, duration });

  return ctx.startRendering();
}

export const STEMS = ["drums", "bass"];

export async function renderAllStems(analysis, durationCap, onProgress) {
  const out = [];
  for (let i = 0; i < STEMS.length; i++) {
    const name = STEMS[i];
    onProgress?.(name, i, STEMS.length);
    const buffer = await renderStem({
      chords: analysis.chords,
      beats:  analysis.beats,
      duration: durationCap,
      stem: name,
    });
    const blob = encodeWav(buffer);
    out.push({ name, blob, url: URL.createObjectURL(blob), buffer });
  }
  return out;
}