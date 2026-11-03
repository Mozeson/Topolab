// Sounds of the field, synthesised with Web Audio (no sound files): footsteps that depend on
// the ground, breathing that grows heavier with effort, a grunt on hard climbs, and the wind
// rising and falling with the gusts, panned to the side it comes from.

export function createFieldAudio(getContext) {
  let noise = null;
  let wind = null;

  function context() {
    const audio = getContext();
    if (audio && !noise) {
      noise = audio.createBuffer(1, audio.sampleRate * 2, audio.sampleRate);
      const data = noise.getChannelData(0);
      let brown = 0;
      for (let i = 0; i < data.length; i++) {
        const white = Math.random() * 2 - 1;
        brown = (brown + .02 * white) / 1.02;
        data[i] = white * .6 + brown * 3;
      }
    }
    return audio;
  }

  // A filtered noise burst.
  function burst({ type = 'bandpass', freq, q = 1, gain, attack = .005, decay = .1, delay = 0, sweep = 1 }) {
    const audio = context();
    if (!audio) return;
    const t = audio.currentTime + delay;
    const source = audio.createBufferSource();
    source.buffer = noise;
    const filter = audio.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, t);
    filter.frequency.exponentialRampToValueAtTime(freq * sweep, t + attack + decay);
    filter.Q.value = q;
    const amp = audio.createGain();
    amp.gain.setValueAtTime(.0001, t);
    amp.gain.exponentialRampToValueAtTime(Math.max(.0002, gain), t + attack);
    amp.gain.exponentialRampToValueAtTime(.0001, t + attack + decay);
    source.connect(filter).connect(amp).connect(audio.destination);
    source.start(t, Math.random() * 1.5);
    source.stop(t + attack + decay + .05);
  }

  return {
    // kind: 'grass' | 'rock' | 'road' | 'forest'; strength ~1 walking, more running.
    footstep(kind, strength = 1) {
      const g = .07 * strength;
      if (kind === 'rock') {
        burst({ freq: 2600, q: .9, gain: g * 1.1, decay: .07 });
        burst({ freq: 4200, q: 2, gain: g * .5, decay: .04, delay: .02 });
      } else if (kind === 'road') {
        burst({ type: 'lowpass', freq: 500, gain: g * 1.4, decay: .06 });
      } else if (kind === 'forest') {
        burst({ freq: 1500, q: .7, gain: g, decay: .14, sweep: .7 });
      } else {
        burst({ type: 'lowpass', freq: 1100, gain: g * 1.2, decay: .1, sweep: .6 });
        burst({ freq: 3000, q: 1.5, gain: g * .35, decay: .06, delay: .015 });
      }
    },
    // One breath: in through the mouth, then out. volume 0..1.
    breath(volume) {
      if (volume <= 0) return;
      const g = .02 + .09 * volume;
      burst({ freq: 1300, q: 1.2, gain: g * .7, attack: .18, decay: .22, sweep: 1.3 });
      burst({ freq: 700, q: .9, gain: g, attack: .05, decay: .38 + .1 * (1 - volume), delay: .38, sweep: .7 });
    },
    // A short effort grunt (a voiced "hhn") on a hard climb.
    grunt(volume = 1) {
      const audio = context();
      if (!audio) return;
      const t = audio.currentTime;
      const osc = audio.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(140, t);
      osc.frequency.linearRampToValueAtTime(105, t + .28);
      const formant = audio.createBiquadFilter();
      formant.type = 'bandpass';
      formant.frequency.value = 600;
      formant.Q.value = 3;
      const amp = audio.createGain();
      amp.gain.setValueAtTime(.0001, t);
      amp.gain.exponentialRampToValueAtTime(.05 * volume, t + .04);
      amp.gain.exponentialRampToValueAtTime(.0001, t + .3);
      osc.connect(formant).connect(amp).connect(audio.destination);
      osc.start(t);
      osc.stop(t + .32);
    },
    // Continuous wind: strength 0..1, pan −1 (left) … 1 (right).
    setWind(strength, pan) {
      const audio = context();
      if (!audio) return;
      if (!wind) {
        const source = audio.createBufferSource();
        source.buffer = noise;
        source.loop = true;
        const filter = audio.createBiquadFilter();
        filter.type = 'lowpass';
        const whistle = audio.createBiquadFilter();
        whistle.type = 'peaking';
        whistle.Q.value = 6;
        const amp = audio.createGain();
        amp.gain.value = 0;
        const panner = audio.createStereoPanner ? audio.createStereoPanner() : null;
        source.connect(filter).connect(whistle).connect(amp);
        if (panner) amp.connect(panner).connect(audio.destination);
        else amp.connect(audio.destination);
        source.start();
        wind = { source, filter, whistle, amp, panner };
      }
      const t = audio.currentTime;
      wind.filter.frequency.setTargetAtTime(180 + 1100 * strength, t, .3);
      wind.whistle.frequency.setTargetAtTime(500 + 900 * strength, t, .5);
      wind.whistle.gain.setTargetAtTime(strength > .55 ? 8 * (strength - .55) : 0, t, .5);
      wind.amp.gain.setTargetAtTime(.012 + .11 * strength ** 1.6, t, .35);
      wind.panner?.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)) * .7, t, .4);
    },
    stopWind() {
      if (!wind) return;
      try { wind.source.stop(); } catch { /* already stopped */ }
      wind.amp.disconnect();
      wind = null;
    },
  };
}
