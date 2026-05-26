// audio.js — All audio analysis and synthesis for Honkytonk Stems.
// Pure functions, no DOM, no framework. Ported from the original bundle.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const RENDER_SAMPLE_RATE = 44100;

export const STEM_LABELS = {
  drums: "Drums",
  bass: "Bass",
  piano: "Piano",
  pedalSteel: "Pedal Steel",
};

// ---------------------------------------------------------------------------
// Chord templates: 12 major + 12 minor triads as binary 12-vectors
// ---------------------------------------------------------------------------

function buildChordTemplates() {
  const out = [];
  for (let root = 0; root < 12; root++) {
    const maj = new Array(12).fill(0);
    maj[root] = 1;
    maj[(root + 4) % 12] = 1; // major third
    maj[(root + 7) % 12] = 1; // perfect fifth
    out.push({ name: NOTE_NAMES[root], root, quality: "maj", vec: maj });

    const min = new Array(12).fill(0);
    min[root] = 1;
    min[(root + 3) % 12] = 1; // minor third
    min[(root + 7) % 12] = 1; // perfect fifth
    out.push({ name: NOTE_NAMES[root] + "m", root, quality: "min", vec: min });
  }
  return out;
}

const CHORD_TEMPLATES = buildChordTemplates();

// ---------------------------------------------------------------------------
// Helpers: math + audio plumbing
// ---------------------------------------------------------------------------

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

// Goertzel single-bin DFT — cheap energy estimate at one frequency.
function goertzelMagnitude(samples, sampleRate, freqHz) {
  const k = Math.round(samples.length * freqHz / sampleRate);
  const w = (2 * Math.PI * k) / samples.length;
  const coeff = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2);
}

