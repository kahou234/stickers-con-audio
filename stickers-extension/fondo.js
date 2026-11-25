// Stickers con audio — fondo de la extensión.
// - Botón de la extensión: abre WhatsApp Web y le monta encima el panel de stickers (wa-puente.js). Si estabas
//   en un video (reel, TikTok, YouTube…), el panel abre con ese video ya cargado.
// - "traer": el panel le pide bajar un link; se manda al ayudante local (stickers.py) con las cookies
//   de ESE sitio, para lo que pide sesión (Instagram casi siempre). Nada sale de la compu.
// - "mandar": baja del ayudante el WebP y el Ogg del sticker y se los pasa a WhatsApp Web (wa-mandar.js).
const AYUDANTE = "http://localhost:4195";
const WA = "https://web.whatsapp.com/";
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- abrir WhatsApp Web con el panel ----------
function esVideo(url) {
  if (!url || !/^https?:\/\//.test(url)) return false;
  if (url.startsWith(WA) || url.startsWith(AYUDANTE) || url.startsWith("http://127.0.0.1:4195")) return false;
  return !/^https?:\/\/(www\.)?google\.[a-z.]+\/?(\?|$|search|webhp)/.test(url);
}

async function cargada(tabId, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === "complete") return;
    await dormir(300);
  }
}

async function puenteListo(tabId, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { await chrome.tabs.sendMessage(tabId, { stk: "hola" }); return true; } catch (e) { await dormir(400); }
  }
  return false;
}

async function pestanaWhatsApp() {
  let [tab] = await chrome.tabs.query({ url: WA + "*" });
  if (!tab) {
    tab = await chrome.tabs.create({ url: WA, active: true });
    await cargada(tab.id);
  }
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  // una pestaña abierta antes de instalar o recargar la extensión no tiene los scripts: se recarga una vez
  if (!(await puenteListo(tab.id, 1500))) {
    await chrome.tabs.reload(tab.id);
    await cargada(tab.id);
    await puenteListo(tab.id);
  }
  return tab;
}

async function abrirPanel(url, desdeWhatsApp) {
  const tab = await pestanaWhatsApp();
  await chrome.tabs.sendMessage(tab.id, url ? { stk: "panel", url } : { stk: "panel", alternar: !!desdeWhatsApp });
}

chrome.action.onClicked.addListener((tab) => {
  const url = tab && tab.url;
  abrirPanel(esVideo(url) ? url : null, !!url && url.startsWith(WA)).catch((e) => console.error(e));
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "link", title: "Hacer sticker con este video", contexts: ["link"] });
  chrome.contextMenus.create({ id: "pagina", title: "Hacer sticker con el video de esta página", contexts: ["page", "video"] });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.menuItemId === "link" ? info.linkUrl : (info.pageUrl || (tab && tab.url));
  abrirPanel(esVideo(url) ? url : null, false).catch((e) => console.error(e));
});

// ---------- bajar un link con tu sesión ----------
async function traer(url) {
  let cookies = [];
  try {
    cookies = (await chrome.cookies.getAll({ url })).map((c) => ({
      domain: c.domain, path: c.path, secure: c.secure, expirationDate: c.expirationDate, name: c.name, value: c.value,
    }));
  } catch (e) { /* sin cookies igual se intenta */ }
  const r = await fetch(`${AYUDANTE}/api/traer`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, cookies }),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || r.statusText);
  return { ok: true, id: j.id };
}

// ---------- mandar a WhatsApp Web ----------
async function aB64(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`No pude leer ${url.split("/").pop()} del ayudante`);
  const u = new Uint8Array(await r.arrayBuffer());
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}

let quienPide = null; // pestaña (y marco) de la ventana que pidió mandar, para avisarle los pasos

function avisarPaso(texto) {
  // la ventana sola (localhost) lo recibe por su puente; la del panel es página de la extensión y oye el aviso general
  if (quienPide) chrome.tabs.sendMessage(quienPide.tab, { stk: "paso", texto }, { frameId: quienPide.frame }).catch(() => {});
  chrome.runtime.sendMessage({ stk: "paso", texto }).catch(() => {});
}

// Le pasa a WhatsApp Web el tramo ya recortado; ahí el código de Shirtep (shirtep/*.js) arma el WebP y el Ogg
// y lo manda, igual que su extensión. Lo que arma se guarda de vuelta en la carpeta de stickers.
async function mandar({ base, wa, destino, paquete, autor }) {
  if (!wa || !wa.tramo) throw new Error("Ese sticker es de antes; dale ➔ otra vez");
  avisarPaso("Preparando el tramo…");
  const video64 = await aB64(`${AYUDANTE}/tramo/${encodeURIComponent(wa.tramo)}`);
  avisarPaso("Abriendo WhatsApp Web…");
  const tab = await pestanaWhatsApp();
  const r = await chrome.tabs.sendMessage(tab.id, {
    stk: "mandar", video64, duracion: wa.duracion, modo: wa.modo || "ajustar", paquete, autor, destino,
  }, { frameId: 0 });
  if (!r) return { ok: false, error: "WhatsApp Web no respondió" };
  const { webp64, ogg64, ...resto } = r;
  if (r.ok && webp64) {
    try {
      await fetch(`${AYUDANTE}/api/guardar-wa`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base, webp64, ogg64 }),
      });
    } catch (e) { /* ya se mandó; guardarlo es extra */ }
  }
  return resto;
}

chrome.runtime.onMessage.addListener((msg, de, responder) => {
  if (!msg) return;
  if (msg.stk === "paso") { avisarPaso(msg.texto); return; }
  const fallar = (e) => responder({ ok: false, error: String(e && e.message || e) });
  if (msg.stk === "traer") { traer(msg.url).then(responder).catch(fallar); return true; }
  if (msg.stk === "mandar") {
    quienPide = de.tab ? { tab: de.tab.id, frame: de.frameId || 0 } : null;
    mandar(msg).then(responder).catch(fallar);
    return true;
  }
});
