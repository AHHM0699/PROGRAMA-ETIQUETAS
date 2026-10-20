// ════════════════════════════════════════════════════════════════════
//  PROGRAMA-ETIQUETAS — Android (Termux)  —  independiente del servidor de caja
//
//  Maneja la impresora de etiquetas HPRT HT300 (POS-D LP300X, 203 dpi)
//  por red y sirve una página web para diseñar e imprimir desde
//  cualquier dispositivo (Android, iPhone, iPad, Mac, PC).
//
//  - El navegador arma la etiqueta (imagen de fondo, textos con campos
//    variables, códigos de barras, QR) y la manda como mapa de bits de
//    1 bit a 8 puntos/mm. Aquí solo se envuelve en TSPL (BITMAP) con el
//    tamaño y el origen del perfil del rollo cargado.
//  - Una sola conexión con la impresora y una cola: dos conversaciones
//    a la vez le desordenan las respuestas.
//  - Configuración de la impresora con el protocolo de HPRT:
//      ESC FS "& V1 getval \"clave\"\r\n"          → texto terminado en 0x00
//      ESC FS "& V1 setval \"clave\" \"valor\"\r\n" → no contesta
//      ESC FS "& V1 do \"accion\"\r\n"             → no contesta
//    NO consultar "country_code": el firmware vuelca ~64 KB de memoria.
//  - Perfiles (uno por tipo de rollo) y plantillas viven en
//    data/etiquetas/. Cambiar de rollo = sensor del perfil + calibración.
//  - La página (public/) se actualiza sola desde el repo de GitHub: basta
//    con hacer push y esperar unos minutos (o tocar "Buscar actualización").
//    El resto (este archivo) se sigue instalando por cable.
//  - Vive en su propia carpeta (~/programa-etiquetas) con su config.json
//    y su data/. No comparte nada con el servidor de caja.
// ════════════════════════════════════════════════════════════════════
'use strict';

const http   = require('http');
const net    = require('net');
const dgram  = require('dgram');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

let CONFIG = {};
try {
  CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8').replace(/^﻿/, ''));
} catch (e) { /* sin config.json */ }
// config.json: { impresoraHost, impresoraPuerto, puertoWeb, nombreLocal, actualizar }
const ET = CONFIG;

const IMP_HOST   = ET.impresoraHost   || '192.168.1.251';
const IMP_PUERTO = ET.impresoraPuerto || 9100;
const WEB_PUERTO = ET.puertoWeb       || 8091;
const NOMBRE_LOCAL = `${ET.nombreLocal || 'etiche'}.local`;   // http://etiche.local:8091
const PUNTOS_MM  = 8;                                   // 203 dpi
const ANCHO_CABEZAL = 864;                              // 108 mm
const DATA_DIR   = path.join(__dirname, 'data');
const DIR_PLANT  = path.join(DATA_DIR, 'plantillas');
const F_PERFILES = path.join(DATA_DIR, 'perfiles.json');
const F_ESTADO   = path.join(DATA_DIR, 'estado.json');
const PUBLICO    = path.join(__dirname, 'public');

// Actualización de la página desde GitHub (solo public/).
const ACT        = ET.actualizar || {};
const ACT_REPO   = ACT.repo    || 'AHHM0699/PROGRAMA-ETIQUETAS';
const ACT_RAMA   = ACT.rama    || 'main';
const ACT_RUTA   = 'public';
const ACT_MIN    = ACT.minutos ?? 5;                    // 0 = solo con el botón
const F_VERSION  = path.join(PUBLICO, '.version.json'); // dentro de public: si se reinstala por cable, se vuelve a bajar

// Perfiles medidos con la impresora real (oct-2026). referencia en puntos:
// X = del borde izquierdo del cabezal al borde de la etiqueta (REFERENCE),
// Y = corrimiento vertical respecto de la marca o el gap (SHIFT).
const PERFILES_INICIALES = {
  trans: {
    nombre: 'TRANS (marca negra)', ancho: 100, alto: 100, sensor: 'black mark',
    referenciaX: 44, referenciaY: 8, ribbon: true, densidad: null, velocidad: null,
    columnas: 1, separacion: 0,
  },
  conmemorativas: {
    nombre: 'Conmemorativas blancas (gap)', ancho: 101, alto: 150, sensor: 'gap',
    referenciaX: 20, referenciaY: 0, ribbon: true, densidad: null, velocidad: null,
    columnas: 1, separacion: 0,
  },
};
const SENSORES = ['gap', 'black mark', 'continuous'];

