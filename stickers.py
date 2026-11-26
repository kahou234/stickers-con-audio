"""Stickers con audio: de un link (Instagram, TikTok, YouTube, lo que yt-dlp entienda) a un sticker de WhatsApp
con sonido. Es el ayudante local que usa la extensión de Chrome (carpeta stickers-extension/).

Baja el video con yt-dlp, deja elegir el tramo y el recorte en la ventana y saca un GIF + MP3 + MP4 con ffmpeg.
El sticker de WhatsApp (WebP + Ogg/Opus) lo arma y lo manda, dentro de WhatsApp Web, el código de
WA-audio-stickers de Shirtep (stickers-extension/shirtep/).

    python stickers.py instalar        # una vez: que el botón de la extensión prenda el ayudante solo
                                       # (es lo que hacen instalar-ayudante.bat / instalar-ayudante.command)
    python stickers.py servir          # a mano: la ventana en http://localhost:4195 (en Windows: py stickers.py servir)
    python stickers.py traer <link>    # solo baja el video (prueba)

Los archivos quedan en ~/Videos/StickersConAudio (Mac: ~/Movies/StickersConAudio), o donde diga STICKERS_CARPETA.
Usa yt-dlp (módulo de Python) y ffmpeg/ffprobe del PATH.
"""
import argparse
import array
import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

# dónde quedan los archivos (cambiable con la variable de entorno STICKERS_CARPETA)
_CARPETA = Path(os.environ.get("STICKERS_CARPETA")
                or Path.home() / ("Movies" if sys.platform == "darwin" else "Videos") / "StickersConAudio")
FUENTES = _CARPETA / "videos"
SALIDA = _CARPETA / "stickers"

PUERTO = 4195
# la ventana vive dentro de la extensión (sirve igual sola aquí y en el panel de WhatsApp Web)
VENTANA = Path(__file__).resolve().parent / "stickers-extension" / "ventana"
PAGINAS = {"/": "index.html", "/index.html": "index.html", "/ventana.css": "ventana.css", "/ventana.js": "ventana.js",
           # el código de Shirtep, para probar su conversión en la ventana sola (diagnóstico)
           "/shirtep/logger.js": "../shirtep/logger.js", "/shirtep/convert.js": "../shirtep/convert.js"}
TOPES = (5.0, 10.0, 20.0, 30.0)  # s; WhatsApp no revisa la duración, solo que el sticker pese ≤ 1 MB 
ORIGENES_OK = ("chrome-extension://", f"http://localhost:{PUERTO}", f"http://127.0.0.1:{PUERTO}")

TRABAJOS = {}  # id -> dict con estado, pct, titulo, error, ...
_candado = threading.Lock()


# ---------- utilidades ----------

def ytdlp():
    try:
        import yt_dlp  # noqa: F401
        return [sys.executable, "-m", "yt_dlp"]
    except ImportError:
        if shutil.which("yt-dlp"):
            return ["yt-dlp"]
        raise RuntimeError("Falta yt-dlp: corré  py -m pip install -U yt-dlp")


def correr(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)


def id_de(url):
    limpio = url.strip()
    p = urlparse(limpio)
    if "instagram.com" in p.netloc or "tiktok.com" in p.netloc:
        limpio = f"{p.netloc}{p.path}".rstrip("/")  # sin ?igsh=… ni ?is_from_webapp=…
    return hashlib.sha1(limpio.encode()).hexdigest()[:12]


def slug(texto, largo=40):
    t = unicodedata.normalize("NFKD", texto or "").encode("ascii", "ignore").decode()
    t = re.sub(r"[^\w\s-]", "", t).strip().lower()
    t = re.sub(r"[\s_-]+", "-", t).strip("-")
    return t[:largo].strip("-") or "sticker"


def sondear(f):
    r = correr(["ffprobe", "-v", "error", "-show_entries",
                "format=duration:stream=codec_type,codec_name,width,height",
                "-of", "json", str(f)])
    d = json.loads(r.stdout or "{}")
    v = next((s for s in d.get("streams", []) if s.get("codec_type") == "video"), {})
    a = next((s for s in d.get("streams", []) if s.get("codec_type") == "audio"), None)
    return {"duracion": float(d.get("format", {}).get("duration") or 0),
            "ancho": v.get("width"), "alto": v.get("height"),
            "vcodec": v.get("codec_name"), "audio": a is not None}


def fuente(tid):
    if not re.fullmatch(r"[0-9a-f]{12}", tid or ""):
        raise ValueError("trabajo raro")
    f = FUENTES / f"{tid}.mp4"
    if not f.exists():
        raise FileNotFoundError("Ese video ya no está; pegá el link otra vez")
    return f


def meta_de(tid):
    m = FUENTES / f"{tid}.json"
    return json.loads(m.read_text(encoding="utf-8")) if m.exists() else {}


# ---------- bajar ----------

