// Canvas drawing. Positions and layer order follow the original game clip (DefineSprite_282);
// the art is the original's vector shapes, rasterised once at the current screen resolution.

import { COURT_H, LABELS, MES } from './sim.js';

export const STAGE = 600; // the original stage is 600 x 600
const SCREEN_OX = 300;
const SCREEN_OY = 300;
const MES_Y = 132; // where the message clip sits on the stage

const SHAPE = {
  court: '52', net: '17', post: '18', ball: '7', shadow: '55', mark: '154',
  board: '257', lose: '273', backdrop: '16',
  winA: '272_1', winB: '272_6', space: '50_1', spaceDown: '50_2',
};

function loadImage(svg) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode a shape'));
    img.src = url;
  });
}

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return res.json();
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(Math.min(1, got / total));
  }
  const all = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return JSON.parse(new TextDecoder().decode(all));
}

export class Assets {
  constructor() {
    this.shapes = {};
    this.anims = null;
  }

  // onProgress(0..1)
  async load(onProgress) {
    const [shapes, anims] = await Promise.all([
      fetchWithProgress('assets/shapes.json', (f) => onProgress(f * 0.7)),
      fetch('assets/anims.json').then((r) => r.json()),
    ]);
    this.anims = anims;
    const ids = Object.keys(shapes);
    let done = 0;
    await Promise.all(
      ids.map(async (id) => {
        const s = shapes[id];
        const img = await loadImage(s.svg);
        this.shapes[id] = { img, w: s.w, h: s.h, ox: s.ox, oy: s.oy, raster: null, k: 0 };
        done++;
        onProgress(0.7 + (0.3 * done) / ids.length);
      }),
    );
    if (document.fonts?.load) {
      await Promise.all([document.fonts.load('20px Vagabond'), document.fonts.load('32px AlphaDot')]).catch(() => {});
    }
  }
}