function log(...a) {
  const t = new Date().toLocaleString('es-PE', { timeZone: 'America/Lima', hour12: false });
  console.log(`[${t}]`, ...a);
}

function leerJSON(f, def) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return def; }
}
function guardarJSON(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, f);
}

function perfiles() { return leerJSON(F_PERFILES, null) || PERFILES_INICIALES; }
function estadoGuardado() { return leerJSON(F_ESTADO, {}); }

const esperar = ms => new Promise(r => setTimeout(r, ms));

// ─── Conexión con la impresora ──────────────────────────────────────
// Conexión permanente; se reabre sola si se cae. Todo pasa por la cola.
class Impresora {
  constructor(host, puerto) {
    this.host = host; this.puerto = puerto;
    this.sock = null; this.conectada = false;
    this.rx = [];                       // bytes recibidos sin consumir
    this.cola = Promise.resolve();
    this.avisoCaida = false;
    this.conectar();
  }

  conectar() {
    const s = net.connect({ host: this.host, port: this.puerto });
    s.setKeepAlive(true, 15000);
    s.setNoDelay(true);
    s.on('connect', () => {
      this.sock = s; this.conectada = true; this.avisoCaida = false;
      log(`Conectada a la impresora ${this.host}:${this.puerto}`);
    });
    s.on('data', d => { this.rx.push(d); });
    s.on('error', e => {
      if (!this.avisoCaida) { log(`Impresora sin conexión (${e.code || e.message}); reintento cada 10 s`); this.avisoCaida = true; }
    });
    s.on('close', () => {
      if (this.conectada) log('Se cerró la conexión con la impresora');
      this.conectada = false; this.sock = null;
      setTimeout(() => this.conectar(), 10000);
    });
  }

  // Encola una operación; devuelve su resultado. `pendientes` > 0 = ocupada.
  turno(fn) {
    this.pendientes = (this.pendientes || 0) + 1;
    const r = this.cola.then(fn).finally(() => { this.pendientes--; });
    this.cola = r.catch(() => {});
    return r;
  }

  escribir(buf) {
    return new Promise((ok, mal) => {
      if (!this.conectada) return mal(new Error('La impresora no está conectada'));
      this.sock.write(buf, e => (e ? mal(e) : ok()));
    });
  }

  // Envía y junta la respuesta hasta que `listo(buffer)` o hasta `maxMs`.
  async pedir(buf, listo, maxMs = 2500) {
    this.rx = [];
    await this.escribir(buf);
    const fin = Date.now() + maxMs;
    while (Date.now() < fin) {
      const b = Buffer.concat(this.rx);
      if (b.length && listo(b)) return b;
      await esperar(40);
    }
    return Buffer.concat(this.rx);
  }
}

const imp = new Impresora(IMP_HOST, IMP_PUERTO);

const ESC_FS = Buffer.from([0x1b, 0x1c]);
const cmdHPRT = txt => Buffer.concat([ESC_FS, Buffer.from(`& V1 ${txt}\r\n`, 'latin1')]);

// Las respuestas de getval terminan en 0x00. La de printer_status trae
// "printer status:\0" seguido de 4 bytes, que pueden incluir ceros.
async function getval(clave) {
  if (clave === 'country_code') throw new Error('country_code no se consulta (bug del firmware)');
  const esEstado = clave === 'printer_status';
  const b = await imp.pedir(cmdHPRT(`getval "${clave}"`),
    x => (esEstado ? x.length >= 20 : x.includes(0)), 2000);
  if (esEstado) return b.subarray(0, 20);
  const i = b.indexOf(0);
  return i >= 0 ? b.subarray(0, i).toString('latin1') : null;
}
const setval = (clave, valor) => imp.escribir(cmdHPRT(`setval "${clave}" "${valor}"`));
const accion = nombre => imp.escribir(cmdHPRT(`do "${nombre}"`));

