// Página de etiquetas: diseña, previsualiza e imprime en la HT300 a través
// del Samsung. La etiqueta se dibuja aquí a 8 puntos/mm y se manda como
// mapa de bits de 1 bit, así la vista previa es exactamente lo que sale.
'use strict';

const PMM = 8;                                  // puntos por mm (203 dpi)
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

let ESTADO = { perfiles: {} };
let PERFILES = {};
let PLANTILLAS = [];
const cacheImg = new Map();
const cacheBits = new Map();   // imagen ya tramada, por imagen + tamaño + ajustes

qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];

// sinRed = no se pudo hablar con el Samsung (red, Wi-Fi dormido, tiempo agotado).
async function api(metodo, ruta, cuerpo, maxMs = 120000) {
  const corte = new AbortController();
  const t = setTimeout(() => corte.abort(), maxMs);
  let r;
  try {
    r = await fetch(ruta, {
      method: metodo,
      headers: cuerpo ? { 'Content-Type': 'application/json' } : {},
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      signal: corte.signal,
    });
  } catch (e) {
    throw Object.assign(new Error('No hay conexión con el Samsung. Revisa que este dispositivo esté en el Wi-Fi de la tienda.'), { sinRed: true });
  } finally { clearTimeout(t); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
  return j;
}

function mensaje(el, txt, tipo) { el.textContent = txt || ''; el.className = 'msg' + (tipo ? ' ' + tipo : ''); }
const redondear = (v, paso = 0.25) => Math.round(v / paso) * paso;
const nombrePerfil = id => (PERFILES[id] || {}).nombre || id || '—';

// ─── Dibujo ─────────────────────────────────────────────────────────
function cargarImagen(src) {
  if (!cacheImg.has(src)) {
    cacheImg.set(src, new Promise((ok, mal) => {
      const im = new Image();
      im.onload = () => ok(im); im.onerror = () => mal(new Error('No se pudo leer la imagen'));
      im.src = src;
    }));
  }
  return cacheImg.get(src);
}
const precargar = pl => Promise.all(pl.elementos.filter(e => e.tipo === 'imagen' && e.src).map(e => cargarImagen(e.src)));

const RE_CAMPO = /\{([^{}]+)\}/g;
function camposDe(pl) {
  const s = new Set();
  for (const e of pl.elementos) for (const t of [e.texto, e.datos]) {
    if (typeof t === 'string') for (const m of t.matchAll(RE_CAMPO)) s.add(m[1]);
  }
  return [...s];
}
function sustituir(txt, valores, relleno) {
  return String(txt ?? '').replace(RE_CAMPO, (m, k) => (k in valores ? valores[k] : relleno ? relleno(k) : m));
}

// Imagen → 1 bit (tramado Floyd–Steinberg o umbral). Lo blanco queda transparente.
function imagenABits(im, e, W, H) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
  const r = im.width / im.height, R = W / H;
  let dw = W, dh = H;
  if (e.ajuste === 'contener') { if (r > R) dh = W / r; else dw = H * r; }
  else if (e.ajuste !== 'estirar') { if (r > R) dw = H * r; else dh = W / r; }   // cubrir
  x.drawImage(im, (W - dw) / 2, (H - dh) / 2, dw, dh);
  const d = x.getImageData(0, 0, W, H), p = d.data;
  const g = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = 0.299 * p[i * 4] + 0.587 * p[i * 4 + 1] + 0.114 * p[i * 4 + 2];
  const umbral = e.umbral ?? 128;
  for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
    const i = y * W + X, viejo = g[i], negro = viejo < umbral, err = viejo - (negro ? 0 : 255);
    let n = negro; if (e.invertir) n = !n;
    p[i * 4] = p[i * 4 + 1] = p[i * 4 + 2] = 0; p[i * 4 + 3] = n ? 255 : 0;
    if (e.tramado !== false) {
      if (X + 1 < W) g[i + 1] += err * 7 / 16;
      if (y + 1 < H) {
        if (X > 0) g[i + W - 1] += err * 3 / 16;
        g[i + W] += err * 5 / 16;
        if (X + 1 < W) g[i + W + 1] += err / 16;
      }
    }
  }
  x.putImageData(d, 0, 0);
  return c;
}

// Caja ocupada por algo dibujado en (x,y) de tamaño (w,h) y rotado `rot` grados.
function cajaRotada(x, y, w, h, rot) {
  switch (rot | 0) {
    case 90:  return { x: x - h, y, w: h, h: w };
    case 180: return { x: x - w, y: y - h, w, h };
    case 270: return { x, y: y - w, w: h, h: w };
    default:  return { x, y, w, h };
  }
}

