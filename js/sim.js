// Match simulation: a port of the original game's ActionScript (DefineSprite_282).
//
// The original had a human on the near side (player 0) and a computer on the far side
// (player 1). The physics, hit boxes, shot placement and scoring below are the original's.
// The computer's logic (move_enemy / set_ball_dest_com) is gone: player 1 now runs the same
// control code as player 0, in a frame of reference rotated 180 degrees.
//
// World coordinates: vx across the court (-180..180 between the sidelines), vy along it
// (net at 0, player 0's baseline at +360, player 1's at -360), vh = height above ground.
// One call to step() is one frame of the original (30 per second).

export const COURT_W = 180;
export const COURT_H = 360;
export const SERVE_H = 200;
export const NET_H = 40;
export const TOSS_H = 50;
export const GRAVITY = 0.8;
export const FPS = 30;

const PS_WAIT = 1;
const PS_STROKE = 3;
const PS_SERVE = 4;
const PS_TOSS = 5;
const PS_AFTER = 7;

const ST_FORE = 1;
const ST_BACK = 2;
const ST_SMASH = 3;

const HIT_X1_FORE = -10;
const HIT_X2_FORE = 60;
const HIT_X1_BACK = -60;
const HIT_X2_BACK = 10;
const HIT_X1_SMASH = -30;
const HIT_X2_SMASH = 50;
const HIT_Y1 = -120;
const HIT_Y2 = 80;
const HIT_Z = 120;

const RESULT_FAULT = 1;
const RESULT_OUT = 2;
const RESULT_MISS = 3;
const RESULT_VOLLEY = 4;

// Player animation labels (frame labels of the original player clips) and their lengths.
export const LABELS = ['wait', 'right', 'left', 'fore', 'back', 'smash', 'serve', 'toss', 'lose', 'win'];
const ANIM_LEN = { wait: 1, right: 13, left: 13, fore: 21, back: 21, smash: 17, serve: 1, toss: 10, lose: 1, win: 1 };
const TOSS_HOLD_FRAME = 7; // the toss clip has stop() on its 8th frame

// Message overlay states (frame labels of the original message clip, "win"/"lose" merged into "match").
export const MES = ['inplay', 'mes', 'score', 'game', 'match'];
const MES_HOLD = 30;        // frames a message / score stays up
const SPACE_ANIM = 12;      // frames between pressing the space-bar button and its action
const SPACE_GUARD_GAME = 15;  // ignore the hit key for a moment so a late swing does not skip the board
const SPACE_GUARD_MATCH = 30;

// Keep players on screen. The original had no limit at all; these sit outside any useful position.
const MAX_X = 250;
const MAX_BACK = 540;

const r2 = (n) => Math.round(n * 100) / 100;

export class Sim {
  // names: [near, far]; stats: per player [forehand, backhand, serve, footwork], each 0..9
  constructor({ names, stats, rng = Math.random }) {
    this.rng = rng;
    this.pname = names.slice();
    this.players = [0, 1].map((i) => ({
      vx: 0, vy: 0, stat: PS_WAIT, cnt: 0,
      label: 'wait', frame: 0, fresh: false,
      stroke_type: 0, hit_x1: 0, hit_x2: 0, hit_y1: 0, hit_y2: 0,
      forehand: 20 + 1 * stats[i][0],
      backhand: 20 + 0.5 * stats[i][1],
      serve: 30 + 3 * stats[i][2],
      footwork: 6 + 0.3 * stats[i][3],
    }));
    this.ball = { vx: 0, vy: 0, vh: 0, ax: 0, ay: 0, up: 0, down: 0, dx: 0, dy: 0, side: 0, bound: 0, moving: 0, visible: false };
    this.boundMark = { x: 0, y: 0, alpha: 0 };
    this.mes = { label: 'inplay', txt: '', cnt: 0, space: 0 };
    this.events = [];
    this.tick = 0;
    this.prevTrig = [false, false];

    this.server = 0;
    this.receiver = 1;
    this.gpoint = [0, 0];
    this.game_winner = -1;
    this.match_winner = -1;
    this.over = false;
    this.init_game();
  }

  // ---- frame ---------------------------------------------------------------------------