// Bits confirmados: listo 00 00 02 00 · cabezal abierto 00 20 00 00 ·
// calibrando 00 00 01 00. Lo demás se informa en crudo.
function leerEstado(b) {
  if (!b || b.length < 20 || !b.subarray(0, 15).toString('latin1').startsWith('printer status:')) return null;
  const e = b.subarray(16, 20);
  return {
    listo:          !!(e[2] & 0x02),
    calibrando:     !!(e[2] & 0x01),
    cabezalAbierto: !!(e[1] & 0x20),
    crudo: [...e].map(x => x.toString(16).padStart(2, '0')).join(' '),
  };
}

async function estadoImpresora() {
  const est = leerEstado(await getval('printer_status'));
  const sensor = await getval('media_sensor');
  return { estado: est, sensor };
}

async function esperarLista(maxMs = 45000) {
  const fin = Date.now() + maxMs;
  await esperar(2500);                 // da tiempo a que empiece a moverse
  while (Date.now() < fin) {
    const est = leerEstado(await getval('printer_status'));
    if (est && est.listo && !est.calibrando) return est;
    await esperar(1000);
  }
  throw new Error('La impresora no volvió a quedar lista');
}

// ─── Trabajos TSPL ──────────────────────────────────────────────────
// SIZE siempre con el ancho del cabezal: con un ancho menor la impresora
// centra la ventana y el origen X se movería al cambiar el tamaño.
// La Y va por SHIFT y no por REFERENCE: REFERENCE corre el dibujo dentro
// de la ventana de SIZE y lo de abajo quedaría recortado.
function cabeceraTSPL(p) {
  const l = [
    `SIZE ${ANCHO_CABEZAL / PUNTOS_MM} mm,${p.alto} mm`,
    `REFERENCE ${p.referenciaX | 0},0`,
    `SHIFT ${p.referenciaY | 0}`,
    `SET RIBBON ${p.ribbon === false ? 'OFF' : 'ON'}`,
  ];
  if (p.densidad != null && p.densidad !== '') l.push(`DENSITY ${p.densidad | 0}`);
  if (p.velocidad != null && p.velocidad !== '') l.push(`SPEED ${p.velocidad | 0}`);
  l.push('CLS');
  return l.join('\r\n') + '\r\n';
}

const anchoTotal = p => {
  const c = Math.max(1, p.columnas | 0);
  return +(c * p.ancho + (c - 1) * (+p.separacion || 0)).toFixed(2);
};

// bits: 1 = negro (como lo manda el navegador). TSPL BITMAP usa 0 = negro.
function trabajoBitmap(p, bitsB64, anchoPts, altoPts, copias) {
  const bpf = Math.ceil(anchoPts / 8);
  const bits = Buffer.from(bitsB64, 'base64');
  if (bits.length !== bpf * altoPts) throw new Error(`Bitmap inválido: ${bits.length} bytes, se esperaban ${bpf * altoPts}`);
  const col = Math.max(1, p.columnas | 0);
  const pasoPts = Math.round((p.ancho + (+p.separacion || 0)) * PUNTOS_MM);
  const anchoFila = Math.ceil(((col - 1) * pasoPts + anchoPts) / 8);
  const fila = Buffer.alloc(anchoFila * altoPts, 0xff);       // todo blanco
  for (let c = 0; c < col; c++) {
    const x0 = c * pasoPts;
    for (let y = 0; y < altoPts; y++) {
      for (let x = 0; x < anchoPts; x++) {
        if (bits[y * bpf + (x >> 3)] & (0x80 >> (x & 7))) {
          const X = x0 + x;
          fila[y * anchoFila + (X >> 3)] &= ~(0x80 >> (X & 7));
        }
      }
    }
  }
  const filas = Math.ceil(Math.max(1, copias | 0) / col);
  return Buffer.concat([
    Buffer.from(cabeceraTSPL(p), 'latin1'),
    Buffer.from(`BITMAP 0,0,${anchoFila},${altoPts},0,`, 'latin1'),
    fila,
    Buffer.from(`\r\nPRINT ${filas},1\r\n`, 'latin1'),
  ]);
}