// Dibuja la plantilla a 8 puntos/mm. Devuelve el lienzo binarizado, los
// bits empaquetados (1 = negro) y la caja de cada elemento (en puntos).
function dibujar(pl, perfil, valores, relleno) {
  const W = Math.round(perfil.ancho * PMM), H = Math.round(perfil.alto * PMM);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
  x.imageSmoothingEnabled = false;
  const cajas = [], errores = [];

  pl.elementos.forEach((e, idx) => {
    const ex = e.x * PMM, ey = e.y * PMM, color = e.blanco ? '#fff' : '#000';
    x.save();
    try {
      if (e.tipo === 'imagen') {
        const w = Math.max(1, Math.round(e.w * PMM)), h = Math.max(1, Math.round(e.h * PMM));
        const im = e.src && cacheImg.get(e.src) && cacheImg.get(e.src).ya;
        if (im) {
          // El tramado es lo más pesado: se recalcula solo si cambia la imagen o su tamaño.
          const clave = [e.src.length, e.src.slice(-40), w, h, e.ajuste, e.umbral, e.tramado, e.invertir].join('|');
          if (!cacheBits.has(clave)) {
            if (cacheBits.size > 30) cacheBits.delete(cacheBits.keys().next().value);
            cacheBits.set(clave, imagenABits(im, e, w, h));
          }
          x.drawImage(cacheBits.get(clave), Math.round(ex), Math.round(ey));
        }
        else { x.strokeStyle = '#000'; x.setLineDash([8, 8]); x.strokeRect(ex, ey, w, h); }
        cajas[idx] = { x: ex, y: ey, w, h };
      } else if (e.tipo === 'texto') {
        const px = Math.max(4, e.tam * PMM);
        x.font = `${e.cursiva ? 'italic ' : ''}${e.negrita ? 'bold ' : ''}${px}px ${e.fuente || 'sans-serif'}`;
        x.fillStyle = color; x.textBaseline = 'top';
        const anchoCaja = (e.w || 0) * PMM, lh = px * (e.interlineado || 1.15);
        // Ancho libre: se parte en líneas solo si llegaría al borde de la
        // etiqueta (con 1,5 mm de margen), en lugar de salir cortado.
        const limite = anchoCaja || ((e.rot | 0) ? 0 : Math.max(px, W - ex - 1.5 * PMM));
        const lineas = [];
        for (const parrafo of sustituir(e.texto, valores, relleno).split('\n')) {
          if (!limite || (!anchoCaja && x.measureText(parrafo).width <= limite)) { lineas.push(parrafo); continue; }
          let actual = '';
          for (const pal of parrafo.split(' ')) {
            const prueba = actual ? actual + ' ' + pal : pal;
            if (actual && x.measureText(prueba).width > limite) { lineas.push(actual); actual = pal; } else actual = prueba;
          }
          lineas.push(actual);
        }
        const wReal = anchoCaja || Math.max(1, ...lineas.map(l => x.measureText(l).width));
        x.translate(ex, ey); x.rotate((e.rot | 0) * Math.PI / 180);
        x.textAlign = e.alinear || 'left';
        const ax = e.alinear === 'center' ? wReal / 2 : e.alinear === 'right' ? wReal : 0;
        lineas.forEach((l, i) => x.fillText(l, ax, i * lh));
        cajas[idx] = cajaRotada(ex, ey, wReal, lineas.length * lh, e.rot);
      } else if (e.tipo === 'precio') {
        // Precio: enteros grandes y decimales pequeños arriba (como potencia).
        // Se toma el último número del texto: "S/ 12.50 c/u" → "S/ 12" ⁵⁰ " c/u".
        // De cada campo solo se usa el número ("S/ 12.50" del Excel → "12.50"):
        // el símbolo va en el diseño, así no sale "S/ S/".
        const soloNumero = v => { const n = String(v).match(/\d[\d,]*(?:\.\d+)?/g); return n ? n[n.length - 1] : v; };
        const vals = Object.fromEntries(Object.entries(valores).map(([k, v]) => [k, k === '#' ? v : soloNumero(v)]));
        const s = sustituir(e.texto, vals, relleno).replace(/\s*\n\s*/g, ' ');
        const px = Math.max(4, e.tam * PMM), pxDec = Math.max(4, px * (e.decimales || 0.5));
        const fuente = p => `${e.cursiva ? 'italic ' : ''}${e.negrita ? 'bold ' : ''}${p}px ${e.fuente || 'sans-serif'}`;
        const nums = [...s.matchAll(/\d[\d,]*(?:\.\d+)?/g)], m = nums[nums.length - 1];
        let antes = s, dec = '', despues = '';
        if (m) {
          const [ent, d = ''] = m[0].split('.');
          antes = s.slice(0, m.index) + ent;
          despues = s.slice(m.index + m[0].length);
          dec = e.dosDecimales === false ? d : (d + '00').slice(0, Math.max(2, d.length));
          if (dec && e.punto) dec = '.' + dec;
        }
        x.fillStyle = color; x.textBaseline = 'alphabetic'; x.textAlign = 'left';
        x.font = fuente(px);
        const altoG = x.measureText('0').actualBoundingBoxAscent || px * 0.72;
        const wAntes = x.measureText(antes).width, wDespues = x.measureText(despues).width;
        const bajo = Math.max(0, ...[antes, despues].map(t => t ? x.measureText(t).actualBoundingBoxDescent || 0 : 0));
        x.font = fuente(pxDec);
        const altoP = x.measureText('0').actualBoundingBoxAscent || pxDec * 0.72, wDec = x.measureText(dec).width;
        const wTotal = wAntes + wDec + wDespues, anchoCaja = (e.w || 0) * PMM, wReal = Math.max(1, anchoCaja || wTotal);
        const x0 = e.alinear === 'center' ? (wReal - wTotal) / 2 : e.alinear === 'right' ? wReal - wTotal : 0;
        x.translate(ex, ey); x.rotate((e.rot | 0) * Math.PI / 180);
        // La parte de arriba de los decimales queda a la altura de la de los enteros.
        x.font = fuente(px);
        x.fillText(antes, x0, altoG);
        x.fillText(despues, x0 + wAntes + wDec, altoG);
        x.font = fuente(pxDec);
        x.fillText(dec, x0 + wAntes, altoP);
        cajas[idx] = cajaRotada(ex, ey, wReal, altoG + bajo, e.rot);
      } else if (e.tipo === 'barras') {
        const t = document.createElement('canvas');
        const datos = sustituir(e.datos, valores, relleno);
        try {
          JsBarcode(t, datos, {
            format: e.formato || 'CODE128', width: Math.max(1, e.modulo | 0 || 2), height: Math.round(e.h * PMM),
            displayValue: e.conTexto !== false, fontSize: Math.round((e.tamTexto || 3) * PMM), font: 'monospace',
            textMargin: 2, margin: 0, background: '#ffffff', lineColor: '#000000',
          });
          x.translate(ex, ey); x.rotate((e.rot | 0) * Math.PI / 180);
          x.drawImage(t, 0, 0);
          cajas[idx] = cajaRotada(ex, ey, t.width, t.height, e.rot);
        } catch (er) {
          errores.push(`Código "${datos}": ${typeof er === 'string' ? er : 'no válido para ' + (e.formato || 'CODE128')}`);
          const w = 40 * PMM, h = e.h * PMM;
          x.strokeStyle = '#000'; x.lineWidth = 3; x.strokeRect(ex, ey, w, h);
          x.beginPath(); x.moveTo(ex, ey); x.lineTo(ex + w, ey + h); x.moveTo(ex + w, ey); x.lineTo(ex, ey + h); x.stroke();
          cajas[idx] = { x: ex, y: ey, w, h };
        }
      } else if (e.tipo === 'qr') {
        const q = qrcode(0, e.ecc || 'M');
        q.addData(sustituir(e.datos, valores, relleno) || ' ');
        q.make();
        const n = q.getModuleCount(), m = Math.max(1, Math.floor((e.tam * PMM) / n));
        x.fillStyle = color;
        for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) x.fillRect(Math.round(ex) + k * m, Math.round(ey) + r * m, m, m);
        cajas[idx] = { x: ex, y: ey, w: n * m, h: n * m };
      } else if (e.tipo === 'recuadro') {
        const w = Math.round(e.w * PMM), h = Math.round(e.h * PMM), g = Math.max(1, Math.round((e.grosor || 0.5) * PMM));
        const X = Math.round(ex), Y = Math.round(ey);
        x.fillStyle = color;
        if (e.relleno) x.fillRect(X, Y, w, h);
        else { x.fillRect(X, Y, w, g); x.fillRect(X, Y + h - g, w, g); x.fillRect(X, Y, g, h); x.fillRect(X + w - g, Y, g, h); }
        cajas[idx] = { x: X, y: Y, w, h };
      }
    } finally { x.restore(); }
  });

  // Binarizar: lo que no es claro se imprime.
  const d = x.getImageData(0, 0, W, H), p = d.data, bpf = Math.ceil(W / 8);
  const bits = new Uint8Array(bpf * H);
  for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
    const i = (y * W + X) * 4, negro = (0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]) < 128;
    p[i] = p[i + 1] = p[i + 2] = negro ? 0 : 255; p[i + 3] = 255;
    if (negro) bits[y * bpf + (X >> 3)] |= 0x80 >> (X & 7);
  }
  x.putImageData(d, 0, 0);
  return { lienzo: c, bits, W, H, cajas, errores };
}

// Las imágenes se cargan una vez; `ya` marca las listas para dibujar.
async function asegurarImagenes(pl) {
  for (const e of pl.elementos) if (e.tipo === 'imagen' && e.src) {
    const im = await cargarImagen(e.src).catch(() => null);
    if (im) cacheImg.get(e.src).ya = im;
  }
}

function aBase64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

// Manija para cambiar el tamaño: cuadrado en la esquina inferior derecha.
const ladoManija = W => Math.max(28, Math.round(W / 16));
function manija(c, W) { const m = ladoManija(W); return { x: c.x + c.w - m / 2, y: c.y + c.h - m / 2, w: m, h: m }; }

function mostrar(canvasVisible, res, seleccion, sinManija) {
  if (canvasVisible.width !== res.W) canvasVisible.width = res.W;
  if (canvasVisible.height !== res.H) canvasVisible.height = res.H;
  const x = canvasVisible.getContext('2d');
  x.drawImage(res.lienzo, 0, 0);
  if (seleccion) {
    x.strokeStyle = '#1f6feb'; x.lineWidth = Math.max(2, res.W / 300); x.setLineDash([10, 6]);
    x.strokeRect(seleccion.x - 2, seleccion.y - 2, seleccion.w + 4, seleccion.h + 4);
    if (!sinManija) {
      const m = manija(seleccion, res.W);
      x.setLineDash([]); x.fillStyle = '#1f6feb'; x.fillRect(m.x, m.y, m.w, m.h);
      x.strokeStyle = '#fff'; x.lineWidth = 3; x.strokeRect(m.x, m.y, m.w, m.h);
    }
  }
  // Líneas guía del imán (solo mientras se arrastra).
  if (canvasVisible.id === 'dis-lienzo' && GUIAS.length) {
    x.setLineDash([]); x.strokeStyle = '#e5197a'; x.lineWidth = Math.max(2, res.W / 400);
    x.beginPath();
    for (const g of GUIAS) {
      if (g.x != null) { x.moveTo(g.x, 0); x.lineTo(g.x, res.H); } else { x.moveTo(0, g.y); x.lineTo(res.W, g.y); }
    }
    x.stroke();
  }
}

// ─── Alineación ─────────────────────────────────────────────────────
let GUIAS = [];                                   // [{x}|{y}] en puntos
const IMAN_PTS = 1.5 * PMM;                       // distancia a la que "se pega"
let MARGEN_MM = (() => { try { return +localStorage.getItem('etiquetas.margen') || 2; } catch (e) { return 2; } })();

// Líneas de referencia de la etiqueta: bordes, márgenes y centro.
function lineasEtiqueta(W, H) {
  const m = MARGEN_MM * PMM;
  return { xs: [0, m, W / 2, W - m, W], ys: [0, m, H / 2, H - m, H] };
}

// Mueve el elemento para que su caja quede en `donde` (izq|centro|der|arriba|medio|abajo|centrar).
function alinear(donde) {
  const e = PL.elementos[SEL], c = ULTIMO && ULTIMO.cajas[SEL];
  if (!e || !c || e.bloqueado) return;
  const W = ULTIMO.W, H = ULTIMO.H, m = MARGEN_MM * PMM;
  let dx = 0, dy = 0;
  if (donde === 'izq') dx = m - c.x;
  if (donde === 'der') dx = (W - m) - (c.x + c.w);
  if (donde === 'centro' || donde === 'centrar') dx = W / 2 - (c.x + c.w / 2);
  if (donde === 'arriba') dy = m - c.y;
  if (donde === 'abajo') dy = (H - m) - (c.y + c.h);
  if (donde === 'medio' || donde === 'centrar') dy = H / 2 - (c.y + c.h / 2);
  e.x = Math.round((e.x + dx / PMM) * 8) / 8;     // al punto más cercano (0,125 mm)
  e.y = Math.round((e.y + dy / PMM) * 8) / 8;
  renderEditor(); pintarProps(); registrar();
}

