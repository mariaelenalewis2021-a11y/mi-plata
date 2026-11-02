/**
 * Mi Plata · servidor (Google Apps Script) — rev 1.1
 * Cuenta: mariaelenalewis2021@gmail.com · Datos: planilla «Mi Plata · Datos» en su Drive.
 *
 * Seguridad:
 *  - PIN de 6 a 8 dígitos elegido por el dueño en la app (nunca por chat): sal + pimienta, SHA-256 iterado.
 *  - El alta del PIN solo es posible durante 60 min después de correr prepararMiPlata() en el editor.
 *  - Sesiones por dispositivo: token aleatorio (se guarda solo su hash), vence a los 30 días sin uso, revocable.
 *  - 5 PIN incorrectos = bloqueo 15 min; al 3.er bloqueo seguido, 24 h.
 *  - Validación estricta de cada movimiento en el servidor; LockService en escrituras; sin fórmulas inyectables.
 *  - Permiso pedido: solo Hojas de cálculo (SpreadsheetApp).
 */
const REV = '1.1';
const TZ = 'America/Argentina/Buenos_Aires';
const P = PropertiesService.getScriptProperties();
const COLS = ['ID', 'Fecha', 'Tipo', 'Monto', 'Categoría', 'Medio', 'Detalle', 'Descuento', 'Cuota', 'Grupo', 'Fijo', 'Creado'];
const TOKEN_DIAS = 30, MAX_TOKENS = 10, ITER = 3000;