  // pads: one per player, in that player's own view of the court:
  //   h: -1 = to their left, +1 = to their right;  v: -1 = toward the net, +1 = back;  trig: hit key held
  step(pads) {
    this.events = [];
    this.tick++;
    this.player_action(0, pads[0]);
    this.player_action(1, pads[1]);
    this.move_ball();
    this.advance_anims();
    if (this.boundMark.alpha > 0) this.boundMark.alpha -= 10;
    const pressed = (pads[0].trig && !this.prevTrig[0]) || (pads[1].trig && !this.prevTrig[1]);
    this.prevTrig = [!!pads[0].trig, !!pads[1].trig];
    this.tick_mes(pressed);
  }

  // What a screen needs to draw this frame (also what the host sends to the guest).
  view() {
    const b = this.ball;
    return {
      t: this.tick,
      p: this.players.map((p) => [r2(p.vx), r2(p.vy), LABELS.indexOf(p.label), p.frame]),
      b: [r2(b.vx), r2(b.vy), r2(b.vh), b.visible ? 1 : 0],
      k: [r2(this.boundMark.x), r2(this.boundMark.y), Math.max(0, this.boundMark.alpha)],
      m: [MES.indexOf(this.mes.label), this.mes.txt, this.mes.cnt, this.mes.space],
      s: this.score_txt,
      g: this.gpoint.slice(),
      w: this.match_winner,
      e: this.events,
    };
  }

  // ---- game / point setup --------------------------------------------------------------

  init_game() {
    this.serve_pos = 1;
    this.play_winner = -1;
    this.fault_cnt = 0;
    this.point = [0, 0];
    this.score_txt = `${this.pname[this.server]} 0 - 0 ${this.pname[this.receiver]}`;
    this.init_play();
  }

  init_play() {
    this.rally_cnt = 0;
    this.play_result = 0;
    this.set_mes('inplay');
    for (let i = 0; i < 2; i++) {
      const mc = this.players[i];
      mc.vy = COURT_H + 20;
      if (i === 1) mc.vy *= -1;
      if (this.server === i) {
        mc.vx = this.serve_pos * 20;
        this.start_serve(i);
      } else {
        mc.vx = (this.serve_pos * -COURT_W * 2) / 3;
        mc.stat = PS_WAIT;
        this.set_label(mc, 'wait');
      }
      if (this.server === 1) mc.vx *= -1;
    }
    this.init_ball();
  }

  // ---- players -------------------------------------------------------------------------

  set_label(mc, label) {
    if (mc.label === label) return; // gotoAndStop to the current label does not restart the clip
    mc.label = label;
    mc.frame = 0;
    mc.fresh = true;
  }

  // The original user_action(), for either player. sgn turns a player's own view into world coordinates.
  player_action(pn, pad) {
    const mc = this.players[pn];
    const sgn = pn === 0 ? 1 : -1;
    switch (mc.stat) {
      case PS_SERVE:
        if (pad.trig) this.start_toss(pn);
        break;
      case PS_TOSS:
        mc.cnt++;
        if (mc.cnt > 8) {
          if (pad.trig) this.start_stroke(pn);
        }
        if (mc.cnt === 7) this.start_toss_ball(pn);
        break;
      case PS_STROKE:
        mc.cnt++;
        if (mc.cnt === 3) {
          if (this.check_hit(pn)) this.set_ball_dest(pn, pad);
        }
        break;
      case PS_WAIT:
        if (pad.v === 0 && pad.h === 0) {
          this.set_label(mc, 'wait');
        } else {
          const a = mc.footwork;
          mc.vx += sgn * pad.h * a;
          mc.vy += sgn * pad.v * a;
          if (sgn * mc.vy <= 20) mc.vy = sgn * 20;
          if (sgn * mc.vy > MAX_BACK) mc.vy = sgn * MAX_BACK;
          if (mc.vx > MAX_X) mc.vx = MAX_X;
          if (mc.vx < -MAX_X) mc.vx = -MAX_X;
          this.set_label(mc, pad.h < 0 ? 'left' : 'right');
        }
        if (pad.trig) this.start_stroke(pn);
        break;
      default:
        break;
    }
  }

  start_serve(pn) {
    const mc = this.players[pn];
    mc.stat = PS_SERVE;
    mc.cnt = 0;
    this.set_label(mc, 'serve');
  }

  start_toss(pn) {
    const mc = this.players[pn];
    mc.stat = PS_TOSS;
    this.set_label(mc, 'toss');
    mc.cnt = 0;
  }