// Imán: ajusta (dx, dy) en puntos para que algún borde o el centro de la
// caja caiga sobre una línea de la etiqueta. Deja las guías para dibujar.
function iman(c, dx, dy, W, H) {
  const { xs, ys } = lineasEtiqueta(W, H);
  GUIAS = [];
  const probar = (pos, lineas) => {
    let mejor = null;
    for (const [i, p] of pos.entries()) for (const l of lineas) {
      const d = l - p;
      if (Math.abs(d) <= IMAN_PTS && (!mejor || Math.abs(d) < Math.abs(mejor.d))) mejor = { d, l, i };
    }
    return mejor;
  };
  const nx = c.x + dx, ny = c.y + dy;
  const sx = probar([nx, nx + c.w / 2, nx + c.w], xs);
  const sy = probar([ny, ny + c.h / 2, ny + c.h], ys);
  if (sx) { dx += sx.d; GUIAS.push({ x: sx.l }); }
  if (sy) { dy += sy.d; GUIAS.push({ y: sy.l }); }
  return { dx, dy };
}

// ─── Estado ─────────────────────────────────────────────────────────
let fallosSeguidos = 0;
async function refrescarEstado() {
  const chip = $('#estado');
  try {
    ESTADO = await api('GET', '/api/estado', null, 15000);
    fallosSeguidos = 0;
    PERFILES = ESTADO.perfiles || {};
    const e = ESTADO.estado, rollo = ESTADO.perfil ? nombrePerfil(ESTADO.perfil) : 'rollo sin elegir';
    if (!ESTADO.conectada) { chip.textContent = 'Impresora sin conexión (el Samsung reintenta solo)'; chip.className = 'chip mal'; }
    else if (ESTADO.ocupada) { chip.textContent = 'Trabajando… (imprimiendo o calibrando)'; chip.className = 'chip ocupada'; }
    else if (!e) { chip.textContent = 'La impresora no contesta'; chip.className = 'chip mal'; chip.title = ESTADO.errorImpresora || ''; }
    else if (e.cabezalAbierto) { chip.textContent = 'Cabezal abierto'; chip.className = 'chip mal'; }
    else if (e.calibrando) { chip.textContent = 'Calibrando…'; chip.className = 'chip ocupada'; }
    else if (e.listo) { chip.textContent = `Lista · ${rollo}`; chip.className = 'chip ok'; }
    else { chip.textContent = `Ocupada (${e.crudo})`; chip.className = 'chip ocupada'; }
  } catch (er) {
    // Un fallo suelto (p. ej. al volver de otra app) no se muestra: se reintenta enseguida.
    if (++fallosSeguidos < 2) { setTimeout(refrescarEstado, 1500); return; }
    chip.textContent = er.sinRed ? 'Sin conexión con el Samsung' : er.message; chip.className = 'chip mal';
  }
  avisoImprimir();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refrescarEstado(); });

// ─── Pestañas ───────────────────────────────────────────────────────
$$('nav button').forEach(b => b.onclick = () => {
  $$('nav button').forEach(o => o.classList.toggle('activo', o === b));
  $$('main > section').forEach(s => s.classList.toggle('oculto', s.id !== 'tab-' + b.dataset.tab));
  if (b.dataset.tab === 'rollos') pintarRollos();
  if (b.dataset.tab === 'disenar') { prepararEditor(); renderEditor(); }
  if (b.dataset.tab === 'imprimir') {
    if ($('#imp-plantilla').value !== (IMP && IMP.id)) elegirParaImprimir(); else renderImprimir();
  }
});

async function cargarListaPlantillas() {
  PLANTILLAS = await api('GET', '/api/plantillas');
  for (const sel of [$('#imp-plantilla'), $('#dis-plantilla')]) {
    const actual = sel.value;
    sel.innerHTML = (sel.id === 'dis-plantilla' ? '<option value="">(nueva)</option>' : '') +
      PLANTILLAS.map(p => `<option value="${p.id}">${p.base ? '★ ' : ''}${escapar(p.nombre || p.id)} · ${escapar(nombrePerfil(p.perfil))}</option>`).join('');
    if ([...sel.options].some(o => o.value === actual)) sel.value = actual;
  }
}
const escapar = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ─── Imprimir ───────────────────────────────────────────────────────
let IMP = null;   // plantilla elegida

async function elegirParaImprimir() {
  const id = $('#imp-plantilla').value;
  IMP = null; $('#imp-campos').innerHTML = ''; pintarLista();
  if (!id) { mensaje($('#imp-msg'), 'Todavía no hay plantillas: créalas en "Diseñar".'); return; }
  mensaje($('#imp-msg'), 'Cargando plantilla…');
  try { IMP = await api('GET', '/api/plantilla?id=' + id); }
  catch (er) { return mensaje($('#imp-msg'), er.message, 'mal'); }
  IMP.id = id;
  await asegurarImagenes(IMP);
  pintarCamposImp();
  $('#imp-num-caja').classList.toggle('oculto', !camposDe(IMP).includes('#'));
  mensaje($('#imp-msg'), '');
  renderImprimir();
}

// Campos a mano. Los que vienen de una columna de la lista se muestran
// bloqueados con el valor de la fila que se está viendo.
const MANUAL = {};
function pintarCamposImp() {
  const campos = IMP ? camposDe(IMP).filter(c => c !== '#') : [];
  const deLista = LISTA ? columnasLista().campos : {};
  $('#imp-campos').innerHTML = campos.map(c => {
    if (c in deLista) return `<label>${escapar(c)} <small>· columna "${escapar(LISTA.titulos[deLista[c]])}"</small>
      <input data-campo="${escapar(c)}" data-lista="1" disabled value="${escapar(celdaLista(LISTA.vista, deLista[c]))}"></label>`;
    const v = c in MANUAL ? MANUAL[c] : (IMP.valores || {})[c] || '';
    return `<label>${escapar(c)} <input data-campo="${escapar(c)}" value="${escapar(v)}"></label>`;
  }).join('');
  $$('#imp-campos input:not([data-lista])').forEach(i => i.oninput = () => { MANUAL[i.dataset.campo] = i.value; renderImprimir(); });
  pintarLista();
}

// `fila`: índice en LISTA.filas cuyos datos llenan los campos con columna.
function valoresImprimir(numero, fila) {
  const v = {};
  $$('#imp-campos input').forEach(i => v[i.dataset.campo] = i.value);
  if (LISTA) {
    const f = fila ?? LISTA.vista;
    for (const [c, k] of Object.entries(columnasLista().campos)) v[c] = celdaLista(f, k);
  }
  v['#'] = String(numero ?? (+$('#imp-num').value || 1));
  return v;
}

// ─── Lista de Excel: una etiqueta por fila ──────────────────────────
// LISTA = { hojas, hoja, titulos, filas, vista }. La primera fila de la hoja
// son los títulos; cada columna llena el {campo} del mismo nombre.
let LISTA = null;
const normalizar = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const celdaLista = (f, k) => String((LISTA.filas[f] || [])[k] ?? '');

function columnasLista() {
  const porTitulo = {};
  LISTA.titulos.forEach((t, k) => { const n = normalizar(t); if (n && !(n in porTitulo)) porTitulo[n] = k; });
  const campos = {}, faltan = [];
  const lista = IMP ? camposDe(IMP).filter(c => c !== '#') : [];
  for (const c of lista) { const k = porTitulo[normalizar(c)]; if (k === undefined) faltan.push(c); else campos[c] = k; }
  // Columna de cantidad por fila, si la plantilla no tiene un campo con ese nombre.
  const nombresCampos = new Set(lista.map(normalizar));
  const cantidad = ['copias', 'cantidad'].filter(n => !nombresCampos.has(n)).map(n => porTitulo[n]).find(k => k !== undefined);
  return { campos, faltan, cantidad };
}

function usarHoja(i) {
  const h = LISTA.hojas[i], filas = h.filas.map(f => f.map(c => String(c ?? '')));
  const ini = filas.findIndex(f => f.some(c => c.trim()));
  LISTA.hoja = i;
  LISTA.titulos = ini < 0 ? [] : filas[ini].map(c => c.trim());
  LISTA.filas = ini < 0 ? [] : filas.slice(ini + 1).filter(f => f.some(c => c.trim()));
  LISTA.vista = 0;
  $('#xl-desde').value = 1;
  $('#xl-hasta').value = Math.max(1, LISTA.filas.length);
  pintarCamposImp();
  renderImprimir();
}