def escribir_cookies(tid, cookies):
    """Las cookies que manda la extensión (chrome.cookies) en formato Netscape para yt-dlp."""
    if not cookies:
        return None
    f = FUENTES / f"cookies-{tid}.txt"
    filas = ["# Netscape HTTP Cookie File"]
    for c in cookies:
        dom = c.get("domain", "")
        filas.append("\t".join([
            dom, "TRUE" if dom.startswith(".") else "FALSE", c.get("path", "/"),
            "TRUE" if c.get("secure") else "FALSE", str(int(c.get("expirationDate") or 0)),
            c.get("name", ""), c.get("value", "")]))
    f.write_text("\n".join(filas) + "\n", encoding="utf-8")
    return f


def _bajar(tid, url, cookies):
    t = TRABAJOS[tid]
    FUENTES.mkdir(parents=True, exist_ok=True)
    archivo_cookies = escribir_cookies(tid, cookies)
    try:
        for viejo in FUENTES.glob(f"{tid}.*"):
            if viejo.suffix in (".part", ".ytdl") or ".f" in viejo.name:
                viejo.unlink(missing_ok=True)
        def intento(con_cookies):
            cmd = ytdlp() + [
                "--no-playlist", "--newline", "--progress", "--no-colors",
                "-S", "res:720,vcodec:h264,acodec:aac,ext:mp4:m4a", "-f", "bv*+ba/b",
                "--merge-output-format", "mp4",
                "-o", str(FUENTES / f"{tid}.%(ext)s"),
                "--progress-template",
                "download:PCT %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s",
                "-O", "after_move:TITULO %(title)s",
                "-O", "after_move:ARCHIVO %(filepath)s",
            ]
            if con_cookies:
                cmd += ["--cookies", str(con_cookies)]
            cmd.append(url)
            env = dict(os.environ, PYTHONIOENCODING="utf-8")
            p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                 encoding="utf-8", errors="replace", env=env)
            archivo, errores, partes = None, [], 0
            t["pct_parte"] = 0
            for linea in p.stdout:
                linea = linea.strip()
                if linea.startswith("PCT"):
                    partes_linea = linea.split()[1:]
                    try:
                        hecho = float(partes_linea[0])
                        total = next(float(x) for x in partes_linea[1:] if x not in ("NA", "None"))
                        pct = hecho * 100 / total if total else 0
                    except (IndexError, ValueError, StopIteration):
                        continue
                    if pct < t["pct_parte"] - 5:  # empezó la segunda parte (el audio)
                        partes += 1
                    t["pct_parte"] = pct
                    t["pct"] = min(99, pct if partes == 0 else 90 + pct / 10)
                elif linea.startswith("TITULO "):
                    t["titulo"] = linea[7:]
                elif linea.startswith("ARCHIVO "):
                    archivo = Path(linea[8:])
                elif "ERROR" in linea:
                    errores.append(linea.replace("ERROR: ", ""))
            p.wait()
            ok = p.returncode == 0 and archivo and archivo.exists()
            return (archivo if ok else None), errores

        archivo, errores = intento(archivo_cookies)
        if not archivo and archivo_cookies:
            # Con cookies de una sesión a medias (ej. TikTok sin iniciar sesión) el sitio da 403; sin ellas baja
            # (2026-11-25). Se reintenta sin cookies; Instagram, que sí las necesita, ya bajó en el primer intento.
            t["pct"] = 0
            archivo, errores_2 = intento(None)
            errores = errores_2 or errores
        if not archivo:
            raise RuntimeError(errores[-1] if errores else "yt-dlp no pudo bajar ese link")
        t["estado"], t["pct"] = "convirtiendo", 99
        info = sondear(archivo)
        destino = FUENTES / f"{tid}.mp4"
        if info["vcodec"] != "h264" or archivo != destino:
            # el navegador no siempre reproduce HEVC/VP9/AV1: se pasa a H.264 una vez
            tmp = FUENTES / f"{tid}.tmp.mp4"
            if info["vcodec"] == "h264":
                vid = ["-c:v", "copy"]
            else:
                vid = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]
            r = correr(["ffmpeg", "-y", "-v", "error", "-i", str(archivo), *vid,
                        "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(tmp)])
            if r.returncode != 0:
                raise RuntimeError("ffmpeg no pudo convertir el video: " + r.stderr[-300:])
            if archivo != destino:
                archivo.unlink(missing_ok=True)
            tmp.replace(destino)
            info = sondear(destino)
        meta = {"url": url, "titulo": t.get("titulo") or "sticker", **info}
        (FUENTES / f"{tid}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
        t.update(meta, estado="listo", pct=100)
    except Exception as e:  # la ventana muestra el error tal cual
        t.update(estado="error", error=explicar_error(str(e)))
    finally:
        if archivo_cookies:
            archivo_cookies.unlink(missing_ok=True)


def explicar_error(msj):
    m = msj.lower()
    if "login" in m or "cookies" in m or "sign in" in m or "private" in m or "rate-limit" in m:
        return ("Ese sitio pide sesión. Bajalo con el botón de la extensión de Chrome "
                "(usa tu sesión), o revisá que el video sea público. Detalle: " + msj)
    if "yt-dlp -u" in m or "report this issue" in m or "unexpected response" in m:
        return ("Ese sitio cambió y yt-dlp quedó viejo. Actualizalo: "
                "py -m pip install -U --pre \"yt-dlp[default,curl-cffi]\" y dale Traer otra vez. Detalle: " + msj)
    if "unsupported url" in m:
        return "yt-dlp no reconoce ese link. Copiá el link del video mismo (no del perfil). Detalle: " + msj
    return msj


def traer(url, cookies=None):
    url = (url or "").strip()
    if not re.match(r"https?://", url):
        raise ValueError("Pegá un link que empiece con http")
    tid = id_de(url)
    with _candado:
        t = TRABAJOS.get(tid)
        if t and t["estado"] in ("bajando", "convirtiendo"):
            return tid
        if (FUENTES / f"{tid}.mp4").exists() and (FUENTES / f"{tid}.json").exists():
            TRABAJOS[tid] = {"id": tid, "estado": "listo", "pct": 100, **meta_de(tid)}
            return tid
        TRABAJOS[tid] = {"id": tid, "url": url, "estado": "bajando", "pct": 0, "pct_parte": 0, "titulo": None}
    threading.Thread(target=_bajar, args=(tid, url, cookies), daemon=True).start()
    return tid


def estado(tid):
    t = TRABAJOS.get(tid)
    if not t:
        if (FUENTES / f"{tid}.mp4").exists():
            t = TRABAJOS[tid] = {"id": tid, "estado": "listo", "pct": 100, **meta_de(tid)}
        else:
            return {"id": tid, "estado": "error", "error": "No encuentro ese video; pegá el link otra vez"}
    return {k: v for k, v in t.items() if k != "pct_parte"}


# ---------- forma de onda ----------

_ondas = {}


def onda(tid):
    if tid in _ondas:
        return _ondas[tid]
    f = fuente(tid)
    info = meta_de(tid) or sondear(f)
    if not info.get("audio", True):
        return {"porSegundo": 0, "picos": []}
    por_seg = 100 if info.get("duracion", 0) <= 600 else 20
    muestras = 4
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(f), "-vn", "-ac", "1",
                        "-ar", str(por_seg * muestras), "-f", "s16le", "-"], capture_output=True)
    a = array.array("h", r.stdout[: len(r.stdout) // 2 * 2])
    if sys.byteorder == "big":
        a.byteswap()
    picos = [max(abs(x) for x in a[i:i + muestras]) for i in range(0, len(a) - muestras + 1, muestras)]
    tope = max(picos or [1]) or 1
    res = {"porSegundo": por_seg, "picos": [round(p * 100 / tope) for p in picos]}
    _ondas[tid] = res
    return res


# ---------- exportar ----------

def borde_px(lado):
    """Grosor del borde blanco: 12 px en un sticker de 512 (WhatsApp recomienda un trazo blanco), par."""
    return max(2, round(lado * 12 / 512 / 2) * 2)


def encuadre_vf(d, lado, relleno=None):
    """Filtro de ffmpeg del recorte, con o sin borde blanco. Las esquinas siempre quedan rectas.
    Cuadrado: recorta un cuadrado en `pos` (el recuadro que se arrastró en la ventana).
    Completo: el video entero dentro de lado×lado; `relleno` = color, "transparente" o None (sin rellenar)."""
    b = borde_px(lado) if d.get("borde") else 0
    adentro = lado - 2 * b
    if d.get("encuadre") == "cuadrado":
        pos = max(0.0, min(1.0, float(d.get("pos", 0.5))))
        s = "min(iw\\,ih)"
        vf = f"crop={s}:{s}:(iw-{s})*{pos:.3f}:(ih-{s})*{pos:.3f},scale={adentro}:{adentro}:flags=lanczos"
        return vf + (f",pad={lado}:{lado}:{b}:{b}:color=white" if b else "")
    vf = f"scale={adentro}:{adentro}:force_original_aspect_ratio=decrease:flags=lanczos"
    if b:
        vf += f",pad=iw+{2 * b}:ih+{2 * b}:{b}:{b}:color=white"
    if relleno == "transparente":
        vf += f",format=rgba,pad={lado}:{lado}:(ow-iw)/2:(oh-ih)/2:color=0x00000000"
    elif relleno:
        vf += f",pad={lado}:{lado}:(ow-iw)/2:(oh-ih)/2:color={relleno}"
    return vf


def nombre_libre(base):
    n, i = base, 2
    while any((SALIDA / f"{n}.{ext}").exists() for ext in ("gif", "mp3", "mp4", "webp", "ogg")):
        n, i = f"{base}-{i}", i + 1
    return n


def exportar(d):
    tid = d["id"]
    f = fuente(tid)
    meta = meta_de(tid) or sondear(f)
    ini = max(0.0, float(d["inicio"]))
    fin = min(float(d["fin"]), meta.get("duracion") or float(d["fin"]))
    dur = round(fin - ini, 3)
    if dur < 0.1:
        raise ValueError("El tramo es muy corto")
    tope = float(d.get("tope", 10))
    if tope not in TOPES:
        raise ValueError("El tope es 5, 10, 20 o 30 s")
    if dur > tope + 0.05:
        raise ValueError(f"El tramo dura {dur:.1f} s; el tope es {tope:.0f} s")
    fondo = {"negro": "black", "blanco": "white"}.get(d.get("fondo", "negro"), "black")
    lado = int(d.get("lado", 512))
    fps = int(d.get("fps", 15))
    kbps = int(d.get("kbps", 64))
    colores = int(d.get("colores", 128))
    if lado not in (256, 320, 384, 512) or fps not in (8, 10, 12, 15, 20, 24) or kbps not in (32, 48, 64, 96, 128):
        raise ValueError("Opciones raras")
    colores = max(16, min(256, colores))
    SALIDA.mkdir(parents=True, exist_ok=True)
    base = nombre_libre(d.get("nombre") and slug(d["nombre"]) or f"{slug(meta.get('titulo'), 32)}-{ini:.1f}s".replace(".", "-"))

    lado = min(lado, min(meta.get("ancho") or lado, meta.get("alto") or lado) if d.get("encuadre") == "cuadrado"
               else max(meta.get("ancho") or lado, meta.get("alto") or lado))  # nunca agrandar: solo pesa más
    recorte = encuadre_vf(d, lado)  # en "Completo" el GIF queda con la forma del video, sin relleno
    filtro =(f"fps={fps},{recorte},hqdn3d=2:2:3:3,split[a][b];[a]palettegen=max_colors={colores}:stats_mode=diff[p];"
              f"[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle")
    from concurrent.futures import ThreadPoolExecutor
    trabajos = ThreadPoolExecutor(max_workers=2)
    en_mp4 = trabajos.submit(hacer_mp4, f, meta, base, ini, dur, d, fondo)
    en_wa = trabajos.submit(hacer_tramo_wa, f, meta, base, ini, dur, d)
    trabajos.shutdown(wait=False)
    gif = SALIDA / f"{base}.gif"
    r = correr(["ffmpeg", "-y", "-v", "error", "-ss", f"{ini:.3f}", "-t", f"{dur:.3f}", "-i", str(f),
                "-filter_complex", filtro, "-loop", "0", str(gif)])
    if r.returncode != 0:
        raise RuntimeError("ffmpeg no pudo hacer el GIF: " + r.stderr[-400:])

    res = {"base": base, "duracion": dur, "gif": {"nombre": gif.name, "bytes": gif.stat().st_size}, "mp3": None}
    if meta.get("audio", True):
        mp3 = SALIDA / f"{base}.mp3"
        fundido = f"afade=t=in:d=0.02,afade=t=out:st={max(0, dur - 0.04):.3f}:d=0.04"
        r = correr(["ffmpeg", "-y", "-v", "error", "-ss", f"{ini:.3f}", "-t", f"{dur:.3f}", "-i", str(f),
                    "-vn", "-ac", "1", "-ar", "44100", "-af", fundido,
                    "-c:a", "libmp3lame", "-b:a", f"{kbps}k", str(mp3)])
        if r.returncode != 0:
            raise RuntimeError("ffmpeg no pudo hacer el MP3: " + r.stderr[-400:])
        res["mp3"] = {"nombre": mp3.name, "bytes": mp3.stat().st_size}
    res["mp4"] = en_mp4.result()
    res.update(en_wa.result())
    return res


def hacer_mp4(f, meta, base, ini, dur, d, fondo):
    """Lo que exporta StikSound: video cuadrado (lado par, máx. 512, sin agrandar), fondo sólido si el video
    no es cuadrado y se pidió "Completo", H.264 + AAC, faststart. Sale del video original, no del GIF."""
    corto = min(meta.get("ancho") or 512, meta.get("alto") or 512)
    largo = max(meta.get("ancho") or 512, meta.get("alto") or 512)
    lado = min(512, corto if d.get("encuadre") == "cuadrado" else largo) // 2 * 2
    vf = encuadre_vf(d, lado, fondo) + ",setsar=1,format=yuv420p"
    mp4 = SALIDA / f"{base}.mp4"
    cmd = ["ffmpeg", "-y", "-v", "error", "-ss", f"{ini:.3f}", "-t", f"{dur:.3f}", "-i", str(f), "-vf", vf,
           "-c:v", "libx264", "-preset", "medium", "-crf", "22", "-profile:v", "high", "-fpsmax", "30"]
    if meta.get("audio", True):
        fundido = f"afade=t=in:d=0.02,afade=t=out:st={max(0, dur - 0.04):.3f}:d=0.04"
        cmd += ["-af", fundido, "-c:a", "aac", "-b:a", "128k", "-ar", "48000"]
    else:
        cmd += ["-an"]
    r = correr(cmd + ["-movflags", "+faststart", str(mp4)])
    if r.returncode != 0:
        raise RuntimeError("ffmpeg no pudo hacer el MP4: " + r.stderr[-400:])
    return {"nombre": mp4.name, "bytes": mp4.stat().st_size, "lado": lado}


# ---------- el sticker con sonido de WhatsApp ----------
# El WebP y el Ogg/Opus los arma el MISMO código de WA-audio-stickers (github.com/Shirtep/WA-audio-stickers,
# copiado tal cual en stickers-extension/shirtep/, PolyForm Noncommercial 1.0.0 — Required Notice: Copyright Shirtep),
# dentro de WhatsApp Web, igual que su extensión. Aquí solo se saca el tramo ya recortado (recorte + borde de la
# ventana) en un MP4 limpio, que su código toma como "el video". Lo que arma se guarda de vuelta con guardar_wa().

def hacer_tramo_wa(f, meta, base, ini, dur, d):
    """MP4 del tramo para el proceso de Shirtep: cuadrado 512 (Cuadrado) o la forma del video con su borde
    (Completo: su modo "ajustar" le pone los bordes transparentes). 30 cuadros por segundo como su captura."""
    corto = min(meta.get("ancho") or 512, meta.get("alto") or 512)
    largo = max(meta.get("ancho") or 512, meta.get("alto") or 512)
    lado = min(512, corto if d.get("encuadre") == "cuadrado" else largo) // 2 * 2
    vf = encuadre_vf(d, lado) + ",scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,format=yuv420p"
    FUENTES.mkdir(parents=True, exist_ok=True)
    tramo = FUENTES / f"wa-{base}.mp4"
    cmd = ["ffmpeg", "-y", "-v", "error", "-ss", f"{ini:.3f}", "-t", f"{dur:.3f}", "-i", str(f), "-vf", vf,
           "-c:v", "libx264", "-preset", "fast", "-crf", "16", "-fpsmax", "30"]
    if meta.get("audio", True):
        cmd += ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"]
    else:
        cmd += ["-an"]
    r = correr(cmd + ["-movflags", "+faststart", str(tramo)])
    if r.returncode != 0:
        raise RuntimeError("ffmpeg no pudo hacer el tramo para WhatsApp: " + r.stderr[-400:])
    return {"wa": {"tramo": tramo.name, "duracion": round(sondear(tramo)["duracion"] or dur, 3), "modo": "ajustar"}}


def guardar_wa(d):
    """Guarda el WebP y el Ogg que armó el código de Shirtep, junto al GIF/MP3/MP4 del mismo sticker."""
    import base64
    base = d.get("base") or ""
    if not re.fullmatch(r"[\w.-]+", base) or not (SALIDA / f"{base}.gif").exists():
        raise ValueError("Sticker desconocido")
    out = {}
    for ext, campo in (("webp", "webp64"), ("ogg", "ogg64")):
        if d.get(campo):
            dest = SALIDA / f"{base}.{ext}"
            dest.write_bytes(base64.b64decode(d[campo]))
            out[ext] = {"nombre": dest.name, "bytes": dest.stat().st_size}
    return out


def kb(b):
    return f"{b / 1024:.0f} KB" if b < 1048576 else f"{b / 1048576:.1f} MB"


def lado_webp(f):
    try:
        with f.open("rb") as h:
            cab = h.read(30)
        if cab[12:16] == b"VP8X":
            return int.from_bytes(cab[24:27], "little") + 1
    except OSError:
        pass
    return 512


def segundos_ogg(f):
    """Duración de un Ogg Opus leyendo la última página (granule a 48 kHz menos el pre-skip)."""
    try:
        datos = f.read_bytes()
        i = datos.rfind(b"OggS")
        granulo = int.from_bytes(datos[i + 6:i + 14], "little")
        j = datos.find(b"OpusHead")
        preskip = int.from_bytes(datos[j + 10:j + 12], "little") if j >= 0 else 0
        return round(max(0, granulo - preskip) / 48000, 2)
    except (OSError, ValueError):
        return 0


def hechos(limite=24):
    if not SALIDA.exists():
        return []
    gifs = sorted(SALIDA.glob("*.gif"), key=lambda p: p.stat().st_mtime, reverse=True)[:limite]
    out = []
    for g in gifs:
        m, v, w, o = (g.with_suffix(x) for x in (".mp3", ".mp4", ".webp", ".ogg"))
        out.append({"base": g.stem, "gif": {"nombre": g.name, "bytes": g.stat().st_size},
                    "mp3": {"nombre": m.name, "bytes": m.stat().st_size} if m.exists() else None,
                    "mp4": {"nombre": v.name, "bytes": v.stat().st_size} if v.exists() else None,
                    "webp": {"nombre": w.name, "bytes": w.stat().st_size, "lado": lado_webp(w)} if w.exists() else None,
                    "ogg": {"nombre": o.name, "bytes": o.stat().st_size, "segundos": segundos_ogg(o)} if o.exists() else None})
    return out


def abrir_carpeta():
    SALIDA.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        os.startfile(SALIDA)  # noqa: S606
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(SALIDA)])
    else:
        subprocess.Popen(["xdg-open", str(SALIDA)])
    return {"ok": True, "carpeta": str(SALIDA)}


# ---------- servidor ----------

class Ventana(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def host_ok(self):
        """Solo pedidos a localhost:PUERTO. Una página maliciosa que apunte su dominio a 127.0.0.1 ("DNS rebinding")
        llega con otro Host y se rechaza, así no puede leer la lista de stickers ni los archivos."""
        host = (self.headers.get("Host") or "").strip().lower()
        if host in (f"localhost:{PUERTO}", f"127.0.0.1:{PUERTO}"):
            return True
        self.send_error(403, "Host no permitido")
        return False

    def end_headers(self):
        # el panel vive dentro de WhatsApp Web, que exige COEP require-corp: todo lo de aquí se deja embeber
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        super().end_headers()

    def responder(self, datos, codigo=200):
        cuerpo = json.dumps(datos, ensure_ascii=False).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(cuerpo)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(cuerpo)

    def archivo(self, f, bajar=False):
        total = f.stat().st_size
        tipo = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        ini, fin, codigo = 0, total - 1, 200
        if m := re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range", "")):
            if m[1]:
                ini = int(m[1])
                fin = min(int(m[2]), total - 1) if m[2] else total - 1
            elif m[2]:
                ini = max(0, total - int(m[2]))
            codigo = 206
        self.send_response(codigo)
        self.send_header("Content-Type", tipo)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(fin - ini + 1))
        self.send_header("Cache-Control", "no-store")
        if bajar:
            self.send_header("Content-Disposition", f'attachment; filename="{f.name}"')
        if codigo == 206:
            self.send_header("Content-Range", f"bytes {ini}-{fin}/{total}")
        self.end_headers()
        with f.open("rb") as h:
            h.seek(ini)
            falta = fin - ini + 1
            try:
                while falta > 0:
                    trozo = h.read(min(1 << 16, falta))
                    if not trozo:
                        break
                    self.wfile.write(trozo)
                    falta -= len(trozo)
            except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
                pass

    def do_GET(self):
        if not self.host_ok():
            return
        u = urlparse(self.path)
        ruta = unquote(u.path)
        try:
            if ruta in PAGINAS:
                f = VENTANA / PAGINAS[ruta]
                cuerpo = f.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", (mimetypes.guess_type(f.name)[0] or "text/plain") + "; charset=utf-8")
                self.send_header("Content-Length", str(len(cuerpo)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return self.wfile.write(cuerpo)
            if ruta == "/api/hola":
                return self.responder({"ok": True, "app": "stickers"})
            if ruta == "/api/hechos":
                return self.responder(hechos())
            if m := re.fullmatch(r"/api/trabajo/([0-9a-f]{12})", ruta):
                return self.responder(estado(m[1]))
            if m := re.fullmatch(r"/api/onda/([0-9a-f]{12})", ruta):
                return self.responder(onda(m[1]))
            if m := re.fullmatch(r"/tramo/(wa-[\w.-]+\.mp4)", ruta):
                f = FUENTES / m[1]
                if f.exists():
                    return self.archivo(f)
            if m := re.fullmatch(r"/fuente/([0-9a-f]{12})\.mp4", ruta):
                return self.archivo(fuente(m[1]))
            if m := re.fullmatch(r"/salida/([^/\\]+\.(gif|mp3|mp4|webp|ogg))", ruta):
                f = SALIDA / m[1]
                if f.exists() and f.parent == SALIDA:
                    return self.archivo(f, bajar="bajar" in parse_qs(u.query))
            self.send_error(404)
        except FileNotFoundError as e:
            self.responder({"error": str(e)}, codigo=404)
        except Exception as e:
            self.responder({"error": f"{type(e).__name__}: {e}"}, codigo=400)

    def do_OPTIONS(self):
        if not self.host_ok():
            return
        self.send_response(204)
        self.end_headers()

    def do_POST(self):
        if not self.host_ok():
            return
        origen = self.headers.get("Origin")
        if origen and not origen.startswith(ORIGENES_OK):
            return self.responder({"error": "origen no permitido"}, codigo=403)
        try:
            largo = int(self.headers.get("Content-Length") or 0)
            datos = json.loads(self.rfile.read(largo) or b"{}")
            ruta = urlparse(self.path).path
            if ruta == "/api/traer":
                return self.responder({"id": traer(datos.get("url"), datos.get("cookies"))})
            if ruta == "/api/exportar":
                return self.responder(exportar(datos))
            if ruta == "/api/guardar-wa":
                return self.responder(guardar_wa(datos))
            if ruta == "/api/abrir":
                return self.responder(abrir_carpeta())
            self.send_error(404)
        except Exception as e:
            self.responder({"error": str(e) if isinstance(e, (ValueError, RuntimeError, FileNotFoundError))
                            else f"{type(e).__name__}: {e}"}, codigo=400)


class _ServidorUnico(ThreadingHTTPServer):
    """Un solo servidor por puerto (en Windows SO_REUSEADDR deja que dos procesos escuchen el mismo; ver revision.py)."""
    allow_reuse_address = False
    daemon_threads = True

    def server_bind(self):
        import socket
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def servir(puerto=PUERTO, salir_si_hay=False):
    try:
        srv = _ServidorUnico(("127.0.0.1", puerto), Ventana)
    except OSError:
        print(f"Ya hay una ventana de stickers en http://localhost:{puerto}: uso esa.", flush=True)
        if salir_si_hay:
            return
        while True:
            time.sleep(3600)
    print(f"Ventana de stickers en http://localhost:{puerto}", flush=True)
    srv.serve_forever()


# ---------- prender desde la extensión (Native Messaging de Chrome) ----------
# El clic en la extensión le pide a Chrome que corra `stickers.py arranque`; eso prende el ayudante en segundo
# plano (sin ventana) si estaba apagado y contesta. Para que Chrome sepa dónde está, se instala una vez con
# `instalar-ayudante.bat` (Mac: `instalar-ayudante.command`), que corre `stickers.py instalar`.

HOST = "com.stickers_con_audio.ayudante"
EXTENSION = Path(__file__).resolve().parent / "stickers-extension"
CASA_HOST = (Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "StickersConAudio" if sys.platform == "win32"
             else Path.home() / ".stickers-con-audio")
# dónde busca cada navegador (Chrome, Edge, Brave, Chromium) el manifiesto del ayudante
REGS = [rf"Software\{n}\NativeMessagingHosts\{HOST}"
        for n in (r"Google\Chrome", r"Microsoft\Edge", r"BraveSoftware\Brave-Browser", "Chromium")]
_SOP = Path.home() / "Library/Application Support"
DIRS_MANIFIESTO = {  # Mac y Linux: los manifiestos van en estas carpetas
    "darwin": [_SOP / n / "NativeMessagingHosts" for n in
               ("Google/Chrome", "Microsoft Edge", "BraveSoftware/Brave-Browser", "Chromium")],
    "linux": [Path.home() / ".config" / n / "NativeMessagingHosts" for n in
              ("google-chrome", "microsoft-edge", "BraveSoftware/Brave-Browser", "chromium")],
}


def prendido(ms=800):
    import urllib.request
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PUERTO}/api/hola", timeout=ms / 1000) as r:
            return json.loads(r.read()).get("app") == "stickers"
    except Exception:
        return False


def prender():
    """Arranca `servir` aparte, sin ventana, y espera a que conteste. Lo que imprima va a un log."""
    if prendido():
        return {"ok": True, "ya": True}
    CASA_HOST.mkdir(parents=True, exist_ok=True)
    log = CASA_HOST / "ayudante.log"
    if log.exists() and log.stat().st_size > 1 << 20:
        log.unlink()
    cmd = [sys.executable, str(Path(__file__).resolve()), "servir", "--salir-si-hay"]
    kw = {"stdin": subprocess.DEVNULL, "stdout": log.open("a", encoding="utf-8"), "stderr": subprocess.STDOUT,
          "cwd": str(Path(__file__).resolve().parent)}
    if sys.platform == "win32":
        base = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
        try:  # que no muera cuando Chrome cierra el proceso que lo prendió
            subprocess.Popen(cmd, creationflags=base | subprocess.CREATE_BREAKAWAY_FROM_JOB, **kw)
        except OSError:
            subprocess.Popen(cmd, creationflags=base, **kw)
    else:
        subprocess.Popen(cmd, start_new_session=True, **kw)
    t0 = time.time()
    while time.time() - t0 < 20:
        if prendido():
            return {"ok": True}
        time.sleep(0.3)
    cola = log.read_text(encoding="utf-8", errors="replace")[-600:] if log.exists() else ""
    return {"ok": False, "error": "El ayudante no arrancó. " + cola.strip()}


def arranque():
    """Lo corre Chrome: lee un mensaje (4 bytes de largo + JSON), prende el ayudante y contesta igual."""
    import struct
    if sys.platform == "win32":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    largo = sys.stdin.buffer.read(4)
    if len(largo) == 4:
        sys.stdin.buffer.read(struct.unpack("<I", largo)[0])
    try:
        r = prender()
    except Exception as e:
        r = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    cuerpo = json.dumps(r, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(cuerpo)) + cuerpo)
    sys.stdout.buffer.flush()


def _id_desde_carpeta(carpeta):
    """El id que Chrome le da a una extensión 'descomprimida': sale del hash de la ruta de su carpeta."""
    datos = str(carpeta).encode("utf-16-le" if sys.platform == "win32" else "utf-8")
    return "".join(chr(ord("a") + int(c, 16)) for c in hashlib.sha256(datos).hexdigest()[:32])


def _ids_extension():
    s = str(EXTENSION)
    variantes = {s, s[0].upper() + s[1:], s[0].lower() + s[1:]} if sys.platform == "win32" else {s}
    ids = {_id_desde_carpeta(v) for v in variantes}
    # y los que Chrome tenga anotados con esta carpeta (en cualquier perfil)
    raiz = {"win32": Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/User Data",
            "darwin": Path.home() / "Library/Application Support/Google/Chrome"}.get(
        sys.platform, Path.home() / ".config/google-chrome")
    if raiz.exists():
        for pref in list(raiz.glob("*/Secure Preferences")) + list(raiz.glob("*/Preferences")):
            try:
                ext = json.loads(pref.read_text(encoding="utf-8")).get("extensions", {}).get("settings", {})
                for i, d in ext.items():
                    ruta = isinstance(d, dict) and d.get("path")
                    if ruta and Path(ruta).resolve() == EXTENSION:
                        ids.add(i)
            except Exception:
                continue
    return sorted(ids)


def instalar():
    CASA_HOST.mkdir(parents=True, exist_ok=True)
    py = Path(sys.executable)
    if sys.platform == "win32":
        lanzador = CASA_HOST / "ayudante.bat"
        lanzador.write_text(f'@echo off\r\n"{py}" "{Path(__file__).resolve()}" arranque %*\r\n', encoding="utf-8")
    else:
        lanzador = CASA_HOST / "ayudante.sh"
        lanzador.write_text(f'#!/bin/sh\nexec "{py}" "{Path(__file__).resolve()}" arranque "$@"\n', encoding="utf-8")
        lanzador.chmod(0o755)
    ids = _ids_extension()
    manifiesto = {"name": HOST, "description": "Prende el ayudante de Stickers con audio", "path": str(lanzador),
                  "type": "stdio", "allowed_origins": [f"chrome-extension://{i}/" for i in ids]}
    texto = json.dumps(manifiesto, indent=2)
    if sys.platform == "win32":
        import winreg
        f = CASA_HOST / f"{HOST}.json"
        f.write_text(texto, encoding="utf-8")
        for reg in REGS:
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, reg) as k:
                winreg.SetValueEx(k, "", 0, winreg.REG_SZ, str(f))
        donde = rf"HKEY_CURRENT_USER\{REGS[0]}" + " (y lo mismo para Edge, Brave y Chromium)"
    else:
        dirs = DIRS_MANIFIESTO.get(sys.platform, [])
        for d in dirs:
            if d.parent.exists():  # solo en los navegadores que estén instalados
                d.mkdir(exist_ok=True)
                (d / f"{HOST}.json").write_text(texto, encoding="utf-8")
        donde = ", ".join(str(d) for d in dirs if d.exists())
    print("Listo: el botón de la extensión ya prende el ayudante solo.")
    print(f"  Archivos: {CASA_HOST}")
    print(f"  Chrome lo encuentra en: {donde}")
    print(f"  Extensión (ids): {', '.join(ids)}")
    print("Si movés la carpeta del proyecto, volvé a correr el instalador. Para quitarlo: desinstalar-ayudante.")


