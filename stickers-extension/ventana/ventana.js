const $ = (id) => document.getElementById(id);

/* La ventana vive en la carpeta de la extensión y sirve de dos formas:
   - sola, servida por el ayudante en http://localhost:4195 (la extensión le habla por ventana-puente.js);
   - como página de la extensión, dentro del panel encima de WhatsApp Web (habla directo con la extensión). */
const EXT = location.protocol === "chrome-extension:";
const BASE = EXT ? "http://localhost:4195" : "";
const hayExtension = () => EXT || !!document.documentElement.dataset.stickersExt;
function ext(tipo, datos) {
  if (EXT) return chrome.runtime.sendMessage({ stk: tipo, ...datos });
  const id = Math.random().toString(36).slice(2);
  return new Promise((ok) => {
    const oir = (ev) => {
      if (ev.source !== window || !ev.data || ev.data.__stk !== `resultado-${tipo}` || ev.data.id !== id) return;
      window.removeEventListener("message", oir); ok(ev.data);
    };
    window.addEventListener("message", oir);
    window.postMessage({ __stk: `pedir-${tipo}`, id, ...datos }, location.origin);
  });
}
/* lo que se recuerda (paquete, autor, destino, borde): en el panel va a chrome.storage, que no se borra */
const memoria = {
  _cache: {},
  leer(k) { try { return EXT ? (memoria._cache[k] ?? null) : localStorage.getItem(`stk-${k}`); } catch (e) { return null; } },
  guardar(k, v) {
    try { if (EXT) { memoria._cache[k] = v; chrome.storage.local.set({ [k]: v }); } else localStorage.setItem(`stk-${k}`, v); } catch (e) { /* sin memoria */ }
  },
};
const video = $("video"), resultado = $("resultado"), audioSticker = $("audioSticker");
const canvas = $("canvas"), ctx = canvas.getContext("2d"), cMapa = $("canvasMapa"), ctxM = cMapa.getContext("2d");
const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>';
const ICON_PAUSA = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
const C = { onda: "#3A4150", ondaSel: "#25D366", sel: "rgba(37,211,102,.14)", borde: "#25D366", cursor: "#E8EAED", suave: "#8C95A5" };

const EMBEBIDO = new URLSearchParams(location.search).has("embebido");
const st = { id: null, url: "", dur: 0, ancho: 0, alto: 0, titulo: "", ini: 0, fin: 0, v0: 0, v1: 1,
  picos: [], porSeg: 0, tope: 10, encuadre: "cuadrado", pos: 0.5, caja: { l: 1, x: 0, y: 0 }, borde: false, loop: false, hecho: null };