function cargarLista(hojas) {
  LISTA = { hojas };
  $('#xl-hoja').innerHTML = hojas.map((h, i) => `<option value="${i}">${escapar(h.nombre)}</option>`).join('');
  $('#xl-hoja-caja').classList.toggle('oculto', hojas.length < 2);
  // Se abre la primera hoja que tenga datos.
  const i = Math.max(0, hojas.findIndex(h => h.filas.some(f => f.some(c => String(c ?? '').trim()))));
  $('#xl-hoja').value = i;
  usarHoja(i);
}

function quitarLista() {
  LISTA = null;
  $('#xl-pegar').value = '';
  $('#xl-pegar').classList.add('oculto');
  $('#xl-archivo').value = '';
  pintarCamposImp();
  renderImprimir();
}

function pintarLista() {
  const conCampos = !!IMP && camposDe(IMP).some(c => c !== '#');
  $('#xl').classList.toggle('oculto', !conCampos && !LISTA);
  $('#xl-info').classList.toggle('oculto', !LISTA);
  $('#imp-copias-txt').textContent = 'Copias';
  if (!LISTA) return;
  const { campos, faltan, cantidad } = columnasLista();
  const n = LISTA.filas.length, usadas = Object.keys(campos).length;
  const partes = [`${n} fila(s) con datos.`];
  if (IMP) partes.push(usadas ? `Columnas usadas: ${Object.keys(campos).map(c => LISTA.titulos[campos[c]]).join(', ')}.` : 'Ninguna columna coincide con los campos de esta plantilla: revisa la fila de títulos.');
  if (faltan.length) partes.push(`Sin columna (se llenan a mano, igual en todas): ${faltan.join(', ')}.`);
  if (cantidad !== undefined) partes.push(`La columna "${LISTA.titulos[cantidad]}" indica cuántas copias de cada fila.`);
  $('#xl-resumen').textContent = partes.join(' ');
  $('#xl-fila').textContent = n ? `Fila ${LISTA.vista + 1} de ${n}` : 'Sin filas';
  $('#xl-ant').disabled = LISTA.vista <= 0;
  $('#xl-sig').disabled = LISTA.vista >= n - 1;
  if (cantidad !== undefined) $('#imp-copias-txt').textContent = 'Copias (filas sin cantidad)';
}

function verFila(i) {
  if (!LISTA) return;
  LISTA.vista = Math.min(Math.max(0, i), Math.max(0, LISTA.filas.length - 1));
  pintarCamposImp();
  renderImprimir();
}

$('#xl-pegar-btn').onclick = () => { const t = $('#xl-pegar'); t.classList.remove('oculto'); t.focus(); };
$('#xl-pegar').oninput = () => {
  const t = $('#xl-pegar').value;
  if (!t.trim()) return;
  cargarLista([{ nombre: 'Pegado', filas: Excel.leerTexto(t) }]);
};
$('#xl-abrir').onclick = () => $('#xl-archivo').click();
$('#xl-archivo').onchange = async () => {
  const f = $('#xl-archivo').files[0];
  if (!f) return;
  mensaje($('#imp-msg'), `Leyendo ${f.name}…`);
  try {
    cargarLista(await Excel.leerArchivo(f));
    $('#xl-pegar').classList.add('oculto');
    mensaje($('#imp-msg'), '');
  } catch (er) { mensaje($('#imp-msg'), er.message, 'mal'); }
  $('#xl-archivo').value = '';
};
$('#xl-hoja').onchange = () => usarHoja(+$('#xl-hoja').value);
$('#xl-ant').onclick = () => verFila(LISTA.vista - 1);
$('#xl-sig').onclick = () => verFila(LISTA.vista + 1);
$('#xl-quitar').onclick = quitarLista;

function avisoImprimir() {
  const av = $('#imp-aviso');
  if (!IMP) return av.classList.add('oculto');
  const otro = ESTADO.perfil && IMP.perfil !== ESTADO.perfil;
  av.classList.toggle('oculto', !otro);
  if (otro) av.textContent = `Esta plantilla es para el rollo "${nombrePerfil(IMP.perfil)}" y está cargado "${nombrePerfil(ESTADO.perfil)}". Cambia el rollo en la pestaña Rollos.`;
}

function renderImprimir() {
  if (!IMP || !PERFILES[IMP.perfil]) return;
  const r = dibujar(IMP, PERFILES[IMP.perfil], valoresImprimir());
  mostrar($('#imp-vista'), r);
  if (r.errores.length) mensaje($('#imp-msg'), r.errores.join(' · '), 'mal');
  avisoImprimir();
}

$('#imp-plantilla').onchange = elegirParaImprimir;
$('#imp-num').oninput = renderImprimir;
$('#imp-boton').onclick = async () => {
  if (!IMP) {
    if ($('#imp-plantilla').value) await elegirParaImprimir();
    if (!IMP) return mensaje($('#imp-msg'), 'Elige una plantilla.', 'mal');
  }
  const perfil = PERFILES[IMP.perfil], copias = Math.max(1, +$('#imp-copias').value || 1);
  if (!perfil) return mensaje($('#imp-msg'), `La plantilla usa el rollo "${IMP.perfil}", que ya no existe.`, 'mal');
  const numerada = camposDe(IMP).includes('#'), desde = +$('#imp-num').value || 1;

  // Sin lista: una sola fila "virtual" con lo escrito a mano.
  let filas = [{ fila: undefined, copias }];
  if (LISTA) {
    const { campos, cantidad } = columnasLista();
    const n = LISTA.filas.length;
    if (!n) return mensaje($('#imp-msg'), 'La lista no tiene filas con datos.', 'mal');
    if (!Object.keys(campos).length) return mensaje($('#imp-msg'), 'Ninguna columna de la lista coincide con los campos de la plantilla.', 'mal');
    const a = Math.max(1, +$('#xl-desde').value || 1), b = Math.min(n, +$('#xl-hasta').value || n);
    if (a > b) return mensaje($('#imp-msg'), `Revisa las filas: "desde" (${a}) es mayor que "hasta" (${b}).`, 'mal');
    filas = [];
    for (let f = a - 1; f < b; f++) {
      let c = copias;
      if (cantidad !== undefined && celdaLista(f, cantidad).trim() !== '') {
        c = Math.round(+celdaLista(f, cantidad).replace(',', '.'));
        if (!(c >= 0) || c > 500) return mensaje($('#imp-msg'), `Fila ${f + 1}: la cantidad "${celdaLista(f, cantidad)}" no es válida (0 a 500).`, 'mal');
      }
      if (c > 0) filas.push({ fila: f, copias: c });
    }
    const total = filas.reduce((s, t) => s + t.copias, 0);
    if (!total) return mensaje($('#imp-msg'), 'Todas las filas elegidas tienen cantidad 0.', 'mal');
    if (!confirm(`Se imprimirán ${total} etiqueta(s) de ${filas.length} fila(s) (filas ${a} a ${b}) en "${nombrePerfil(IMP.perfil)}". ¿Continuar?`)) return;
  }

  // Con {#} cada copia es distinta: un trabajo por copia.
  const tandas = [];
  let num = desde;
  for (const t of filas) {
    if (numerada) for (let i = 0; i < t.copias; i++) tandas.push({ fila: t.fila, n: num++, copias: 1 });
    else tandas.push({ fila: t.fila, n: num, copias: t.copias });
  }

  const boton = $('#imp-boton'), detener = $('#imp-detener');
  boton.disabled = true;
  let enviadas = 0, parar = false;
  try {
    // Primero se dibuja todo: si alguna fila tiene un código inválido no sale nada.
    mensaje($('#imp-msg'), LISTA ? 'Revisando las filas…' : 'Enviando…');
    const malas = [];
    for (const [i, t] of tandas.entries()) {
      const r = dibujar(IMP, perfil, valoresImprimir(t.n, t.fila));
      if (r.errores.length) malas.push((t.fila !== undefined ? `Fila ${t.fila + 1}: ` : '') + r.errores.join(' · '));
      if (malas.length >= 5) break;
      if (LISTA && i % 25 === 24) await new Promise(ok => setTimeout(ok));
    }
    if (malas.length) throw new Error(malas.join(' | ') + (LISTA ? ' — No se imprimió nada.' : ''));

    detener.classList.toggle('oculto', tandas.length < 2);
    detener.onclick = () => { parar = true; detener.disabled = true; };
    detener.disabled = false;
    for (const [i, t] of tandas.entries()) {
      if (parar) break;
      const r = dibujar(IMP, perfil, valoresImprimir(t.n, t.fila));
      if (tandas.length > 1) mensaje($('#imp-msg'), `Enviando ${i + 1} de ${tandas.length}${t.fila !== undefined ? ` (fila ${t.fila + 1})` : ''}…`);
      if (t.fila !== undefined) verFila(t.fila);
      await api('POST', '/api/imprimir', { perfil: IMP.perfil, nombre: IMP.nombre, ancho: r.W, alto: r.H, bits: aBase64(r.bits), copias: t.copias });
      enviadas += t.copias;
      if (numerada) $('#imp-num').value = t.n + 1;
    }
    mensaje($('#imp-msg'), parar ? `Detenido: se enviaron ${enviadas} etiqueta(s).` : `Listo: ${enviadas} etiqueta(s) enviadas.`, parar ? '' : 'ok');
  } catch (er) {
    mensaje($('#imp-msg'), er.message + (enviadas ? ` (ya se habían enviado ${enviadas} etiqueta(s))` : ''), 'mal');
  }
  detener.classList.add('oculto');
  boton.disabled = false;
  renderImprimir();
};