// Build a chroma vector (12 pitch-class energies, max-normalized) for a window
// of samples by summing Goertzel responses across MIDI octaves 3..6.
function computeChromaVector(samples, sampleRate) {
  const chroma = new Array(12).fill(0);
  const minOctave = 2;
  const maxOctave = 5;
  for (let octave = minOctave; octave <= maxOctave; octave++) {
    for (let pc = 0; pc < 12; pc++) {
      const midi = 12 * (octave + 1) + pc;
      const freq = 440 * Math.pow(2, (midi - 69) / 12);
      if (freq > sampleRate / 2) continue; // Nyquist guard
      chroma[pc] += goertzelMagnitude(samples, sampleRate, freq);
    }
  }
  const peak = Math.max(...chroma);
  if (peak > 0) for (let i = 0; i < 12; i++) chroma[i] /= peak;
  return chroma;
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

function matchChordTemplate(chroma) {
  let best = CHORD_TEMPLATES[0];
  let bestScore = -Infinity;
  for (const tpl of CHORD_TEMPLATES) {
    const score = cosineSimilarity(chroma, tpl.vec);
    if (score > bestScore) {
      bestScore = score;
      best = tpl;
    }
  }
  return { name: best.name, root: best.root, quality: best.quality };
}

// Two-pass: (1) replace a single chord sandwiched by identical neighbours with
// the neighbour chord ("flap" removal); (2) merge consecutive identical chords.
function smoothAndMergeChords(segments) {
  if (segments.length === 0) return [];
  const flapped = segments.map((seg, i) => {
    if (i === 0 || i === segments.length - 1) return seg;
    const prev = segments[i - 1];
    const next = segments[i + 1];
    if (prev.chord === next.chord && prev.chord !== seg.chord) {
      return { ...seg, chord: prev.chord, root: prev.root, quality: prev.quality };
    }
    return seg;
  });
  const merged = [];
  for (const seg of flapped) {
    const last = merged[merged.length - 1];
    if (last && last.chord === seg.chord) {
      last.end = seg.end;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// BPM detection — autocorrelation on a low-frequency envelope.
// Replaces the original ~6000-line worker pipeline.
// ---------------------------------------------------------------------------

async function detectBpm(buffer) {
  const sr = buffer.sampleRate;
  const mono = toMonoSamples(buffer);

  // 1. Downsample to ~200 Hz envelope by computing windowed peak energy.
  //    This is fast and exposes the beat structure.
  const targetSr = 200;
  const blockSize = Math.floor(sr / targetSr);
  const blocks = Math.floor(mono.length / blockSize);
  const env = new Float32Array(blocks);
  for (let i = 0; i < blocks; i++) {
    let peak = 0;
    const start = i * blockSize;
    for (let j = 0; j < blockSize; j++) {
      const v = Math.abs(mono[start + j]);
      if (v > peak) peak = v;
    }
    env[i] = peak;
  }

  // 2. High-pass via subtraction of a moving mean (removes slow drift).
  const meanWin = Math.floor(targetSr * 0.5);
  const hp = new Float32Array(blocks);
  let sum = 0;
  for (let i = 0; i < blocks; i++) {
    sum += env[i];
    if (i >= meanWin) sum -= env[i - meanWin];
    const m = sum / Math.min(i + 1, meanWin);
    hp[i] = Math.max(0, env[i] - m);
  }

  // 3. Autocorrelate over lags corresponding to 60..180 BPM.
  const minBpm = 60, maxBpm = 180;
  const minLag = Math.floor((60 / maxBpm) * targetSr);
  const maxLag = Math.floor((60 / minBpm) * targetSr);
  let bestLag = minLag, bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < blocks; i++) acc += hp[i] * hp[i + lag];
    if (acc > bestScore) {
      bestScore = acc;
      bestLag = lag;
    }
  }

  const bpm = (60 * targetSr) / bestLag;
  if (!Number.isFinite(bpm) || bpm < 40 || bpm > 220) return 100;
  return bpm;
}

// ---------------------------------------------------------------------------
// Top-level analysis: BPM, chord segments, estimated key, duration
// ---------------------------------------------------------------------------

export async function analyzeSong(buffer, onProgress) {
  onProgress?.(0.05, "Detecting tempo…");

  let bpm = 100;
  try {
    bpm = Math.round(await detectBpm(buffer));
  } catch {
    bpm = 100;
  }

  onProgress?.(0.25, "Analyzing harmony…");

  const mono = toMonoSamples(buffer);
  const sr = buffer.sampleRate;
  const windowSec = (60 / bpm) * 2;            // 2 beats per analysis window
  const windowLen = Math.floor(windowSec * sr);
  const numWindows = Math.floor(mono.length / windowLen);

  const segments = [];
  for (let w = 0; w < numWindows; w++) {
    const offset = w * windowLen;
    const chunk = mono.subarray(offset, offset + windowLen);
    const chroma = computeChromaVector(chunk, sr);
    const match = matchChordTemplate(chroma);
    segments.push({
      start: offset / sr,
      end: (offset + windowLen) / sr,
      chord: match.name,
      root: match.root,
      quality: match.quality,
    });
    if (w % 8 === 0) {
      onProgress?.(0.25 + 0.7 * (w / numWindows), `Detecting chords (${w}/${numWindows})…`);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const merged = smoothAndMergeChords(segments);

  // Estimated "key" = chord with highest total duration.
  const totals = {};
  for (const seg of merged) totals[seg.chord] = (totals[seg.chord] || 0) + (seg.end - seg.start);
  const key = Object.entries(totals).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "C";

  onProgress?.(1, "Done");
  return { bpm, key, chords: merged, duration: buffer.duration };
}

// ---------------------------------------------------------------------------
// WAV encoding (PCM-16 little-endian, multi-channel)
// ---------------------------------------------------------------------------

export function encodeWav(buffer) {
  const channels = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const bytes = buffer.length * channels * 2 + 44;
  const ab = new ArrayBuffer(bytes);
  const view = new DataView(ab);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, bytes - 8, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);             // fmt chunk size
  view.setUint16(20, 1, true);              // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * channels * 2, true); // byte rate
  view.setUint16(32, channels * 2, true);   // block align
  view.setUint16(34, 16, true);             // bits per sample
  writeStr(36, "data");
  view.setUint32(40, bytes - 44, true);

  const chanData = [];
  for (let c = 0; c < channels; c++) chanData.push(buffer.getChannelData(c));

  let cursor = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let c = 0; c < channels; c++) {
      const x = Math.max(-1, Math.min(1, chanData[c][i]));
      view.setInt16(cursor, x < 0 ? x * 32768 : x * 32767, true);
      cursor += 2;
    }
  }

  return new Blob([ab], { type: "audio/wav" });
}

// ---------------------------------------------------------------------------
// Synthesis primitives
// ---------------------------------------------------------------------------

function midiToHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function triadMidi(rootPc, quality, octave = 4) {
  const third = quality === "maj" ? 4 : 3;
  const base = 12 * (octave + 1) + rootPc;
  return [base, base + third, base + 7];
}

// Keep scheduled times within the rendered context window.
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

// Drum: kick — 150→48 Hz sine with sharp attack and 220 ms decay.
function playKick(ctx, dest, t) {
  const start = safeTime(t, ctx.length / ctx.sampleRate);
  const osc = new OscillatorNode(ctx, { type: "sine", frequency: 150 });
  const gain = new GainNode(ctx, { gain: 0 });
  osc.connect(gain).connect(dest);
  osc.frequency.setValueAtTime(150, start);
  osc.frequency.exponentialRampToValueAtTime(48, start + 0.18);
  gain.gain.setValueAtTime(1e-4, start);
  gain.gain.exponentialRampToValueAtTime(0.9, start + 0.002);
  gain.gain.exponentialRampToValueAtTime(1e-4, start + 0.22);
  osc.start(start);
  osc.stop(start + 0.24);
}

// Helper: filtered noise burst (used by snare body + hi-hat).
function playFilteredNoise(ctx, dest, noiseBuf, t, durSec, peakGain, filterType, filterFreq) {
  const start = safeTime(t, ctx.length / ctx.sampleRate);
  const src = new AudioBufferSourceNode(ctx, { buffer: noiseBuf });
  const bpf = new BiquadFilterNode(ctx, { type: filterType, frequency: filterFreq, Q: 0.7 });
  const gain = new GainNode(ctx, { gain: 0 });
  src.connect(bpf).connect(gain).connect(dest);
  gain.gain.setValueAtTime(1e-4, start);
  gain.gain.exponentialRampToValueAtTime(peakGain, start + 0.0015);
  gain.gain.exponentialRampToValueAtTime(1e-4, start + durSec);
  src.start(start);
  src.stop(start + durSec + 0.01);
}

// Drum: snare — highpassed noise burst plus a short tonal "body".
function playSnare(ctx, dest, noiseBuf, t) {
  const start = safeTime(t, ctx.length / ctx.sampleRate);
  playFilteredNoise(ctx, dest, noiseBuf, start, 0.16, 0.42, "highpass", 1800);
  const osc = new OscillatorNode(ctx, { type: "triangle", frequency: 220 });
  const gain = new GainNode(ctx, { gain: 0 });
  osc.connect(gain).connect(dest);
  osc.frequency.setValueAtTime(220, start);
  osc.frequency.exponentialRampToValueAtTime(140, start + 0.08);
  gain.gain.setValueAtTime(1e-4, start);
  gain.gain.exponentialRampToValueAtTime(0.24, start + 0.002);
  gain.gain.exponentialRampToValueAtTime(1e-4, start + 0.12);
  osc.start(start);
  osc.stop(start + 0.14);
}

// Drum: hi-hat — bright noise burst.
function playHat(ctx, dest, noiseBuf, t) {
  playFilteredNoise(ctx, dest, noiseBuf, t, 0.05, 0.16, "highpass", 7000);
}

// Bass: triangle through a 520 Hz lowpass with an envelope.
function playBassNote(ctx, dest, midi, t, durSec) {
  const start = safeTime(t, ctx.length / ctx.sampleRate);
  const end = Math.min(start + durSec, ctx.length / ctx.sampleRate - 0.001);
  const osc = new OscillatorNode(ctx, { type: "triangle", frequency: midiToHz(midi) });
  const lpf = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 520, Q: 1.2 });
  const gain = new GainNode(ctx, { gain: 0 });
  osc.connect(lpf).connect(gain).connect(dest);
  gain.gain.setValueAtTime(1e-4, start);
  gain.gain.exponentialRampToValueAtTime(0.48, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.2, Math.min(end, start + 0.12));
  gain.gain.exponentialRampToValueAtTime(1e-4, end);
  osc.start(start);
  osc.stop(end + 0.02);
}