// Prueba de márgenes con comandos nativos: marco a 2 mm y cruz al centro.
function trabajoPrueba(p) {
  const W = Math.round(p.ancho * PUNTOS_MM), H = Math.round(p.alto * PUNTOS_MM), m = 16;
  const t = [
    `BOX ${m},${m},${W - m},${H - m},3`,
    `BAR ${(W >> 1) - 1},${m},3,${H - 2 * m}`,
    `BAR ${m},${(H >> 1) - 1},${W - 2 * m},3`,
    `TEXT ${m + 24},${m + 24},"3",0,1,1,"${p.nombre.replace(/"/g, "'")}"`,
    `TEXT ${m + 24},${m + 64},"2",0,1,1,"${p.ancho} x ${p.alto} mm  REF ${p.referenciaX},${p.referenciaY}  marco a 2 mm"`,
    'PRINT 1,1',
  ];
  return Buffer.from(cabeceraTSPL(p) + t.join('\r\n') + '\r\n', 'latin1');
}

// El rollo cargado tiene que coincidir con el perfil, si no se desperdicia papel.
async function verificarParaImprimir(idPerfil) {
  const st = estadoGuardado();
  if (st.perfil !== idPerfil) {
    const ps = perfiles();
    throw Object.assign(new Error(`El rollo cargado es "${(ps[st.perfil] || {}).nombre || 'desconocido'}". Cambia de rollo a "${ps[idPerfil].nombre}" primero.`), { codigo: 409 });
  }
  const est = leerEstado(await getval('printer_status'));
  if (!est) throw Object.assign(new Error('La impresora no contesta'), { codigo: 503 });
  if (est.cabezalAbierto) throw Object.assign(new Error('El cabezal está abierto'), { codigo: 409 });
  if (!est.listo) throw Object.assign(new Error(`La impresora no está lista (estado ${est.crudo})`), { codigo: 409 });
}

// ─── Actualización de la página desde GitHub ────────────────────────
// Cada ACT_MIN minutos pregunta cuál es el último commit que tocó
// public/ (1 consulta a la API de GitHub). Si cambió, baja todos
// los archivos a public.nuevo/, verifica tamaños y recién ahí reemplaza
// public/. Si algo falla, queda la versión anterior.
let actualizando = null;

async function gh(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'etiquetas-cheplas', Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub ${r.status} en ${url.replace('https://api.github.com', '')}`);
  return r.json();
}

async function listarArchivos(ruta, sha) {
  const items = await gh(`https://api.github.com/repos/${ACT_REPO}/contents/${ruta}?ref=${sha}`);
  const out = [];
  for (const it of items) {
    if (it.type === 'dir') out.push(...await listarArchivos(it.path, sha));
    else if (it.type === 'file') out.push({ rel: it.path.slice(ACT_RUTA.length + 1), size: it.size });
  }
  return out;
}

async function buscarActualizacion() {
  if (typeof fetch !== 'function') throw new Error('Este Node no tiene fetch (hace falta Node 18 o más)');
  const [ultimo] = await gh(`https://api.github.com/repos/${ACT_REPO}/commits?sha=${ACT_RAMA}&path=${ACT_RUTA}&per_page=1`);
  if (!ultimo) throw new Error('No se encontró la carpeta de la página en el repo');
  const actual = leerJSON(F_VERSION, {});
  if (actual.sha === ultimo.sha) return { actualizado: false, sha: ultimo.sha };

  const archivos = await listarArchivos(ACT_RUTA, ultimo.sha);
  if (!archivos.some(a => a.rel === 'index.html')) throw new Error('La versión del repo no trae index.html');
  const nuevo = PUBLICO + '.nuevo';
  fs.rmSync(nuevo, { recursive: true, force: true });
  for (const a of archivos) {
    const r = await fetch(`https://raw.githubusercontent.com/${ACT_REPO}/${ultimo.sha}/${ACT_RUTA}/${a.rel}`);
    const b = Buffer.from(await r.arrayBuffer());
    if (!r.ok || b.length !== a.size) throw new Error(`Descarga incompleta de ${a.rel}`);
    fs.mkdirSync(path.dirname(path.join(nuevo, a.rel)), { recursive: true });
    fs.writeFileSync(path.join(nuevo, a.rel), b);
  }
  const fecha = (ultimo.commit && ultimo.commit.committer && ultimo.commit.committer.date) || null;
  fs.writeFileSync(path.join(nuevo, '.version.json'), JSON.stringify({ sha: ultimo.sha, fecha, mensaje: ultimo.commit && ultimo.commit.message }));
  const anterior = PUBLICO + '.anterior';
  fs.rmSync(anterior, { recursive: true, force: true });
  if (fs.existsSync(PUBLICO)) fs.renameSync(PUBLICO, anterior);
  fs.renameSync(nuevo, PUBLICO);
  log(`Página actualizada a ${ultimo.sha.slice(0, 7)} (${archivos.length} archivos)`);
  return { actualizado: true, sha: ultimo.sha };
}

