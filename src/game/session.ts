import type { Sprites } from '../assets/sprites';
import type { GameMap } from '../assets/types';
import type { Audio, SoundName } from '../audio/audio';
import { eventVolume } from '../audio/spatial';
import { botHooks, setAllyOrder, type AllyOrder } from '../bots';
import type { NetTick } from '../net/lockstep';
import { cloneMatch } from '../engine/clone';
import { createMatch, matchResult, skinFor, step, type MatchResult } from '../engine/match';
import { NO_INPUT, type EngineAssets, type InputState, type Match, type MatchOptions } from '../engine/types';
import type { ButtonLayout, ButtonId, Insets } from '../input/layout';
import type { StickState } from '../input/touch';
import { orderLabel, t } from '../i18n';
import type { Platform } from '../platform/telegram';
import { cameraTarget, computeCamera, followCamera, type Point } from '../render/camera';
import { Effects } from '../render/effects';
import { drawActors, drawFighter } from '../render/fighters';
import { drawControls, drawHud, drawToast } from '../render/hud';
import { computeScale } from '../render/scale';
import { advanceWorldAnim, beginWorld, drawTram, drawWorld, newWorldAnim, TILE } from '../render/world';

export const TICK_HZ = 1000 / 60;
const TARGET_TILES_H = 14;
const CAMERA_STEP_X = 6;
const CAMERA_STEP_Y = 9;
const TOAST_TICKS = 36;
/** a prediction correction bigger than this is a teleport or a respawn: shown at once, not smoothed */
const MAX_SMOOTH_PX = 64;
/** how much of a smoothed correction is left after each drawn frame (about 100 ms to fade out at 60 fps) */
const SMOOTH_DECAY = 0.86;

export interface SessionDeps {
  sprites: Sprites;
  audio: Audio;
  platform: Platform;
  assets: EngineAssets;
  maps: GameMap[];
}

export interface FrameInfo {
  /** CSS pixels */
  w: number;
  h: number;
  dpr: number;
  safe: Insets;
  layout: ButtonLayout;
  held: ReadonlySet<ButtonId>;
  stick: StickState;
  showControls: boolean;
}

/** One running match: engine state plus everything that only exists for presentation (camera, effects, interpolation). */
export class GameSession {
  /** the simulation confirmed by the server (online) or the only simulation (solo): events, results and scores come from it */
  private readonly auth: Match;
  /** what is drawn: online, a copy of `auth` run ahead with the local player's input (client-side prediction); solo: `auth` itself */
  private shown: Match;
  private readonly online: boolean;
  /** local input per predicted tick, replayed when a server tick corrects the prediction */
  private readonly history = new Map<number, InputState>();
  /** the other humans' last confirmed input: the best guess for what they do in the predicted ticks */
  private readonly remoteHeld = new Map<number, InputState>();
  private held: InputState = { ...NO_INPUT };
  private pulseSel: InputState['weaponSelect'] = -1;
  private pulseDelta: InputState['weaponDelta'] = 0;
  private dirty = false;
  /** per fighter: screen offset still to fade out after a prediction correction (smoothing), in pixels */
  private readonly corr: { x: number; y: number }[] = [0, 1, 2, 3].map(() => ({ x: 0, y: 0 }));
  result: MatchResult = { over: false, winner: null };
  private readonly effects = new Effects();
  private readonly anim = newWorldAnim();
  private prev: { x: number; y: number }[] = [];
  private prevProj = new Map<object, number>();
  /** previous-tick y of lift cars (pobj index -> y), so riders and their car are interpolated together */
  private prevCarY = new Map<number, number>();
  private prevTramX = 0;
  private cam: Point = { x: 0, y: 0 };
  private prevCam: Point = { x: 0, y: 0 };
  private view = { w: 176, h: 192 };
  private lastHp = 100;
  private toast: { text: string; ticks: number } | null = null;