/* ---------------- preparación (correr una vez desde el editor) ---------------- */
function prepararMiPlata() {
  let id = P.getProperty('SS_ID'), ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('Mi Plata · Datos');
    P.setProperty('SS_ID', ss.getId());
  }
  hoja_(ss, 'Movimientos', COLS);
  hoja_(ss, 'Config', ['Configuración (JSON, la escribe la app)']);
  hoja_(ss, 'Historial', ['Fecha y hora', 'Acción', 'Detalle']);
  const def = ss.getSheetByName('Hoja 1') || ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);
  if (!P.getProperty('PEPPER')) P.setProperty('PEPPER', Utilities.getUuid() + Utilities.getUuid());
  const tienePin = !!P.getProperty('PIN');
  if (!tienePin) P.setProperty('SETUP_HASTA', String(Date.now() + 60 * 60 * 1000));
  log_('preparar', tienePin ? 'planilla verificada' : 'alta de PIN habilitada 60 min');
  Logger.log('MI_PLATA ' + JSON.stringify({ rev: REV, planilla: ss.getUrl(), pinConfigurado: tienePin, altaPinHasta: tienePin ? null : new Date(+P.getProperty('SETUP_HASTA')).toString() }));
}
/** Si te olvidaste el PIN: correr esto en el editor (borra PIN y sesiones; los datos quedan) y luego prepararMiPlata(). */
function resetearPin() {
  ['PIN', 'TOKENS', 'FALLOS'].forEach(k => P.deleteProperty(k));
  log_('reset_pin', 'PIN y sesiones borrados desde el editor');
  Logger.log('PIN borrado. Corré prepararMiPlata() para habilitar el alta de un PIN nuevo.');
}
function hoja_(ss, nombre, enc) {
  let sh = ss.getSheetByName(nombre);
  if (!sh) sh = ss.insertSheet(nombre);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, enc.length).setValues([enc]).setFontWeight('bold').setBackground('#312e81').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    if (nombre === 'Movimientos') {
      sh.getRange('A:C').setNumberFormat('@'); sh.getRange('E:L').setNumberFormat('@');
      sh.getRange('D:D').setNumberFormat('#,##0.00'); sh.getRange('H:H').setNumberFormat('#,##0.00');
    }
  }
  return sh;
}
const ss_ = () => { const id = P.getProperty('SS_ID'); if (!id) throw err_('Falta preparar el servidor.', 'SETUP'); return SpreadsheetApp.openById(id); };
function log_(accion, detalle) {
  try { const id = P.getProperty('SS_ID'); if (!id) return; const sh = SpreadsheetApp.openById(id).getSheetByName('Historial'); if (sh) sh.appendRow([Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'), accion, String(detalle || '').slice(0, 200)]); } catch (e) {}
}

/* ---------------- HTTP ---------------- */
function doGet() { return json_({ ok: true, app: 'MiPlata', rev: REV, pinConfigurado: !!P.getProperty('PIN') }); }
function doPost(e) {
  try {
    const raw = e && e.postData ? e.postData.contents : '';
    if (!raw || raw.length > 2e6) throw err_('Pedido inválido.');
    const q = JSON.parse(raw);
    const a = String(q.accion || '');
    if (a === 'estado') return json_({ ok: true, rev: REV, pinConfigurado: !!P.getProperty('PIN'), altaHabilitada: altaHabilitada_() });
    if (a === 'configurarPin') return json_(configurarPin_(q.pin, q.disp));
    if (a === 'login') return json_(login_(q.pin, q.disp));
    const ses = sesion_(q.token);
    switch (a) {
      case 'datos': return json_(datos_());
      case 'alta': return json_(conLock_(() => alta_(q.items)));
      case 'editar': return json_(conLock_(() => editar_(q.item)));
      case 'borrar': return json_(conLock_(() => borrar_(q.ids)));
      case 'borrarGrupo': return json_(conLock_(() => borrarGrupo_(q.g)));
      case 'cfg': return json_(conLock_(() => guardarCfg_(q.cfg)));
      case 'borrarTodo': return json_(conLock_(() => borrarTodo_(q.confirmar)));
      case 'sesiones': return json_({ ok: true, sesiones: tokens_().map(t => ({ disp: t.disp, ult: t.ult, actual: t.h === ses.h })) });
      case 'logout': revocar_(ses.h, !!q.todas); return json_({ ok: true });
      default: throw err_('Acción desconocida.');
    }
  } catch (x) {
    return json_({ ok: false, error: x && x.publico ? x.message : 'Error del servidor.', code: (x && x.code) || 'ERR' });
  }
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function err_(m, code) { const e = new Error(m); e.publico = true; e.code = code || 'ERR'; return e; }
function conLock_(fn) { const l = LockService.getScriptLock(); if (!l.tryLock(20000)) throw err_('El servidor está ocupado, reintentá.', 'BUSY'); try { return fn(); } finally { l.releaseLock(); } }

/* ---------------- PIN y sesiones ---------------- */
const altaHabilitada_ = () => !P.getProperty('PIN') && Date.now() < Number(P.getProperty('SETUP_HASTA') || 0);
function hashPin_(pin, sal) {
  let h = sal + '|' + P.getProperty('PEPPER') + '|' + pin;
  let b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8);
  for (let i = 0; i < ITER; i++) b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, b.concat(Utilities.newBlob(sal).getBytes()));
  return Utilities.base64Encode(b);
}
const sha_ = s => Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8));
const pinValido_ = pin => typeof pin === 'string' && /^\d{6,8}$/.test(pin) && !/^(\d)\1+$/.test(pin) && !'0123456789012345678'.includes(pin) && !'9876543210987654321'.includes(pin);
function configurarPin_(pin, disp) {
  return conLock_(() => {
    if (P.getProperty('PIN')) throw err_('El PIN ya está configurado.', 'YA');
    if (!altaHabilitada_()) throw err_('El alta del PIN no está habilitada. Hay que correr prepararMiPlata() en el editor.', 'SETUP');
    if (!pinValido_(pin)) throw err_('Elegí un PIN de 6 a 8 números, que no sea repetido ni correlativo.', 'PIN');
    const sal = Utilities.getUuid();
    P.setProperty('PIN', JSON.stringify({ sal: sal, h: hashPin_(pin, sal), desde: new Date().toISOString() }));
    P.deleteProperty('SETUP_HASTA');
    log_('pin_configurado', 'desde ' + limpiarDisp_(disp));
    return Object.assign({ ok: true }, nuevaSesion_(disp));
  });
}
function login_(pin, disp) {
  const cfg = JSON.parse(P.getProperty('PIN') || 'null');
  if (!cfg) throw err_(altaHabilitada_() ? 'Todavía no elegiste tu PIN.' : 'El servidor no tiene PIN. Hay que correr prepararMiPlata().', 'SINPIN');
  const F = JSON.parse(P.getProperty('FALLOS') || '{"n":0,"hasta":0,"bloq":0}');
  if (Date.now() < F.hasta) throw err_('Demasiados intentos. Probá de nuevo en ' + Math.ceil((F.hasta - Date.now()) / 60000) + ' min.', 'BLOQ');
  const ok = typeof pin === 'string' && pin.length <= 8 && hashPin_(pin, cfg.sal) === cfg.h;
  if (!ok) {
    F.n++;
    if (F.n >= 5) { F.bloq++; F.n = 0; F.hasta = Date.now() + (F.bloq >= 3 ? 24 * 3600e3 : 15 * 60e3); log_('bloqueo', 'PIN incorrecto 5 veces (bloqueo ' + F.bloq + ')'); }
    P.setProperty('FALLOS', JSON.stringify(F));
    throw err_(F.hasta > Date.now() ? 'PIN incorrecto. Acceso bloqueado por un rato.' : 'PIN incorrecto.', 'PIN');
  }
  P.setProperty('FALLOS', JSON.stringify({ n: 0, hasta: 0, bloq: 0 }));
  log_('login', limpiarDisp_(disp));
  return Object.assign({ ok: true }, nuevaSesion_(disp));
}
const limpiarDisp_ = d => String(d || 'dispositivo').replace(/[^\w áéíóúñÁÉÍÓÚÑ().,\/-]/g, '').slice(0, 60);
function tokens_() { const ahora = Date.now(); return JSON.parse(P.getProperty('TOKENS') || '[]').filter(t => t.exp > ahora); }
function nuevaSesion_(disp) {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const L = tokens_(); L.push({ h: sha_(token), exp: Date.now() + TOKEN_DIAS * 864e5, ult: new Date().toISOString(), disp: limpiarDisp_(disp) });
  while (L.length > MAX_TOKENS) L.shift();
  P.setProperty('TOKENS', JSON.stringify(L));
  return { token: token, dias: TOKEN_DIAS };
}
function sesion_(token) {
  if (typeof token !== 'string' || token.length !== 64) throw err_('Sesión vencida. Ingresá tu PIN.', 'AUTH');
  const h = sha_(token), L = tokens_(), t = L.find(x => x.h === h);
  if (!t) throw err_('Sesión vencida. Ingresá tu PIN.', 'AUTH');
  if (Date.now() - new Date(t.ult).getTime() > 3600e3) { t.ult = new Date().toISOString(); t.exp = Date.now() + TOKEN_DIAS * 864e5; P.setProperty('TOKENS', JSON.stringify(L)); }
  return t;
}
function revocar_(h, todas) { P.setProperty('TOKENS', JSON.stringify(todas ? [] : tokens_().filter(t => t.h !== h))); log_('logout', todas ? 'todas las sesiones' : 'una sesión'); }