// ─── Diseñar ────────────────────────────────────────────────────────
let PL = nuevaPlantilla();
let SEL = -1;
let ULTIMO = null;   // último dibujo (para tocar/arrastrar)
let BASE_GUARDADA = false;    // la plantilla abierta está guardada como base
let EDITAR_ORIGINAL = false;  // se pidió modificar esa base en lugar de crear una nueva

function nuevaPlantilla() {
  return { nombre: '', perfil: ESTADO.perfil || Object.keys(PERFILES)[0] || 'trans', elementos: [] };
}

const NUEVOS = {
  texto:    () => ({ tipo: 'texto', x: 5, y: 5, texto: 'Texto', tam: 6, fuente: 'sans-serif', negrita: true, alinear: 'left', w: 0, rot: 0 }),
  precio:   () => ({ tipo: 'precio', x: 5, y: 5, texto: 'S/ {precio}', tam: 12, decimales: 0.5, punto: false, dosDecimales: true, fuente: 'sans-serif', negrita: true, alinear: 'left', w: 0, rot: 0 }),
  imagen:   () => { const p = PERFILES[PL.perfil]; return { tipo: 'imagen', x: 0, y: 0, w: p.ancho, h: p.alto, ajuste: 'contener', tramado: true, umbral: 128 }; },
  barras:   () => ({ tipo: 'barras', x: 5, y: 20, datos: '{codigo}', formato: 'CODE128', h: 12, modulo: 2, conTexto: true, tamTexto: 3, rot: 0 }),
  qr:       () => ({ tipo: 'qr', x: 5, y: 40, datos: 'https://', tam: 25, ecc: 'M' }),
  recuadro: () => { const p = PERFILES[PL.perfil]; return { tipo: 'recuadro', x: 2, y: 2, w: p.ancho - 4, h: p.alto - 4, grosor: 0.5, relleno: false }; },
};
const NOMBRES = { texto: 'Texto', precio: 'Precio', imagen: 'Imagen', barras: 'Código de barras', qr: 'QR', recuadro: 'Recuadro' };

// Campos editables por tipo: [clave, etiqueta, tipo, opciones]
const PROPS = {
  texto: [['texto', 'Texto', 'area'], ['x', 'X (mm)', 'num'], ['y', 'Y (mm)', 'num'], ['tam', 'Alto letra (mm)', 'num'],
    ['w', 'Ancho de caja (mm, 0 = libre)', 'num'], ['fuente', 'Fuente', 'sel', ['sans-serif', 'serif', 'monospace', 'Arial', 'Arial Black', 'Georgia', 'Impact', 'Courier New', 'Verdana']],
    ['alinear', 'Alineación', 'sel', ['left', 'center', 'right']], ['rot', 'Rotación', 'sel', [0, 90, 180, 270]],
    ['interlineado', 'Interlineado', 'num'], ['negrita', 'Negrita', 'bool'], ['cursiva', 'Cursiva', 'bool'], ['blanco', 'Blanco (sobre fondo negro)', 'bool']],
  precio: [['texto', 'Precio (ej. S/ {precio})', 'texto'], ['x', 'X (mm)', 'num'], ['y', 'Y (mm)', 'num'], ['tam', 'Alto letra (mm)', 'num'],
    ['decimales', 'Tamaño de los decimales (0,3 a 0,8 del alto)', 'num'],
    ['w', 'Ancho de caja (mm, 0 = libre)', 'num'], ['fuente', 'Fuente', 'sel', ['sans-serif', 'serif', 'monospace', 'Arial', 'Arial Black', 'Georgia', 'Impact', 'Courier New', 'Verdana']],
    ['alinear', 'Alineación', 'sel', ['left', 'center', 'right']], ['rot', 'Rotación', 'sel', [0, 90, 180, 270]],
    ['dosDecimales', 'Siempre 2 decimales (12 → 12⁰⁰)', 'bool'], ['punto', 'Mostrar el punto antes de los decimales', 'bool'],
    ['negrita', 'Negrita', 'bool'], ['cursiva', 'Cursiva', 'bool'], ['blanco', 'Blanco (sobre fondo negro)', 'bool']],
  imagen: [['src', 'Cambiar imagen', 'archivo'], ['x', 'X (mm)', 'num'], ['y', 'Y (mm)', 'num'], ['w', 'Ancho (mm)', 'num'], ['h', 'Alto (mm)', 'num'],
    ['ajuste', 'Ajuste', 'sel', ['contener', 'cubrir', 'estirar']], ['umbral', 'Umbral (0–255)', 'num'],
    ['tramado', 'Tramado (para fotos y degradés)', 'bool'], ['invertir', 'Invertir', 'bool']],
  barras: [['datos', 'Datos', 'texto'], ['formato', 'Formato', 'sel', ['CODE128', 'EAN13', 'EAN8', 'UPC', 'CODE39', 'ITF14']],
    ['x', 'X (mm)', 'num'], ['y', 'Y (mm)', 'num'], ['h', 'Alto barras (mm)', 'num'], ['modulo', 'Grosor de barra (puntos)', 'num'],
    ['tamTexto', 'Alto del número (mm)', 'num'], ['rot', 'Rotación', 'sel', [0, 90, 180, 270]], ['conTexto', 'Mostrar número', 'bool']],
  qr: [['datos', 'Datos', 'texto'], ['x', 'X (mm)', 'num'], ['y', 'Y (mm)', 'num'], ['tam', 'Tamaño (mm)', 'num'], ['ecc', 'Corrección', 'sel', ['L', 'M', 'Q', 'H']], ['blanco', 'Blanco', 'bool']],
  recuadro: [['x', 'X (mm)', 'num'], ['y', 'Y (mm)', 'num'], ['w', 'Ancho (mm)', 'num'], ['h', 'Alto (mm)', 'num'], ['grosor', 'Grosor (mm)', 'num'],
    ['relleno', 'Relleno (línea o bloque)', 'bool'], ['blanco', 'Blanco', 'bool']],
};

// Menús y nombre: solo al abrir o cambiar de plantilla (no en cada redibujo).
function prepararEditor() {
  $('#dis-perfil').innerHTML = Object.entries(PERFILES).map(([id, q]) => `<option value="${id}">${escapar(q.nombre)} (${q.ancho}×${q.alto} mm)</option>`).join('');
  $('#dis-perfil').value = PL.perfil;
  $('#dis-nombre').value = PL.nombre || '';
  $('#dis-base').checked = !!PL.base;
  avisoBase();
}

function avisoBase() {
  const av = $('#dis-aviso');
  av.classList.toggle('oculto', !BASE_GUARDADA);
  if (!BASE_GUARDADA) return;
  av.innerHTML = EDITAR_ORIGINAL
    ? '<span>Estás modificando la plantilla base original: "Guardar" la reemplaza.</span><button type="button" data-original="0">Volver a protegerla</button>'
    : '<span>Plantilla base: al guardar se crea una etiqueta nueva y la original queda igual.</span><button type="button" data-original="1">Modificar la original</button>';
  av.querySelector('button').onclick = ev => { EDITAR_ORIGINAL = ev.target.dataset.original === '1'; avisoBase(); };
}

function abrirEnEditor(pl) {
  PL = pl; SEL = -1;
  BASE_GUARDADA = !!(pl.id && pl.base); EDITAR_ORIGINAL = false;
  prepararEditor(); renderEditor(); pintarProps(); reiniciarHistoria();
}