  /** `localSlot`: which fighter this device controls; `names`: player nicknames by slot (online matches only) */
  constructor(opts: MatchOptions, seed: number, private readonly deps: SessionDeps, readonly localSlot = 0, readonly names: string[] = []) {
    this.auth = createMatch(opts, deps.maps[opts.mapId]!, seed, deps.assets, botHooks);
    this.online = names.length > 0;
    this.shown = this.online ? cloneMatch(this.auth) : this.auth;
    this.snapPrev(this.shown);
    const p = this.shown.fighters[localSlot]!;
    this.cam = this.prevCam = computeCamera(cameraTarget(p, p.headsLeft, this.view), this.view, { w: this.shown.mapWidth, h: this.shown.mapHeight });
    this.lastHp = p.hp;
  }

  /** the match being drawn (online: the predicted one) */
  get match(): Match {
    return this.shown;
  }

  /** the match as the server has confirmed it: use it for scores, results and anything shown as fact */
  get authoritative(): Match {
    return this.auth;
  }

  private snapPrev(m: Match): void {
    this.prev = m.fighters.map((f) => ({ x: f.x, y: f.y }));
    this.prevProj.clear();
    for (const p of m.projectiles) this.prevProj.set(p, p.x);
    this.prevTramX = m.tram.x;
    this.prevCarY.clear();
    m.pobjs.forEach((p, i) => { if (p.type === 1 || p.type === 18 || p.type === 19) this.prevCarY.set(i, p.y); });
  }

  /** One 60 ms engine tick with the player's input. */
  tick(input: InputState): void {
    this.advance(new Map([[this.localSlot, input]]));
  }

  /** One server-issued tick of an online match: everybody's input, plus humans who left (bots take over). */
  tickNet(nt: NetTick): void {
    const m = this.auth;
    for (const slot of nt.dropped) {
      const f = m.fighters[slot];
      if (f && f.human) {
        f.human = false;
        f.skin = skinFor(m, f);
        m.ai.findNearestNode(m, f);
      }
      this.remoteHeld.delete(slot);
    }
    step(m, nt.inputs);
    for (const [slot, input] of nt.inputs) if (slot !== this.localSlot) this.remoteHeld.set(slot, { ...input, weaponSelect: -1, weaponDelta: 0 });
    for (const t of [...this.history.keys()]) if (t <= m.tick) this.history.delete(t);
    this.dirty = true; // the prediction restarts from this confirmed tick the next time it runs
    this.present(m);
    this.result = matchResult(m);
  }

  /** The device's current input; weapon pulses wait for the next predicted tick. */
  setLocalInput(i: InputState): void {
    this.held = { ...i, weaponSelect: -1, weaponDelta: 0 };
    if (i.weaponSelect !== -1) this.pulseSel = i.weaponSelect;
    if (i.weaponDelta !== 0) this.pulseDelta = i.weaponDelta;
  }

  /** The tick the next local input will apply from (sent with the input, so the server uses it at the same tick). */
  get nextTick(): number {
    return this.shown.tick + 1;
  }

  /** Runs the predicted simulation up to `target` with the local input; confirmed ticks correct it as they arrive. */
  predictTo(target: number): void {
    if (this.dirty) this.rebuildPrediction();
    for (let n = 0; this.shown.tick < target && n < 12; n++) this.predictStep();
  }

  private predictedInputs(local: InputState): Map<number, InputState> {
    const inputs = new Map(this.remoteHeld);
    inputs.set(this.localSlot, local);
    return inputs;
  }

  private predictStep(): void {
    this.snapPrev(this.shown);
    const local: InputState = { ...this.held, weaponSelect: this.pulseSel, weaponDelta: this.pulseDelta };
    this.pulseSel = -1;
    this.pulseDelta = 0;
    this.history.set(this.shown.tick + 1, local);
    step(this.shown, this.predictedInputs(local));
    this.shown.events.length = 0; // sounds and effects come from confirmed ticks only
    this.updateCamera();
  }

  /** A confirmed tick arrived: restart from the confirmed state and replay the local input that is still unconfirmed. */
  private rebuildPrediction(): void {
    const to = this.shown.tick;
    const seen = this.shown.fighters.map((f) => ({ x: f.x, y: f.y }));
    this.shown = cloneMatch(this.auth);
    this.dirty = false;
    if (to <= this.shown.tick) { this.snapPrev(this.shown); return; }
    for (let t = this.shown.tick + 1; t <= to; t++) {
      if (t === to) this.snapPrev(this.shown); // interpolate over the last replayed tick only
      step(this.shown, this.predictedInputs(this.history.get(t) ?? { ...this.held, weaponSelect: -1, weaponDelta: 0 }));
      this.shown.events.length = 0;
    }
    this.smoothCorrections(seen);
  }

