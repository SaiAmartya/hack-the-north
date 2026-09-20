import * as THREE from "three";
import type { GameEvent, Slot, Snapshot, Spell } from "./contracts";

/** Authoritative flight interpolation between the two wand tips (arena fractions). */
export function flightPosition(
  launch: number,
  impact: number,
  now: number,
  outgoing: boolean,
): { x: number; y: number; progress: number } {
  const p = Math.max(
    0,
    Math.min(1, (now - launch) / Math.max(1, impact - launch)),
  );
  const start = outgoing ? [0.32, 0.62] : [0.7, 0.42];
  const end = outgoing ? [0.74, 0.44] : [0.26, 0.72];
  return {
    x:
      start[0] +
      (end[0] - start[0]) * p +
      Math.sin(p * Math.PI) * (outgoing ? 0.09 : -0.13),
    y: start[1] + (end[1] - start[1]) * p - Math.sin(p * Math.PI) * 0.12,
    progress: p,
  };
}

/** Where sprites and the arena relic sit, as fractions of the arena. */
export const ANCHORS = {
  me: { x: 0.26, y: 0.72 },
  rival: { x: 0.74, y: 0.44 },
  myWand: { x: 0.32, y: 0.62 },
  rivalWand: { x: 0.7, y: 0.42 },
  relic: { x: 0.5, y: 0.56 },
};

type AttackSpell = "stupefy" | "expelliarmus" | "incendio";
type Style = {
  color: number;
  core: number;
  width: number;
  height: number;
  trail: number;
  trailWidth: number;
  jitter: number;
  spiral: number;
  flicker: number;
  embers: number;
};
const STYLES: Record<AttackSpell, Style> = {
  // A thin, fast, crackling bolt.
  stupefy: { color: 0xff4d6d, core: 0xfff2f2, width: 0.11, height: 0.05, trail: 7, trailWidth: 0.012, jitter: 0.014, spiral: 0, flicker: 0, embers: 0.35 },
  // A golden hook that spirals out before it yanks the wand back.
  expelliarmus: { color: 0xffc94d, core: 0xfff8dc, width: 0.1, height: 0.1, trail: 12, trailWidth: 0.01, jitter: 0, spiral: 0.035, flicker: 0, embers: 0.6 },
  // A slow, heavy fireball trailing embers.
  incendio: { color: 0xff7a2d, core: 0xffe680, width: 0.32, height: 0.3, trail: 14, trailWidth: 0.034, jitter: 0.004, spiral: 0, flicker: 0.12, embers: 3.2 },
};
const REFLECT_TINT = new THREE.Color(0x9ff3ff);
const SPELL_COLORS: Record<Spell, number> = {
  stupefy: 0xff4d6d,
  expelliarmus: 0xffc94d,
  incendio: 0xff7a2d,
  protego: 0x85cfff,
  episkey: 0x8dffb0,
};
const POWERUP_COLOR = 0xffd86b;

