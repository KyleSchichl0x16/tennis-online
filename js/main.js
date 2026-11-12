// Screens, keyboard, and the match loop.
//
// Online play is host-authoritative: the player who created the match runs the simulation,
// the guest sends key states and draws the snapshots the host sends back (turned around,
// so each player sees their own end of the court nearest to them).

import { Sound } from './audio.js';
import { cleanCode, hostMatch, joinMatch, makeCode } from './net.js';
import { Assets, Renderer } from './render.js';
import { FPS, Sim } from './sim.js';

const PROTOCOL = 1;
const FRAME_MS = 1000 / FPS;
const STAT_NAMES = ['Forehand', 'Backhand', 'Serve', 'Footwork'];
const DEFAULT_STATS = [5, 5, 5, 5];
const GAME_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyF']);

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const assets = new Assets();
const sound = new Sound();
let renderer = null;

const state = {
  screen: 'loading',
  mode: null, // 'host' | 'guest' | 'local'
  link: null,
  code: '',
  connected: false,
  names: ['PLAYER 1', 'PLAYER 2'], // [player 0 = host / near side, player 1 = guest / far side]
  stats: [DEFAULT_STATS.slice(), DEFAULT_STATS.slice()],
  sim: null,
  view: null,
  result: '',
  // guest
  queue: [],
  shownT: 0,
  padSeq: 0,
  padSent: '',
  padAge: 0,
  // host
  remotePad: { h: 0, v: 0, trig: false },
  remoteSeq: 0,
  remoteLatch: false,
};
const latch = { Space: false, KeyF: false }; // a tap shorter than one frame still counts
const keys = new Set();

// ---- saved name and abilities ----------------------------------------------------------