// Una sola búsqueda a la vez; los errores se registran y no tumban nada.
function actualizar() {
  if (!actualizando) {
    actualizando = buscarActualizacion()
      .catch(e => { log('Actualización de la página:', e.message); throw e; })
      .finally(() => { actualizando = null; });
  }
  return actualizando;
}
if (ACT_MIN > 0) {
  setTimeout(() => actualizar().catch(() => {}), 20000);
  setInterval(() => actualizar().catch(() => {}), ACT_MIN * 60000);
}

// ─── API ────────────────────────────────────────────────────────────
let ultimoEstado = null;
const RUTAS = {
  'GET /api/estado': async () => {
    const ps = perfiles(), st = estadoGuardado();
    const base = { conectada: imp.conectada, impresora: `${IMP_HOST}:${IMP_PUERTO}`, perfil: st.perfil || null, perfiles: ps };
    if (!imp.conectada) return base;
    // Imprimiendo o calibrando: no esperar en la cola, contestar con lo último que se supo.
    if (imp.pendientes > 0 && ultimoEstado) return { ...base, ...ultimoEstado, ocupada: true };
    // Nunca devuelve error: un tropiezo con la impresora no es "el Samsung no responde".
    try { ultimoEstado = await imp.turno(estadoImpresora); return { ...base, ...ultimoEstado }; }
    catch (e) { return { ...base, estado: null, errorImpresora: e.message }; }
  },

  'GET /api/version': async () => ({ ...leerJSON(F_VERSION, {}), repo: ACT_REPO, rama: ACT_RAMA, cadaMinutos: ACT_MIN }),
  'POST /api/actualizar': async () => {
    try { return await actualizar(); }
    catch (e) { throw Object.assign(new Error(`No se pudo actualizar: ${e.message}`), { codigo: 502 }); }
  },

  'PUT /api/perfiles': async (q, body) => {
    const ps = body && body.perfiles;
    if (!ps || typeof ps !== 'object') throw Object.assign(new Error('Faltan perfiles'), { codigo: 400 });
    for (const [id, p] of Object.entries(ps)) {
      if (!/^[a-z0-9-]{1,40}$/.test(id)) throw Object.assign(new Error(`Id de perfil inválido: ${id}`), { codigo: 400 });
      if (!(p.ancho > 0 && p.alto > 0)) throw Object.assign(new Error(`${p.nombre}: falta el tamaño`), { codigo: 400 });
      if (!SENSORES.includes(p.sensor)) throw Object.assign(new Error(`${p.nombre}: sensor inválido`), { codigo: 400 });
      if (Math.round(anchoTotal(p) * PUNTOS_MM) + (p.referenciaX | 0) > ANCHO_CABEZAL + 16) throw Object.assign(new Error(`${p.nombre}: el ancho total pasa los 108 mm del cabezal`), { codigo: 400 });
    }
    guardarJSON(F_PERFILES, ps);
    log('Perfiles actualizados:', Object.keys(ps).join(', '));
    return { ok: true };
  },

  // Cambio de rollo: sensor del perfil + calibración (salvo papel continuo).
  'POST /api/rollo': async (q, body) => {
    const p = perfiles()[body.perfil];
    if (!p) throw Object.assign(new Error('Perfil desconocido'), { codigo: 404 });
    return imp.turno(async () => {
      await setval('media_sensor', p.sensor);
      await esperar(300);
      const sensor = await getval('media_sensor');
      if (sensor !== p.sensor) throw new Error(`La impresora no aceptó el sensor (quedó en "${sensor}")`);
      if (p.sensor !== 'continuous' && !body.sinCalibrar) { await accion('calibrate_sensor'); await esperarLista(); }
      guardarJSON(F_ESTADO, { ...estadoGuardado(), perfil: body.perfil, desde: new Date().toISOString() });
      log(`Rollo cambiado a "${p.nombre}" (sensor ${sensor})`);
      return { ok: true, sensor };
    });
  },

  'POST /api/calibrar': async () => imp.turno(async () => {
    await accion('calibrate_sensor');
    await esperarLista();
    log('Calibración hecha');
    return { ok: true };
  }),

  'POST /api/prueba': async (q, body) => {
    const id = body.perfil || estadoGuardado().perfil;
    const p = perfiles()[id];
    if (!p) throw Object.assign(new Error('Perfil desconocido'), { codigo: 404 });
    return imp.turno(async () => {
      await verificarParaImprimir(id);
      await imp.escribir(trabajoPrueba(p));
      log(`Prueba de márgenes: ${p.nombre}`);
      return { ok: true };
    });
  },

  'POST /api/imprimir': async (q, body) => {
    const p = perfiles()[body.perfil];
    if (!p) throw Object.assign(new Error('Perfil desconocido'), { codigo: 404 });
    const copias = Math.min(Math.max(1, body.copias | 0), 500);
    const trabajo = trabajoBitmap(p, body.bits, body.ancho | 0, body.alto | 0, copias);
    return imp.turno(async () => {
      await verificarParaImprimir(body.perfil);
      await imp.escribir(trabajo);
      log(`Impresas ${copias} etiqueta(s) "${body.nombre || 'sin nombre'}" en ${p.nombre} (${trabajo.length} bytes)`);
      return { ok: true, copias };
    });
  },

  'GET /api/plantillas': async () => {
    fs.mkdirSync(DIR_PLANT, { recursive: true });
    return fs.readdirSync(DIR_PLANT).filter(f => f.endsWith('.json')).map(f => {
      const t = leerJSON(path.join(DIR_PLANT, f), {});
      return { id: f.slice(0, -5), nombre: t.nombre, perfil: t.perfil, base: !!t.base, modificada: t.modificada };
    }).sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
  },
  'GET /api/plantilla': async q => {
    const t = leerJSON(rutaPlantilla(q.get('id')), null);
    if (!t) throw Object.assign(new Error('No existe'), { codigo: 404 });
    return t;
  },
  'PUT /api/plantilla': async (q, body) => {
    // Una plantilla base solo se reemplaza si se pidió a propósito (?original=1).
    if (q.get('id') && !q.get('original') && leerJSON(rutaPlantilla(q.get('id')), {}).base) {
      throw Object.assign(new Error('Es una plantilla base: guárdala como nueva o toca "Modificar la original".'), { codigo: 409 });
    }
    const id = q.get('id') || `${(body.nombre || 'plantilla').toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'plantilla'}-${crypto.randomBytes(3).toString('hex')}`;
    guardarJSON(rutaPlantilla(id), { ...body, modificada: new Date().toISOString() });
    return { ok: true, id };
  },
  'DELETE /api/plantilla': async q => {
    fs.rmSync(rutaPlantilla(q.get('id')), { force: true });
    return { ok: true };
  },
};

