// Lectura de tablas para imprimir una etiqueta por fila: .xlsx (Excel),
// .csv y el texto que deja Excel al copiar (separado por tabuladores).
// Devuelve siempre filas de texto tal como se verían en la celda.
// El .xlsx es un zip: se lee con DecompressionStream del navegador, sin librerías.
'use strict';

const Excel = (() => {
  // ─── Texto separado (CSV / pegado desde Excel) ──────────────────
  function separadorDe(texto) {
    const linea = texto.split(/\r?\n/, 1)[0].replace(/"[^"]*"/g, '');
    let mejor = '\t', n = 0;
    for (const s of ['\t', ';', ',']) {
      const k = linea.split(s).length - 1;
      if (k > n) { mejor = s; n = k; }
    }
    return mejor;
  }

  function leerTexto(texto, sep) {
    texto = String(texto).replace(/^﻿/, '');
    sep = sep || separadorDe(texto);
    const filas = []; let fila = [], celda = '', comillas = false;
    for (let i = 0; i < texto.length; i++) {
      const ch = texto[i];
      if (comillas) {
        if (ch === '"') {
          if (texto[i + 1] === '"') { celda += '"'; i++; } else comillas = false;
        } else celda += ch;
      } else if (ch === '"' && celda === '') comillas = true;
      else if (ch === sep) { fila.push(celda); celda = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && texto[i + 1] === '\n') i++;
        fila.push(celda); filas.push(fila); fila = []; celda = '';
      } else celda += ch;
    }
    if (celda !== '' || fila.length) { fila.push(celda); filas.push(fila); }
    return filas;
  }

  // Excel en Windows guarda el CSV en ANSI (1252); si no es UTF-8 válido se lee así.
  function decodificar(buf) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch (e) { return new TextDecoder('windows-1252').decode(buf); }
  }

  // ─── Zip ─────────────────────────────────────────────────────────
  function leerZip(buf) {
    const d = new DataView(buf), u8 = new Uint8Array(buf);
    let fin = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
      if (d.getUint32(i, true) === 0x06054b50) { fin = i; break; }
    }
    if (fin < 0) throw new Error('El archivo no es un Excel (.xlsx) válido');
    const total = d.getUint16(fin + 10, true);
    let p = d.getUint32(fin + 16, true);
    const archivos = new Map(), dec = new TextDecoder();
    for (let k = 0; k < total; k++) {
      if (d.getUint32(p, true) !== 0x02014b50) break;
      const metodo = d.getUint16(p + 10, true), tam = d.getUint32(p + 20, true);
      const ln = d.getUint16(p + 28, true), le = d.getUint16(p + 30, true), lc = d.getUint16(p + 32, true);
      const local = d.getUint32(p + 42, true);
      const nombre = dec.decode(u8.subarray(p + 46, p + 46 + ln));
      const ini = local + 30 + d.getUint16(local + 26, true) + d.getUint16(local + 28, true);
      archivos.set(nombre, { metodo, datos: u8.subarray(ini, ini + tam) });
      p += 46 + ln + le + lc;
    }
    return archivos;
  }

  async function sacar(archivos, nombre) {
    const a = archivos.get(nombre);
    if (!a) return null;
    if (a.metodo === 0) return new TextDecoder().decode(a.datos);
    if (a.metodo !== 8) throw new Error('El Excel usa una compresión que no se puede leer aquí');
    if (typeof DecompressionStream !== 'function') throw new Error('Este navegador no puede abrir .xlsx; pega las filas desde Excel o actualiza el navegador');
    const s = new Blob([a.datos]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(s).text();
  }

  const xml = t => new DOMParser().parseFromString(t, 'application/xml');
  const etiquetas = (n, tag) => [...n.getElementsByTagNameNS('*', tag)];
  const hijos = (n, tag) => [...n.children].filter(c => c.localName === tag);

  // ─── Formato de números y fechas ────────────────────────────────
  const FORMATOS = { 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00',
    14: 'dd/mm/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM',
    20: 'h:mm', 21: 'h:mm:ss', 22: 'dd/mm/yyyy h:mm', 37: '#,##0 ;(#,##0)', 38: '#,##0 ;(#,##0)',
    39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;(#,##0.00)', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0', 49: '@' };

  // Primera sección del formato sin textos entre comillas ni [colores].
  const limpio = f => f.split(';')[0].replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
  const esFecha = f => /[dmyhs]/i.test(limpio(f).replace(/General/gi, '').replace(/E[+-]/gi, ''));

  function fecha(v, f) {
    const t = new Date(Math.round((v - 25569) * 86400) * 1000);
    const dd = String(t.getUTCDate()).padStart(2, '0'), mm = String(t.getUTCMonth() + 1).padStart(2, '0');
    const hh = String(t.getUTCHours()).padStart(2, '0'), mi = String(t.getUTCMinutes()).padStart(2, '0');
    const l = limpio(f).toLowerCase();
    const conDia = /[dy]/.test(l), conHora = /h|ss/.test(l);
    const parteDia = `${dd}/${mm}/${t.getUTCFullYear()}`, parteHora = `${hh}:${mi}`;
    return conDia && conHora ? `${parteDia} ${parteHora}` : conHora ? parteHora : parteDia;
  }

  // Textos fijos del formato: "S/" , \€ , [$S/-280A] , espacios, paréntesis…
  function literales(seccion) {
    let antes = '', despues = '', visto = false;
    const re = /"([^"]*)"|\\(.)|\[\$([^\]-]*)[^\]]*\]|\[[^\]]*\]|[_*].|([0#?.,]+)|(.)/g;
    for (const m of seccion.matchAll(re)) {
      const lit = m[1] ?? m[2] ?? m[3] ?? m[5] ?? null;
      if (m[4] && /[0#?]/.test(m[4])) { visto = true; continue; }
      if (lit == null) continue;
      if (visto) despues += lit; else antes += lit;
    }
    return { antes, despues };
  }

  function numero(v, f) {
    if (!f || /^general$/i.test(f) || f === '@') return String(+v.toPrecision(15));
    if (esFecha(f)) return fecha(v, f);
    const secciones = f.split(';');
    const sec = v < 0 && secciones[1] ? secciones[1] : secciones[0];
    const l = limpio(sec);
    if (/E[+-]/i.test(l)) return String(+v.toPrecision(15));
    const pct = l.includes('%');
    const dec = (l.split('.')[1] || '').replace(/[^0#?]/g, '').length;
    const miles = /[0#?],[0#?]/.test(l);
    let n = Math.abs(pct ? v * 100 : v);
    if (v < 0 && !secciones[1]) n = -n;
    const txt = n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: miles });
    const { antes, despues } = literales(sec);
    return (antes + txt + despues).trim();
  }

  // ─── Libro .xlsx ────────────────────────────────────────────────
  const columna = ref => {
    const letras = (/^[A-Z]+/i.exec(ref || '') || [''])[0].toUpperCase();
    let n = 0; for (const ch of letras) n = n * 26 + ch.charCodeAt(0) - 64;
    return n - 1;
  };
  // Texto de una celda; se omiten las lecturas fonéticas (<rPh>).
  const texto = n => etiquetas(n, 't').filter(t => t.parentNode.localName !== 'rPh').map(t => t.textContent).join('');

  async function leerXlsx(buf) {
    const z = leerZip(buf);
    const libro = await sacar(z, 'xl/workbook.xml');
    if (!libro) throw new Error('El archivo no es un Excel (.xlsx) válido');
    const rels = xml(await sacar(z, 'xl/_rels/workbook.xml.rels') || '<r/>');
    const destino = {};
    for (const r of etiquetas(rels, 'Relationship')) {
      const t = r.getAttribute('Target');
      destino[r.getAttribute('Id')] = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
    }
    const compartidos = [];
    const ss = await sacar(z, 'xl/sharedStrings.xml');
    if (ss) for (const si of etiquetas(xml(ss), 'si')) compartidos.push(texto(si));

    const formatoDeEstilo = [];
    const est = await sacar(z, 'xl/styles.xml');
    if (est) {
      const e = xml(est), propios = {};
      for (const f of etiquetas(e, 'numFmt')) propios[f.getAttribute('numFmtId')] = f.getAttribute('formatCode');
      const xfs = etiquetas(e, 'cellXfs')[0];
      if (xfs) for (const xf of hijos(xfs, 'xf')) {
        const id = xf.getAttribute('numFmtId') || '0';
        formatoDeEstilo.push(propios[id] || FORMATOS[id] || '');
      }
    }

    const hojas = [];
    for (const h of etiquetas(xml(libro), 'sheet')) {
      const rid = h.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || h.getAttribute('r:id');
      const contenido = destino[rid] && await sacar(z, destino[rid]);
      if (!contenido) continue;
      const filas = [];
      let numFila = 0;
      for (const r of etiquetas(xml(contenido), 'row')) {
        numFila = +r.getAttribute('r') || numFila + 1;
        const fila = [];
        let col = -1;
        for (const c of hijos(r, 'c')) {
          col = c.getAttribute('r') ? columna(c.getAttribute('r')) : col + 1;
          const tipo = c.getAttribute('t'), v = hijos(c, 'v')[0], crudo = v ? v.textContent : '';
          let val = '';
          if (tipo === 's') val = compartidos[+crudo] ?? '';
          else if (tipo === 'inlineStr') val = hijos(c, 'is').map(texto).join('');
          else if (tipo === 'str' || tipo === 'e') val = crudo;
          else if (tipo === 'b') val = crudo === '1' ? 'VERDADERO' : 'FALSO';
          else if (crudo !== '') val = numero(+crudo, formatoDeEstilo[+c.getAttribute('s') || 0]);
          fila[col] = val;
        }
        filas[numFila - 1] = Array.from(fila, x => x ?? '');
      }
      hojas.push({ nombre: h.getAttribute('name') || `Hoja ${hojas.length + 1}`, filas: Array.from(filas, x => x || []) });
    }
    if (!hojas.length) throw new Error('El Excel no tiene hojas con datos');
    return hojas;
  }

  async function leerArchivo(archivo) {
    const buf = await archivo.arrayBuffer();
    const u8 = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
    if (u8[0] === 0x50 && u8[1] === 0x4b) return leerXlsx(buf);
    if (u8[0] === 0xd0 && u8[1] === 0xcf) throw new Error('Es un Excel antiguo (.xls). Guárdalo como .xlsx o pega las filas desde Excel.');
    return [{ nombre: archivo.name, filas: leerTexto(decodificar(buf)) }];
  }

  return { leerTexto, leerArchivo };
})();
