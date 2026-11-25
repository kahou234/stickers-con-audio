// Corre DENTRO de WhatsApp Web (mundo MAIN), después de shirtep/logger.js, convert.js y wa.js (copias tal cual de
// WA-audio-stickers). No hace nada propio: recibe el tramo ya recortado (con el recorte y el borde que se eligieron en la ventana)
// y corre el MISMO proceso que la extensión de Shirtep:
//   analyze (captura los cuadros) → opción automática → create (WebP + Ogg/Opus) → wa.publish (sube y manda).
// Licencia del código que usa: PolyForm Noncommercial 1.0.0 — Required Notice: Copyright Shirtep
// (https://github.com/Shirtep/WA-audio-stickers). Uso personal, sin fines comerciales. No oficial.
(() => {
  if (window.__stkMandar) return;
  window.__stkMandar = true;
  const S = window.STKWA;

  // igual que waitForWA de su main.js
  async function esperarWhatsApp(ms = 180000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (S.wa.hasLoader() && S.wa.ns("WAWebChatCollection").ChatCollection) return; } catch (e) { /* cargando */ }
      await new Promise((r) => setTimeout(r, 800));
    }
    throw new Error("WhatsApp Web no terminó de cargar (¿la sesión está abierta?)");
  }

  const deB64 = (s, tipo) => {
    const bin = atob(s), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new Blob([u], { type: tipo });
  };
  async function aB64(blob) {
    const u = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // Balance entre fluido y nítido: al menos 12 cuadros por segundo y, con eso, el tamaño más
  // grande. Vale una casilla amarilla de su tabla ("baja": cabe bajando un poco la calidad del WebP) si el peso
  // estimado no pasa de 1,2 MB, para que no salga con cuadritos. La de Shirtep prefería fluidez (en 30 s, 96 px).
  const FPS_BALANCE = 12, EST_MAX = 1_200_000;
  function elegir(an) {
    const sirve = (c) => c.estado === "ok" || (c.estado === "baja" && c.est <= EST_MAX);
    const orden = (a, b) => b.side - a.side || b.fps - a.fps;
    const conFps = (min) => (an.cells || []).filter((c) => sirve(c) && c.fps >= min).sort(orden)[0];
    const g = conFps(FPS_BALANCE) || conFps(10);
    return g && (!an.auto || g.side >= an.auto.side) ? g : an.auto;
  }

  // como convert() de su convert.js: analizar + elegir + crear
  async function convertir(file, duracion, modo, paquete, autor, paso) {
    const an = await S.analyze({ file, start: 0, duration: duracion, mode: modo, onProgress: (t) => paso(t) });
    try {
      const c = elegir(an);
      if (!c) throw new Error("Ninguna combinación cabe en 1 MB para este tramo; cortalo más");
      return await S.create(an, { side: c.side, fps: c.fps, packName: paquete, publisher: autor, onProgress: (t) => paso(t) });
    } finally {
      S.release(an);
    }
  }

  // Su forceSoundStickers() solo corre al mandar (dentro de wa.publish). Después de recargar WhatsApp Web, hasta
  // mandar uno, la página no dejaba sonar los stickers con sonido ("No se pudo reproducir el sonido del sticker",
  // 2026-11-25). Se prende apenas carga WhatsApp Web; las opciones de la cuenta llegan unos segundos después
  // (su main.js espera 8 s), así que se vuelve a prender a los 8 s.
  (async () => {
    try {
      // lo antes posible: apenas existen sus módulos, antes de que lea los mensajes guardados
      const t0 = Date.now();
      while (!S.wa._forced && Date.now() - t0 < 120000) {
        try { if (S.wa.hasLoader()) S.wa.forceSoundStickers(); } catch (e) { /* todavía no */ }
        if (!S.wa._forced) await new Promise((r) => setTimeout(r, 100));
      }
      await esperarWhatsApp();
      S.wa.forceSoundStickers();
      await new Promise((r) => setTimeout(r, 8000));
      S.wa._forced = false;
      S.wa.forceSoundStickers();
    } catch (e) { if (S.warn) S.warn("stickers-con-audio:no-prendio", e); }
  })();

  window.addEventListener("message", async (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__stk !== "mandar") return;
    const { id, video64, duracion, modo, paquete, autor, destino } = ev.data;
    const paso = (texto) => window.postMessage({ __stk: "paso", id, texto }, location.origin);
    S.activeRun = id;
    try {
      await esperarWhatsApp();
      const file = new File([deB64(video64, "video/mp4")], "sticker.mp4", { type: "video/mp4" });
      paso("Armando el sticker…");
      const r = await convertir(file, duracion, modo || "ajustar", paquete || "", autor || "", paso);
      const { chat, msg } = await S.wa.publish({ webp: r.webp, ogg: r.ogg, info: r.info },
        { destino, abrirReenviar: destino !== "abierto", onProgress: paso });
      const enMensaje = !!(msg && (msg.stickerAudio || (msg.attributes && msg.attributes.stickerAudio)));
      window.postMessage({
        __stk: "listo", id, ok: true, conAudio: enMensaje, audioDescartado: !enMensaje,
        chat: String((chat && (chat.formattedTitle || chat.name)) || "").slice(0, 40),
        info: { lado: r.info.lado, fps: r.info.fps, webpBytes: r.info.webpBytes, oggBytes: r.info.oggBytes },
        webp64: await aB64(r.webp), ogg64: await aB64(r.ogg),
      }, location.origin);
    } catch (e) {
      if (S.error) S.error("stickers-con-audio:error", e);
      window.postMessage({ __stk: "listo", id, ok: false, error: String((e && e.message) || e) }, location.origin);
    } finally {
      S.activeRun = null;
    }
  });
})();
