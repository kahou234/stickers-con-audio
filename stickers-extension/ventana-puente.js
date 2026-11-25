// Puente en la ventana de stickers (http://localhost:4195, sola o dentro del panel de WhatsApp Web):
// le avisa a la página que la extensión está y le pasa al fondo los pedidos "traer" (bajar un link con
// tus cookies de ese sitio) y "mandar" (mandar el sticker a WhatsApp Web).
document.documentElement.dataset.stickersExt = chrome.runtime.getManifest().version;

window.addEventListener("message", async (ev) => {
  if (ev.source !== window || !ev.data) return;
  const tipo = { "pedir-mandar": "mandar", "pedir-traer": "traer" }[ev.data.__stk];
  if (!tipo) return;
  const { __stk, id, ...datos } = ev.data;
  let r;
  try { r = await chrome.runtime.sendMessage({ stk: tipo, ...datos }); }
  catch (e) { r = { ok: false, error: "La extensión no respondió; recargala en chrome://extensions. " + (e.message || e) }; }
  window.postMessage({ __stk: `resultado-${tipo}`, id, ...(r || { ok: false, error: "Sin respuesta de la extensión" }) }, location.origin);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.stk === "paso") window.postMessage({ __stk: "paso-mandar", texto: msg.texto }, location.origin);
});
