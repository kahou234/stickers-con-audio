// Puente en WhatsApp Web (mundo aislado):
// - monta y esconde el panel de stickers encima de WhatsApp Web (ventana/index.html, página de la extensión);
// - pasa la orden "mandar" del fondo de la extensión a wa-mandar.js (que corre en la página) y devuelve la respuesta.

const ANCHO = 470;
let caja = null;

function montarPanel(url) {
  if (!caja) {
    caja = document.createElement("div");
    caja.id = "stk-panel";
    Object.assign(caja.style, {
      position: "fixed", top: "0", right: "0", bottom: "0", width: `${ANCHO}px`, maxWidth: "100vw",
      zIndex: "2147483000", background: "#121418", boxShadow: "-12px 0 40px rgba(0,0,0,.45)",
      borderLeft: "1px solid #2C313A", display: "flex",
    });
    const cerrar = document.createElement("button");
    cerrar.type = "button";
    cerrar.title = "Esconder el panel (el botón de la extensión lo vuelve a abrir)";
    cerrar.setAttribute("aria-label", "Esconder el panel de stickers");
    cerrar.textContent = "›";
    Object.assign(cerrar.style, {
      position: "absolute", left: "-30px", top: "50%", transform: "translateY(-50%)", width: "30px", height: "64px",
      border: "1px solid #2C313A", borderRight: "0", borderRadius: "10px 0 0 10px", background: "#1A1D23",
      color: "#E8EAED", fontSize: "22px", cursor: "pointer", padding: "0",
    });
    cerrar.addEventListener("click", () => { caja.style.display = "none"; });
    const marco = document.createElement("iframe");
    // WhatsApp Web exige COEP require-corp: sin "credentialless" bloquea el panel (sale gris)
    marco.setAttribute("credentialless", "");
    marco.credentialless = true;
    marco.allow = "autoplay; clipboard-read; clipboard-write";
    Object.assign(marco.style, { border: "0", width: "100%", height: "100%" });
    caja.append(cerrar, marco);
    document.documentElement.append(caja);
    caja._marco = marco;
    caja._url = null;
  }
  const nuevo = chrome.runtime.getURL("ventana/index.html") + "?embebido=1" + (url ? `&url=${encodeURIComponent(url)}` : "");
  if (!caja._marco.src || (url && caja._url !== url)) { caja._marco.src = nuevo; caja._url = url || null; }
  caja.style.display = "flex";
}

function alternarPanel() {
  if (caja && caja.style.display !== "none") caja.style.display = "none";
  else montarPanel(null);
}

chrome.runtime.onMessage.addListener((msg, _de, responder) => {
  if (!msg) return;
  if (msg.stk === "hola") { responder({ ok: true }); return; }
  if (msg.stk === "panel") {
    if (msg.url) montarPanel(msg.url);
    else if (msg.alternar) alternarPanel();
    else montarPanel(null);
    responder({ ok: true });
    return;
  }
  if (msg.stk !== "mandar") return;
  const id = Math.random().toString(36).slice(2);
  const escuchar = (ev) => {
    if (ev.source !== window || !ev.data || ev.data.id !== id) return;
    if (ev.data.__stk === "paso") { chrome.runtime.sendMessage({ stk: "paso", texto: ev.data.texto }).catch(() => {}); return; }
    if (ev.data.__stk !== "listo") return;
    window.removeEventListener("message", escuchar);
    const { __stk, id: _, ...resto } = ev.data;
    responder(resto);
  };
  window.addEventListener("message", escuchar);
  window.postMessage({ __stk: "mandar", id, video64: msg.video64, duracion: msg.duracion, modo: msg.modo,
    paquete: msg.paquete, autor: msg.autor, destino: msg.destino }, location.origin);
  return true; // responde después
});
