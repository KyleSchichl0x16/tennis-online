// Sound effects and menu music (the original's own samples), played through Web Audio.

const FILES = {
  hit: 'assets/snd/hit.mp3',
  bound: 'assets/snd/bound.mp3',
  app: 'assets/snd/app.mp3',
  app2: 'assets/snd/app2.mp3',
  click: 'assets/snd/click.mp3',
  title: 'assets/snd/bgm_title.mp3',
  start: 'assets/snd/bgm_start.mp3',
};

// MP3 decoding pads both ends with silence, which would put a gap in a loop: find the real sound.
function soundingRange(buffer) {
  const data = buffer.getChannelData(0);
  const quiet = 0.004;
  let a = 0;
  let b = data.length - 1;
  while (a < b && Math.abs(data[a]) < quiet) a++;
  while (b > a && Math.abs(data[b]) < quiet) b--;
  return [a / buffer.sampleRate, (b + 1) / buffer.sampleRate];
}

export class Sound {
  constructor() {
    this.ctx = null;
    this.buffers = {};
    this.music = null;
    this.musicName = null;
    this.muted = false;
    try {
      this.muted = localStorage.getItem('tennis.muted') === '1';
    } catch {
      // storage unavailable: start with sound on
    }
  }

  async load() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.muted ? 0 : 1;
    this.gain.connect(this.ctx.destination);
    await Promise.all(
      Object.entries(FILES).map(async ([name, url]) => {
        try {
          const raw = await (await fetch(url)).arrayBuffer();
          this.buffers[name] = await this.ctx.decodeAudioData(raw);
        } catch {
          // a missing sound is not worth stopping the game for
        }
      }),
    );
  }

  // Browsers keep audio suspended until the first click or key press.
  unlock() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  play(name) {
    const buf = this.buffers[name];
    if (!buf || !this.ctx) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    src.start();
  }

  // Loop a piece of music, or stop it with null.
  setMusic(name) {
    if (name === this.musicName) return;
    this.musicName = name;
    if (this.music) {
      try {
        this.music.stop();
      } catch {
        // already stopped
      }
      this.music = null;
    }
    const buf = name && this.buffers[name];
    if (!buf || !this.ctx) return;
    const [from, to] = soundingRange(buf);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = from;
    src.loopEnd = to;
    src.connect(this.gain);
    src.start(0, from);
    this.music = src;
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.gain) this.gain.gain.value = muted ? 0 : 1;
    try {
      localStorage.setItem('tennis.muted', muted ? '1' : '0');
    } catch {
      // storage unavailable: the choice lasts for this visit only
    }
  }
}