def desinstalar():
    if sys.platform == "win32":
        import winreg
        for reg in REGS:
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, reg)
            except FileNotFoundError:
                pass
    else:
        for d in DIRS_MANIFIESTO.get(sys.platform, []):
            (d / f"{HOST}.json").unlink(missing_ok=True)
    for f in ("ayudante.bat", "ayudante.sh", f"{HOST}.json"):
        (CASA_HOST / f).unlink(missing_ok=True)
    print("Quitado: la extensión ya no prende el ayudante (si está prendido, sigue hasta que apagués la compu).")


def main():
    # Chrome corre el lanzador con `arranque` (y le agrega el origen): ahí stdout es el canal, nada de prints
    if len(sys.argv) > 1 and sys.argv[1] == "arranque":
        return arranque()
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="Stickers con audio: link → GIF + MP3")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("servir")
    s.add_argument("--salir-si-hay", action="store_true", help="si ya hay uno prendido, salir en vez de esperar")
    sub.add_parser("instalar", help="que el botón de la extensión prenda el ayudante (una vez por compu)")
    sub.add_parser("desinstalar", help="quitar lo que puso 'instalar'")
    t = sub.add_parser("traer")
    t.add_argument("url")
    a = ap.parse_args()
    if a.cmd == "servir":
        servir(salir_si_hay=a.salir_si_hay)
    elif a.cmd == "instalar":
        instalar()
    elif a.cmd == "desinstalar":
        desinstalar()
    else:
        tid = traer(a.url)
        while (e := estado(tid))["estado"] in ("bajando", "convirtiendo"):
            print(f"\r{e['estado']} {e.get('pct', 0):.0f}%", end="", flush=True)
            time.sleep(0.5)
        print()
        print(json.dumps(estado(tid), ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