function rutaPlantilla(id) {
  if (!/^[a-z0-9-]{1,60}$/.test(id || '')) throw Object.assign(new Error('Id inválido'), { codigo: 400 });
  return path.join(DIR_PLANT, `${id}.json`);
}

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

function servirArchivo(res, ruta) {
  const f = path.normalize(path.join(PUBLICO, ruta === '/' ? 'index.html' : ruta));
  if (!f.startsWith(PUBLICO) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end('No existe'); }
  res.writeHead(200, { 'Content-Type': TIPOS[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
}

const MAX_CUERPO = 20 * 1024 * 1024;   // plantillas con imagen de fondo

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const ruta = RUTAS[`${req.method} ${url.pathname}`];
  if (!ruta) return req.method === 'GET' ? servirArchivo(res, url.pathname) : (res.writeHead(404), res.end());
  const partes = []; let largo = 0;
  req.on('data', d => { largo += d.length; if (largo > MAX_CUERPO) req.destroy(); else partes.push(d); });
  req.on('end', async () => {
    let cuerpo = {};
    try { if (partes.length) cuerpo = JSON.parse(Buffer.concat(partes).toString('utf8')); } catch (e) { cuerpo = null; }
    try {
      if (cuerpo === null) throw Object.assign(new Error('JSON inválido'), { codigo: 400 });
      const r = await ruta(url.searchParams, cuerpo);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(r));
    } catch (e) {
      if (!e.codigo) log('Error en', url.pathname, '→', e.message);
      res.writeHead(e.codigo || 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}).listen(WEB_PUERTO, '0.0.0.0', () => log(`Etiquetas: página en http://${NOMBRE_LOCAL}:${WEB_PUERTO}  ·  impresora ${IMP_HOST}:${IMP_PUERTO}`));

// ─── Nombre en la red local (mDNS) ──────────────────────────────────
// Contesta "etiche.local = IP de este celular" a quien pregunte por
// multicast (iPhone, iPad, Mac, Windows). Sin dependencias.
// La IP se averigua "conectando" un socket UDP hacia la impresora: en
// Android os.networkInterfaces() puede fallar por permisos.
let ipPropia = null;
function averiguarIP() {
  const s = dgram.createSocket('udp4');
  s.on('error', () => s.close());
  s.connect(9, IMP_HOST, () => {
    try { ipPropia = s.address().address; } catch (e) { /* sin red */ }
    s.close();
  });
}
averiguarIP();
setInterval(averiguarIP, 60000);

function nombreDNS(b, o) {
  const partes = [];
  for (let saltos = 0; o < b.length && saltos < 20; saltos++) {
    const n = b[o];
    if (n === 0) return { nombre: partes.join('.'), fin: o + 1 };
    if ((n & 0xc0) === 0xc0) {                       // puntero de compresión
      const r = nombreDNS(b, ((n & 0x3f) << 8) | b[o + 1]);
      return { nombre: [...partes, r.nombre].filter(Boolean).join('.'), fin: o + 2 };
    }
    partes.push(b.subarray(o + 1, o + 1 + n).toString('latin1'));
    o += n + 1;
  }
  return { nombre: partes.join('.'), fin: o };
}
const codificarNombre = n => Buffer.concat([...n.split('.').map(p => Buffer.concat([Buffer.from([p.length]), Buffer.from(p)])), Buffer.from([0])]);

function respuestaMDNS(id, pregunta) {
  const nom = codificarNombre(NOMBRE_LOCAL);
  const cab = Buffer.alloc(12);
  cab.writeUInt16BE(id, 0); cab.writeUInt16BE(0x8400, 2);          // respuesta autoritativa
  cab.writeUInt16BE(pregunta ? 1 : 0, 4); cab.writeUInt16BE(1, 6);
  const resp = Buffer.alloc(10 + 4);
  resp.writeUInt16BE(1, 0); resp.writeUInt16BE(pregunta ? 1 : 0x8001, 2);   // A, IN (+flush)
  resp.writeUInt32BE(120, 4); resp.writeUInt16BE(4, 8);
  ipPropia.split('.').forEach((n, i) => { resp[10 + i] = +n; });
  const q = pregunta ? Buffer.concat([nom, Buffer.from([0, 1, 0, 1])]) : Buffer.alloc(0);
  return Buffer.concat([cab, q, nom, resp]);
}

const mdns = dgram.createSocket({ type: 'udp4', reuseAddr: true });
mdns.on('error', e => log('mDNS:', e.message));
mdns.on('message', (b, de) => {
  if (b.length < 12 || (b[2] & 0x80) || !ipPropia) return;          // solo consultas
  const preguntas = b.readUInt16BE(4);
  let o = 12;
  for (let i = 0; i < preguntas && o < b.length; i++) {
    const { nombre, fin } = nombreDNS(b, o);
    const tipo = b.readUInt16BE(fin), clase = b.readUInt16BE(fin + 2);
    o = fin + 4;
    if (nombre.toLowerCase() !== NOMBRE_LOCAL || (tipo !== 1 && tipo !== 255)) continue;
    if (de.port !== 5353) {                                           // consulta "legacy": unicast con el mismo id
      mdns.send(respuestaMDNS(b.readUInt16BE(0), true), de.port, de.address);
    } else {
      mdns.send(respuestaMDNS(0, false), 5353, '224.0.0.251');
      if (clase & 0x8000) mdns.send(respuestaMDNS(0, false), 5353, de.address);   // pidió respuesta unicast
    }
  }
});
mdns.bind(5353, () => {
  try { mdns.addMembership('224.0.0.251'); mdns.setMulticastTTL(255); } catch (e) { log('mDNS:', e.message); }
  log(`Nombre local: ${NOMBRE_LOCAL}`);
  // Anuncio al arrancar (cuando ya se sabe la IP).
  setTimeout(() => { if (ipPropia) mdns.send(respuestaMDNS(0, false), 5353, '224.0.0.251'); }, 3000);
});
