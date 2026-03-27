import { useEffect, useRef } from 'react';

const TAU = Math.PI * 2;
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function ease(t: number) { return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3) / 2; }
function clamp(v: number, lo = 0, hi = 1) { return Math.max(lo, Math.min(hi, v)); }
function rgba(c: number[], a: number) { return `rgba(${c[0]},${c[1]},${c[2]},${Math.min(a, 1)})`; }

// Chimney red palette
const RED: number[] = [160, 21, 21];       // #A01515 muted crimson
const BRIGHT: number[] = [204, 51, 51];    // #CC3333 highlight
const DARK: number[] = [42, 8, 8];         // #2A0808 structural

interface Particle { x: number; y: number; vx: number; vy: number; life: number; size: number; }
interface Ripple { x: number; y: number; life: number; maxR: number; }

function glowDot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: number[], alpha: number, blur: number) {
  ctx.save();
  ctx.shadowBlur = blur;
  ctx.shadowColor = rgba(color, alpha * 0.8);
  ctx.fillStyle = rgba(color, alpha);
  ctx.beginPath();
  ctx.arc(x, y, Math.max(r, 0.5), 0, TAU);
  ctx.fill();
  ctx.restore();
}

/** Props for {@link NerveLogo}. */
interface NerveLogoProps {
  /** Logical size in CSS pixels. @default 28 */
  size?: number;
}

/**
 * Titan Bob animated lightning bolt logo.
 *
 * Renders a glowing lightning bolt with chimney-red pulse animations:
 * charge builds from base to tip → tip discharge → ripple → fade → repeat.
 * ~4s cycle.
 */