/* ---------------- datos ---------------- */
const txt_ = (v, n) => { let s = String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n); if (/^[=+\-@]/.test(s)) s = "'" + s; return s; };
const sinApos_ = s => String(s || '').replace(/^'/, '');
function item_(x) {
  if (!x || typeof x !== 'object') throw err_('Movimiento inválido.');
  const m = Number(x.m), d = x.d == null || x.d === '' ? 0 : Number(x.d);
  if (typeof x.id !== 'string' || !/^[\w-]{4,40}$/.test(x.id)) throw err_('Movimiento sin ID válido.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(x.f))) throw err_('Fecha inválida.');
  if (x.t !== 'e' && x.t !== 'i') throw err_('Tipo inválido.');
  if (!(isFinite(m) && m > 0 && m < 1e12)) throw err_('Monto inválido.');
  if (!(isFinite(d) && d >= 0 && d < 1e12)) throw err_('Descuento inválido.');
  return [x.id, String(x.f), x.t, Math.round(m * 100) / 100, txt_(x.c, 40) || 'Otros', txt_(x.p, 30) || 'Efectivo', txt_(x.n, 120), d ? Math.round(d * 100) / 100 : '',
    /^\d{1,2}\/\d{1,2}$/.test(String(x.q || '')) ? String(x.q) : '', /^[\w-]{0,40}$/.test(String(x.g || '')) ? String(x.g || '') : '', /^[\w-]{0,40}$/.test(String(x.fx || '')) ? String(x.fx || '') : '',
    String(Number(x.ts) || Date.now())];
}
function fila2item_(r) {
  const o = { id: String(r[0]), f: String(r[1]).slice(0, 10), t: String(r[2]), m: Number(r[3]), c: sinApos_(r[4]), p: sinApos_(r[5]), n: sinApos_(r[6]), ts: Number(r[11]) || 0 };
  if (Number(r[7]) > 0) o.d = Number(r[7]); if (r[8]) o.q = String(r[8]); if (r[9]) o.g = String(r[9]); if (r[10]) o.fx = String(r[10]);
  return o;
}
function movs_() { const sh = ss_().getSheetByName('Movimientos'); const n = sh.getLastRow() - 1; return { sh: sh, filas: n > 0 ? sh.getRange(2, 1, n, COLS.length).getValues() : [] }; }
function datos_() {
  const M = movs_(), items = M.filas.filter(r => r[0]).map(fila2item_);
  const c = ss_().getSheetByName('Config').getRange('A2').getValue();
  let cfg = null; try { cfg = c ? JSON.parse(c) : null; } catch (e) {}
  return { ok: true, rev: REV, items: items, cfg: cfg, leido: new Date().toISOString() };
}
function alta_(items) {
  if (!Array.isArray(items) || !items.length || items.length > 2000) throw err_('Nada para guardar.');
  const M = movs_(), ya = new Set(M.filas.map(r => String(r[0])));
  const filas = items.map(item_).filter(r => { if (ya.has(r[0])) return false; ya.add(r[0]); return true; });
  if (filas.length) M.sh.getRange(M.sh.getLastRow() + 1, 1, filas.length, COLS.length).setValues(filas);
  if (items.length > 20) log_('importar', filas.length + ' movimientos');
  return { ok: true, guardados: filas.length, repetidos: items.length - filas.length };
}
function filaDe_(sh, id) {
  if (typeof id !== 'string' || !/^[\w-]{4,40}$/.test(id)) return 0;
  const r = sh.getRange('A:A').createTextFinder(id).matchEntireCell(true).findNext();
  return r ? r.getRow() : 0;
}
/** Borra una fila sin chocar con el límite de Sheets (no se pueden borrar todas las filas no fijas). */
function quitarFila_(sh, r) { if (sh.getMaxRows() <= 2) sh.getRange(r, 1, 1, COLS.length).clearContent(); else sh.deleteRow(r); }
function editar_(x) {
  const fila = item_(x), M = movs_(), n = filaDe_(M.sh, fila[0]);
  if (!n || n < 2) throw err_('Ese movimiento ya no existe.', 'NOEXISTE');
  M.sh.getRange(n, 1, 1, COLS.length).setValues([fila]);
  return { ok: true };
}
function borrar_(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 500) throw err_('Nada para borrar.');
  const M = movs_(), set = new Set(ids.map(String)); let n = 0;
  for (let i = M.filas.length - 1; i >= 0; i--) if (set.has(String(M.filas[i][0]))) { quitarFila_(M.sh, i + 2); n++; }
  return { ok: true, borrados: n };
}
function borrarGrupo_(g) {
  if (typeof g !== 'string' || !/^[\w-]{4,40}$/.test(g)) throw err_('Grupo inválido.');
  const M = movs_(); let n = 0;
  for (let i = M.filas.length - 1; i >= 0; i--) if (String(M.filas[i][9]) === g) { quitarFila_(M.sh, i + 2); n++; }
  return { ok: true, borrados: n };
}
function guardarCfg_(cfg) {
  if (!cfg || typeof cfg !== 'object') throw err_('Configuración inválida.');
  const s = JSON.stringify(sanearCfg_(cfg));
  if (s.length > 45000) throw err_('Configuración demasiado grande.');
  const sh = ss_().getSheetByName('Config'); sh.getRange('A2').setNumberFormat('@').setValue(s);
  return { ok: true };
}
function sanearCfg_(c) {
  const cats = a => Array.isArray(a) ? a.filter(x => Array.isArray(x) && typeof x[0] === 'string').slice(0, 40).map(x => [String(x[0]).slice(0, 40), String(x[1] || '•').slice(0, 8)]) : undefined;
  const o = {};
  if (cats(c.catE)) o.catE = cats(c.catE); if (cats(c.catI)) o.catI = cats(c.catI);
  if (Array.isArray(c.medios)) o.medios = c.medios.filter(s => typeof s === 'string').slice(0, 15).map(s => s.slice(0, 30));
  if (c.presu && typeof c.presu === 'object') { o.presu = {}; Object.keys(c.presu).slice(0, 60).forEach(k => { if (Number(c.presu[k]) > 0) o.presu[String(k).slice(0, 40)] = Number(c.presu[k]); }); }
  if (Array.isArray(c.fijos)) o.fijos = c.fijos.filter(f => f && typeof f.n === 'string' && Number(f.m) > 0).slice(0, 60).map(f => ({ id: String(f.id || Utilities.getUuid()).replace(/[^\w-]/g, '').slice(0, 40), t: f.t === 'i' ? 'i' : 'e', n: String(f.n).slice(0, 60), m: Number(f.m), c: String(f.c || 'Otros').slice(0, 40), p: String(f.p || 'Efectivo').slice(0, 30), dia: Math.max(1, Math.min(31, Number(f.dia) || 1)) }));
  if (Number(c.objAhorro) >= 0) o.objAhorro = Math.min(90, Number(c.objAhorro));
  if (Number(c.saldoMP) >= 0) o.saldoMP = Math.min(1e12, Number(c.saldoMP));
  if (Number(c.tnaManual) >= 0) o.tnaManual = Math.min(300, Number(c.tnaManual));
  if ([3, 6, 12, 24].indexOf(Number(c.horiz)) >= 0) o.horiz = Number(c.horiz);
  if (Number(c.recorte) >= 0) o.recorte = Math.min(50, Number(c.recorte));
  if (Number(c.pctMP) >= 0) o.pctMP = Math.min(100, Number(c.pctMP));
  return o;
}
function borrarTodo_(conf) {
  if (conf !== 'BORRAR') throw err_('Falta confirmar.');
  const M = movs_(); const n = M.filas.length;
  if (n) { M.sh.getRange(2, 1, n, COLS.length).clearContent(); if (M.sh.getMaxRows() > n + 1) M.sh.deleteRows(2, n); else if (n > 1) M.sh.deleteRows(3, n - 1); }
  log_('borrar_todo', n + ' movimientos');
  return { ok: true, borrados: n };
}
