// Vagues de l'écran de connexion : plusieurs couches de houle dessinées sur un canevas.
// Chaque couche additionne trois ondulations (houle longue, vague moyenne, clapot) qui avancent à des vitesses
// différentes ; les couches du fond sont plus hautes, plus calmes et plus pâles, celles de devant plus amples.
// Les couleurs suivent le thème (couleur d'accent, clair ou sombre). Mouvement réduit : une image fixe.

const LAYERS = 5;

function themeColors() {
  const css = getComputedStyle(document.documentElement);
  const rgb = (name, fallback) => (css.getPropertyValue(name).trim() || fallback).split(',').map((v) => Number(v.trim()));
  const light = (document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')) === 'light';
  return { a: rgb('--accent-rgb', '255,107,53'), b: rgb('--accent-2-rgb', '255,61,119'), light };
}

const mix = (c1, c2, t) => c1.map((v, i) => Math.round(v + (c2[i] - v) * t));
const rgba = (c, a) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
// assombrit (thème sombre) ou éclaircit (thème clair) une couleur
const shade = (c, t, light) => c.map((v) => Math.round(light ? v + (255 - v) * t : v * (1 - t)));

export function startWaves(canvas) {
  const ctx = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let colors = themeColors();
  let w = 0;
  let h = 0;
  let frame = 0;
  const start = performance.now();
  // phases de départ différentes pour chaque couche (vagues désordonnées, comme en mer)
  const seeds = Array.from({ length: LAYERS }, (_, i) => [i * 1.7 + 0.4, i * 2.3 + 1.1, i * 0.9 + 2.2]);

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const draw = (now) => {
    const t = (now - start) / 1000;
    ctx.clearRect(0, 0, w, h);
    const scale = Math.max(0.6, Math.min(1.4, h / 900));
    for (let i = 0; i < LAYERS; i++) {
      const d = i / (LAYERS - 1); // 0 = fond, 1 = devant
      // perspective : les couches lointaines sont plus serrées, plus basses et à vagues plus courtes
      const base = h * (0.6 + 0.34 * d ** 1.45);
      const amp = (6 + 26 * d ** 1.3) * scale;
      const [p1, p2, p3] = seeds[i];
      const k1 = (2 * Math.PI) / ((w * 0.55 + 260) * (0.55 + 0.65 * d));
      const k2 = (2 * Math.PI) / ((200 + 160 * d) * scale);
      const k3 = (2 * Math.PI) / ((70 + 60 * d) * scale);
      const s = 0.35 + 0.35 * d; // les couches de devant bougent plus vite (parallaxe)
      const y = (x) =>
        base +
        amp * Math.sin(k1 * x - t * 0.55 * s + p1) +
        amp * 0.38 * Math.sin(k2 * x + t * 0.9 * s + p2) +
        amp * 0.12 * Math.sin(k3 * x - t * 1.7 * s + p3);

      // couleur : du fond (couleur secondaire, pâle) vers l'avant (couleur d'accent, plus dense)
      const color = mix(colors.b, colors.a, d);
      const top = base - amp * 1.5;
      const grad = ctx.createLinearGradient(0, top, 0, h);
      const alpha = colors.light ? 0.16 + 0.22 * d : 0.18 + 0.34 * d;
      grad.addColorStop(0, rgba(color, alpha));
      grad.addColorStop(0.45, rgba(shade(color, 0.35, colors.light), alpha * 0.9));
      grad.addColorStop(1, rgba(shade(color, 0.7, colors.light), alpha * 0.85));

      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x <= w + 4; x += 4) ctx.lineTo(x, y(x));
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // reflet sur la crête : plus marqué là où la vague monte
      ctx.beginPath();
      for (let x = 0; x <= w + 4; x += 4) {
        if (x === 0) ctx.moveTo(x, y(x));
        else ctx.lineTo(x, y(x));
      }
      const crest = ctx.createLinearGradient(0, 0, w, 0);
      const shine = colors.light ? 0.5 + 0.3 * d : 0.08 + 0.16 * d;
      crest.addColorStop(0, `rgba(255, 255, 255, ${shine * 0.4})`);
      crest.addColorStop(0.5, `rgba(255, 255, 255, ${shine})`);
      crest.addColorStop(1, `rgba(255, 255, 255, ${shine * 0.4})`);
      ctx.strokeStyle = crest;
      ctx.lineWidth = 1 + d;
      ctx.stroke();
    }
  };

  const loop = (now) => {
    if (!canvas.isConnected) return; // écran de connexion quitté
    draw(now);
    frame = requestAnimationFrame(loop);
  };

  let stop = () => {};
  const onResize = () => {
    if (!canvas.isConnected) return stop();
    resize();
    if (reduce) draw(start);
    return undefined;
  };
  const onTheme = () => {
    if (!canvas.isConnected) return stop();
    colors = themeColors();
    if (reduce) draw(start);
    return undefined;
  };
  resize();
  window.addEventListener('resize', onResize);
  window.addEventListener('astra:theme', onTheme);
  if (reduce) draw(start);
  else frame = requestAnimationFrame(loop);

  stop = () => {
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('astra:theme', onTheme);
  };
  return stop;
}