export default function NerveLogo({ size = 28 }: NerveLogoProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<{
    particles: Particle[];
    ripples: Ripple[];
    chargeProgress: number;
    dischargeProgress: number;
    phase: 'idle' | 'charging' | 'discharge' | 'fade';
    phaseT: number;
    rafId: number;
  } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 2;
    const PAD = 2.0;
    const pxSize = size * dpr * PAD;
    canvas.width = pxSize;
    canvas.height = pxSize;
    canvas.style.width = `${size * PAD}px`;
    canvas.style.height = `${size * PAD}px`;
    canvas.style.margin = `${-size * (PAD - 1) / 2}px`;

    const W = pxSize;
    const S = W / (size * PAD);
    const cx = W / 2;
    const cy = W / 2;

    // Lightning bolt points (normalized 0-1, then scaled)
    // Classic zigzag bolt: top-center → mid-right → mid-left → bottom-center
    const boltScale = size * 0.38 * S;
    const rawPts = [
      [0.15, -0.95],   // top-left of bolt head
      [0.50, -0.95],   // top-right of bolt head
      [0.05, -0.05],   // mid-left bend
      [0.42, -0.05],   // mid-right bend
      [-0.15, 0.95],   // bottom tip
      [-0.42, 0.95],   // bottom-left
      [-0.05, 0.08],   // upper-left
      [-0.38, 0.08],   // upper-right
    ];
    const pts = rawPts.map(([px, py]) => [cx + px * boltScale, cy + py * boltScale]);

    // Spine of the bolt for particle travel (simplified 3-point path)
    const spine = [
      [cx + 0.32 * boltScale, cy - 0.90 * boltScale],   // top
      [cx + 0.18 * boltScale, cy + 0.0 * boltScale],    // middle
      [cx - 0.08 * boltScale, cy + 0.90 * boltScale],   // tip
    ];

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const CYCLE = 4.0;

    const particles: Particle[] = [];
    const ripples: Ripple[] = [];

    stateRef.current = {
      particles, ripples,
      chargeProgress: 0,
      dischargeProgress: 0,
      phase: 'idle',
      phaseT: 0,
      rafId: 0,
    };

    function drawBoltShape(alpha: number, glowAlpha: number, glowBlur: number) {
      if (!ctx) return;
      ctx.save();
      ctx.shadowBlur = glowBlur;
      ctx.shadowColor = rgba(RED, glowAlpha);
      ctx.strokeStyle = rgba(RED, alpha * 0.6);
      ctx.fillStyle = rgba(DARK, alpha * 0.85);
      ctx.lineWidth = 1.2 * S;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    function getSpinePoint(t: number): [number, number] {
      // t in [0,1] along the spine
      if (t <= 0.5) {
        const u = t / 0.5;
        return [lerp(spine[0][0], spine[1][0], u), lerp(spine[0][1], spine[1][1], u)];
      } else {
        const u = (t - 0.5) / 0.5;
        return [lerp(spine[1][0], spine[2][0], u), lerp(spine[1][1], spine[2][1], u)];
      }
    }

    function animate(time: number) {
      if (!ctx) return;
      const t = (time / 1000) % CYCLE;
      ctx.clearRect(0, 0, W, W);

      // Phase timing
      // 0.0–0.1: idle
      // 0.1–1.5: charging (progress 0→1)
      // 1.5–2.0: hold charged
      // 2.0–2.5: discharge
      // 2.5–3.5: fade/ripple
      // 3.5–4.0: idle

      const chargeStart = 0.1, chargeEnd = 1.5;
      const dischargeStart = 2.0, dischargeEnd = 2.5;
      const fadeEnd = 3.5;

      const chargeP = clamp((t - chargeStart) / (chargeEnd - chargeStart));
      const dischargeP = clamp((t - dischargeStart) / (dischargeEnd - dischargeStart));
      const isCharged = t > chargeEnd && t < dischargeStart;
      const isFading = t > dischargeEnd && t < fadeEnd;

      // Draw static bolt structure
      const ambientGlow = 0.08 + 0.04 * Math.sin(time / 1000 * 1.5);
      drawBoltShape(0.7, ambientGlow, 6 * S);

      // Charging effect: glow travels up spine from tip to top
      if (t > chargeStart && t < dischargeStart) {
        const reach = ease(chargeP); // how far up the spine the charge has reached
        for (let seg = 0; seg < 20; seg++) {
          const segT = (seg / 20) * reach;
          const [sx, sy] = getSpinePoint(1 - segT); // 1 = tip, 0 = top
          const brightness = (1 - segT / reach) * 0.6 * chargeP;
          glowDot(ctx, sx, sy, 2.5 * S, RED, brightness, 12 * S);
        }
        // Particle emission along charging front
        if (Math.random() < 0.4 * chargeP) {
          const frontT = 1 - reach;
          const [fx, fy] = getSpinePoint(frontT);
          particles.push({
            x: fx + (Math.random() - 0.5) * 4 * S,
            y: fy + (Math.random() - 0.5) * 4 * S,
            vx: (Math.random() - 0.5) * 1.5 * S,
            vy: (Math.random() - 0.5) * 1.5 * S,
            life: 0.7 + Math.random() * 0.3,
            size: 1.5 * S + Math.random() * S,
          });
        }
      }

      // Fully charged: bolt pulses bright
      if (isCharged) {
        const pulse = 0.6 + 0.4 * Math.sin(time / 1000 * 12);
        drawBoltShape(0.0, pulse * 0.9, 18 * S);
        glowDot(ctx, spine[2][0], spine[2][1], 5 * S, BRIGHT, pulse * 0.8, 20 * S);
        if (Math.random() < 0.5) {
          const st = Math.random();
          const [sx, sy] = getSpinePoint(st);
          particles.push({
            x: sx, y: sy,
            vx: (Math.random() - 0.5) * 2 * S, vy: (Math.random() - 0.5) * 2 * S,
            life: 0.4, size: S + Math.random() * S,
          });
        }
      }

      // Discharge: bolt flares white-hot and shoots sparks from tip
      if (t > dischargeStart && t < dischargeEnd) {
        const dp = ease(dischargeP);
        drawBoltShape(0, dp * 1.0, 30 * S * dp);
        // Core white flash
        ctx.save();
        ctx.globalAlpha = dp * 0.7 * (1 - dp);
        ctx.fillStyle = rgba(BRIGHT, 1);
        ctx.shadowBlur = 25 * S;
        ctx.shadowColor = rgba(BRIGHT, 0.9);
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        // Shoot sparks from tip
        if (Math.random() < 0.7) {
          const tip = spine[2];
          const angle = Math.random() * TAU;
          const speed = (2 + Math.random() * 3) * S;
          particles.push({
            x: tip[0], y: tip[1],
            vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
            life: 0.6 + Math.random() * 0.4, size: 1.2 * S + Math.random() * S,
          });
        }
        // Ripple from tip on first discharge frame
        if (dischargeP < 0.15 && ripples.length < 3) {
          ripples.push({ x: spine[2][0], y: spine[2][1], life: 1, maxR: 18 * S });
        }
      }

      // Fade out
      if (isFading) {
        const fp = (t - dischargeEnd) / (fadeEnd - dischargeEnd);
        drawBoltShape(0, (1 - fp) * 0.4, (1 - fp) * 12 * S);
      }

      // Ripples
      for (let i = ripples.length - 1; i >= 0; i--) {
        const r = ripples[i];
        r.life -= 0.02;
        if (r.life <= 0) { ripples.splice(i, 1); continue; }
        ctx.save();
        ctx.strokeStyle = rgba(RED, r.life * 0.3);
        ctx.lineWidth = Math.max(1, 1.5 * S * r.life);
        ctx.shadowBlur = 6 * S;
        ctx.shadowColor = rgba(RED, r.life * 0.2);
        ctx.beginPath();
        ctx.arc(r.x, r.y, (1 - r.life) * r.maxR, 0, TAU);
        ctx.stroke();
        ctx.restore();
      }

      // Particles
      const MAX_PARTICLES = 150;
      if (particles.length > MAX_PARTICLES) particles.splice(0, particles.length - MAX_PARTICLES);
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.03 * S; // subtle gravity
        p.life -= 0.04;
        if (p.life <= 0) { particles.splice(i, 1); continue; }
        glowDot(ctx, p.x, p.y, p.size * p.life, RED, p.life * 0.5, 4 * S);
      }

      // Ambient tip glow (always subtle)
      glowDot(ctx, spine[2][0], spine[2][1], 2 * S, RED, ambientGlow * 0.6, 8 * S);

      if (stateRef.current) stateRef.current.rafId = requestAnimationFrame(animate);
    }

    if (prefersReducedMotion) {
      drawBoltShape(0.7, 0.15, 8 * S);
      return;
    }

    stateRef.current.rafId = requestAnimationFrame(animate);
    return () => {
      if (stateRef.current) cancelAnimationFrame(stateRef.current.rafId);
    };
  }, [size]);

  return <canvas ref={canvasRef} role="img" aria-label="Titan Bob logo" style={{ display: 'block' }} />;
}