const VERTEX = `varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
const CORE = `varying vec2 vUv; uniform vec3 color; uniform vec3 core; uniform float opacity; void main(){float d=length(vUv-.5)*2.;float a=pow(max(0.,1.-d),1.7);gl_FragColor=vec4(mix(color,core,pow(max(0.,1.-d*1.6),2.)),a*opacity);}`;
const SHIELD = `varying vec2 vUv; uniform vec3 color; uniform float opacity; uniform float time; void main(){vec2 p=(vUv-.5)*2.;float r=length(p);float rim=1.-smoothstep(0.,.07,abs(r-.84));float wave=pow(max(0.,sin(r*30.-time*4.)),14.)*.12;float a=(rim*.9+max(0.,1.-r)*.10+wave)*(1.-smoothstep(.90,1.,r));gl_FragColor=vec4(color,a*opacity);}`;
const RIPPLE = `varying vec2 vUv; uniform vec3 color; uniform float opacity; uniform float time; void main(){float r=length(vUv-.5)*2.;float a=1.-smoothstep(0.,.08,abs(r-time));gl_FragColor=vec4(color,a*opacity);}`;
const POINT_VERTEX = `attribute float size; attribute vec3 tint; attribute float alpha; uniform float scale; varying vec3 vTint; varying float vAlpha; void main(){vTint=tint;vAlpha=alpha;gl_PointSize=size*scale;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
const POINT_FRAGMENT = `varying vec3 vTint; varying float vAlpha; void main(){float d=length(gl_PointCoord-.5)*2.;float a=smoothstep(1.,.25,d)*vAlpha;gl_FragColor=vec4(vTint,a);}`;

const point = (x: number, y: number) =>
  new THREE.Vector3(x * 2 - 1, 1 - y * 2, 0);
const hexRgb = (hex: number) => [
  ((hex >> 16) & 255) / 255,
  ((hex >> 8) & 255) / 255,
  (hex & 255) / 255,
];

type Particle = {
  x: number; y: number; vx: number; vy: number;
  born: number; life: number; size: number; gravity: number;
  r: number; g: number; b: number; fade: number;
};
type WandFlight = { at: number; from: { x: number; y: number }; to: { x: number; y: number }; mesh: THREE.Mesh };

/** Fixed pooled geometry; no physics engine, lights, video textures or React-frame state. */
export class DuelEffects {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  private projectiles: {
    head: THREE.Mesh;
    halo: THREE.Mesh;
    trail: THREE.Mesh;
    positions: Float32Array;
    seenId?: string;
  }[] = [];
  private shields: THREE.Mesh[] = [];
  private ripples: { mesh: THREE.Mesh; at: number; duration: number }[] = [];
  private wands: WandFlight[] = [];
  private points: THREE.Points;
  private readonly maxParticles: number;
  private particlePositions: Float32Array;
  private particleTints: Float32Array;
  private particleSizes: Float32Array;
  private particleAlphas: Float32Array;
  private particles: Particle[] = [];
  private seen = new Set<string>();
  private state?: Snapshot;
  private slot: Slot = "P1";
  private round = -1;
  private raf = 0;
  private observer: ResizeObserver;
  private reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private lastFrame = 0;
  private lastDraw = 0;
  private emitCarry = new Map<string, number>();
  private randomSeed = 1;
  readonly frameIntervals: number[] = [];
  constructor(
    canvas: HTMLCanvasElement,
    private readonly now: () => number,
    low = false,
  ) {
    this.maxParticles = low ? 160 : 420;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: !low,
      powerPreference: "low-power",
    });
    this.renderer.setClearColor(0, 0);
    this.camera.position.z = 5;
    const plane = new THREE.PlaneGeometry(1, 1);
    const shader = (fragmentShader: string, color: number, core = 0xffffff) =>
      new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          color: { value: new THREE.Color(color) },
          core: { value: new THREE.Color(core) },
          opacity: { value: 1 },
          time: { value: 0 },
        },
      });
    for (let i = 0; i < 8; i++) {
      const head = new THREE.Mesh(plane, shader(CORE, 0xff335d));
      head.scale.set(0.13, 0.19, 1);
      const halo = new THREE.Mesh(plane, shader(CORE, 0xff335d));
      halo.scale.set(0.3, 0.3, 1);
      (halo.material as THREE.ShaderMaterial).uniforms.opacity.value = 0.35;
      const positions = new Float32Array(16 * 6 * 3);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(positions, 3),
      );
      const trail = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({
          color: 0xff335d,
          transparent: true,
          opacity: 0.55,
          side: THREE.DoubleSide,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      head.frustumCulled = halo.frustumCulled = trail.frustumCulled = false;
      this.scene.add(halo, trail, head);
      this.projectiles.push({ head, halo, trail, positions });
    }
    for (let i = 0; i < 2; i++) {
      const mesh = new THREE.Mesh(plane, shader(SHIELD, 0x85cfff));
      mesh.scale.set(i === 0 ? 0.58 : 0.46, i === 0 ? 1.1 : 0.85, 1);
      this.scene.add(mesh);
      this.shields.push(mesh);
    }
    for (let i = 0; i < 4; i++) {
      const mesh = new THREE.Mesh(plane, shader(RIPPLE, 0xc8a9ff));
      mesh.scale.set(1.2, 1.25, 1);
      this.scene.add(mesh);
      this.ripples.push({ mesh, at: -Infinity, duration: 500 });
    }
    for (let i = 0; i < 2; i++) {
      const mesh = new THREE.Mesh(
        plane,
        new THREE.MeshBasicMaterial({ color: 0x8a5a33, transparent: true, depthWrite: false }),
      );
      mesh.scale.set(0.13, 0.016, 1);
      mesh.visible = false;
      this.scene.add(mesh);
      this.wands.push({ at: -Infinity, from: ANCHORS.rivalWand, to: ANCHORS.myWand, mesh });
    }
    this.particlePositions = new Float32Array(this.maxParticles * 3);
    this.particleTints = new Float32Array(this.maxParticles * 3);
    this.particleSizes = new Float32Array(this.maxParticles);
    this.particleAlphas = new Float32Array(this.maxParticles);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.particlePositions, 3));
    geometry.setAttribute("tint", new THREE.BufferAttribute(this.particleTints, 3));
    geometry.setAttribute("size", new THREE.BufferAttribute(this.particleSizes, 1));
    geometry.setAttribute("alpha", new THREE.BufferAttribute(this.particleAlphas, 1));
    this.points = new THREE.Points(
      geometry,
      new THREE.ShaderMaterial({
        vertexShader: POINT_VERTEX,
        fragmentShader: POINT_FRAGMENT,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        uniforms: { scale: { value: 1 } },
      }),
    );
    this.points.frustumCulled = false;
    this.scene.add(this.points);
    this.renderer.compile(this.scene, this.camera);
    // Compile alone does not upload lazy geometry. Warm every pool before Ready,
    // then clear it synchronously so the setup screen never displays the pools.
    this.renderer.setSize(1, 1, false);
    this.renderer.render(this.scene, this.camera);
    this.draw(this.now(), low);
    this.renderer.render(this.scene, this.camera);
    this.observer = new ResizeObserver(() => {
      const { width, height } = canvas.getBoundingClientRect();
      const scale = Math.min(
        devicePixelRatio || 1,
        (low ? 1280 : 1920) / Math.max(width, 1),
        (low ? 720 : 1080) / Math.max(height, 1),
      );
      this.renderer.setPixelRatio(scale);
      this.renderer.setSize(Math.max(1, width), Math.max(1, height), false);
      (this.points.material as THREE.ShaderMaterial).uniforms.scale.value = scale * Math.max(0.6, Math.min(1.6, width / 900));
    });
    this.observer.observe(canvas);
    const render = (time: number) => {
      if (this.lastFrame) {
        this.frameIntervals.push(time - this.lastFrame);
        if (this.frameIntervals.length > 1800) this.frameIntervals.shift();
      }
      this.lastFrame = time;
      this.draw(this.now(), low);
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(render);
    };
    this.raf = requestAnimationFrame(render);
  }
  update(state: Snapshot | undefined, slot: Slot = "P1") {
    if (!state) {
      this.state = undefined;
      this.round = -1;
      this.seen.clear();
      this.particles = [];
      for (const ripple of this.ripples) ripple.at = -Infinity;
      for (const wand of this.wands) wand.at = -Infinity;
      return;
    }
    this.slot = slot;
    if (state.roundId !== this.round || state.result?.outcome === "aborted") {
      this.round = state.roundId;
      this.seen.clear();
      this.particles = [];
      for (const r of this.ripples) r.at = -Infinity;
      for (const wand of this.wands) wand.at = -Infinity;
    }
    const initial = !this.state || this.state.roundId !== state.roundId;
    for (const event of state.recentEvents) {
      if (this.seen.has(event.id)) continue;
      this.seen.add(event.id);
      // History restores flights/shields below; never replay old completed explosions.
      if (
        !initial &&
        event.roundId === state.roundId &&
        this.now() - event.atMs < 450 &&
        state.result?.outcome !== "aborted"
      )
        this.event(event);
    }
    if (this.seen.size > 512) this.seen = new Set([...this.seen].slice(-256));
    this.state = state;
  }
  private random() {
    // Small deterministic generator: identical replays draw identical sparks.
    this.randomSeed = (this.randomSeed * 1664525 + 1013904223) >>> 0;
    return this.randomSeed / 4294967296;
  }
  private spriteOf(slot: Slot | null | undefined) {
    return slot === this.slot ? ANCHORS.me : ANCHORS.rival;
  }
  private wandOf(slot: Slot | null | undefined) {
    return slot === this.slot ? ANCHORS.myWand : ANCHORS.rivalWand;
  }
  private spawn(
    count: number,
    x: number,
    y: number,
    options: {
      color: number; speed?: number; spread?: number; up?: number; life?: number;
      size?: number; gravity?: number; scatter?: number; fade?: number; second?: number;
    },
  ) {
    if (this.reduce) return;
    const now = this.now();
    const [r, g, b] = hexRgb(options.color);
    const [r2, g2, b2] = options.second === undefined ? [r, g, b] : hexRgb(options.second);
    for (let i = 0; i < count; i++) {
      if (this.particles.length >= this.maxParticles) this.particles.shift();
      const angle = this.random() * Math.PI * 2;
      const speed = (options.speed ?? 0.00016) * (0.35 + this.random() * 0.9);
      const mix = this.random();
      this.particles.push({
        x: x + (this.random() - 0.5) * (options.scatter ?? 0.02),
        y: y + (this.random() - 0.5) * (options.scatter ?? 0.02),
        vx: Math.cos(angle) * speed * (options.spread ?? 1),
        vy: Math.sin(angle) * speed * (options.spread ?? 1) - (options.up ?? 0),
        born: now,
        life: (options.life ?? 500) * (0.7 + this.random() * 0.6),
        size: (options.size ?? 5) * (0.6 + this.random() * 0.8),
        gravity: options.gravity ?? 0,
        r: r + (r2 - r) * mix,
        g: g + (g2 - g) * mix,
        b: b + (b2 - b) * mix,
        fade: options.fade ?? 1,
      });
    }
  }
  private ripple(x: number, y: number, color: number, duration = 500, scale = 1.2) {
    const ripple =
      this.ripples.find((r) => this.now() - r.at > r.duration) ?? this.ripples[0];
    ripple.at = this.now();
    ripple.duration = duration;
    ripple.mesh.position.copy(point(x, y));
    ripple.mesh.scale.set(scale, scale * 1.04, 1);
    (ripple.mesh.material as THREE.ShaderMaterial).uniforms.color.value.setHex(color);
  }
  private flyWand(from: { x: number; y: number }, to: { x: number; y: number }) {
    const wand = this.wands.find((w) => this.now() - w.at > 900) ?? this.wands[0];
    wand.at = this.now();
    wand.from = from;
    wand.to = to;
  }
  private event(event: GameEvent) {
    const target = this.spriteOf(event.target);
    const actor = this.spriteOf(event.actor);
    const spellColor = event.spell ? SPELL_COLORS[event.spell] : 0xffffff;
    switch (event.type) {
      case "castAccepted": {
        const tip = this.wandOf(event.actor);
        this.spawn(10, tip.x, tip.y, { color: spellColor, second: 0xffffff, speed: 0.0002, life: 320, size: 5 });
        break;
      }
      case "damage": {
        const heavy = event.spell === "incendio" || event.critical;
        this.spawn(heavy ? 44 : 26, target.x, target.y, {
          color: spellColor, second: event.critical ? 0xfff2b0 : 0xffffff,
          speed: heavy ? 0.00032 : 0.00024, life: heavy ? 620 : 460, size: heavy ? 7 : 5, gravity: 0.0000006, scatter: 0.05,
        });
        if (event.critical) this.ripple(target.x, target.y, 0xffe08a, 520, 1.5);
        break;
      }
      case "burned":
        this.spawn(8, target.x, target.y, { color: 0xff7a2d, second: 0xffe680, speed: 0.0001, up: 0.00014, life: 520, size: 5, scatter: 0.08 });
        break;
      case "stunned":
        this.spawn(14, target.x, target.y - 0.12, { color: 0xfff08a, second: 0xffffff, speed: 0.00012, life: 700, size: 4, scatter: 0.06 });
        break;
      case "healed":
        this.spawn(30, target.x, target.y + 0.05, { color: 0x8dffb0, second: 0xf3ffe9, speed: 0.00006, up: 0.00022, life: 900, size: 5, scatter: 0.16 });
        break;
      case "impactBlocked":
        this.ripple(target.x, target.y, 0x9fd8ff, 500, 1.2);
        this.spawn(22, target.x, target.y, { color: 0x9fd8ff, second: spellColor, speed: 0.00022, life: 420, size: 4, scatter: 0.05 });
        break;
      case "impactReflected":
        this.ripple(target.x, target.y, event.reason === "mirror" ? 0xeaf9ff : 0x7ff0ff, 620, 1.6);
        this.spawn(36, target.x, target.y, { color: 0x7ff0ff, second: 0xffffff, speed: 0.0003, life: 560, size: 5, scatter: 0.04 });
        break;
      case "shieldBroken":
        this.ripple(target.x, target.y, 0x9fd8ff, 420, 1.0);
        this.spawn(34, target.x, target.y, { color: 0x9fd8ff, second: 0xffffff, speed: 0.00026, life: 700, size: 6, gravity: 0.0000012, scatter: 0.12 });
        break;
      case "offenseLocked": {
        // Expelliarmus: the wand leaves the disarmed wizard's hand and is yanked toward the caster.
        const from = this.wandOf(event.target), to = this.wandOf(event.actor);
        this.flyWand(from, { x: to.x + (to.x < from.x ? -0.06 : 0.06), y: to.y + 0.12 });
        this.spawn(18, from.x, from.y, { color: 0xffc94d, second: 0xffffff, speed: 0.0002, life: 480, size: 5 });
        break;
      }
      case "powerupAppeared":
        this.ripple(ANCHORS.relic.x, ANCHORS.relic.y, POWERUP_COLOR, 700, 0.9);
        this.spawn(26, ANCHORS.relic.x, ANCHORS.relic.y, { color: POWERUP_COLOR, second: 0xffffff, speed: 0.00014, life: 800, size: 5, scatter: 0.04 });
        break;
      case "powerupClaimed":
        this.ripple(actor.x, actor.y, POWERUP_COLOR, 600, 1.4);
        this.spawn(40, ANCHORS.relic.x, ANCHORS.relic.y, { color: POWERUP_COLOR, second: 0xffffff, speed: 0.0003, life: 600, size: 6 });
        this.spawn(24, actor.x, actor.y, { color: POWERUP_COLOR, second: 0xffffff, speed: 0.0001, up: 0.0002, life: 900, size: 5, scatter: 0.14 });
        break;
      case "roundEnded":
        if (event.actor)
          this.spawn(60, actor.x, actor.y, { color: POWERUP_COLOR, second: 0xffffff, speed: 0.00012, up: 0.00026, life: 1400, size: 6, scatter: 0.2 });
        break;
      default:
        break;
    }
  }
  private emit(key: string, perMs: number, dt: number): number {
    const carry = (this.emitCarry.get(key) ?? 0) + perMs * dt;
    const count = Math.floor(carry);
    this.emitCarry.set(key, carry - count);
    return count;
  }
  private draw(now: number, low: boolean) {
    const state = this.state;
    const dt = this.lastDraw ? Math.min(100, Math.max(0, now - this.lastDraw)) : 0;
    this.lastDraw = now;
    const playing = state?.phase === "playing";
    this.projectiles.forEach(({ head, halo, trail, positions }, index) => {
      const p = state?.projectiles[index];
      head.visible = halo.visible = trail.visible =
        !!p && now >= p.launchAtMs && now < p.impactAtMs && !this.reduce;
      if (!p || !head.visible) return;
      const style = STYLES[p.spell];
      const outgoing = p.caster === this.slot;
      const at = flightPosition(p.launchAtMs, p.impactAtMs, now, outgoing);
      const before = flightPosition(p.launchAtMs, p.impactAtMs, now - 16, outgoing);
      const angle = Math.atan2(-(at.y - before.y), at.x - before.x);
      const flicker = style.flicker ? 1 + Math.sin(now / 37) * style.flicker : 1;
      const grow = 0.75 + Math.min(1, at.progress * 3) * 0.25;
      head.position.copy(point(at.x, at.y));
      head.rotation.z = angle;
      head.scale.set(style.width * flicker * grow, style.height * flicker * grow, 1);
      halo.position.copy(point(at.x, at.y));
      const haloScale = p.spell === "incendio" ? 2.9 : 2.4;
      halo.scale.set(style.width * haloScale * flicker, style.height * haloScale * flicker, 1);
      const color = new THREE.Color(style.color);
      if (p.reflected) color.lerp(REFLECT_TINT, 0.55);
      const headMaterial = head.material as THREE.ShaderMaterial;
      headMaterial.uniforms.color.value.copy(color);
      headMaterial.uniforms.core.value.setHex(style.core);
      (halo.material as THREE.ShaderMaterial).uniforms.color.value.copy(color);
      (trail.material as THREE.MeshBasicMaterial).color.copy(color);
      const segments = Math.min(16, style.trail);
      const step = p.spell === "stupefy" ? 9 : 16;
      for (let i = 0; i < 16; i++) {
        if (i >= segments) {
          positions.fill(0, i * 18, i * 18 + 18);
          continue;
        }
        const a = flightPosition(p.launchAtMs, p.impactAtMs, now - i * step, outgoing),
          b = flightPosition(p.launchAtMs, p.impactAtMs, now - (i + 1) * step, outgoing);
        const wobble = style.spiral ? Math.sin((now - i * step) / 45) * style.spiral : 0;
        const jitterA = style.jitter ? (this.random() - 0.5) * style.jitter * 2 : 0;
        const jitterB = style.jitter ? (this.random() - 0.5) * style.jitter * 2 : 0;
        const width = style.trailWidth * (1 - i / segments);
        const ap = point(a.x + jitterA, a.y + wobble + jitterA),
          bp = point(b.x + jitterB, b.y - wobble + jitterB);
        positions.set(
          [
            ap.x - width, ap.y, 0,
            ap.x + width, ap.y, 0,
            bp.x - width, bp.y, 0,
            ap.x + width, ap.y, 0,
            bp.x + width, bp.y, 0,
            bp.x - width, bp.y, 0,
          ],
          i * 18,
        );
      }
      trail.geometry.attributes.position.needsUpdate = true;
      // Continuous emission along the flight: embers for fire, sparks for bolts, sparkle for the hook.
      const count = this.emit(p.id, (style.embers * (low ? 0.5 : 1)) / 32, dt);
      if (count)
        this.spawn(count, at.x, at.y, {
          color: p.reflected ? 0x9ff3ff : style.color, second: style.core,
          speed: 0.00008, up: p.spell === "incendio" ? 0.00012 : 0,
          life: p.spell === "incendio" ? 620 : 300, size: p.spell === "incendio" ? 6 : 4, scatter: style.height * 0.5,
        });
    });
    this.shields.forEach((mesh, i) => {
      const slot: Slot = i === 0 ? this.slot : this.slot === "P1" ? "P2" : "P1";
      const p = state?.players[slot];
      const mirror = !!p && p.mirrorUntilMs > now;
      const shielded = !!p && p.shieldUntilMs > now;
      mesh.visible = playing && (shielded || mirror);
      mesh.position.copy(point(i === 0 ? ANCHORS.me.x : ANCHORS.rival.x, i === 0 ? ANCHORS.me.y : ANCHORS.rival.y));
      const material = mesh.material as THREE.ShaderMaterial;
      material.uniforms.color.value.setHex(shielded ? 0x85cfff : 0xe6f6ff);
      material.uniforms.time.value = this.reduce ? 0 : now / (shielded ? 1000 : 600);
    });
    for (const r of this.ripples) {
      const age = (now - r.at) / r.duration;
      r.mesh.visible = age >= 0 && age < 1 && !this.reduce;
      const m = r.mesh.material as THREE.ShaderMaterial;
      m.uniforms.time.value = age;
      m.uniforms.opacity.value = 1 - age;
    }
    for (const wand of this.wands) {
      const age = (now - wand.at) / 750;
      wand.mesh.visible = age >= 0 && age < 1 && !this.reduce;
      if (!wand.mesh.visible) continue;
      const eased = 1 - Math.pow(1 - age, 2.2);
      const x = wand.from.x + (wand.to.x - wand.from.x) * eased;
      const y = wand.from.y + (wand.to.y - wand.from.y) * eased - Math.sin(age * Math.PI) * 0.16;
      wand.mesh.position.copy(point(x, y));
      wand.mesh.rotation.z = age * Math.PI * 5 * (wand.to.x < wand.from.x ? 1 : -1);
      (wand.mesh.material as THREE.MeshBasicMaterial).opacity = age < 0.8 ? 1 : 1 - (age - 0.8) / 0.2;
      if (this.emit("wand", 1 / 40, dt)) this.spawn(1, x, y, { color: 0xffc94d, second: 0xffffff, speed: 0.00005, life: 320, size: 4 });
    }
    // Lingering status emitters: a burning wizard sheds embers until cured.
    if (playing && state && !this.reduce)
      for (const slot of ["P1", "P2"] as const) {
        const p = state.players[slot];
        if (!p) continue;
        const at = this.spriteOf(slot);
        if (p.burnUntilMs > now && p.hp > 0) {
          const count = this.emit(`burn:${slot}`, (low ? 0.5 : 1) / 70, dt);
          if (count) this.spawn(count, at.x, at.y + 0.02, { color: 0xff7a2d, second: 0xffe680, speed: 0.00004, up: 0.00018, life: 760, size: 6, scatter: 0.13 });
        }
        if (p.lucky) {
          const count = this.emit(`lucky:${slot}`, 1 / 220, dt);
          if (count) this.spawn(count, at.x, at.y - 0.05, { color: POWERUP_COLOR, second: 0xffffff, speed: 0.00003, up: 0.0001, life: 900, size: 4, scatter: 0.16 });
        }
        if (p.hasteUntilMs > now) {
          const count = this.emit(`haste:${slot}`, 1 / 160, dt);
          if (count) this.spawn(count, at.x, at.y + 0.08, { color: 0xc8a9ff, second: 0xffffff, speed: 0.00006, up: 0.00016, life: 620, size: 4, scatter: 0.14 });
        }
      }
    if (state?.powerup && playing && !this.reduce) {
      const count = this.emit("relic", 1 / 140, dt);
      if (count) this.spawn(count, ANCHORS.relic.x, ANCHORS.relic.y + 0.04, { color: POWERUP_COLOR, second: 0xffffff, speed: 0.00003, up: 0.00009, life: 900, size: 4, scatter: 0.08 });
    }
    // Advance and pack every live particle.
    let count = 0;
    const alive: Particle[] = [];
    for (const particle of this.particles) {
      const age = (now - particle.born) / particle.life;
      if (age < 0 || age >= 1) continue;
      particle.vy += particle.gravity * dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      alive.push(particle);
      const p = point(particle.x, particle.y);
      this.particlePositions.set([p.x, p.y, 0], count * 3);
      this.particleTints.set([particle.r, particle.g, particle.b], count * 3);
      this.particleSizes[count] = particle.size * (1 - age * 0.5);
      this.particleAlphas[count] = Math.pow(1 - age, particle.fade);
      count++;
    }
    this.particles = alive;
    const geometry = this.points.geometry;
    geometry.setDrawRange(0, count);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.tint.needsUpdate = true;
    geometry.attributes.size.needsUpdate = true;
    geometry.attributes.alpha.needsUpdate = true;
    this.points.visible = count > 0;
  }
  resourceCounts() {
    return {
      ...this.renderer.info.memory,
      drawCalls: this.renderer.info.render.calls,
    };
  }
  dispose() {
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    const geometries = new Set<THREE.BufferGeometry>(),
      materials = new Set<THREE.Material>();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Points) {
        geometries.add(o.geometry);
        for (const m of Array.isArray(o.material) ? o.material : [o.material])
          materials.add(m);
      }
    });
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
    this.renderer.dispose();
  }
}