// Piano: triad with triangle fundamental + sine octave-up, slightly staggered.
function playPianoChord(ctx, dest, midiArr, t, durSec) {
  const start = safeTime(t, ctx.length / ctx.sampleRate);
  const end = Math.min(start + durSec, ctx.length / ctx.sampleRate - 0.001);
  midiArr.forEach((midi, i) => {
    const f = midiToHz(midi);
    const fund = new OscillatorNode(ctx, { type: "triangle", frequency: f });
    const oct  = new OscillatorNode(ctx, { type: "sine",     frequency: f * 2 });
    const gFund = new GainNode(ctx, { gain: 0 });
    const gOct  = new GainNode(ctx, { gain: 0 });
    fund.connect(gFund).connect(dest);
    oct.connect(gOct).connect(dest);
    const noteStart = start + i * 0.008; // tiny strum roll
    gFund.gain.setValueAtTime(1e-4, noteStart);
    gFund.gain.exponentialRampToValueAtTime(0.17, noteStart + 0.01);
    gFund.gain.exponentialRampToValueAtTime(1e-4, end);
    gOct.gain.setValueAtTime(1e-4, noteStart);
    gOct.gain.exponentialRampToValueAtTime(0.05, noteStart + 0.008);
    gOct.gain.exponentialRampToValueAtTime(1e-4, Math.min(end, noteStart + 0.18));
    fund.start(noteStart);
    oct.start(noteStart);
    fund.stop(end + 0.02);
    oct.stop(end + 0.02);
  });
}