// ─── Deshacer / rehacer ─────────────────────────────────────────────
// Fotos del diseño después de cada cambio. Los elementos son planos: con
// {...e} basta, y las imágenes (textos largos) se comparten, no se copian.
let HIST = [], POS = -1, tHist = null;
const MAX_HIST = 100;
const foto = () => ({ perfil: PL.perfil, elementos: PL.elementos.map(e => ({ ...e })), sel: SEL });
function mismaFoto(a, b) {
  return a.perfil === b.perfil && a.elementos.length === b.elementos.length && a.elementos.every((e, i) => {
    const o = b.elementos[i], ks = Object.keys(e);
    return ks.length === Object.keys(o).length && ks.every(k => e[k] === o[k]);
  });
}
// Agrega una foto si algo cambió desde la última.
function registrar() {
  clearTimeout(tHist); tHist = null;
  const f = foto();
  if (POS >= 0 && mismaFoto(HIST[POS], f)) { HIST[POS].sel = SEL; return botonesHistoria(); }
  HIST.splice(POS + 1);
  HIST.push(f);
  if (HIST.length > MAX_HIST) HIST.shift();
  POS = HIST.length - 1;
  botonesHistoria();
}
// Lo que cambia letra a letra cuenta como un solo paso al dejar de escribir.
function registrarLuego() { clearTimeout(tHist); tHist = setTimeout(registrar, 700); botonesHistoria(); }
function reiniciarHistoria() { HIST = []; POS = -1; registrar(); }
function botonesHistoria() {
  $('#dis-deshacer').disabled = POS <= 0 && !tHist;
  $('#dis-rehacer').disabled = POS >= HIST.length - 1 || !!tHist;
}
function moverHistoria(d) {
  if (tHist) registrar();
  const f = HIST[POS + d];
  if (!f) return;
  POS += d;
  PL.perfil = f.perfil;
  PL.elementos = f.elementos.map(e => ({ ...e }));
  SEL = f.sel < PL.elementos.length ? f.sel : -1;
  GUIAS = [];
  prepararEditor(); renderEditor(); pintarProps(); botonesHistoria();
}
$('#dis-deshacer').onclick = () => moverHistoria(-1);
$('#dis-rehacer').onclick = () => moverHistoria(1);
// Ctrl+Z / Ctrl+Y (o Ctrl+Shift+Z). Dentro de un campo de texto deshace el propio campo.
document.addEventListener('keydown', ev => {
  if ($('#tab-disenar').classList.contains('oculto') || !(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
  if (ev.target.matches('textarea, input:not([type=checkbox])')) return;
  const k = ev.key.toLowerCase();
  if (k === 'z' && !ev.shiftKey) { ev.preventDefault(); moverHistoria(-1); }
  else if (k === 'y' || (k === 'z' && ev.shiftKey)) { ev.preventDefault(); moverHistoria(1); }
});

// Junta los pedidos de redibujo: como mucho uno por cuadro de pantalla.
let renderPendiente = false;
function pedirRender() {
  if (renderPendiente) return;
  renderPendiente = true;
  requestAnimationFrame(() => { renderPendiente = false; renderEditor(); });
}

function renderEditor() {
  const p = PERFILES[PL.perfil];
  if (!p) return;
  const relleno = k => (k === '#' ? '1' : `[${k}]`);
  const rellenoCodigos = k => (k === '#' ? '1' : '123456789012');
  // Textos muestran [campo]; códigos usan números de ejemplo para poder dibujarse
  // y los precios un 12.50 para que se vean los decimales.
  const pl = { ...PL, elementos: PL.elementos.map(e => (e.tipo === 'barras' || e.tipo === 'qr') ? { ...e, datos: sustituir(e.datos, {}, rellenoCodigos) }
    : e.tipo === 'precio' ? { ...e, texto: sustituir(e.texto, {}, k => (k === '#' ? '1' : '12.50')) } : e) };
  ULTIMO = dibujar(pl, p, {}, relleno);
  mostrar($('#dis-lienzo'), ULTIMO, ULTIMO.cajas[SEL], PL.elementos[SEL] && PL.elementos[SEL].bloqueado);
  mensaje($('#dis-msg'), ULTIMO.errores.join(' · '), ULTIMO.errores.length ? 'mal' : '');
  $('#dis-lista').innerHTML = PL.elementos.map((e, i) =>
    `<button data-i="${i}" class="${i === SEL ? 'sel' : ''}${e.bloqueado ? ' bloq' : ''}"><span>${NOMBRES[e.tipo]}</span><small>${escapar(String(e.texto || e.datos || '').slice(0, 24))}</small>` +
    `<span class="candado" data-bloq="${i}" title="${e.bloqueado ? 'Bloqueado: toca para desbloquear' : 'Bloquear para que no se mueva'}">${e.bloqueado ? '🔒' : '🔓'}</span></button>`).join('')
    || '<p class="ayuda">Agrega elementos con los botones de arriba.</p>';
  $$('#dis-lista button').forEach(b => b.onclick = ev => {
    const c = ev.target.closest('[data-bloq]');
    if (c) { alternarBloqueo(+c.dataset.bloq); return; }
    SEL = +b.dataset.i; renderEditor(); pintarProps();
  });
}

// Bloqueado = no se mueve ni cambia de tamaño en la etiqueta (ni con los
// botones de alinear); sus datos sí se pueden cambiar en el panel.
function alternarBloqueo(i) {
  const e = PL.elementos[i];
  if (!e) return;
  e.bloqueado = !e.bloqueado;
  renderEditor(); if (i === SEL) pintarProps(); registrar();
}

function pintarProps() {
  const caja = $('#dis-props');
  const e = PL.elementos[SEL];
  if (!e) { caja.innerHTML = ''; return; }
  caja.innerHTML = `<label class="check bloqueo"><input id="dis-bloq" type="checkbox" ${e.bloqueado ? 'checked' : ''}> 🔒 Bloqueado (no se mueve en la etiqueta)</label>` +
    '<div class="rejilla">' + PROPS[e.tipo].map(([k, et, t, ops]) => {
    const v = e[k];
    if (t === 'area') return `<label class="ancho">${et}<textarea data-k="${k}">${escapar(v ?? '')}</textarea></label>`;
    if (t === 'texto') return `<label class="ancho">${et}<input data-k="${k}" value="${escapar(v ?? '')}"></label>`;
    if (t === 'num') return `<label>${et}<input data-k="${k}" type="number" step="0.25" value="${v ?? ''}"></label>`;
    if (t === 'sel') return `<label>${et}<select data-k="${k}">${ops.map(o => `<option ${String(o) === String(v) ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`;
    if (t === 'bool') return `<label class="check ancho"><input data-k="${k}" type="checkbox" ${v ? 'checked' : ''}>${et}</label>`;
    if (t === 'archivo') return `<label class="ancho">${et}<button type="button" data-archivo>Elegir archivo…</button></label>`;
    return '';
  }).join('') + `</div>
    <div class="alinear">
      <span class="ayuda">Alinear en la etiqueta</span>
      <div class="botones-alinear">
        <button data-alinear="izq" title="Izquierda">⇤</button><button data-alinear="centro" title="Centro horizontal">↔</button><button data-alinear="der" title="Derecha">⇥</button>
        <button data-alinear="arriba" title="Arriba">⤒</button><button data-alinear="medio" title="Centro vertical">↕</button><button data-alinear="abajo" title="Abajo">⤓</button>
        <button data-alinear="centrar" class="ancho2" title="Centro de la etiqueta">⊕ Centrar</button>
      </div>
      <label class="margen">Margen de los bordes (mm) <input id="dis-margen" type="number" min="0" step="0.5" value="${MARGEN_MM}"></label>
    </div>` + '<div class="botones"><button data-acc="subir">↑ Atrás</button><button data-acc="bajar">↓ Adelante</button><button data-acc="dup">Duplicar</button><button data-acc="quitar" class="peligro">Quitar</button></div>';
  caja.querySelectorAll('[data-k]').forEach(inp => {
    const aplicar = () => {
      const k = inp.dataset.k;
      e[k] = inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? (inp.value === '' ? null : +inp.value)
        : (k === 'rot' ? +inp.value : inp.value);
      pedirRender();
    };
    inp.oninput = () => { aplicar(); registrarLuego(); };
    inp.onchange = () => { aplicar(); registrar(); };
  });
  caja.querySelector('#dis-bloq').onchange = () => alternarBloqueo(SEL);
  caja.querySelectorAll('[data-alinear]').forEach(b => { b.disabled = !!e.bloqueado; b.onclick = () => alinear(b.dataset.alinear); });
  const mg = caja.querySelector('#dis-margen');
  mg.oninput = () => { MARGEN_MM = Math.max(0, +mg.value || 0); try { localStorage.setItem('etiquetas.margen', MARGEN_MM); } catch (e) { /* sin almacenamiento */ } };
  const btnArch = caja.querySelector('[data-archivo]');
  if (btnArch) btnArch.onclick = () => elegirImagen(e);
  caja.querySelectorAll('[data-acc]').forEach(b => b.onclick = () => {
    const a = b.dataset.acc, L = PL.elementos;
    if (a === 'quitar') { L.splice(SEL, 1); SEL = -1; }
    if (a === 'dup') { L.splice(SEL + 1, 0, { ...e, x: e.x + 2, y: e.y + 2, bloqueado: false }); SEL++; }
    if (a === 'subir' && SEL > 0) { [L[SEL - 1], L[SEL]] = [L[SEL], L[SEL - 1]]; SEL--; }
    if (a === 'bajar' && SEL < L.length - 1) { [L[SEL + 1], L[SEL]] = [L[SEL], L[SEL + 1]]; SEL++; }
    renderEditor(); pintarProps(); registrar();
  });
}

// Imagen subida: se reduce a lo que la impresora puede mostrar (8 puntos/mm).
function elegirImagen(e) {
  const inp = $('#dis-archivo');
  inp.value = '';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    const url = await new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(f); });
    const im = await cargarImagen(url);
    const p = PERFILES[PL.perfil], maxLado = Math.round(Math.max(p.ancho, p.alto) * PMM);   // la impresora no da más detalle
    const k = Math.min(1, maxLado / Math.max(im.width, im.height));
    const c = document.createElement('canvas'); c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(im, 0, 0, c.width, c.height);
    e.src = c.toDataURL('image/png');
    await asegurarImagenes(PL);
    renderEditor(); pintarProps(); registrar();
  };
  inp.click();
}

$$('[data-nuevo]').forEach(b => b.onclick = () => {
  if (!PERFILES[PL.perfil]) return mensaje($('#dis-msg'), 'Primero define un rollo en la pestaña Rollos.', 'mal');
  const e = NUEVOS[b.dataset.nuevo]();
  if (e.tipo === 'imagen') { PL.elementos.unshift(e); SEL = 0; elegirImagen(e); }
  else { PL.elementos.push(e); SEL = PL.elementos.length - 1; }
  renderEditor(); pintarProps(); registrar();
});

$('#dis-nombre').oninput = () => { PL.nombre = $('#dis-nombre').value; };
$('#dis-perfil').onchange = () => { PL.perfil = $('#dis-perfil').value; renderEditor(); registrar(); };
$('#dis-base').onchange = () => { PL.base = $('#dis-base').checked; };
$('#dis-plantilla').onchange = async () => {
  const id = $('#dis-plantilla').value;
  if (!id) return abrirEnEditor(nuevaPlantilla());
  mensaje($('#dis-msg'), 'Cargando plantilla…');
  try {
    const pl = await api('GET', '/api/plantilla?id=' + id); pl.id = id; await asegurarImagenes(pl);
    abrirEnEditor(pl);
  } catch (er) { mensaje($('#dis-msg'), er.message, 'mal'); }
};
$('#dis-nueva').onclick = () => { $('#dis-plantilla').value = ''; abrirEnEditor(nuevaPlantilla()); };

// Guardar sobre una plantilla base (sin "Modificar la original") o con
// "Guardar como nueva" crea otra plantilla; la abierta no se toca.
async function guardarPlantilla(comoNueva) {
  if (!PL.nombre) return mensaje($('#dis-msg'), 'Ponle un nombre a la plantilla.', 'mal');
  const copia = !!PL.id && (comoNueva || (BASE_GUARDADA && !EDITAR_ORIGINAL));
  const { id, ...cuerpo } = PL;
  if (copia) {
    const original = PLANTILLAS.find(p => p.id === id), sugerido = original && original.nombre === PL.nombre ? PL.nombre + ' (nueva)' : PL.nombre;
    const nombre = (prompt(BASE_GUARDADA ? 'La plantilla base no se modifica. Nombre de la nueva etiqueta:' : 'Nombre de la nueva plantilla:', sugerido) || '').trim();
    if (!nombre) return;
    Object.assign(cuerpo, { nombre, base: false });
  }
  try {
    const ruta = '/api/plantilla' + (copia || !id ? '' : '?id=' + id + (BASE_GUARDADA ? '&original=1' : ''));
    const r = await api('PUT', ruta, cuerpo);
    const nombreOriginal = PL.nombre, eraBase = BASE_GUARDADA;
    Object.assign(PL, { id: r.id, nombre: cuerpo.nombre, base: !!cuerpo.base });
    if (copia) EDITAR_ORIGINAL = false;
    BASE_GUARDADA = PL.base;
    await cargarListaPlantillas();
    $('#dis-plantilla').value = r.id;
    prepararEditor();
    mensaje($('#dis-msg'), !copia ? (eraBase ? 'Plantilla base actualizada.' : PL.base ? 'Guardada como plantilla base.' : 'Guardada.')
      : `Guardada como "${PL.nombre}".` + (comoNueva ? '' : ` La plantilla base "${nombreOriginal}" quedó igual.`), 'ok');
  } catch (er) { mensaje($('#dis-msg'), er.message, 'mal'); }
}
$('#dis-guardar').onclick = () => guardarPlantilla(false);
$('#dis-copia').onclick = () => guardarPlantilla(true);
$('#dis-borrar').onclick = async () => {
  if (!PL.id || !confirm(BASE_GUARDADA ? `"${PL.nombre}" es una plantilla base. ¿Eliminarla de todos modos?` : `¿Eliminar la plantilla "${PL.nombre}"?`)) return;
  await api('DELETE', '/api/plantilla?id=' + PL.id);
  await cargarListaPlantillas();
  $('#dis-plantilla').value = '';
  abrirEnEditor(nuevaPlantilla());
};

// Tocar para elegir, arrastrar para mover y arrastrar la manija azul de la
// esquina para cambiar el tamaño (mouse, dedo o lápiz).
(() => {
  const cv = $('#dis-lienzo');
  let arrastre = null;
  const punto = ev => { const r = cv.getBoundingClientRect(); return { x: (ev.clientX - r.left) * cv.width / r.width, y: (ev.clientY - r.top) * cv.height / r.height }; };
  const dentro = (p, c) => c && p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h;
  cv.addEventListener('pointerdown', ev => {
    if (!ULTIMO) return;
    const p = punto(ev);
    // La manija del elemento elegido tiene prioridad (los bloqueados no tienen).
    const elegido = PL.elementos[SEL];
    if (elegido && !elegido.bloqueado && ULTIMO.cajas[SEL] && dentro(p, manija(ULTIMO.cajas[SEL], ULTIMO.W))) {
      arrastre = { modo: 'tam', p, orig: { ...PL.elementos[SEL] }, caja: { ...ULTIMO.cajas[SEL] }, W: ULTIMO.W, H: ULTIMO.H };
      cv.setPointerCapture(ev.pointerId);
      return;
    }
    let hit = -1;
    // Los bloqueados no se agarran al tocar: se elige lo que haya debajo o encima.
    for (let i = PL.elementos.length - 1; i >= 0; i--) if (!PL.elementos[i].bloqueado && dentro(p, ULTIMO.cajas[i])) { hit = i; break; }
    SEL = hit; renderEditor(); pintarProps();
    if (hit >= 0) { arrastre = { modo: 'mover', p, x: PL.elementos[hit].x, y: PL.elementos[hit].y, caja: { ...ULTIMO.cajas[hit] }, W: ULTIMO.W, H: ULTIMO.H }; cv.setPointerCapture(ev.pointerId); }
  });
  cv.addEventListener('pointermove', ev => {
    if (!arrastre || SEL < 0) return;
    const p = punto(ev), e = PL.elementos[SEL];
    const dx = (p.x - arrastre.p.x) / PMM, dy = (p.y - arrastre.p.y) / PMM;
    if (arrastre.modo === 'mover') {
      // Imán hacia bordes, márgenes y centro (ev.altKey lo desactiva en computadora).
      const im = ev.altKey ? (GUIAS = [], { dx: dx * PMM, dy: dy * PMM }) : iman(arrastre.caja, dx * PMM, dy * PMM, arrastre.W, arrastre.H);
      e.x = GUIAS.some(g => g.x != null) ? Math.round((arrastre.x + im.dx / PMM) * 8) / 8 : redondear(arrastre.x + im.dx / PMM);
      e.y = GUIAS.some(g => g.y != null) ? Math.round((arrastre.y + im.dy / PMM) * 8) / 8 : redondear(arrastre.y + im.dy / PMM);
    } else {
      const o = arrastre.orig, c = arrastre.caja;
      if (e.tipo === 'imagen') {                     // mantiene la proporción
        const f = Math.max(0.05, (o.w + dx) / o.w);
        e.w = redondear(o.w * f); e.h = redondear(o.h * f);
      } else if (e.tipo === 'recuadro') {
        e.w = Math.max(0.5, redondear(o.w + dx)); e.h = Math.max(0.5, redondear(o.h + dy));
      } else if (e.tipo === 'qr') {
        e.tam = Math.max(5, redondear(o.tam + Math.max(dx, dy)));
      } else if (e.tipo === 'texto' || e.tipo === 'precio') {   // alto de letra según el alto de la caja
        e.tam = Math.max(1, redondear(o.tam * (c.h + dy * PMM) / c.h, 0.25));
        if (o.w) e.w = Math.max(5, redondear(o.w + dx));
      } else if (e.tipo === 'barras') {
        e.h = Math.max(3, redondear(o.h + dy));
        e.modulo = Math.max(1, Math.min(8, Math.round((o.modulo || 2) * (c.w + dx * PMM) / c.w)));
      }
    }
    pedirRender();
  });
  const soltar = () => { if (arrastre) { arrastre = null; GUIAS = []; renderEditor(); pintarProps(); registrar(); } };
  cv.addEventListener('pointerup', soltar);
  cv.addEventListener('pointercancel', soltar);
})();

// ─── Rollos ─────────────────────────────────────────────────────────
let EDIT_PERF = null;

function pintarRollos() {
  if (!EDIT_PERF) EDIT_PERF = JSON.parse(JSON.stringify(PERFILES));
  $('#rol-actual').textContent = ESTADO.perfil ? `Rollo cargado: ${nombrePerfil(ESTADO.perfil)} · sensor de la impresora: ${ESTADO.sensor || '?'}${ESTADO.lectura ? ' (' + ESTADO.lectura + ')' : ''}` : 'Todavía no se eligió qué rollo está cargado.';
  const campos = [['nombre', 'Nombre', 'text'], ['ancho', 'Ancho (mm)', 'number'], ['alto', 'Alto (mm)', 'number'],
    ['sensor', 'Sensor', 'sel'], ['lectura', 'Lectura del sensor', 'lectura'], ['refXmm', 'Origen X (mm)', 'number'], ['refYmm', 'Origen Y (mm)', 'number'],
    ['columnas', 'Columnas', 'number'], ['separacion', 'Separación entre columnas (mm)', 'number'],
    ['densidad', 'Densidad (vacío = la de la impresora)', 'number'], ['velocidad', 'Velocidad (vacío = la de la impresora)', 'number'], ['ribbon', 'Usa cinta (ribbon)', 'bool']];
  $('#rol-lista').innerHTML = Object.entries(EDIT_PERF).map(([id, p]) => `
    <div class="rollo ${id === ESTADO.perfil ? 'cargado' : ''}" data-id="${id}">
      <h3><span>${escapar(p.nombre)}</span>${id === ESTADO.perfil ? '<small>cargado</small>' : ''}</h3>
      <div class="rejilla">${campos.map(([k, et, t]) => {
        const v = k === 'refXmm' ? p.referenciaX / PMM : k === 'refYmm' ? p.referenciaY / PMM : p[k];
        if (t === 'sel') return `<label>${et}<select data-k="${k}">${['gap', 'black mark', 'continuous'].map(s => `<option ${s === v ? 'selected' : ''} value="${s}">${{ gap: 'Gap (separadas)', 'black mark': 'Marca negra', continuous: 'Continuo' }[s]}</option>`).join('')}</select></label>`;
        if (t === 'lectura') return `<label>${et}<select data-k="${k}">${[['', 'Automática'], ['reflective', 'Reflectiva'], ['transmissive', 'Transmisiva']].map(([s, n]) => `<option ${s === (v || '') ? 'selected' : ''} value="${s}">${n}</option>`).join('')}</select></label>`;
        if (t === 'bool') return `<label class="check"><input data-k="${k}" type="checkbox" ${v !== false ? 'checked' : ''}>${et}</label>`;
        return `<label>${et}<input data-k="${k}" type="${t}" ${t === 'number' ? 'step="0.125"' : ''} value="${v ?? ''}"></label>`;
      }).join('')}</div>
      <div class="botones">
        <button data-acc="cargar" class="primario">Cambiar a este rollo</button>
        <button data-acc="yapuesto" title="Ajusta el sensor sin calibrar (si la impresora ya estaba calibrada para este rollo)">Ya está puesto</button>
        <button data-acc="prueba">Prueba de márgenes</button>
        <button data-acc="quitar" class="peligro">Quitar</button>
      </div>
    </div>`).join('');
  $$('#rol-lista .rollo').forEach(div => {
    const id = div.dataset.id, p = EDIT_PERF[id];
    div.querySelectorAll('[data-k]').forEach(inp => inp.oninput = inp.onchange = () => {
      const k = inp.dataset.k, v = inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? (inp.value === '' ? null : +inp.value) : inp.value;
      if (k === 'refXmm') p.referenciaX = Math.round((v || 0) * PMM);
      else if (k === 'refYmm') p.referenciaY = Math.round((v || 0) * PMM);
      else p[k] = v;
    });
    div.querySelectorAll('[data-acc]').forEach(b => b.onclick = () => accionRollo(id, b.dataset.acc, b));
  });
}

async function guardarPerfiles() {
  await api('PUT', '/api/perfiles', { perfiles: EDIT_PERF });
  await refrescarEstado();
}

async function accionRollo(id, acc, boton) {
  const msg = $('#rol-msg');
  boton.disabled = true;
  try {
    if (acc === 'quitar') {
      if (!confirm(`¿Quitar el rollo "${EDIT_PERF[id].nombre}"?`)) return;
      delete EDIT_PERF[id]; await guardarPerfiles(); EDIT_PERF = null; pintarRollos();
      return mensaje(msg, 'Rollo quitado.', 'ok');
    }
    await guardarPerfiles();                              // usa lo que esté en pantalla
    if (acc === 'cargar' || acc === 'yapuesto') {
      const calibrar = acc === 'cargar';
      mensaje(msg, calibrar ? 'Ajustando el sensor y calibrando… (la impresora va a avanzar algunas etiquetas)' : 'Ajustando el sensor…');
      await api('POST', '/api/rollo', { perfil: id, sinCalibrar: !calibrar });
      await refrescarEstado(); EDIT_PERF = null; pintarRollos();
      mensaje(msg, `Listo: rollo "${nombrePerfil(id)}" cargado${calibrar ? ' y calibrado' : ''}.`, 'ok');
    }
    if (acc === 'prueba') { await api('POST', '/api/prueba', { perfil: id }); mensaje(msg, 'Prueba enviada: el marco debe quedar a 2 mm de cada borde.', 'ok'); }
  } catch (er) { mensaje(msg, er.message, 'mal'); }
  finally { boton.disabled = false; }
}

$('#rol-agregar').onclick = () => {
  const id = 'rollo-' + Date.now().toString(36);
  EDIT_PERF[id] = { nombre: 'Nuevo rollo', ancho: 100, alto: 50, sensor: 'gap', lectura: '', referenciaX: 0, referenciaY: 0, ribbon: true, densidad: null, velocidad: null, columnas: 1, separacion: 0 };
  pintarRollos();
};
$('#rol-guardar').onclick = async () => {
  try { await guardarPerfiles(); EDIT_PERF = null; pintarRollos(); mensaje($('#rol-msg'), 'Guardado.', 'ok'); }
  catch (er) { mensaje($('#rol-msg'), er.message, 'mal'); }
};
$('#rol-calibrar').onclick = async () => {
  const b = $('#rol-calibrar'); b.disabled = true;
  mensaje($('#rol-msg'), 'Calibrando…');
  try { await api('POST', '/api/calibrar'); mensaje($('#rol-msg'), 'Calibrada.', 'ok'); }
  catch (er) { mensaje($('#rol-msg'), er.message, 'mal'); }
  b.disabled = false; refrescarEstado();
};

// ─── Versión de la página (se actualiza sola desde GitHub) ──────────
async function mostrarVersion() {
  try {
    const v = await api('GET', '/api/version', null, 10000);
    $('#ver-texto').textContent = v.sha
      ? `Versión de la página: ${v.sha.slice(0, 7)}${v.fecha ? ' · ' + new Date(v.fecha).toLocaleString('es-PE') : ''} · se actualiza sola cada ${v.cadaMinutos} min`
      : 'Versión de la página: instalada por cable (todavía no se buscó en GitHub)';
  } catch (e) { $('#ver-texto').textContent = 'Versión de la página: desconocida'; }
}
$('#ver-buscar').onclick = async () => {
  const b = $('#ver-buscar'); b.disabled = true;
  mensaje($('#rol-msg'), 'Buscando actualización…');
  try {
    const r = await api('POST', '/api/actualizar', null, 120000);
    if (r.actualizado) { mensaje($('#rol-msg'), 'Página actualizada. Recargando…', 'ok'); setTimeout(() => location.reload(), 800); }
    else { mensaje($('#rol-msg'), 'Ya tienes la última versión.', 'ok'); mostrarVersion(); }
  } catch (er) { mensaje($('#rol-msg'), er.message, 'mal'); }
  b.disabled = false;
};

// ─── Inicio ─────────────────────────────────────────────────────────
(async () => {
  await refrescarEstado();
  try { await cargarListaPlantillas(); } catch (e) { /* sin servidor */ }
  await elegirParaImprimir();
  abrirEnEditor(nuevaPlantilla());
  mostrarVersion();
  setInterval(() => { if (!document.hidden) refrescarEstado(); }, 8000);
})();