function cleanName(text, fallback) {
  const s = String(text ?? '').toUpperCase().replace(/[^A-Z0-9 .!?'-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 8);
  return s || fallback;
}

function cleanStats(list) {
  const out = DEFAULT_STATS.slice();
  if (Array.isArray(list)) {
    for (let i = 0; i < 4; i++) {
      const n = Math.round(Number(list[i]));
      if (n >= 0 && n <= 9) out[i] = n;
    }
  }
  return out;
}

function loadProfile() {
  try {
    const p = JSON.parse(localStorage.getItem('tennis.profile') || 'null');
    if (p) return { name: cleanName(p.name, ''), stats: cleanStats(p.stats) };
  } catch {
    // no saved profile
  }
  return { name: '', stats: DEFAULT_STATS.slice() };
}

function saveProfile() {
  if (state.mode === 'local') return;
  const i = me();
  try {
    localStorage.setItem('tennis.profile', JSON.stringify({ name: state.names[i], stats: state.stats[i] }));
  } catch {
    // storage unavailable
  }
}

const me = () => (state.mode === 'guest' ? 1 : 0);

// ---- screens ---------------------------------------------------------------------------

function show(screen) {
  state.screen = screen;
  for (const name of ['loading', 'title', 'lobby', 'play']) $(`scr-${name}`).hidden = name !== screen;
  sound.setMusic(screen === 'title' ? 'title' : screen === 'lobby' ? 'start' : null);
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

let toastTimer = null;
function toast(text, ms = 4000) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, ms);
}

function notice(text) {
  $('title-notice').textContent = text || '';
}

function hashCode() {
  return cleanCode(location.hash.replace(/^#/, ''));
}

function showTitle(message) {
  closeLink();
  state.mode = null;
  state.sim = null;
  state.view = null;
  $('join-form').hidden = true;
  document.querySelector('.menu').hidden = false;
  const code = hashCode();
  $('btn-join').textContent = code ? `JOIN MATCH ${code}` : 'JOIN MATCH';
  $('btn-join').classList.toggle('primary', !!code);
  notice(message);
  show('title');
}

function closeLink() {
  if (state.link) {
    state.link.close();
    state.link = null;
  }
  state.connected = false;
}

// ---- lobby -----------------------------------------------------------------------------

function buildSide(container) {
  container.textContent = '';
  const who = el('div', 'who');
  const role = el('span', 'role');
  const name = el('input');
  name.type = 'text';
  name.maxLength = 8;
  name.autocomplete = 'off';
  name.spellcheck = false;
  name.setAttribute('aria-label', 'Player name');
  const keysHint = el('span', 'keys');
  who.append(role, name, keysHint);
  const bars = el('div', 'bars');
  const rows = STAT_NAMES.map((label, si) => {
    const row = el('div', 'bar-row');
    const bar = el('div', 'bar');
    const segs = [];
    for (let v = 0; v < 10; v++) {
      const b = el('button');
      b.type = 'button';
      b.setAttribute('aria-label', `${label} ${v + 1}`);
      b.addEventListener('click', () => setStat(container.playerIndex, si, v));
      bar.append(b);
      segs.push(b);
    }
    const num = el('span', 'bar-num');
    row.append(el('span', '', label), bar, num);
    bars.append(row);
    return { bar, segs, num };
  });
  const wait = el('span', 'wait-text');
  container.append(who, bars, wait);
  name.addEventListener('input', () => setName(container.playerIndex, name.value));
  name.addEventListener('blur', () => renderLobby());
  container.parts = { who, role, name, keysHint, bars, rows, wait };
}

function setStat(i, si, v) {
  if (!canEdit(i)) return;
  state.stats[i][si] = v;
  lobbyChanged();
}

function setName(i, text) {
  if (!canEdit(i)) return;
  state.names[i] = cleanName(text, i === 0 ? 'PLAYER 1' : 'PLAYER 2');
  lobbyChanged();
}

const canEdit = (i) => state.mode === 'local' || i === me();

function lobbyChanged() {
  saveProfile();
  if (state.mode === 'host') sendLobby();
  if (state.mode === 'guest' && state.link) state.link.send({ k: 'me', name: state.names[1], stats: state.stats[1] });
  renderLobby();
}

function sendLobby() {
  if (state.link && state.connected) state.link.send({ k: 'lobby', names: state.names, stats: state.stats });
}

function renderSide(container, i) {
  const p = container.parts;
  container.playerIndex = i;
  const present = state.mode === 'local' || i === me() || state.connected;
  container.classList.toggle('waiting', !present);
  p.who.hidden = !present;
  p.bars.hidden = !present;
  p.wait.hidden = present;
  if (!present) {
    p.wait.textContent = 'Waiting for your friend to join...';
    return;
  }
  const editable = canEdit(i);
  if (state.mode === 'local') {
    p.role.textContent = i === 0 ? 'PLAYER 1 (NEAR SIDE)' : 'PLAYER 2 (FAR SIDE)';
    p.keysHint.textContent = i === 0 ? 'Arrow keys to move, Space to hit' : 'W A S D to move, F to hit';
  } else {
    p.role.textContent = i === me() ? 'YOU' : 'YOUR FRIEND';
    p.keysHint.textContent = i === me() ? 'Arrow keys to move, Space to hit' : '';
  }
  p.name.readOnly = !editable;
  if (document.activeElement !== p.name) p.name.value = state.names[i];
  p.rows.forEach((row, si) => {
    const v = state.stats[i][si];
    row.bar.classList.toggle('mine', editable);
    row.segs.forEach((b, n) => {
      b.classList.toggle('on', n <= v);
      b.disabled = !editable;
    });
    row.num.textContent = String(v + 1);
  });
}

function renderLobby() {
  const top = state.mode === 'guest' ? 0 : 1;
  renderSide($('side-top'), top);
  renderSide($('side-bottom'), 1 - top);

  const waiting = state.mode === 'host' && !state.connected;
  $('invite').hidden = !waiting;
  if (waiting) $('invite-url').value = state.code ? inviteUrl() : 'Creating the match...';
  $('btn-copy').disabled = !state.code;

  let status = state.result;
  if (state.mode === 'guest') status = status ? `${status}  Waiting for your friend to start the next match.` : 'Waiting for your friend to start the match.';
  else if (state.mode === 'host' && state.connected && !status) status = 'Your friend is here. Start when you are both ready.';
  $('lobby-status').textContent = status;

  const start = $('btn-start');
  start.hidden = state.mode === 'guest';
  start.disabled = state.mode === 'host' && !state.connected;
}

function inviteUrl() {
  return `${location.origin}${location.pathname}${location.search}#${state.code}`;
}

function openLobby() {
  renderLobby();
  show('lobby');
}

// ---- creating / joining ----------------------------------------------------------------

function startLocal() {
  closeLink();
  state.mode = 'local';
  state.names = ['PLAYER 1', 'PLAYER 2'];
  state.stats = [DEFAULT_STATS.slice(), DEFAULT_STATS.slice()];
  state.result = '';
  openLobby();
}

function createMatch() {
  closeLink();
  const profile = loadProfile();
  state.mode = 'host';
  state.code = '';
  state.names = [profile.name || 'PLAYER 1', 'PLAYER 2'];
  state.stats = [profile.stats, DEFAULT_STATS.slice()];
  state.result = '';
  const code = makeCode();
  state.link = hostMatch(code, {
    onReady() {
      state.code = code;
      if (state.screen === 'lobby') renderLobby();
    },
    onOpen() {
      // wait for the guest's hello before showing them
    },
    onMessage: onHostMessage,
    onClose() {
      state.connected = false;
      state.result = '';
      if (state.screen === 'play') {
        state.sim = null;
        toast('Your friend left the match.');
        openLobby();
      } else {
        toast('Your friend left.');
        renderLobby();
      }
    },
    onError(text) {
      showTitle(text);
    },
  });
  openLobby();
}

function join(code) {
  closeLink();
  const profile = loadProfile();
  state.mode = 'guest';
  state.code = code;
  state.names = ['PLAYER 1', profile.name || 'PLAYER 2'];
  state.stats = [DEFAULT_STATS.slice(), profile.stats];
  state.result = '';
  notice(`Joining match ${code}...`);
  state.link = joinMatch(code, {
    onOpen() {
      state.link.send({ k: 'hello', v: PROTOCOL, name: state.names[1], stats: state.stats[1] });
    },
    onMessage: onGuestMessage,
    onClose() {
      showTitle('The connection to your friend was lost.');
    },
    onError(text) {
      showTitle(text);
    },
  });
}

// ---- messages --------------------------------------------------------------------------

function onHostMessage(m) {
  if (!m || typeof m !== 'object') return;
  switch (m.k) {
    case 'hello':
      if (m.v !== PROTOCOL) {
        state.link.send({ k: 'version' });
        return;
      }
      state.names[1] = cleanName(m.name, 'PLAYER 2');
      state.stats[1] = cleanStats(m.stats);
      state.connected = true;
      state.result = '';
      sendLobby();
      if (state.screen === 'lobby') renderLobby();
      break;
    case 'me':
      if (state.screen !== 'lobby') return;
      state.names[1] = cleanName(m.name, 'PLAYER 2');
      state.stats[1] = cleanStats(m.stats);
      sendLobby();
      renderLobby();
      break;
    case 'in':
      if (typeof m.q === 'number' && m.q > state.remoteSeq) {
        state.remoteSeq = m.q;
        state.remotePad = { h: Math.sign(m.h) || 0, v: Math.sign(m.v) || 0, trig: !!m.t };
        if (m.t) state.remoteLatch = true;
      }
      break;
    case 'quit':
      if (state.screen === 'play') endMatch(-1, 'Your friend left the match.');
      break;
    default:
      onPingMessage(m);
      break;
  }
}

// Either side: answer the other's ping, show the round trip of our own.
function onPingMessage(m) {
  if (m.k === 'ping') state.link?.send({ k: 'pong', t: m.t });
  else if (m.k === 'pong') $('ping').textContent = `ping ${Math.max(0, Math.round(performance.now() - m.t))} ms`;
}

function onGuestMessage(m) {
  if (!m || typeof m !== 'object') return;
  switch (m.k) {
    case 'lobby':
      // take the host's side; our own side is whatever we last typed
      if (Array.isArray(m.names)) state.names[0] = cleanName(m.names[0], 'PLAYER 1');
      if (Array.isArray(m.stats)) state.stats[0] = cleanStats(m.stats[0]);
      state.connected = true;
      if (state.screen === 'title') {
        notice('');
        openLobby();
      } else if (state.screen === 'lobby') {
        renderLobby();
      }
      break;
    case 'start':
      state.names = [cleanName(m.names?.[0], 'PLAYER 1'), cleanName(m.names?.[1], 'PLAYER 2')];
      beginPlay();
      break;
    case 's':
      if (state.screen === 'play' && m.v) onSnapshot(m.v);
      break;
    case 'end':
      if (state.screen === 'play') finishMatch(m.w, cleanGames(m.g), m.w < 0 ? 'Your friend ended the match.' : '');
      break;
    case 'full':
      showTitle('That match already has two players.');
      break;
    case 'version':
      showTitle('Your friend is on a different version of the game. Both of you should reload the page.');
      break;
    default:
      onPingMessage(m);
      break;
  }
}

// ---- match -----------------------------------------------------------------------------

function startMatch() {
  if (state.mode === 'guest') return;
  if (state.mode === 'host' && !state.connected) return;
  if (state.mode === 'host') state.link.send({ k: 'start', names: state.names, stats: state.stats });
  state.sim = new Sim({ names: state.names, stats: state.stats });
  state.remotePad = { h: 0, v: 0, trig: false };
  state.remoteLatch = false;
  state.view = state.sim.view();
  beginPlay();
}

function beginPlay() {
  state.result = '';
  state.queue = [];
  state.shownT = 0;
  state.padSent = '';
  latch.Space = false;
  latch.KeyF = false;
  $('ping').textContent = '';
  keys.delete('Space'); // the press that started the match must not also toss the ball
  keys.delete('KeyF');
  if (state.mode === 'guest') state.view = null;
  ticker.reset();
  show('play');
}

const cleanGames = (g) => [Number(g?.[0]) || 0, Number(g?.[1]) || 0];

// Host / same keyboard: the match is over (winner < 0 = abandoned).
function endMatch(winner, message) {
  const g = state.sim ? state.sim.gpoint.slice() : [0, 0];
  if (state.mode === 'host' && state.link) state.link.send({ k: 'end', w: winner, g });
  finishMatch(winner, g, message);
}

// Everyone: back to the lobby, with the result if there was one.
function finishMatch(winner, g, message) {
  state.sim = null;
  state.view = null;
  state.result = winner === 0 || winner === 1 ? `${state.names[winner]} won ${g[winner]} - ${g[1 - winner]}.` : '';
  if (message) toast(message);
  openLobby();
}

function quitMatch() {
  if (state.mode === 'guest') {
    state.link.send({ k: 'quit' });
    finishMatch(-1, [0, 0], '');
  } else {
    endMatch(-1, '');
  }
}

function playEvents(events) {
  if (events) for (const e of events) sound.play(e);
}

const axis = (neg, pos) => (keys.has(pos) ? 1 : 0) - (keys.has(neg) ? 1 : 0);

function takeLatch(code) {
  const held = keys.has(code) || latch[code];
  latch[code] = false;
  return held;
}

// Own-view pad from the arrow keys (h: left/right, v: up = toward the net, down = back).
function padArrows(withWasd) {
  let h = axis('ArrowLeft', 'ArrowRight');
  let v = axis('ArrowUp', 'ArrowDown');
  if (withWasd) {
    h = h || axis('KeyA', 'KeyD');
    v = v || axis('KeyW', 'KeyS');
  }
  return { h, v, trig: takeLatch('Space') };
}

// Same keyboard: player 2 is at the far end, facing the screen, so screen directions are reversed for them.
function padFarWasd() {
  return { h: -axis('KeyA', 'KeyD'), v: -axis('KeyW', 'KeyS'), trig: takeLatch('KeyF') };
}

function hostTick() {
  const sim = state.sim;
  if (!sim) return;
  let pads;
  if (state.mode === 'local') {
    pads = [padArrows(false), padFarWasd()];
  } else {
    const r = state.remotePad;
    pads = [padArrows(true), { h: r.h, v: r.v, trig: r.trig || state.remoteLatch }];
    state.remoteLatch = false;
  }
  sim.step(pads);
  const view = sim.view();
  state.view = view;
  playEvents(view.e);
  if (state.mode === 'host') state.link.send({ k: 's', v: view });
  if (sim.over) endMatch(sim.match_winner);
}

function onSnapshot(v) {
  if (typeof v.t !== 'number') return;
  if (v.t <= state.shownT) {
    playEvents(v.e); // arrived after a newer one was shown: keep its sounds, skip its picture
    return;
  }
  const q = state.queue;
  let i = q.length;
  while (i > 0 && q[i - 1].t > v.t) i--;
  if (i > 0 && q[i - 1].t === v.t) return;
  q.splice(i, 0, v);
}

function sendPad(force) {
  if (state.mode !== 'guest' || state.screen !== 'play' || !state.link) return;
  const pad = { h: axis('ArrowLeft', 'ArrowRight') || axis('KeyA', 'KeyD'), v: axis('ArrowUp', 'ArrowDown') || axis('KeyW', 'KeyS'), t: keys.has('Space') || latch.Space ? 1 : 0 };
  const sig = `${pad.h},${pad.v},${pad.t}`;
  if (!force && sig === state.padSent) return;
  state.padSent = sig;
  state.padAge = 0;
  latch.Space = false;
  state.link.send({ k: 'in', q: ++state.padSeq, h: pad.h, v: pad.v, t: pad.t });
}

function guestTick() {
  if (++state.padAge >= 8) sendPad(true); // repeat now and then in case one went missing
  else sendPad(false);
  const q = state.queue;
  while (q.length > 2) playEvents(q.shift().e); // fell behind: skip ahead rather than lag
  const v = q.shift();
  if (v) {
    state.view = v;
    state.shownT = v.t;
    playEvents(v.e);
  }
}

// 30 steps a second from a worker timer, which keeps time when the tab is in the background.
const ticker = {
  t0: 0,
  done: 0,
  reset() {
    this.t0 = performance.now();
    this.done = 0;
  },
  pulse() {
    if (state.screen !== 'play') return;
    let due = Math.floor((performance.now() - this.t0) / FRAME_MS) - this.done;
    if (due > 5) {
      this.done += due - 5;
      due = 5;
    }
    while (due-- > 0 && state.screen === 'play') {
      this.done++;
      if (state.mode === 'guest') guestTick();
      else hostTick();
    }
  },
  start() {
    const pulse = () => this.pulse();
    try {
      const src = 'setInterval(function(){postMessage(0)},8)';
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = pulse;
      w.onerror = () => setInterval(pulse, 8);
    } catch {
      setInterval(pulse, 8);
    }
  },
};

function draw() {
  requestAnimationFrame(draw);
  if (!renderer) return;
  if (state.screen === 'play' && state.view) {
    renderer.drawMatch(state.view, { flip: state.mode === 'guest', names: state.names, you: state.mode === 'local' ? -1 : me() });
  } else {
    renderer.drawBackdrop(state.screen === 'lobby' || state.screen === 'play' ? 0.35 : 0);
  }
}

// ---- wiring ----------------------------------------------------------------------------

const typing = () => {
  const a = document.activeElement;
  return a instanceof HTMLInputElement && !a.readOnly;
};

window.addEventListener('keydown', (e) => {
  sound.unlock();
  if (typing()) return;
  if (GAME_KEYS.has(e.code)) e.preventDefault();
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code in latch) latch[e.code] = true;
  if (state.screen === 'play') sendPad(false);
  else if (state.screen === 'lobby' && e.code === 'Space') startMatch();
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (state.screen === 'play') sendPad(false);
});
window.addEventListener('blur', () => {
  keys.clear();
  if (state.screen === 'play') sendPad(false);
});
window.addEventListener('pointerdown', () => sound.unlock());
window.addEventListener('resize', () => renderer?.resize());
window.addEventListener('hashchange', () => {
  if (state.screen === 'title') showTitle('');
});
// a clicked button must not keep the keyboard: Space is the hit key
document.addEventListener('click', (e) => {
  if (e.target instanceof HTMLButtonElement) e.target.blur();
});

$('btn-create').addEventListener('click', createMatch);
$('btn-local').addEventListener('click', startLocal);
$('btn-join').addEventListener('click', () => {
  const code = hashCode();
  if (code) {
    join(code);
    return;
  }
  document.querySelector('.menu').hidden = true;
  $('join-form').hidden = false;
  notice('');
  $('join-code').value = '';
  $('join-code').focus();
});
$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  // accept a pasted link as well as a bare code
  const raw = $('join-code').value;
  const code = cleanCode(raw.includes('#') ? raw.split('#').pop() : raw);
  if (code.length < 4) {
    notice('Enter the match code from your friend\'s link.');
    return;
  }
  $('join-form').hidden = true;
  document.querySelector('.menu').hidden = false;
  join(code);
});
$('btn-join-cancel').addEventListener('click', () => showTitle(''));
$('btn-start').addEventListener('click', startMatch);
$('btn-leave').addEventListener('click', () => showTitle(''));
$('btn-quit').addEventListener('click', quitMatch);
$('btn-copy').addEventListener('click', async () => {
  const input = $('invite-url');
  try {
    await navigator.clipboard.writeText(input.value);
    toast('Link copied. Send it to your friend.', 2500);
  } catch {
    input.select();
    toast('Press Ctrl+C / Cmd+C to copy the link.', 3500);
  }
});
$('invite-url').addEventListener('focus', (e) => e.target.select());
$('btn-sound').addEventListener('click', () => {
  sound.setMuted(!sound.muted);
  $('btn-sound').classList.toggle('off', sound.muted);
});

setInterval(() => {
  if (state.link && state.connected && state.screen === 'play') state.link.send({ k: 'ping', t: performance.now() });
}, 2000);

async function boot() {
  buildSide($('side-top'));
  buildSide($('side-bottom'));
  $('btn-sound').classList.toggle('off', sound.muted);
  try {
    await Promise.all([
      assets.load((f) => {
        $('load-pct').textContent = `${Math.round(f * 100)}%`;
      }),
      sound.load(),
    ]);
  } catch (err) {
    $('load-pct').textContent = 'failed. Reload the page to try again.';
    console.error(err);
    return;
  }
  renderer = new Renderer($('cv'), assets);
  renderer.warm();
  ticker.start();
  requestAnimationFrame(draw);
  showTitle('');
}

boot();

// Handles for automated checks (see tools/); not used by the game itself.
window.__tennis = { state, keys, sound };