  start_stroke(pn) {
    const mc = this.players[pn];
    const b = this.ball;
    const sgn = pn === 0 ? 1 : -1;
    mc.stat = PS_STROKE;
    mc.cnt = 0;
    const px = sgn * mc.vx;
    const nx = sgn * (b.vx + b.ax * 2);
    if (b.vh > 70 && nx > px + HIT_X1_SMASH && nx < px + HIT_X2_SMASH) {
      mc.stroke_type = ST_SMASH;
      mc.hit_x1 = HIT_X1_SMASH;
      mc.hit_x2 = HIT_X2_SMASH;
      this.set_label(mc, 'smash');
    } else if (sgn * (b.vx + b.ax * 3) < px) {
      mc.stroke_type = ST_BACK;
      mc.hit_x1 = HIT_X1_BACK;
      mc.hit_x2 = HIT_X2_BACK;
      this.set_label(mc, 'back');
    } else {
      mc.stroke_type = ST_FORE;
      mc.hit_x1 = HIT_X1_FORE;
      mc.hit_x2 = HIT_X2_FORE;
      this.set_label(mc, 'fore');
    }
    mc.hit_y1 = HIT_Y1;
    mc.hit_y2 = HIT_Y2;
  }

  check_hit(pn) {
    const mc = this.players[pn];
    const b = this.ball;
    const sgn = pn === 0 ? 1 : -1;
    const x = sgn * (b.vx - mc.vx);
    const y = sgn * (b.vy - mc.vy);
    if (x < mc.hit_x1) return 0;
    if (x > mc.hit_x2) return 0;
    if (y < mc.hit_y1) return 0;
    if (y > mc.hit_y2) return 0;
    if (b.vh > HIT_Z) return 0;
    return 1;
  }

  // The original set_ball_dest_user(): the direction held at the moment of contact picks one of
  // nine target zones on the other side (three across, three deep), then a random spot inside it.
  set_ball_dest(pn, pad) {
    const mc = this.players[pn];
    const b = this.ball;
    if (b.side === pn) return; // already hit by this player
    let cx = 1;
    if (pad.h < 0) cx = 0;
    if (pad.h > 0) cx = 2;
    let cy = 1;
    if (pad.v < 0) cy = 0;
    if (pad.v > 0) cy = 2;
    let x1, x2, y1, y2;
    if (this.rally_cnt === 0) {
      if (this.serve_pos > 0) {
        x1 = -COURT_W;
        x2 = 0;
      } else {
        x1 = 0;
        x2 = COURT_W;
      }
      y1 = -SERVE_H;
      y2 = -SERVE_H / 2;
    } else {
      x1 = -COURT_W;
      x2 = COURT_W;
      y1 = -COURT_H;
      y2 = -COURT_H / 3;
    }
    const w = (x2 - x1) / 3;
    const h = (y2 - y1) / 3;
    let x = x1 + w * cx + this.rng() * w;
    let y = y1 + h * cy + this.rng() * h;
    if (pn === 1) {
      x *= -1;
      y *= -1;
    }
    let s = mc.forehand;
    if (mc.stroke_type === ST_BACK) s = mc.backhand;
    if (mc.stroke_type === ST_SMASH) s = mc.serve;
    this.start_move_ball(x, y, pn, s);
  }

  // Called when a stroke animation reaches its last frame.
  start_wait(pn) {
    const mc = this.players[pn];
    const sgn = pn === 0 ? 1 : -1;
    if (mc.stat === PS_STROKE && mc.stroke_type === ST_SMASH) {
      mc.vy += -20 * sgn;
      if (sgn * mc.vy < 0) mc.vy = 0;
    }
    mc.stat = PS_WAIT;
    this.set_label(mc, 'wait');
  }

  advance_anims() {
    for (let pn = 0; pn < 2; pn++) {
      const mc = this.players[pn];
      if (mc.fresh) {
        mc.fresh = false; // a clip placed this frame shows its first frame
        continue;
      }
      const len = ANIM_LEN[mc.label];
      if (len === 1) continue;
      if (mc.label === 'toss') {
        if (mc.frame < TOSS_HOLD_FRAME) mc.frame++;
      } else if (mc.label === 'right' || mc.label === 'left') {
        mc.frame = (mc.frame + 1) % len;
      } else {
        mc.frame++;
        if (mc.frame >= len - 1) this.start_wait(pn);
      }
    }
  }

  // ---- ball ----------------------------------------------------------------------------

  init_ball() {
    const mc = this.players[this.server];
    const b = this.ball;
    b.ax = 0;
    b.ay = 0;
    b.vx = mc.vx;
    b.vy = mc.vy;
    b.vh = 0;
    b.up = 0;
    b.down = 0;
    b.side = this.server === 0 ? 1 : 0; // "side" = who hit it last; the server may hit first
    b.moving = 0;
    b.visible = false;
  }