  /**
   * The corrected simulation may put a fighter somewhere else than where the player has just seen him. Instead of a
   * jump, keep the difference as an offset that fades out over a few frames: what is drawn stays continuous.
   * Big differences (teleports, respawns) are not smoothed.
   */
  private smoothCorrections(seen: { x: number; y: number }[]): void {
    this.shown.fighters.forEach((f, i) => {
      const was = seen[i];
      const c = this.corr[i];
      if (!was || !c) return;
      const dx = was.x - f.x;
      const dy = was.y - f.y;
      if (Math.abs(dx) > MAX_SMOOTH_PX || Math.abs(dy) > MAX_SMOOTH_PX) {
        c.x = 0;
        c.y = 0;
        return;
      }
      c.x = Math.max(-MAX_SMOOTH_PX, Math.min(MAX_SMOOTH_PX, c.x + dx));
      c.y = Math.max(-MAX_SMOOTH_PX, Math.min(MAX_SMOOTH_PX, c.y + dy));
    });
  }

  /** Fades the correction offsets (called once per drawn frame). */
  private decayCorrections(): void {
    for (const c of this.corr) {
      c.x = Math.abs(c.x) < 0.5 ? 0 : c.x * SMOOTH_DECAY;
      c.y = Math.abs(c.y) < 0.5 ? 0 : c.y * SMOOTH_DECAY;
    }
  }

  /** The offset (px) currently applied to a fighter's drawn position after a prediction correction. */
  correctionOf(slot: number): { x: number; y: number } {
    const c = this.corr[slot];
    return { x: Math.round(c?.x ?? 0), y: Math.round(c?.y ?? 0) };
  }

  private advance(inputs: Map<number, InputState>): void {
    const m = this.shown; // solo: the same object as `auth`
    this.snapPrev(m);
    step(m, inputs);
    this.present(m);
    this.updateCamera();
    this.result = matchResult(m);
  }

  /** Sounds, effects, haptics and animation for one confirmed tick of `m`. */
  private present(m: Match): void {
    advanceWorldAnim(this.anim, m.tick);
    this.effects.advance();
    this.effects.spawn(m.events, m.tick);
    const me = m.fighters[this.localSlot]!;
    for (const e of m.events) {
      if (e.kind === 'sound' && (e.by === undefined || e.by === this.localSlot)) this.deps.audio.play(e.name as SoundName, eventVolume(me.x, me.y, e.x, e.y));
    }
    if (me.hp < this.lastHp) this.deps.platform.haptic(me.hp <= 0 ? 'medium' : 'light');
    this.lastHp = me.hp;
    if (this.toast && --this.toast.ticks <= 0) this.toast = null;
  }

  private updateCamera(): void {
    const m = this.match;
    const p = m.fighters[this.localSlot]!;
    const target = cameraTarget(p, p.headsLeft, this.view);
    this.prevCam = this.cam;
    const far = Math.abs(target.x - this.cam.x) > this.view.w || Math.abs(target.y - this.cam.y) > this.view.h;
    const next = far ? target : followCamera(this.cam, target, CAMERA_STEP_X, CAMERA_STEP_Y);
    this.cam = computeCamera(next, this.view, { w: m.mapWidth, h: m.mapHeight });
    if (far) this.prevCam = this.cam;
  }

