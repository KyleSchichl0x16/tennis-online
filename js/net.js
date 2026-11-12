// The link between the two players' browsers.
//
// Normal play uses WebRTC through PeerJS: its free public server only introduces the two
// browsers, after which messages go directly between them. Adding ?bc to the page address
// swaps in a BroadcastChannel link between two tabs of one browser, for testing offline.
//
// Both kinds return { send(msg), close() } and report through handlers:
//   onReady()        host only: the match is registered and can be joined
//   onOpen()         the other player is connected
//   onMessage(msg)
//   onClose()        the other player went away (a host keeps listening for a new one)
//   onError(text)    could not set up or join

const PREFIX = 'gdtennis1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I
const SILENCE_MS = 7000; // no message for this long = the other side is gone
const BEAT_MS = 1000;

export function makeCode() {
  const pick = new Uint32Array(5);
  crypto.getRandomValues(pick);
  return Array.from(pick, (n) => CODE_CHARS[n % CODE_CHARS.length]).join('');
}

export function cleanCode(text) {
  return String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

const useBroadcast = () => new URLSearchParams(location.search).has('bc');

// ?lag=120 holds every incoming message for about half that many milliseconds (unevenly, so some
// arrive out of order), to try the game as it would feel with a 120 ms ping.
const LAG = Math.max(0, Number(new URLSearchParams(location.search).get('lag')) || 0);

export function hostMatch(code, handlers) {
  return useBroadcast() ? broadcastLink(code, true, handlers) : peerLink(code, true, handlers);
}

export function joinMatch(code, handlers) {
  return useBroadcast() ? broadcastLink(code, false, handlers) : peerLink(code, false, handlers);
}

// Heartbeats on top of either transport, so a vanished tab is noticed within a few seconds.
function withHeartbeat(rawSend, handlers) {
  let last = performance.now();
  let live = false;
  const timer = setInterval(() => {
    if (!live) return;
    rawSend({ k: 'beat' });
    if (performance.now() - last > SILENCE_MS) {
      live = false;
      handlers.onClose();
    }
  }, BEAT_MS);
  return {
    opened() {
      live = true;
      last = performance.now();
    },
    closed() {
      live = false;
    },
    isLive: () => live,
    heard(msg) {
      last = performance.now();
      if (msg && msg.k === 'beat') return;
      if (LAG > 0) setTimeout(() => live && handlers.onMessage(msg), LAG / 2 + Math.random() * (LAG / 4));
      else handlers.onMessage(msg);
    },
    stop() {
      live = false;
      clearInterval(timer);
    },
  };
}

function peerErrorText(err, isHost) {
  switch (err?.type) {
    case 'peer-unavailable':
      return 'No match with that code. Check the link, or ask your friend to create a new one.';
    case 'unavailable-id':
      return 'That match code is already in use. Try again.';
    case 'browser-incompatible':
      return 'This browser cannot make the direct connection the game needs.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return 'Could not reach the matchmaking server. Check your internet connection.';
    default:
      return isHost ? 'Could not create the match.' : 'Could not join the match.';
  }
}

function peerLink(code, isHost, handlers) {
  if (!window.Peer) {
    setTimeout(() => handlers.onError('The network library did not load.'), 0);
    return { send() {}, close() {} };
  }
  let conn = null;
  let closed = false;
  const send = (msg) => {
    if (conn?.open) conn.send(msg);
  };
  const beat = withHeartbeat(send, {
    onMessage: handlers.onMessage,
    onClose: () => drop(conn),
  });

  function drop(c) {
    if (conn !== c || !c) return;
    conn = null;
    beat.closed();
    try {
      c.close();
    } catch {
      // already closed
    }
    if (!closed) handlers.onClose();
  }

  function adopt(c) {
    conn = c;
    c.on('open', () => {
      beat.opened();
      handlers.onOpen();
    });
    c.on('data', (msg) => beat.heard(msg));
    c.on('close', () => drop(c));
    c.on('error', () => drop(c));
  }

  const peer = isHost ? new window.Peer(PREFIX + code) : new window.Peer();
  let joinTimer = null;

  peer.on('open', () => {
    if (isHost) {
      handlers.onReady();
    } else {
      // unordered: a late packet never holds up newer ones
      adopt(peer.connect(PREFIX + code, { reliable: false, serialization: 'json' }));
      joinTimer = setTimeout(() => {
        if (!beat.isLive() && !closed) handlers.onError('Could not connect to your friend. Their network may be blocking direct connections.');
      }, 20000);
    }
  });
  peer.on('connection', (c) => {
    if (!isHost) return;
    if (conn) {
      // a third person followed the link
      c.on('open', () => {
        c.send({ k: 'full' });
        setTimeout(() => c.close(), 500);
      });
      return;
    }
    adopt(c);
  });
  peer.on('disconnected', () => {
    // lost the matchmaking server; the direct link (if any) is unaffected
    if (!closed && !peer.destroyed) {
      setTimeout(() => {
        if (!closed && !peer.destroyed && peer.disconnected) peer.reconnect();
      }, 2000);
    }
  });
  peer.on('error', (err) => {
    if (closed) return;
    if (beat.isLive()) return; // already playing: matchmaking hiccups do not matter
    handlers.onError(peerErrorText(err, isHost));
  });

  return {
    send,
    close() {
      closed = true;
      clearTimeout(joinTimer);
      beat.stop();
      try {
        peer.destroy();
      } catch {
        // already gone
      }
    },
  };
}

function broadcastLink(code, isHost, handlers) {
  const ch = new BroadcastChannel(PREFIX + code);
  const me = isHost ? 'h' : 'g';
  let closed = false;
  let joinTimer = null;
  const send = (msg) => {
    if (!closed && beat.isLive()) ch.postMessage({ from: me, d: msg });
  };
  const beat = withHeartbeat(send, {
    onMessage: handlers.onMessage,
    onClose: () => {
      if (!closed) handlers.onClose();
    },
  });
  ch.onmessage = (ev) => {
    const m = ev.data;
    if (!m || m.from === me) return;
    if (m.sys === 'join' && isHost) {
      ch.postMessage({ from: me, sys: 'ok' });
      if (!beat.isLive()) {
        beat.opened();
        handlers.onOpen();
      }
    } else if (m.sys === 'ok' && !isHost) {
      clearInterval(joinTimer);
      if (!beat.isLive()) {
        beat.opened();
        handlers.onOpen();
      }
    } else if (m.sys === 'bye') {
      if (beat.isLive()) {
        beat.closed();
        handlers.onClose();
      }
    } else if (m.d !== undefined && beat.isLive()) {
      beat.heard(m.d);
    }
  };
  if (isHost) {
    setTimeout(() => handlers.onReady(), 0);
  } else {
    let tries = 0;
    const knock = () => {
      if (beat.isLive() || closed) return;
      if (++tries > 20) {
        clearInterval(joinTimer);
        handlers.onError('No match with that code. Check the link, or ask your friend to create a new one.');
        return;
      }
      ch.postMessage({ from: me, sys: 'join' });
    };
    joinTimer = setInterval(knock, 250);
    knock();
  }
  return {
    send,
    close() {
      if (closed) return;
      ch.postMessage({ from: me, sys: 'bye' });
      closed = true;
      clearInterval(joinTimer);
      beat.stop();
      ch.close();
    },
  };
}