export class Renderer {
  constructor(canvas, assets) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.assets = assets;
    this.s = 1; // stage -> canvas pixels
    this.k = 1; // resolution the shapes are rasterised at
    this.resize();
  }

  resize() {
    const css = this.canvas.clientWidth || STAGE;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const px = Math.max(300, Math.round(css * dpr));
    if (this.canvas.width !== px) {
      this.canvas.width = px;
      this.canvas.height = px;
    }
    this.s = px / STAGE;
    this.k = Math.min(3, Math.max(1, Math.ceil(this.s * 2) / 2));
  }

  // The shape as a bitmap at the current resolution (made on first use, remade after a resize).
  raster(id) {
    const sh = this.assets.shapes[id];
    if (!sh) return null;
    if (!sh.raster || sh.k !== this.k) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.ceil(sh.w * this.k));
      c.height = Math.max(1, Math.ceil(sh.h * this.k));
      c.getContext('2d').drawImage(sh.img, 0, 0, c.width, c.height);
      sh.raster = c;
      sh.k = this.k;
    }
    return sh;
  }

  // Rasterise everything a few shapes at a time so the first rally does not stutter.
  warm() {
    const ids = Object.keys(this.assets.shapes);
    let i = 0;
    const some = () => {
      const until = performance.now() + 6;
      while (i < ids.length && performance.now() < until) this.raster(ids[i++]);
      if (i < ids.length) setTimeout(some, 0);
    };
    some();
  }

  // Draw a shape with its own origin at stage point (x, y).
  shape(id, x, y, scale = 1, alpha = 1) {
    const sh = this.raster(id);
    if (!sh || alpha <= 0) return;
    const ctx = this.ctx;
    if (alpha < 1) ctx.globalAlpha = alpha;
    ctx.drawImage(sh.raster, x - sh.ox * scale, y - sh.oy * scale, sh.w * scale, sh.h * scale);
    if (alpha < 1) ctx.globalAlpha = 1;
  }

  begin() {
    const ctx = this.ctx;
    ctx.setTransform(this.s, 0, 0, this.s, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, STAGE, STAGE);
  }

  netAt(x, y, scale) {
    this.shape(SHAPE.net, x, y, scale);
    this.shape(SHAPE.post, x - 257 * scale, y - 80.9 * scale, 0.4538 * scale);
    this.shape(SHAPE.post, x + 134.75 * scale, y - 80.15 * scale, 0.4538 * scale);
  }

  // The stadium picture behind the title and lobby screens.
  drawBackdrop(dim = 0) {
    this.begin();
    this.shape(SHAPE.backdrop, 0, 0);
    this.netAt(288.05, 506.1, 1.439);
    if (dim > 0) {
      this.ctx.fillStyle = `rgba(0,0,0,${dim})`;
      this.ctx.fillRect(0, 0, STAGE, STAGE);
    }
  }

  text(str, x, y, size, color, align = 'left', font = 'Vagabond') {
    const ctx = this.ctx;
    ctx.font = `${size}px ${font}, "Arial Rounded MT Bold", "Trebuchet MS", sans-serif`;
    ctx.textAlign = align;
    ctx.textBaseline = 'top';
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }

  // Big centred message with the original's drop shadow.
  message(str, top) {
    this.text(str, 302, top + 3, 36, 'rgba(0,0,0,0.8)', 'center');
    this.text(str, 300, top, 36, '#fff', 'center');
  }

  player(set, labelIdx, frame, x, y, scale) {
    const frames = this.assets.anims[set][LABELS[labelIdx]];
    if (!frames) return;
    const fr = frames[Math.min(frame, frames.length - 1)];
    for (const [id, ox, oy] of fr) this.shape(String(id), x + ox * scale, y + oy * scale, scale);
  }

  // view: Sim.view(). o.flip: draw the court turned around (the far player's seat).
  // o.names: [player 0, player 1]. o.you: which player is watching (-1 = both, same keyboard).
  drawMatch(view, o) {
    const f = o.flip ? -1 : 1;
    const near = o.flip ? 1 : 0;
    const far = 1 - near;
    const at = (vx, vy) => {
      const wx = f * vx;
      const wy = f * vy;
      const per = 1 + wy / COURT_H / 10;
      return { x: SCREEN_OX + wx * per, y: SCREEN_OY + wy / 2, per };
    };

    this.begin();
    this.shape(SHAPE.court, 0, 0);

    const pn = at(view.p[near][0], view.p[near][1]);
    const pf = at(view.p[far][0], view.p[far][1]);
    this.shape(SHAPE.shadow, pn.x, pn.y);
    this.shape(SHAPE.shadow, pf.x, pf.y);
    this.player('far', view.p[far][2], view.p[far][3], pf.x, pf.y, 0.6 * pf.per);

    this.netAt(293, SCREEN_OY, 1);

    if (view.k[2] > 0) {
      const m = at(view.k[0], view.k[1]);
      this.shape(SHAPE.mark, m.x, m.y, 1, view.k[2] / 100);
    }
    if (view.b[3]) {
      const b = at(view.b[0], view.b[1]);
      this.shape(SHAPE.mark, b.x, b.y);
      this.shape(SHAPE.ball, b.x, b.y - view.b[2] * b.per, b.per);
    }

    this.player('near', view.p[near][2], view.p[near][3], pn.x, pn.y, 0.6 * pn.per);

    this.drawMes(view, o, near, far);
    if (view.s) this.text(view.s, 7.4, 572, 20, '#fff');
  }

  drawMes(view, o, near, far) {
    const [labelIdx, txt, cnt, space] = view.m;
    const label = MES[labelIdx];
    const button = (x, y) => this.shape(space >= 1 && space <= 5 ? SHAPE.spaceDown : SHAPE.space, x, y);

    if (label === 'mes' || label === 'score') {
      this.message(txt, MES_Y + 70);
    } else if (label === 'game') {
      this.message(txt, MES_Y + 4);
      const bx = 145;
      const by = MES_Y + 62.05;
      this.shape(SHAPE.board, bx, by);
      this.text('PLAYER', bx + 36, by + 10, 12, '#fff');
      this.text('GAMES', bx + 227, by + 10, 12, '#fff');
      const rows = [[far, 35], [near, 80]];
      for (const [i, y] of rows) {
        this.text(o.names[i], bx + 43.5, by + y, 32, '#ff0', 'left', 'AlphaDot');
        this.text(String(view.g[i]), bx + 273, by + y, 32, '#ff0', 'right', 'AlphaDot');
      }
      button(230, MES_Y + 224);
    } else if (label === 'match') {
      const w = view.w;
      if (o.you < 0) {
        const str = `${o.names[w]} WINS !`;
        this.text(str, 303, MES_Y + 68, 44, '#fff', 'center');
        this.text(str, 300, MES_Y + 65, 44, '#f60', 'center');
      } else if (o.you === w) {
        this.shape(cnt % 10 < 5 ? SHAPE.winA : SHAPE.winB, -2, MES_Y + 65.5);
      } else {
        const t = Math.min(1, cnt / 30);
        this.shape(SHAPE.lose, 6, MES_Y + 45.4 + 20.55 * t, 1, t);
      }
      if (cnt > 30) button(230, MES_Y + 190);
    }
  }
}
