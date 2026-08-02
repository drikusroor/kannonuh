/**
 * Everything you hear is synthesised at runtime — no audio files, which keeps
 * the bundle tiny and sidesteps Discord's asset CSP entirely.
 */

type Mat = 'stone' | 'wood' | 'metal' | 'flesh' | 'powder' | 'earth';

export class Sound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private music!: GainNode;
  private verb!: ConvolverNode;
  private noise!: AudioBuffer;
  private windSource: AudioBufferSourceNode | null = null;
  private windGain!: GainNode;
  private whistleNodes: { osc: OscillatorNode; gain: GainNode; filter: BiquadFilterNode } | null = null;
  private musicTimer: ReturnType<typeof setInterval> | null = null;
  private musicStep = 0;
  private voices = 0;

  enabled = true;
  musicOn = true;

  /** Must be called from a user gesture. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(ctx.destination);

    this.verb = ctx.createConvolver();
    this.verb.buffer = makeImpulse(ctx, 1.8, 2.6);
    const verbGain = ctx.createGain();
    verbGain.gain.value = 0.26;
    this.verb.connect(verbGain).connect(this.master);

    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.85;
    this.sfx.connect(this.master);
    this.sfx.connect(this.verb);

    this.music = ctx.createGain();
    this.music.gain.value = this.musicOn ? 0.16 : 0;
    this.music.connect(this.master);
    this.music.connect(this.verb);

    this.noise = makeNoise(ctx, 2);

    // Constant, quiet battlefield wind.
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.0;
    const wf = ctx.createBiquadFilter();
    wf.type = 'bandpass';
    wf.frequency.value = 480;
    wf.Q.value = 0.7;
    this.windGain.connect(wf).connect(this.master);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.connect(this.windGain);
    src.start();
    this.windSource = src;

    if (this.musicOn) this.startMusic();
  }

  get ready(): boolean {
    return !!this.ctx && this.enabled;
  }

  private now(): number {
    return this.ctx!.currentTime;
  }

  private budget(): boolean {
    if (!this.ready) return false;
    if (this.voices > 26) return false;
    this.voices++;
    setTimeout(() => this.voices--, 700);
    return true;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.ctx) this.master.gain.value = on ? 0.9 : 0;
  }

  setMusic(on: boolean): void {
    this.musicOn = on;
    if (!this.ctx) return;
    this.music.gain.setTargetAtTime(on ? 0.16 : 0, this.now(), 0.3);
    if (on && !this.musicTimer) this.startMusic();
    if (!on && this.musicTimer) {
      clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
  }

  /** Ambient wind level, 0..1. */
  setWind(strength: number): void {
    if (!this.ctx) return;
    this.windGain.gain.setTargetAtTime(0.004 + Math.abs(strength) * 0.03, this.now(), 1.2);
  }

  // -------------------------------------------------------------------- sfx

  private burst(opts: {
    dur: number;
    gain: number;
    type: BiquadFilterType;
    from: number;
    to: number;
    q?: number;
    delay?: number;
  }): void {
    const ctx = this.ctx!;
    const t = this.now() + (opts.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const filter = ctx.createBiquadFilter();
    filter.type = opts.type;
    filter.Q.value = opts.q ?? 1;
    filter.frequency.setValueAtTime(opts.from, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, opts.to), t + opts.dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(opts.gain, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
    src.connect(filter).connect(gain).connect(this.sfx);
    src.start(t, Math.random() * 1.5);
    src.stop(t + opts.dur + 0.05);
  }

  private tone(opts: {
    freq: number;
    to?: number;
    dur: number;
    gain: number;
    type?: OscillatorType;
    delay?: number;
    dest?: AudioNode;
  }): void {
    const ctx = this.ctx!;
    const t = this.now() + (opts.delay ?? 0);
    const osc = ctx.createOscillator();
    osc.type = opts.type ?? 'sine';
    osc.frequency.setValueAtTime(opts.freq, t);
    if (opts.to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.to), t + opts.dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(opts.gain, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
    osc.connect(gain).connect(opts.dest ?? this.sfx);
    osc.start(t);
    osc.stop(t + opts.dur + 0.05);
  }

  /** Cannon going off. Power 0..1 scales the weight of it. */
  cannon(power = 0.7): void {
    if (!this.budget()) return;
    this.burst({ dur: 0.42 + power * 0.3, gain: 0.55, type: 'lowpass', from: 2600, to: 140, q: 0.8 });
    this.tone({ freq: 150 - power * 40, to: 38, dur: 0.5, gain: 0.5, type: 'sine' });
    this.tone({ freq: 70, to: 30, dur: 0.7, gain: 0.35, type: 'triangle' });
    this.burst({ dur: 0.12, gain: 0.3, type: 'highpass', from: 3200, to: 1800, delay: 0.005 });
  }

  /** Explosion. size 0..1. */
  explode(size = 0.6): void {
    if (!this.budget()) return;
    const dur = 0.5 + size * 0.7;
    this.burst({ dur, gain: 0.6, type: 'lowpass', from: 1800 + size * 1200, to: 90, q: 1.2 });
    this.tone({ freq: 120 - size * 55, to: 26, dur: dur * 1.2, gain: 0.55, type: 'sine' });
    // Crackle tail.
    for (let i = 0; i < 3 + Math.round(size * 4); i++) {
      this.burst({
        dur: 0.05 + Math.random() * 0.08,
        gain: 0.12,
        type: 'bandpass',
        from: 900 + Math.random() * 2400,
        to: 400,
        q: 3,
        delay: 0.05 + Math.random() * dur * 0.8,
      });
    }
  }

  impact(mat: Mat, strength = 0.5): void {
    if (!this.budget()) return;
    switch (mat) {
      case 'stone':
        this.burst({ dur: 0.22, gain: 0.4, type: 'bandpass', from: 1500, to: 700, q: 1.6 });
        this.tone({ freq: 220, to: 90, dur: 0.16, gain: 0.24, type: 'triangle' });
        break;
      case 'wood':
        this.burst({ dur: 0.16, gain: 0.32, type: 'bandpass', from: 900, to: 320, q: 2.4 });
        this.tone({ freq: 180, to: 70, dur: 0.2, gain: 0.28, type: 'square' });
        break;
      case 'metal':
        this.tone({ freq: 620 + strength * 200, to: 300, dur: 0.5, gain: 0.2, type: 'triangle' });
        this.tone({ freq: 934, to: 500, dur: 0.42, gain: 0.13, type: 'sine' });
        this.burst({ dur: 0.1, gain: 0.28, type: 'highpass', from: 3400, to: 2200 });
        break;
      case 'flesh':
        this.burst({ dur: 0.2, gain: 0.35, type: 'lowpass', from: 700, to: 120 });
        this.tone({ freq: 96, to: 44, dur: 0.26, gain: 0.3, type: 'sine' });
        break;
      default:
        this.burst({ dur: 0.26, gain: 0.32, type: 'lowpass', from: 900, to: 160 });
    }
  }

  crumble(): void {
    if (!this.budget()) return;
    for (let i = 0; i < 6; i++) {
      this.burst({
        dur: 0.14 + Math.random() * 0.2,
        gain: 0.16,
        type: 'bandpass',
        from: 500 + Math.random() * 1500,
        to: 200,
        q: 1.4,
        delay: Math.random() * 0.45,
      });
    }
    this.tone({ freq: 90, to: 40, dur: 0.6, gain: 0.22, type: 'sine' });
  }

  ricochet(): void {
    if (!this.budget()) return;
    const ctx = this.ctx!;
    const t = this.now();
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(1800 + Math.random() * 600, t);
    osc.frequency.exponentialRampToValueAtTime(420, t + 0.32);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 8;
    filter.frequency.value = 1400;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    osc.connect(filter).connect(gain).connect(this.sfx);
    osc.start(t);
    osc.stop(t + 0.4);
  }

  /** Shot whistle: call once when a ball leaves the barrel. */
  whistleStart(): void {
    if (!this.ready || this.whistleNodes) return;
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 620;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 9;
    filter.frequency.value = 700;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    gain.gain.setTargetAtTime(0.05, ctx.currentTime, 0.08);
    osc.connect(filter).connect(gain).connect(this.sfx);
    osc.start();
    this.whistleNodes = { osc, gain, filter };
  }

  whistleUpdate(pitch: number): void {
    if (!this.whistleNodes || !this.ctx) return;
    const f = 340 + pitch * 620;
    this.whistleNodes.osc.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.05);
    this.whistleNodes.filter.frequency.setTargetAtTime(f * 1.2, this.ctx.currentTime, 0.05);
  }

  whistleStop(): void {
    const w = this.whistleNodes;
    if (!w || !this.ctx) return;
    this.whistleNodes = null;
    const t = this.ctx.currentTime;
    w.gain.gain.cancelScheduledValues(t);
    w.gain.gain.setTargetAtTime(0.0001, t, 0.05);
    w.osc.stop(t + 0.4);
  }

  coin(): void {
    if (!this.budget()) return;
    this.tone({ freq: 1180, dur: 0.09, gain: 0.16, type: 'square' });
    this.tone({ freq: 1720, dur: 0.16, gain: 0.13, type: 'square', delay: 0.07 });
  }

  click(): void {
    if (!this.ready) return;
    this.tone({ freq: 720, to: 480, dur: 0.05, gain: 0.09, type: 'square' });
  }

  deny(): void {
    if (!this.ready) return;
    this.tone({ freq: 240, to: 140, dur: 0.18, gain: 0.14, type: 'square' });
  }

  fanfare(win: boolean): void {
    if (!this.ready) return;
    const notes = win ? [392, 523.25, 659.25, 783.99, 1046.5] : [392, 349.23, 293.66, 233.08];
    notes.forEach((f, i) => {
      this.tone({ freq: f, dur: win ? 0.55 : 0.7, gain: 0.2, type: 'triangle', delay: i * (win ? 0.13 : 0.2) });
      this.tone({ freq: f / 2, dur: 0.6, gain: 0.12, type: 'sine', delay: i * (win ? 0.13 : 0.2) });
    });
  }

  kingHit(): void {
    if (!this.ready) return;
    this.tone({ freq: 180, to: 60, dur: 0.9, gain: 0.32, type: 'sawtooth' });
    this.burst({ dur: 0.7, gain: 0.3, type: 'lowpass', from: 1200, to: 80 });
  }

  // ------------------------------------------------------------------ music

  private startMusic(): void {
    if (!this.ctx || this.musicTimer) return;
    // A slow D-dorian cycle: drone plus a wandering plucked line.
    const scale = [146.83, 164.81, 174.61, 196.0, 220.0, 246.94, 261.63, 293.66];
    this.musicTimer = setInterval(() => {
      if (!this.ctx || !this.musicOn) return;
      const step = this.musicStep++;
      if (step % 16 === 0) {
        this.tone({ freq: 73.42, dur: 8, gain: 0.1, type: 'sawtooth', dest: this.music });
        this.tone({ freq: 110, dur: 8, gain: 0.05, type: 'triangle', dest: this.music });
      }
      if (step % 2 === 0 || Math.random() < 0.35) {
        const note = scale[Math.floor(Math.random() * scale.length)]!;
        this.tone({
          freq: note * (Math.random() < 0.25 ? 2 : 1),
          dur: 1.1 + Math.random(),
          gain: 0.055,
          type: 'triangle',
          dest: this.music,
        });
      }
      if (step % 8 === 4) {
        this.tone({ freq: 98, dur: 1.4, gain: 0.06, type: 'sine', dest: this.music });
      }
    }, 500);
  }
}

function makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    // Slightly brown-ish noise sounds heavier than pure white.
    last = (last + 0.02 * white) / 1.02;
    data[i] = white * 0.7 + last * 3.5;
  }
  return buf;
}

function makeImpulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

export const sound = new Sound();