  start_toss_ball(pn) {
    const mc = this.players[pn];
    const b = this.ball;
    b.ax = 0;
    b.ay = 0;
    b.vx = mc.vx + (pn === 1 ? -10 : 10);
    b.vy = mc.vy;
    b.vh = TOSS_H;
    b.up = 10;
    b.down = 0;
    b.side = pn === 0 ? 1 : 0;
    b.bound = 0;
    b.moving = 1;
    b.visible = true;
  }

  start_move_ball(dx, dy, side, max_speed) {
    const b = this.ball;
    if (this.rally_cnt === 1 && b.bound === 0) {
      this.set_result(RESULT_VOLLEY); // the serve was returned before it bounced
    }
    b.side = side;
    b.dx = dx;
    b.dy = dy;
    const sx = b.dx - b.vx;
    const sy = b.dy - b.vy;
    const dt = Math.sqrt(sx * sx + sy * sy);
    let speed = max_speed;
    for (let i = 0; i < 5; i++) {
      speed = max_speed - i * 4; // slow the shot down until its arc clears the net
      if (this.check_hit_net(sy, speed, dt) === 1) break;
    }
    const t = dt / speed;
    const h = (t * (t - 1) * GRAVITY) / 2;
    b.ax = sx / t;
    b.ay = sy / t;
    b.up = (h - b.vh) / t;
    b.down = 0;
    b.bound = 0;
    this.rally_cnt++;
    this.events.push('hit');
  }

  check_hit_net(sy, speed, dt) {
    const b = this.ball;
    const t = dt / speed;
    const top = (t * (t - 1) * GRAVITY) / 2;
    const ay = sy / t;
    const up = (top - b.vh) / t;
    let down = 0;
    let y = b.vy;
    let h = b.vh;
    for (let guard = 0; guard < 5000; guard++) {
      h += up - down;
      down += GRAVITY;
      y += ay;
      if (h < 0) return 0;
      if (b.side === 0 && y < 0) return h > NET_H + 10 ? 1 : 0;
      if (b.side === 1 && y > 0) return h > NET_H + 10 ? 1 : 0;
    }
    return 0;
  }

  move_ball() {
    const b = this.ball;
    if (b.moving !== 1) return;
    b.vh += b.up - b.down;
    if (b.vh < 0) {
      b.up = ((b.down - b.up) * 2) / 3;
      if (b.up < 1.3) {
        b.vh = 0;
        b.moving = 0;
      }
      b.down = 0;
      b.vh = 0;
      b.ax = (b.ax * 3) / 5;
      b.ay = (b.ay * 3) / 5;
      b.bound++;
      b.vx += b.ax;
      b.vy += b.ay;
      this.boundMark.x = b.vx;
      this.boundMark.y = b.vy;
      this.boundMark.alpha = 110; // shows at 100 this frame after the fade step in step()
      if (b.bound === 1) {
        if (this.rally_cnt <= 1) {
          if (this.check_out_serve()) this.set_result(RESULT_FAULT);
        } else if (this.check_out()) {
          this.set_result(RESULT_OUT);
        }
      } else if (b.bound === 2) {
        this.set_result(RESULT_MISS);
      }
      this.events.push('bound');
    } else {
      b.down += GRAVITY;
      b.vx += b.ax;
      b.vy += b.ay;
    }
  }

  check_out_serve() {
    const b = this.ball;
    let x1, x2, y1, y2;
    if (this.server === 0) {
      if (this.serve_pos > 0) {
        x1 = -COURT_W;
        x2 = 0;
      } else {
        x1 = 0;
        x2 = COURT_W;
      }
      y1 = -SERVE_H;
      y2 = 0;
    } else {
      if (this.serve_pos > 0) {
        x1 = 0;
        x2 = COURT_W;
      } else {
        x1 = -COURT_W;
        x2 = 0;
      }
      y1 = 0;
      y2 = SERVE_H;
    }
    if (b.vx < x1) return 1;
    if (b.vx > x2) return 1;
    if (b.vy < y1) return 1;
    if (b.vy > y2) return 1;
    return 0;
  }

  check_out() {
    const b = this.ball;
    const x1 = -COURT_W;
    const x2 = COURT_W;
    let y1, y2;
    if (b.side === 0) {
      y1 = -COURT_H;
      y2 = 0;
    } else {
      y1 = 0;
      y2 = COURT_H;
    }
    if (b.vx < x1) return 1;
    if (b.vx > x2) return 1;
    if (b.vy < y1) return 1;
    if (b.vy > y2) return 1;
    return 0;
  }