// Pedal steel: sawtooth → lowpass → vibrato via detune mod → stereo pan.
function playPedalSteelNote(ctx, dest, midi, t, durSec, pan = 0) {
  const start = safeTime(t, ctx.length / ctx.sampleRate);
  const end = Math.min(start + durSec, ctx.length / ctx.sampleRate - 0.001);
  const osc = new OscillatorNode(ctx, { type: "sawtooth", frequency: midiToHz(midi) });
  const lpf = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 2200, Q: 0.8 });
  const gain = new GainNode(ctx, { gain: 0 });
  const vibOsc = new OscillatorNode(ctx, { type: "sine", frequency: 5.2 });
  const vibAmt = new GainNode(ctx, { gain: 8 }); // 8 cents of detune wobble
  const panner = new StereoPannerNode(ctx, { pan });
  vibOsc.connect(vibAmt).connect(osc.detune);
  osc.connect(lpf).connect(gain).connect(panner).connect(dest);
  gain.gain.setValueAtTime(1e-4, start);
  gain.gain.exponentialRampToValueAtTime(0.09, start + 0.18); // slow swell
  gain.gain.exponentialRampToValueAtTime(0.055, Math.min(end, start + 0.8));
  gain.gain.exponentialRampToValueAtTime(1e-4, end);
  vibOsc.start(start);
  osc.start(start);
  vibOsc.stop(end + 0.05);
  osc.stop(end + 0.05);
}

// ---------------------------------------------------------------------------
// Stem rendering
// ---------------------------------------------------------------------------

async function renderStem({ chords, bpm, duration, stem }) {
  const spb = 60 / (Number.isFinite(bpm) && bpm > 20 ? bpm : 100); // seconds per beat
  const numSamples = Math.max(1, Math.ceil(duration * RENDER_SAMPLE_RATE));
  const ctx = new OfflineAudioContext(2, numSamples, RENDER_SAMPLE_RATE);
  const master = new GainNode(ctx, { gain: stem === "drums" ? 0.9 : 0.72 });
  master.connect(ctx.destination);
  const noise = makeNoiseBuffer(ctx, 1);

  if (stem === "drums") {
    for (let t = 0; t < duration; t += spb) {
      const beatIdx = Math.round(t / spb) % 4;
      if (beatIdx === 0 || beatIdx === 2) playKick(ctx, master, t);
      if (beatIdx === 1 || beatIdx === 3) playSnare(ctx, master, noise, t);
      playHat(ctx, master, noise, t);
      playHat(ctx, master, noise, t + spb / 2);
    }
  }

  if (stem === "bass") {
    for (const seg of chords) {
      const dur = seg.end - seg.start;
      const beats = Math.max(1, Math.round(dur / spb));
      for (let i = 0; i < beats; i++) {
        const t = seg.start + i * spb;
        if (t >= duration) break;
        const interval = i % 2 === 0 ? 0 : 7;        // root, fifth, root, fifth…
        const midi = 36 + ((seg.root + interval) % 12); // base octave: C2
        playBassNote(ctx, master, midi, t, spb * 0.92);
      }
    }
  }

  if (stem === "piano") {
    for (const seg of chords) {
      const dur = seg.end - seg.start;
      const beats = Math.max(1, Math.round(dur / spb));
      for (let i = 0; i < beats; i++) {
        if (i % 2 !== 1) continue;                   // play on the "and"
        const t = seg.start + i * spb;
        if (t >= duration) break;
        playPianoChord(ctx, master, triadMidi(seg.root, seg.quality, 4), t, spb * 0.55);
      }
    }
  }

  if (stem === "pedalSteel") {
    for (const seg of chords) {
      if (seg.start >= duration) break;
      const dur = seg.end - seg.start;
      const held = Math.min(dur * 0.92, duration - seg.start);
      if (held <= 0.05) continue;
      const notes = triadMidi(seg.root, seg.quality, 4);
      notes.forEach((midi, i, arr) => {
        const pan = arr.length === 1 ? 0 : -0.25 + (i / (arr.length - 1)) * 0.5;
        playPedalSteelNote(ctx, master, midi, seg.start + i * 0.03, held, pan);
      });
    }
  }

  return ctx.startRendering();
}

export async function renderAllStems(chords, bpm, duration, onProgress) {
  const stems = ["drums", "bass", "piano", "pedalSteel"];
  const out = [];
  for (let i = 0; i < stems.length; i++) {
    const name = stems[i];
    onProgress?.(name, i, stems.length);
    const buffer = await renderStem({ chords, bpm, duration, stem: name });
    const blob = encodeWav(buffer);
    out.push({ name, blob, url: URL.createObjectURL(blob) });
  }
  return out;
}