/* ---------- utilidades ---------- */
async function api(ruta, datos) {
  const op = datos ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(datos) } : {};
  const r = await fetch(BASE + ruta, op);
  const j = await r.json().catch(() => ({ error: "El ayudante respondió algo raro" }));
  if (!r.ok || j.error) throw new Error(j.error || r.statusText);
  return j;
}
const kb = (b) => b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`;
const fmt = (s) => s.toFixed(2);
const sal = (n, extra = "") => `${BASE}/salida/${encodeURIComponent(n)}${extra}`;
/* Avisos: SIEMPRE texto plano (títulos de videos, nombres de chats y errores vienen de afuera).
   estadoHtml solo para nuestras plantillas, y todo lo de afuera adentro pasa por esc(). */
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function estado(msj, tipo = "") { const e = $("estado"); e.className = `estado ${tipo}`; e.textContent = msj || ""; }
function estadoHtml(html, tipo = "") { const e = $("estado"); e.className = `estado ${tipo}`; e.innerHTML = html || ""; }

/* ---------- 5s | 10s ---------- */
document.querySelectorAll("[data-tope]").forEach((el) => {
  el.innerHTML = [5, 10, 20, 30].map((t) => `<button type="button" data-t="${t}">${t}s</button>`).join("");
  el.addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (b) ponerTope(+b.dataset.t); });
});
function ponerTope(t, guardar = true) {
  st.tope = t; if (guardar) memoria.guardar("tope", String(t));
  document.querySelectorAll("[data-tope] button").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.t === t)));
  if (st.id) { if (st.fin - st.ini > t) fijar(st.ini, st.ini + t); vistaAlTramo(); pintarDatos(); }
}
ponerTope(10, false);

/* la dirección de la ventana, sin perder el modo panel (?embebido=1) */
function direccion(extra) {
  const u = new URLSearchParams(extra);
  if (document.documentElement.classList.contains("embebido")) u.set("embebido", "1");
  const t = u.toString();
  return location.pathname + (t ? `?${t}` : "");
}

/* ---------- traer el video ---------- */
$("formLink").addEventListener("submit", (ev) => { ev.preventDefault(); traer($("campoLink").value); });
$("formLinkArriba").addEventListener("submit", (ev) => {
  ev.preventDefault(); const u = $("campoLinkArriba").value.trim(); $("campoLinkArriba").value = ""; $("campoLinkArriba").blur();
  pararLoop(); mostrarResultado(false); traer(u);
});
$("campoLinkArriba").addEventListener("paste", (ev) => {
  const t = (ev.clipboardData.getData("text") || "").trim();
  if (/^https?:\/\//.test(t)) { ev.preventDefault(); $("campoLinkArriba").value = t; $("formLinkArriba").requestSubmit(); }
});
document.addEventListener("paste", (ev) => {
  if (ev.target.closest("input")) return;
  const t = (ev.clipboardData.getData("text") || "").trim();
  if (/^https?:\/\//.test(t)) { $("campoLink").value = t; traer(t); }
});
async function traer(url) {
  estado("");
  // con la extensión, el link baja con tus cookies de ese sitio (Instagram casi siempre pide sesión)
  if (hayExtension()) {
    estado("Pidiendo el video…");
    let r;
    try { r = await ext("traer", { url }); } catch (e) { r = { ok: false, error: String(e.message || e) }; }
    r = r || { ok: false, error: "La extensión no respondió" };
    if (r.ok) { estado(""); return seguir(r.id); }
    return estado(r.error || "No se pudo pedir el video", "error");
  }
  try { const { id } = await api("/api/traer", { url }); seguir(id); }
  catch (e) { estado(e.message, "error"); }
}
async function seguir(id) {
  history.replaceState(null, "", direccion({ trabajo: id }));
  $("tarjeta").hidden = false; $("tarjetaLink").hidden = true; $("tarjetaBajando").hidden = false;
  $("bajandoBarra").style.width = "0%"; $("bajandoTitulo").textContent = "Bajando el video…";
  for (;;) {
    let t;
    try { t = await api(`/api/trabajo/${id}`); } catch (e) { return fallo(e.message); }
    if (t.titulo) $("bajandoTitulo").textContent = t.titulo;
    $("bajandoBarra").style.width = `${t.pct || 0}%`;
    $("bajandoTexto").textContent = t.estado === "convirtiendo" ? "Dejándolo listo para verlo aquí" : `${Math.round(t.pct || 0)} %`;
    if (t.estado === "listo") return abrir(t);
    if (t.estado === "error") return fallo(t.error);
    await new Promise((r) => setTimeout(r, 500));
  }
}
function fallo(msj) {
  $("tarjetaLink").hidden = false; $("tarjetaBajando").hidden = true;
  history.replaceState(null, "", direccion({}));
  estado(msj, "error");
}

function abrir(t) {
  Object.assign(st, { id: t.id, url: t.url || "", dur: t.duracion, ancho: t.ancho, alto: t.alto, titulo: t.titulo || "",
    picos: [], porSeg: 0, pos: 0.5, hecho: null });
  st.caja = cajaCentrada(1);
  $("filaMandar").hidden = true; $("btnHacer").classList.remove("listo"); $("datosSticker").hidden = false;
  st.encuadre = st.ancho === st.alto ? "completo" : "cuadrado";
  pintarEncuadre();
  $("tarjeta").hidden = true; $("tarjetaLink").hidden = false; $("tarjetaBajando").hidden = true;
  video.hidden = false; video.src = `${BASE}/fuente/${t.id}.mp4`;
  mostrarResultado(false);
  $("chips").hidden = false; $("abajoVacia").hidden = true; $("abajoLlena").hidden = false;
  $("btnHacer").disabled = false; $("btnBajar").disabled = false;
  fijar(0, Math.min(st.dur, st.tope)); vistaAlTramo();
  estadoHtml(st.titulo ? `<b style="color:var(--texto)">${esc(st.titulo)}</b>` : "");
  api(`/api/onda/${t.id}`).then((o) => { st.picos = o.picos; st.porSeg = o.porSegundo; dibujarTodo(); }).catch(() => {});
  ajustar();
}
function limpiar() {
  pararLoop(); Object.assign(st, { id: null, hecho: null }); $("filaMandar").hidden = true; $("datosSticker").hidden = true;
  video.removeAttribute("src"); video.hidden = true; mostrarResultado(false);
  $("marco").hidden = true; $("chips").hidden = true; $("pista").hidden = true;
  $("tarjeta").hidden = false; $("tarjetaLink").hidden = false; $("tarjetaBajando").hidden = true;
  $("abajoVacia").hidden = false; $("abajoLlena").hidden = true;
  $("btnHacer").disabled = true; $("btnBajar").disabled = true; $("btnHacer").classList.remove("listo");
  $("campoLink").value = ""; estado(""); history.replaceState(null, "", direccion({}));
  $("campoLink").focus();
}
$("limpiar").onclick = limpiar;

/* ---------- la onda ---------- */
function ajustar() {
  for (const [cv, c] of [[canvas, ctx], [cMapa, ctxM]]) {
    const r = cv.parentElement.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  dibujarTodo(); pintarMarco();
}
new ResizeObserver(ajustar).observe($("lienzo"));
new ResizeObserver(ajustar).observe($("escenario"));

function pico(t0, t1) {
  const n = st.picos.length; let p = 0;
  for (let i = Math.max(0, Math.floor(t0 * st.porSeg)), b = Math.min(n, Math.ceil(t1 * st.porSeg)); i < b; i++) if (st.picos[i] > p) p = st.picos[i];
  return p;
}
function barras(c, w, h, a, b, sel) {
  const mid = h / 2, paso = 3;
  for (let x = 0; x < w; x += paso) {
    const t0 = a + x / w * (b - a), t1 = a + (x + paso) / w * (b - a);
    const alto = st.picos.length ? Math.max(1, pico(t0, t1) / 100 * (mid - 3)) : 1;
    c.fillStyle = sel && t1 > st.ini && t0 < st.fin ? C.ondaSel : C.onda;
    c.fillRect(x, mid - alto, 2, alto * 2);
  }
}
const aX = (t, w) => (t - st.v0) / (st.v1 - st.v0) * w;
const aT = (x, w) => st.v0 + x / w * (st.v1 - st.v0);
function dibujar() {
  if (!st.id) return;
  const w = $("lienzo").clientWidth, h = $("lienzo").clientHeight;
  ctx.clearRect(0, 0, w, h);
  const xi = aX(st.ini, w), xf = aX(st.fin, w);
  ctx.fillStyle = C.sel; ctx.beginPath(); ctx.roundRect(xi, 0, xf - xi, h, 8); ctx.fill();
  barras(ctx, w, h, st.v0, st.v1, true);
  ctx.fillStyle = C.borde;
  for (const x of [xi, xf]) { ctx.fillRect(x - 1, 0, 2, h); ctx.beginPath(); ctx.roundRect(x - 4, h / 2 - 11, 8, 22, 4); ctx.fill(); }
  if (!video.paused || st.loop) { const xc = aX(video.currentTime, w); ctx.fillStyle = C.cursor; ctx.fillRect(xc - 1, 0, 2, h); }
}
function dibujarMapa() {
  if (!st.id) return;
  const w = $("mapa").clientWidth, h = $("mapa").clientHeight;
  ctxM.clearRect(0, 0, w, h);
  barras(ctxM, w, h, 0, st.dur, true);
  const a = st.v0 / st.dur * w, b = st.v1 / st.dur * w;
  ctxM.strokeStyle = C.suave; ctxM.lineWidth = 1; ctxM.strokeRect(a + .5, .5, Math.max(4, b - a) - 1, h - 1);
}
function dibujarTodo() { dibujar(); dibujarMapa(); }

function fijar(ini, fin) {
  ini = Math.max(0, Math.min(ini, st.dur)); fin = Math.max(0, Math.min(fin, st.dur));
  if (fin < ini) [ini, fin] = [fin, ini];
  if (fin - ini < 0.1) fin = Math.min(st.dur, ini + 0.1);
  if (fin - ini > st.tope) fin = ini + st.tope;
  st.ini = ini; st.fin = fin; quedoViejo(); pintarDatos(); dibujarTodo();
}
function centrarEn(t) {
  const largo = st.fin - st.ini, ini = Math.max(0, Math.min(st.dur - largo, t - largo / 2));
  st.ini = ini; st.fin = ini + largo; quedoViejo(); pintarDatos();
  if (st.ini < st.v0 || st.fin > st.v1) vistaAlTramo();
}
function vista(a, b) {
  const r = Math.max(0.5, Math.min(st.dur, b - a)); a = Math.max(0, Math.min(st.dur - r, a));
  st.v0 = a; st.v1 = a + r; dibujarTodo();
}
function vistaAlTramo() {
  const r = Math.min(st.dur, Math.max(st.tope * 2.5, (st.fin - st.ini) * 2));
  const c = (st.ini + st.fin) / 2; vista(c - r / 2, c + r / 2);
}
function pintarDatos() {
  if (document.activeElement !== $("inicio")) $("inicio").value = fmt(st.ini);
  if (document.activeElement !== $("fin")) $("fin").value = fmt(st.fin);
  const d = st.fin - st.ini;
  $("cuenta").textContent = `${d.toFixed(1)}s / ${st.tope}s`;
  $("cuenta").classList.toggle("lleno", d >= st.tope - 0.05);
  // quieto: el video muestra el inicio del tramo, para ver qué queda dentro del recuadro
  if (!st.loop && video.currentSrc && Math.abs(video.currentTime - st.ini) > 0.04) video.currentTime = st.ini;
}
for (const [campo, cual] of [["inicio", "ini"], ["fin", "fin"]]) {
  $(campo).addEventListener("change", () => {
    const v = parseFloat($(campo).value.replace(",", "."));
    if (!isNaN(v)) { cual === "ini" ? fijar(v, Math.max(st.fin, v + 0.1)) : fijar(st.ini, v); vistaAlTramo(); }
    pintarDatos();
  });
}

/* arrastrar en la onda: bordes, mover el tramo, o marcar uno nuevo; un toque lo centra ahí */
let arr = null;
$("lienzo").addEventListener("pointerdown", (ev) => {
  if (!st.id) return;
  const w = $("lienzo").clientWidth, x = ev.offsetX, t = aT(x, w), xi = aX(st.ini, w), xf = aX(st.fin, w);
  $("lienzo").setPointerCapture(ev.pointerId);
  if (Math.abs(x - xi) < 10) arr = { tipo: "ini" };
  else if (Math.abs(x - xf) < 10) arr = { tipo: "fin" };
  else if (x > xi && x < xf) arr = { tipo: "mover", desde: t, ini: st.ini, fin: st.fin, x0: x };
  else arr = { tipo: "nuevo", desde: t, x0: x };
});
$("lienzo").addEventListener("pointermove", (ev) => {
  const w = $("lienzo").clientWidth, t = aT(ev.offsetX, w);
  if (!arr) {
    const cerca = Math.min(Math.abs(ev.offsetX - aX(st.ini, w)), Math.abs(ev.offsetX - aX(st.fin, w))) < 10;
    $("lienzo").style.cursor = cerca ? "ew-resize" : (t > st.ini && t < st.fin ? "grab" : "crosshair"); return;
  }
  if (Math.abs(ev.offsetX - (arr.x0 ?? ev.offsetX)) > 3) arr.movio = true;
  if (arr.tipo === "ini") fijar(Math.max(t, st.fin - st.tope), st.fin);
  else if (arr.tipo === "fin") fijar(st.ini, Math.min(t, st.ini + st.tope));
  else if (arr.tipo === "mover") {
    const largo = arr.fin - arr.ini, ini = Math.max(0, Math.min(st.dur - largo, arr.ini + t - arr.desde));
    st.ini = ini; st.fin = ini + largo; quedoViejo(); pintarDatos(); dibujarTodo();
  } else if (arr.movio) fijar(Math.min(arr.desde, t), Math.max(arr.desde, t));
});
$("lienzo").addEventListener("pointerup", (ev) => {
  if (arr && !arr.movio && (arr.tipo === "nuevo" || arr.tipo === "mover")) centrarEn(aT(ev.offsetX, $("lienzo").clientWidth));
  if (arr) { const sonaba = st.loop; pararLoop(); if (sonaba) escuchar(); }
  arr = null; dibujarTodo();
});
$("lienzo").addEventListener("wheel", (ev) => {
  if (!st.id) return; ev.preventDefault();
  const w = $("lienzo").clientWidth, r = st.v1 - st.v0;
  if (ev.shiftKey || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) { const d = (ev.deltaX || ev.deltaY) / w * r; vista(st.v0 + d, st.v1 + d); }
  else { const t = aT(ev.offsetX, w), f = Math.exp(ev.deltaY * 0.0015); vista(t - (t - st.v0) * f, t + (st.v1 - t) * f); }
}, { passive: false });
/* el mapa de todo el video: tocar o arrastrar lleva el tramo ahí */
let arrMapa = false;
function irMapa(ev) {
  const t = ev.offsetX / $("mapa").clientWidth * st.dur;
  centrarEn(t); const r = st.v1 - st.v0; vista(t - r / 2, t + r / 2);
}
$("mapa").addEventListener("pointerdown", (ev) => { if (!st.id) return; arrMapa = true; $("mapa").setPointerCapture(ev.pointerId); irMapa(ev); });
$("mapa").addEventListener("pointermove", (ev) => { if (arrMapa) irMapa(ev); });
$("mapa").addEventListener("pointerup", () => { arrMapa = false; if (st.loop) { pararLoop(); escuchar(); } });

/* ---------- escuchar el tramo en bucle ---------- */
function pintarPlay() { $("play").innerHTML = st.loop ? ICON_PAUSA : ICON_PLAY; }
function pararLoop() { st.loop = false; video.pause(); pintarPlay(); }
function escuchar() {
  if (st.loop) return pararLoop();
  if (!$("resultado").hidden) mostrarResultado(false);
  st.loop = true; pintarPlay(); video.currentTime = st.ini; video.play().catch(() => {});
}
$("play").onclick = escuchar; pintarPlay();
(function cuadro() {
  if (st.loop && (video.currentTime >= st.fin || video.currentTime < st.ini - 0.3)) video.currentTime = st.ini;
  if (st.id && !video.paused) dibujar();
  requestAnimationFrame(cuadro);
})();
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") return cerrarMenus();
  if (!st.id || ev.target.closest("input,select,textarea")) return;
  if (ev.code === "Space") { ev.preventDefault(); escuchar(); }
  if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
    ev.preventDefault(); const d = (ev.key === "ArrowLeft" ? -1 : 1) * (ev.shiftKey ? 1 : 0.1);
    centrarEn((st.ini + st.fin) / 2 + d); dibujarTodo();
  }
});

/* ---------- el recorte ---------- */
$("encuadre").addEventListener("click", (ev) => {
  const b = ev.target.closest("button"); if (!b) return;
  st.encuadre = b.dataset.v; pintarEncuadre(); quedoViejo();
});
$("borde").addEventListener("click", (ev) => {
  const b = ev.target.closest("button"); if (!b) return;
  st.borde = b.dataset.v === "si"; pintarBorde(); quedoViejo();
  memoria.guardar("borde", st.borde ? "si" : "no");
});
function pintarBorde() {
  for (const x of $("borde").children) x.setAttribute("aria-pressed", String((x.dataset.v === "si") === st.borde));
  pintarMarco();
}
function leerMemoria() {
  st.borde = memoria.leer("borde") === "si"; pintarBorde();
  const t = +memoria.leer("tope"); if ([5, 10, 20, 30].includes(t)) ponerTope(t, false);
  for (const id of ["paquete", "autor", "destino"]) { const v = memoria.leer(id); if (v != null) $(id).value = v; }
  if (EMBEBIDO && memoria.leer("destino") == null) $("destino").value = "abierto";
}
function pintarEncuadre() {
  for (const x of $("encuadre").children) x.setAttribute("aria-pressed", String(x.dataset.v === st.encuadre));
  pintarMarco();
}
function rectVideo() {
  const e = $("escenario").getBoundingClientRect();
  const vw = video.videoWidth || st.ancho || 1, vh = video.videoHeight || st.alto || 1;
  const k = Math.min(e.width / vw, e.height / vh), w = vw * k, h = vh * k;
  return { x: (e.width - w) / 2, y: (e.height - h) / 2, w, h };
}
/* El recuadro (siempre cuadrado) se mueve a cualquier lado y se achica o agranda desde sus esquinas o con la
   rueda. st.caja: x, y = esquina de arriba a la izquierda (fracción del ancho y del alto del video);
   l = lado (fracción del lado corto). El ayudante recorta exactamente eso. */
const LADO_MIN = 0.15;
function cajaCentrada(l) {
  const W = st.ancho || 1, H = st.alto || 1, lado = l * Math.min(W, H);
  return { l, x: (W - lado) / 2 / W, y: (H - lado) / 2 / H };
}
// de la caja (fracciones) a píxeles de pantalla, y al revés, siempre dentro del video
function cajaEnPantalla(r) {
  const lado = st.caja.l * Math.min(r.w, r.h);
  return { lado, left: r.x + st.caja.x * r.w, top: r.y + st.caja.y * r.h };
}
function ponerCaja(r, left, top, lado) {
  lado = Math.max(LADO_MIN * Math.min(r.w, r.h), Math.min(Math.min(r.w, r.h), lado));
  left = Math.max(r.x, Math.min(r.x + r.w - lado, left));
  top = Math.max(r.y, Math.min(r.y + r.h - lado, top));
  st.caja = { l: lado / Math.min(r.w, r.h), x: (left - r.x) / r.w, y: (top - r.y) / r.h };
}
function pintarMarco() {
  const m = $("marco"), ver = !!st.id && st.encuadre === "cuadrado" && $("resultado").hidden;
  m.hidden = !ver; $("pista").hidden = !ver || st.movioMarco;
  if (!ver) return;
  const r = rectVideo(), c = cajaEnPantalla(r);
  m.style.width = m.style.height = `${c.lado}px`;
  m.classList.toggle("con-borde", st.borde);
  m.style.setProperty("--grosor", `${Math.max(2, c.lado * 12 / 512)}px`);
  m.style.left = `${c.left}px`; m.style.top = `${c.top}px`;
}
video.addEventListener("loadedmetadata", pintarMarco);
let arrMarco = null;
$("marco").addEventListener("pointerdown", (ev) => {
  const r = rectVideo();
  arrMarco = { x: ev.clientX, y: ev.clientY, r, c: cajaEnPantalla(r), esquina: ev.target.dataset.c || null };
  $("marco").setPointerCapture(ev.pointerId);
  ev.preventDefault();
});
$("marco").addEventListener("pointermove", (ev) => {
  if (!arrMarco) return;
  const { r, c, esquina } = arrMarco, dx = ev.clientX - arrMarco.x, dy = ev.clientY - arrMarco.y;
  if (!esquina) ponerCaja(r, c.left + dx, c.top + dy, c.lado);
  else {
    // la esquina contraria queda fija; el lado crece o se achica con el arrastre en diagonal
    const d = { se: (dx + dy) / 2, nw: -(dx + dy) / 2, ne: (dx - dy) / 2, sw: (dy - dx) / 2 }[esquina];
    const derecha = c.left + c.lado, abajo = c.top + c.lado;
    const max = {
      se: Math.min(r.x + r.w - c.left, r.y + r.h - c.top),
      nw: Math.min(derecha - r.x, abajo - r.y),
      ne: Math.min(r.x + r.w - c.left, abajo - r.y),
      sw: Math.min(derecha - r.x, r.y + r.h - c.top),
    }[esquina];
    const lado = Math.max(LADO_MIN * Math.min(r.w, r.h), Math.min(max, c.lado + d));
    const left = esquina === "nw" || esquina === "sw" ? derecha - lado : c.left;
    const top = esquina === "nw" || esquina === "ne" ? abajo - lado : c.top;
    ponerCaja(r, left, top, lado);
  }
  st.movioMarco = true; quedoViejo(); pintarMarco();
});
$("marco").addEventListener("pointerup", () => { arrMarco = null; });
// rueda sobre el video: zoom del recuadro alrededor de su centro
$("escenario").addEventListener("wheel", (ev) => {
  if ($("marco").hidden) return;
  ev.preventDefault();
  const r = rectVideo(), c = cajaEnPantalla(r);
  const lado = c.lado * Math.exp(ev.deltaY * 0.0015), cx = c.left + c.lado / 2, cy = c.top + c.lado / 2;
  ponerCaja(r, cx - lado / 2, cy - lado / 2, lado);
  st.movioMarco = true; quedoViejo(); pintarMarco();
}, { passive: false });

/* ---------- menús ---------- */
function cerrarMenus() {
  for (const [m, b] of [["menuOpciones", "btnOpciones"], ["menuBajar", "btnBajar"]]) { $(m).hidden = true; $(b).setAttribute("aria-expanded", "false"); }
}
function alternar(m, b) { const abrir = $(m).hidden; cerrarMenus(); $(m).hidden = !abrir; $(b).setAttribute("aria-expanded", String(abrir)); }
$("btnOpciones").onclick = (ev) => { ev.stopPropagation(); alternar("menuOpciones", "btnOpciones"); };
$("btnBajar").onclick = async (ev) => {
  ev.stopPropagation();
  if (!st.hecho) { await hacer(); if (!st.hecho) return; }
  alternar("menuBajar", "btnBajar");
};
document.addEventListener("click", (ev) => { if (!ev.target.closest(".menu")) cerrarMenus(); });
// paquete y autor no rehacen nada: se usan al mandar
for (const id of ["fondo", "lado", "fps", "colores", "kbps", "nombre"]) $(id).addEventListener("change", quedoViejo);
/* paquete, autor y destino se recuerdan */
for (const id of ["paquete", "autor", "destino"]) {
  $(id).addEventListener("change", () => memoria.guardar(id, $(id).value));
  if (id !== "destino") $(id).addEventListener("input", () => memoria.guardar(id, $(id).value));
}

/* ---------- mandar a WhatsApp (lo hace la extensión, en WhatsApp Web) ---------- */
function pintarMandar() {
  const b = $("btnMandar");
  b.disabled = !hayExtension();
  b.title = hayExtension() ? "" : "Abrí esta ventana en Chrome con la extensión Stickers con audio cargada";
}
let mandando = null;
$("btnMandar").onclick = async () => {
  if (!st.hecho || !hayExtension() || mandando) return;
  mandando = true;
  $("btnMandar").disabled = true; $("btnMandar").textContent = "Mandando…";
  estado("Preparando el sticker para WhatsApp…");
  let r;
  try {
    r = await ext("mandar", { base: st.hecho.base, wa: st.hecho.wa, destino: $("destino").value,
      paquete: $("paquete").value.trim(), autor: $("autor").value.trim() });
  }
  catch (e) { r = { ok: false, error: "La extensión no respondió; recargala en chrome://extensions. " + (e.message || e) }; }
  r = r || { ok: false, error: "Sin respuesta de la extensión" };
  mandando = null; $("btnMandar").textContent = "Mandar a WhatsApp"; pintarMandar();
  if (r.ok && r.audioDescartado) {
    estadoHtml("Se mandó el sticker, pero <b>WhatsApp Web le quitó el audio</b> al mandarlo (la función de stickers con sonido no quedó activa). " +
      "Recargá WhatsApp Web (F5), esperá a que cargue del todo y mandalo otra vez.", "error");
  } else if (r.ok) {
    if (r.info) {  // el WebP y el Ogg que armó el código de Shirtep ya quedaron en la carpeta (para el ⬇)
      for (const [ext2, n, bytes] of [["webp", "Webp", r.info.webpBytes], ["ogg", "Ogg", r.info.oggBytes]]) {
        const nombre = `${st.hecho.base}.${ext2}`, a = $(`bajar${n}`);
        a.hidden = false; a.href = sal(nombre, "?bajar=1"); a.setAttribute("download", nombre); $(`peso${n}`).textContent = kb(bytes || 0);
      }
    }
    estadoHtml($("destino").value === "abierto"
      ? `<b>Enviado</b> al chat ${r.chat ? "«" + esc(r.chat) + "»" : "abierto"}${r.conAudio ? ", con sonido" : ""}.`
      : `<b>Enviado</b> a tu propio chat${r.conAudio ? ", con sonido" : ""}. En WhatsApp Web se abrió Reenviar: elegí a quién mandarlo.`, "bien");
  } else estado(r.error || "No se pudo mandar", "error");
};
/* los pasos del envío ("Subiendo el audio…") */
if (EXT) chrome.runtime.onMessage.addListener((m) => { if (m && m.stk === "paso" && mandando) estado(m.texto); });
else window.addEventListener("message", (ev) => {
  if (ev.source === window && ev.data && ev.data.__stk === "paso-mandar" && mandando) estado(ev.data.texto);
});
$("abrirCarpeta").onclick = $("abrirCarpeta2").onclick = () => api("/api/abrir", {}).catch((e) => estado(e.message, "error"));

/* ---------- ➔ hacer el sticker ---------- */
function quedoViejo() {
  if (!st.hecho) return;
  st.hecho = null; $("btnHacer").classList.remove("listo"); $("filaMandar").hidden = true;
  if (!$("resultado").hidden) mostrarResultado(false);
  estado("Cambiaste algo: dale ➔ otra vez para rehacer el sticker.");
}
async function hacer() {
  if (!st.id) return;
  pararLoop(); cerrarMenus();
  const b = $("btnHacer"); b.disabled = true; estado("Haciendo el GIF, el MP3 y el MP4…");
  try {
    const r = await api("/api/exportar", {
      id: st.id, inicio: st.ini, fin: st.fin, tope: st.tope, encuadre: st.encuadre, pos: st.pos, caja: st.caja, borde: st.borde, fondo: $("fondo").value,
      lado: +$("lado").value, fps: +$("fps").value, kbps: +$("kbps").value, colores: +$("colores").value,
      nombre: $("nombre").value.trim() || null, paquete: $("paquete").value.trim(), autor: $("autor").value.trim(),
    });
    st.hecho = r; b.classList.add("listo");
    for (const [k, n] of [["mp4", "Mp4"], ["gif", "Gif"], ["mp3", "Mp3"], ["webp", "Webp"], ["ogg", "Ogg"]]) {
      const a = $(`bajar${n}`), x = r[k];
      a.hidden = !x; if (!x) continue;
      a.href = sal(x.nombre, "?bajar=1"); a.setAttribute("download", x.nombre); $(`peso${n}`).textContent = kb(x.bytes);
    }
    mostrarResultado(true);
    $("filaMandar").hidden = false; pintarMandar();
    estadoHtml(`<b>Listo.</b> GIF ${kb(r.gif.bytes)}, MP3 ${r.mp3 ? kb(r.mp3.bytes) : "sin audio"} y MP4 ${kb(r.mp4.bytes)} en la carpeta de stickers. ` +
      (hayExtension() ? "Dale <b>Mandar a WhatsApp</b>: el sticker con sonido se arma ahí con el mismo proceso de la extensión de Shirtep."
                      : "Para mandarlo como sticker con sonido, abrí el panel en WhatsApp Web con la extensión."), "bien");
    cargarHechos();
  } catch (e) { estado(e.message, "error"); }
  b.disabled = false;
}
$("btnHacer").onclick = hacer;
function mostrarResultado(si) {
  const r = $("resultado");
  if (si && st.hecho) {
    video.pause(); video.hidden = true; r.hidden = false;
    r.src = sal(st.hecho.mp4.nombre, `?v=${Date.now()}`); r.muted = false; r.play().catch(() => { r.muted = true; r.play(); });
    $("chips").hidden = true; $("chipVolver").hidden = false;
  } else {
    r.pause(); r.removeAttribute("src"); r.hidden = true; $("chipVolver").hidden = true;
    if (st.id) { video.hidden = false; $("chips").hidden = false; }
  }
  pintarMarco();
}
$("volver").onclick = () => mostrarResultado(false);
resultado.onclick = () => { resultado.currentTime = 0; resultado.play(); };

/* ---------- lámina de stickers hechos ---------- */
let sonando = null;
function sonar(r, img, caja) {
  pararLoop();
  img.src = sal(r.gif.nombre, `?v=${Date.now()}`);
  if (sonando) sonando.classList.remove("sonando");
  if (!r.mp3) return;
  audioSticker.src = sal(r.mp3.nombre, `?v=${Date.now()}`); audioSticker.play().catch(() => {});
  sonando = caja; caja.classList.add("sonando");
}
audioSticker.addEventListener("ended", () => sonando && sonando.classList.remove("sonando"));
async function cargarHechos() {
  let lista = []; try { lista = await api("/api/hechos"); } catch { return; }
  $("lamina").hidden = !lista.length;
  const hoja = $("hoja"); hoja.textContent = "";
  lista.forEach((r, i) => {
    const fig = document.createElement("figure"), caja = document.createElement("button"), img = document.createElement("img");
    caja.type = "button"; caja.className = "troquel"; caja.title = "Tocalo para oírlo";
    caja.style.transform = `rotate(${[-3, 2, -1.5, 3, -2.5, 1][i % 6]}deg)`;
    img.loading = "lazy"; img.alt = r.base; img.src = sal(r.gif.nombre);
    caja.append(img); caja.onclick = () => sonar(r, img, caja);
    const cap = document.createElement("figcaption"); cap.textContent = r.base;
    fig.append(caja, cap); hoja.append(fig);
  });
}

/* ---------- arranque ---------- */
const q = new URLSearchParams(location.search);
if (EMBEBIDO) document.documentElement.classList.add("embebido");
// lo recordado (en el panel viene de chrome.storage, que es asíncrono)
if (EXT) chrome.storage.local.get(null).then((m) => { memoria._cache = m || {}; leerMemoria(); }).catch(leerMemoria);
else leerMemoria();
const AVISO_INSTALAR = "Falta un paso (una sola vez por compu): en la carpeta del proyecto (donde está <b>stickers.py</b>) dale doble clic a " +
  "<b>instalar-ayudante.bat</b> (Mac: <b>instalar-ayudante.command</b>). Después cerrá y abrí este panel: desde ahí el botón de la extensión prende el ayudante solo.";
async function arrancar() {
  // en el panel, el ayudante puede estar apagado: la extensión lo prende sola (Native Messaging); si no puede,
  // se dice por qué en vez de fallar callado
  const hola = async () => { try { return (await fetch(`${BASE}/api/hola`, { cache: "no-store" })).ok; } catch (e) { return false; } };
  if (!(await hola())) {
    estado("Prendiendo el ayudante…");
    let p = { ok: false };
    try { p = (EXT && await chrome.runtime.sendMessage({ stk: "prender" })) || p; } catch (e) { p = { ok: false, error: String(e.message || e) }; }
    if (!p.ok || !(await hola())) {
      if (p.falta) return estadoHtml(AVISO_INSTALAR + ` <span style="opacity:.6">(Chrome: ${esc(p.error || "")})</span>`, "error");
      return estadoHtml("No pude prender el ayudante de stickers. " + esc(p.error || "") +
        " Probá cerrar y abrir este panel; si sigue, corré otra vez <b>instalar-ayudante</b>.", "error");
    }
    estado("");
  }
  if (q.get("trabajo")) seguir(q.get("trabajo"));
  else if (q.get("url")) { $("campoLink").value = q.get("url"); traer(q.get("url")); }
  else $("campoLink").focus();
  cargarHechos();
}
arrancar();