  // ---- scoring -------------------------------------------------------------------------

  set_mes(label) {
    this.mes.label = label;
    this.mes.cnt = 0;
    this.mes.space = 0;
  }

  set_result(res) {
    if (this.play_result > 0) return;
    this.play_result = res;
    switch (res) {
      case RESULT_FAULT:
        this.fault_cnt++;
        if (this.fault_cnt === 1) {
          this.mes.txt = 'FAULT';
        } else {
          this.mes.txt = 'DOUBLE FAULT';
          this.play_winner = this.server !== 0 ? 0 : 1;
        }
        this.set_mes('mes');
        break;
      case RESULT_OUT:
        this.mes.txt = 'OUT';
        this.play_winner = this.ball.side !== 0 ? 0 : 1;
        this.set_mes('mes');
        break;
      case RESULT_MISS:
        this.events.push('app');
        this.play_winner = this.ball.side;
        this.start_score();
        break;
      case RESULT_VOLLEY:
        this.play_winner = this.server;
        this.start_score();
        break;
      default:
        break;
    }
  }

  start_score() {
    if (this.play_winner < 0) {
      this.init_play(); // first fault: serve again
      return;
    }
    const w = this.play_winner;
    this.point[w]++;
    if (this.point[w] > 3) {
      if (this.point[0] === this.point[1]) {
        this.score_txt = 'DEUCE';
        this.mes.txt = this.score_txt;
        this.set_mes('score');
      } else {
        if (Math.abs(this.point[0] - this.point[1]) > 1) {
          this.game_winner = w;
          this.gpoint[w]++;
          this.mes.txt = `Game won by ${this.pname[w]}`;
          this.set_mes('game');
          this.end_point_poses(w);
          return;
        }
        this.score_txt = `Advantage ${this.pname[w]}`;
        this.mes.txt = `Advantage ${this.pname[w]}`;
        this.set_mes('score');
      }
    } else {
      const a = this.point[this.server];
      const b = this.point[this.receiver];
      const t = [0, 15, 30, 40];
      this.score_txt = `${this.pname[this.server]} ${t[a]} - ${t[b]} ${this.pname[this.receiver]}`;
      this.mes.txt = `${t[a]} - ${t[b]}`;
      this.set_mes('score');
    }
    this.end_point_poses(w);
  }

  // The original froze only the computer in a win/lose pose; here both players get one.
  end_point_poses(winner) {
    for (let i = 0; i < 2; i++) {
      const mc = this.players[i];
      mc.stat = PS_AFTER;
      this.set_label(mc, i === winner ? 'win' : 'lose');
    }
  }

  after_score() {
    this.fault_cnt = 0;
    this.play_winner = -1;
    this.serve_pos = this.serve_pos !== 1 ? 1 : -1;
    this.init_play();
  }

  after_game_winner() {
    const g = this.gpoint;
    if (g[this.game_winner] >= 3 && Math.abs(g[0] - g[1]) > 1) {
      this.events.push('app2');
      this.score_txt = '';
      this.match_winner = g[0] > g[1] ? 0 : 1;
      this.mes.txt = '';
      this.set_mes('match');
    } else {
      this.set_mes('inplay');
      this.server = this.server !== 0 ? 0 : 1;
      this.receiver = this.server !== 0 ? 0 : 1;
      this.init_game();
    }
  }

  // The message clip's own per-frame scripts, plus its space-bar button.
  tick_mes(pressed) {
    const m = this.mes;
    switch (m.label) {
      case 'mes':
        m.cnt++;
        if (m.cnt >= MES_HOLD) this.start_score();
        break;
      case 'score':
        m.cnt++;
        if (m.cnt >= MES_HOLD) {
          this.set_mes('inplay');
          this.after_score();
        }
        break;
      case 'game':
      case 'match':
        m.cnt++;
        if (m.space === 0) {
          const guard = m.label === 'game' ? SPACE_GUARD_GAME : SPACE_GUARD_MATCH;
          if (pressed && m.cnt > guard) {
            m.space = 1;
            this.events.push('click');
          }
        } else {
          m.space++;
          if (m.space >= SPACE_ANIM) {
            if (m.label === 'game') this.after_game_winner();
            else this.over = true;
          }
        }
        break;
      default:
        break;
    }
  }
}
