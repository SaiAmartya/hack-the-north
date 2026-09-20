import * as THREE from "three";
import type { GameEvent, Slot, Snapshot } from "./contracts";

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
  const start = outgoing ? [0.18, 0.76] : [0.5, 0.46];
  const end = outgoing ? [0.5, 0.46] : [0.5, 0.57];
  return {
    x:
      start[0] +
      (end[0] - start[0]) * p +
      Math.sin(p * Math.PI) * (outgoing ? 0.09 : -0.13),
    y: start[1] + (end[1] - start[1]) * p - Math.sin(p * Math.PI) * 0.12,
    progress: p,
  };
}
const VERTEX = `varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
const CORE = `varying vec2 vUv; uniform vec3 color; uniform float opacity; void main(){float d=length(vUv-.5)*2.;float a=pow(max(0.,1.-d),2.);gl_FragColor=vec4(mix(color,vec3(1.),pow(max(0.,1.-d*2.),2.)),a*opacity);}`;
const SHIELD = `varying vec2 vUv; uniform vec3 color; uniform float opacity; uniform float time; void main(){vec2 p=(vUv-.5)*2.;float r=length(p);float rim=1.-smoothstep(0.,.07,abs(r-.84));float wave=pow(max(0.,sin(r*30.-time*4.)),14.)*.12;float a=(rim*.9+max(0.,1.-r)*.10+wave)*(1.-smoothstep(.90,1.,r));gl_FragColor=vec4(color,a*opacity);}`;
const RIPPLE = `varying vec2 vUv; uniform vec3 color; uniform float opacity; uniform float time; void main(){float r=length(vUv-.5)*2.;float a=1.-smoothstep(0.,.08,abs(r-time));gl_FragColor=vec4(color,a*opacity);}`;
const point = (x: number, y: number) =>
  new THREE.Vector3(x * 2 - 1, 1 - y * 2, 0);
const BOLT_COLORS: Record<string, number> = {
  stupefy: 0xff335d,               // crimson bolt
  expelliarmus: 0xffca60,          // red-gold ribbon
  incendio: 0xff7a1f,              // fire
  sectumsempra: 0xe6e6ff,          // steel-white slash
  "petrificus-totalus": 0x9fb7ff,  // pale binding light
};
const SHIELD_COLOR = 0x85cfff;
const PATRONUS_COLOR = 0xdff4ff;

/** Fixed pooled geometry; no physics, lights, video textures or React-frame state. */
export class DuelEffects {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  private projectiles: {
    head: THREE.Mesh;
    trail: THREE.Mesh;
    positions: Float32Array;
  }[] = [];
  private shields: THREE.Mesh[] = [];
  private ripples: { mesh: THREE.Mesh; at: number }[] = [];
  private particles: THREE.Points;
  private particlePositions = new Float32Array(96 * 3);
  private bursts: { at: number; x: number; y: number; seed: number }[] = [];
  private seen = new Set<string>();
  private state?: Snapshot;
  private slot: Slot = "P1";
  private round = -1;
  private raf = 0;
  private observer: ResizeObserver;
  private reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private lastFrame = 0;
  readonly frameIntervals: number[] = [];
  constructor(
    canvas: HTMLCanvasElement,
    private readonly now: () => number,
    low = false,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: !low,
      powerPreference: "low-power",
    });
    this.renderer.setClearColor(0, 0);
    this.camera.position.z = 5;
    const plane = new THREE.PlaneGeometry(1, 1);
    const shader = (fragmentShader: string, color: number) =>
      new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          color: { value: new THREE.Color(color) },
          opacity: { value: 1 },
          time: { value: 0 },
        },
      });
    for (let i = 0; i < 8; i++) {
      const head = new THREE.Mesh(plane, shader(CORE, 0xff335d));
      head.scale.set(0.13, 0.19, 1);
      const positions = new Float32Array(12 * 6 * 3);
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
          opacity: 0.5,
          side: THREE.DoubleSide,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      head.frustumCulled = trail.frustumCulled = false;
      this.scene.add(head, trail);
      this.projectiles.push({ head, trail, positions });
    }
    for (let i = 0; i < 2; i++) {
      const mesh = new THREE.Mesh(plane, shader(SHIELD, 0x85cfff));
      mesh.scale.set(i === 0 ? 1.25 : 0.64, i === 0 ? 1.3 : 0.7, 1);
      this.scene.add(mesh);
      this.shields.push(mesh);
    }
    for (let i = 0; i < 2; i++) {
      const mesh = new THREE.Mesh(plane, shader(RIPPLE, 0xc8a9ff));
      mesh.scale.set(1.2, 1.25, 1);
      this.scene.add(mesh);
      this.ripples.push({ mesh, at: -Infinity });
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.particlePositions, 3),
    );
    this.particles = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        color: 0xffd697,
        size: low ? 3 : 5,
        sizeAttenuation: false,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.particles.frustumCulled = false;
    this.scene.add(this.particles);
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
  update(state: Snapshot, slot: Slot) {
    this.slot = slot;
    if (state.roundId !== this.round || state.result?.outcome === "aborted") {
      this.round = state.roundId;
      this.seen.clear();
      this.bursts = [];
      for (const r of this.ripples) r.at = -Infinity;
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
  private event(event: GameEvent) {
    const incoming = event.target === this.slot;
    const x = 0.5,
      y = incoming ? 0.57 : 0.46;
    if (event.type === "impactBlocked") {
      const ripple =
        this.ripples.find((r) => this.now() - r.at > 500) ?? this.ripples[0];
      ripple.at = event.atMs;
      ripple.mesh.position.copy(point(x, y));
    }
    if (event.type === "barrierRaised") {
      const ripple =
        this.ripples.find((r) => this.now() - r.at > 500) ?? this.ripples[0];
      ripple.at = event.atMs;
      ripple.mesh.position.copy(point(x, event.actor === this.slot ? 0.55 : 0.46));
    }
    if (["damage", "impactBlocked", "burnDamage", "bodyBound"].includes(event.type))
      this.bursts.push({
        at: event.atMs,
        x,
        y,
        seed: [...event.id].reduce((sum, c) => sum + c.charCodeAt(0), 0),
      });
  }
  private draw(now: number, low: boolean) {
    const state = this.state;
    this.projectiles.forEach(({ head, trail, positions }, index) => {
      const p = state?.projectiles[index];
      head.visible = trail.visible =
        !!p && now >= p.launchAtMs && now < p.impactAtMs && !this.reduce;
      if (!p || !head.visible) return;
      const outgoing = p.caster === this.slot;
      const at = flightPosition(p.launchAtMs, p.impactAtMs, now, outgoing);
      head.position.copy(point(at.x, at.y));
      const color = BOLT_COLORS[p.spell] ?? 0xff335d;
      (head.material as THREE.ShaderMaterial).uniforms.color.value.setHex(
        color,
      );
      (trail.material as THREE.MeshBasicMaterial).color.setHex(color);
      for (let i = 0; i < 12; i++) {
        const a = flightPosition(
            p.launchAtMs,
            p.impactAtMs,
            now - i * 15,
            outgoing,
          ),
          b = flightPosition(
            p.launchAtMs,
            p.impactAtMs,
            now - (i + 1) * 15,
            outgoing,
          );
        const width = 0.016 * (1 - i / 12);
        const ap = point(a.x, a.y),
          bp = point(b.x, b.y);
        positions.set(
          [
            ap.x - width,
            ap.y,
            0,
            ap.x + width,
            ap.y,
            0,
            bp.x - width,
            bp.y,
            0,
            ap.x + width,
            ap.y,
            0,
            bp.x + width,
            bp.y,
            0,
            bp.x - width,
            bp.y,
            0,
          ],
          i * 18,
        );
      }
      trail.geometry.attributes.position.needsUpdate = true;
    });
    this.shields.forEach((mesh, i) => {
      const p =
        state?.players[i === 0 ? this.slot : this.slot === "P1" ? "P2" : "P1"];
      const barrier = !!p && p.barrierUntilMs > now;
      mesh.visible = !!p && (barrier || p.shieldUntilMs > now) && state?.phase === "playing";
      mesh.position.copy(point(0.5, i === 0 ? 0.55 : 0.46));
      (mesh.material as THREE.ShaderMaterial).uniforms.color.value.setHex(barrier ? PATRONUS_COLOR : SHIELD_COLOR);
      (mesh.material as THREE.ShaderMaterial).uniforms.time.value = this.reduce
        ? 0
        : now / 1000;
    });
    for (const r of this.ripples) {
      const age = (now - r.at) / 500;
      r.mesh.visible = age >= 0 && age < 1 && !this.reduce;
      const m = r.mesh.material as THREE.ShaderMaterial;
      m.uniforms.time.value = age;
      m.uniforms.opacity.value = 1 - age;
    }
    this.bursts = this.bursts.filter((b) => now - b.at < 450);
    let count = 0;
    const limit = low ? 32 : 96;
    if (!this.reduce)
      for (const burst of this.bursts)
        for (let i = 0; i < 24 && count < limit; i++) {
          const age = (now - burst.at) / 450;
          if (age < 0) continue;
          const angle = i * 2.39996 + burst.seed;
          const distance = age * (0.08 + (i % 5) * 0.01);
          const p = point(
            burst.x + Math.cos(angle) * distance,
            burst.y + Math.sin(angle) * distance + age * age * 0.035,
          );
          this.particlePositions.set([p.x, p.y, 0], count++ * 3);
        }
    this.particles.geometry.setDrawRange(0, count);
    this.particles.geometry.attributes.position.needsUpdate = true;
    this.particles.visible = count > 0;
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