  /** Nicknames above the other players' heads (online matches). */
  private drawNames(ctx: CanvasRenderingContext2D): void {
    if (this.names.length === 0) return;
    ctx.font = '700 6px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    this.names.forEach((name, slot) => {
      const f = this.match.fighters[slot];
      if (!name || !f || slot === this.localSlot || f.hp <= 0) return;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(name, f.x, f.y - 38);
      ctx.fillStyle = '#fff';
      ctx.fillText(name, f.x, f.y - 38);
    });
  }

  setAllyOrder(order: AllyOrder): void {
    if (!this.canOrderAlly) return;
    setAllyOrder(this.match, order);
    // the ally changes route at his next waypoint, so confirm the order right away
    this.toast = { text: t('toast.ally', { order: orderLabel(order) }), ticks: TOAST_TICKS };
    this.deps.platform.haptic('light');
    this.deps.audio.play('order');
  }

  /** current order of the ally (fighter 1), or -1 when there is no ally */
  get allyOrder(): number {
    return this.canOrderAlly ? this.match.fighters[1]!.aiOrder : -1;
  }

  get canOrderAlly(): boolean {
    return this.match.gameMode === 1 && this.match.numFighters >= 4 && this.names.length === 0;
  }

  /** Renders the current state; `alpha` interpolates between the previous and current tick. */
  draw(ctx: CanvasRenderingContext2D, f: FrameInfo, alpha: number): void {
    const m = this.match;
    const si = computeScale(f.w, f.h, f.dpr, TILE, TARGET_TILES_H);
    this.view = { w: si.viewW, h: si.viewH };
    const cam = computeCamera(
      { x: Math.round(this.prevCam.x + (this.cam.x - this.prevCam.x) * alpha), y: Math.round(this.prevCam.y + (this.cam.y - this.prevCam.y) * alpha) },
      this.view,
      { w: m.mapWidth, h: m.mapHeight },
    );
    beginWorld(ctx, cam, si.scale);
    // interpolate movers for smooth 60 fps on a 16.7 Hz simulation (teleports and respawns are not smoothed);
    // cars and the tram move up to 14 px per tick, so they are interpolated exactly like their passengers
    const carSaved: [number, number][] = [];
    this.prevCarY.forEach((py, i) => {
      const car = m.pobjs[i]!;
      carSaved.push([i, car.y]);
      if (Math.abs(car.y - py) <= 24) car.y = Math.round(py + (car.y - py) * alpha);
    });
    const tramSaved = m.tram.x;
    if (Math.abs(m.tram.x - this.prevTramX) <= 24) m.tram.x = Math.round(this.prevTramX + (m.tram.x - this.prevTramX) * alpha);
    const saved = m.fighters.map((x) => ({ x: x.x, y: x.y }));
    m.fighters.forEach((fi, i) => {
      const p = this.prev[i];
      if (!p || Math.abs(fi.x - p.x) > 24 || Math.abs(fi.y - p.y) > 24) return;
      fi.x = Math.round(p.x + (fi.x - p.x) * alpha);
      fi.y = Math.round(p.y + (fi.y - p.y) * alpha);
    });
    // a prediction correction fades out instead of jumping (restored with the other interpolated values below)
    m.fighters.forEach((fi, i) => { const c = this.corr[i]; if (c) { fi.x += Math.round(c.x); fi.y += Math.round(c.y); } });
    const savedProj = m.projectiles.map((p) => p.x);
    m.projectiles.forEach((p) => {
      const px = this.prevProj.get(p);
      if (px !== undefined) p.x = Math.round(px + (p.x - px) * alpha);
    });
    try {
      const { sprites } = this.deps;
      drawWorld(ctx, m, cam, this.view, sprites, this.anim, (rider) => drawFighter(ctx, rider, m.tick, sprites, this.anim));
      drawActors(ctx, m, sprites, this.anim);
      this.effects.draw(ctx, sprites);
      drawTram(ctx, m, this.view, cam, sprites);
      this.drawNames(ctx);
    } finally {
      m.fighters.forEach((fi, i) => { fi.x = saved[i]!.x; fi.y = saved[i]!.y; });
      carSaved.forEach(([i, y]) => { m.pobjs[i]!.y = y; });
      m.tram.x = tramSaved;
      m.projectiles.forEach((p, i) => { p.x = savedProj[i]!; });
    }
    drawHud(ctx, m, this.localSlot, { w: f.w, h: f.h, dpr: f.dpr }, f.safe);
    if (this.toast) drawToast(ctx, this.toast.text, { w: f.w, h: f.h, dpr: f.dpr }, f.safe, f.safe.t + 74);
    if (f.showControls) drawControls(ctx, f.layout, f.held, f.stick, f.dpr, this.allyOrder, m.fighters[this.localSlot]!.currentWeapon);
    this.decayCorrections();
  }
}
