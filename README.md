# Stickers con audio

Hacé **stickers de WhatsApp con sonido** a partir de cualquier video —un reel de Instagram, un TikTok, un video de YouTube— sin salir de WhatsApp Web.

Pegás el link, elegís el pedacito que querés (sobre la onda del audio), recortás el cuadro y lo mandás. A quien lo recibe le llega un sticker que suena al tocarlo.

> **No oficial.** Esto no tiene relación con WhatsApp ni con Meta. Usa funciones internas de WhatsApp Web que pueden cambiar en cualquier momento, y prende en *tu* navegador la función de stickers con sonido, que WhatsApp todavía está probando. Usalo bajo tu propia responsabilidad.

## Qué hace

- **Desde un link:** Instagram, TikTok, YouTube y cualquier sitio que entienda [yt-dlp](https://github.com/yt-dlp/yt-dlp).
- **Elegís el tramo** sobre la forma de onda del audio, con un mapa de todo el video y tope de 5, 10, 20 o 30 segundos.
- **Recortás:** cuadrado (arrastrás el recuadro sobre el video) o completo, con o sin **borde blanco**.
- **Lo mandás desde WhatsApp Web**, al chat abierto o a vos mismo para reenviarlo a quien querás.
- El sticker siempre pesa **menos de 1 MB** (el límite de WhatsApp): busca el balance entre fluido y nítido.
- De paso te deja el **GIF**, el **MP3** y un **MP4** cuadrado de cada sticker.

## Cómo funciona

Son dos piezas que corren **solo en tu compu**:

1. **El ayudante** (`stickers.py`): un programita en Python que baja el video con yt-dlp y lo recorta con ffmpeg. Corre en `http://localhost:4195` y solo acepta pedidos de tu propia compu. No hace falta abrirlo: la extensión lo prende sola, sin ventana, cuando le das al botón.
2. **La extensión de Chrome** (`stickers-extension/`): pone un panel encima de WhatsApp Web. Ahí elegís el tramo y el recorte, y cuando le das *Mandar*, arma el sticker (WebP animado + audio Ogg/Opus) y lo manda con tu sesión de WhatsApp Web.

Nada se sube a ningún servidor que no sea WhatsApp.

## Requisitos

- **Google Chrome** (o Edge o Brave) de escritorio, actualizado.
- **Python 3.10 o más nuevo.**
- **ffmpeg.**
- **yt-dlp** (con `curl-cffi`, que ayuda con TikTok).

## Instalación

### 1. Bajá el proyecto

```
git clone https://github.com/kahou234/stickers-con-audio.git
cd stickers-con-audio
```

O bajá el ZIP desde el botón verde **Code → Download ZIP** y descomprimilo en una carpeta que no vayás a mover.

### 2. Instalá ffmpeg y yt-dlp

**Windows** (PowerShell):

```
winget install Gyan.FFmpeg
py -m pip install -U "yt-dlp[default,curl-cffi]"
```

**Mac** (con [Homebrew](https://brew.sh)):

```
brew install ffmpeg
python3 -m pip install -U "yt-dlp[default,curl-cffi]"
```

### 3. Cargá la extensión en Chrome

1. Abrí `chrome://extensions`.
2. Prendé **Modo de desarrollador** (arriba a la derecha).
3. Tocá **Cargar descomprimida** y elegí la carpeta `stickers-extension` (la que tiene adentro `manifest.json`).
4. Fijala con el ícono del rompecabezas → chincheta.

### 4. Instalá el ayudante (una sola vez)

En la carpeta del proyecto, doble clic en **`instalar-ayudante.bat`** (Mac: **`instalar-ayudante.command`**; Linux: `python3 stickers.py instalar`). Después recargá la extensión en `chrome://extensions` (↻).

Listo: desde ahí, cada vez que le das al botón de la extensión, el ayudante se prende solo en segundo plano (sin terminal) y queda prendido hasta que apagués la compu.

Qué deja el instalador, para que sepás qué hay en tu compu:
- Una carpeta `%LOCALAPPDATA%\StickersConAudio\` (Mac/Linux: `~/.stickers-con-audio/`) con un lanzador, su manifiesto y `ayudante.log`.
- El registro de ese manifiesto para Chrome, Edge, Brave y Chromium ([Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)): en Windows, claves en `HKEY_CURRENT_USER\Software\...\NativeMessagingHosts\com.stickers_con_audio.ayudante` (no pide administrador); en Mac/Linux, un `.json` en la carpeta `NativeMessagingHosts` de cada navegador.

Solo la extensión cargada desde esta carpeta puede prenderlo. Si movés la carpeta, volvé a correr el instalador. Para quitarlo todo: **`desinstalar-ayudante.bat`** (Mac: `.command`).

Si preferís prenderlo a mano: `py stickers.py servir` (Mac/Linux: `python3 stickers.py servir`).

## Uso

1. Abrí [WhatsApp Web](https://web.whatsapp.com) y el chat donde querés mandar el sticker.
2. Tocá el botón de la extensión: aparece el panel a la derecha.
   - Si estabas viendo un video (un reel, un TikTok, un video de YouTube), el panel abre con ese video ya cargado.
   - Si no, pegá el link arriba y tocá **Traer**.
3. Elegí el tramo arrastrando sobre la onda (▶ lo escuchás en bucle) y el recorte sobre el video.
4. Tocá **➔** para preparar el sticker.
5. Opcional: escribí el **Paquete** y el **Autor**, que WhatsApp muestra debajo del sticker.
6. Tocá **Mandar a WhatsApp**.

Si Chrome pregunta si WhatsApp Web puede acceder a la **red local** o a dispositivos locales, decile que sí: es el panel hablando con el ayudante de tu compu.

Los archivos quedan en `Videos/StickersConAudio/` (Mac: `Movies/StickersConAudio/`). Podés cambiar la carpeta con la variable de entorno `STICKERS_CARPETA`.

## Límites

| | Límite | Por qué |
|---|---|---|
| Peso del sticker | 1 MB | WhatsApp rechaza los más pesados. |
| Duración | hasta 30 s | Mientras más largo, más chiquito o menos fluido queda para caber en 1 MB. Hasta 10 s se ve nítido. |
| Quien lo recibe | WhatsApp actualizado | Si no, le sale "mensaje no compatible con tu versión". |

En **WhatsApp Web** el sonido a veces no se reproduce después de recargar la página; en los **celulares** sí suena.

## Problemas comunes

- **El panel dice "Falta un paso":** corré `instalar-ayudante` (paso 4) y recargá la extensión. Si moviste la carpeta, correlo otra vez.
- **El panel dice que no pudo prender el ayudante:** mirá `ayudante.log` en la carpeta del paso 4; casi siempre falta ffmpeg o yt-dlp.
- **Un video no baja:** actualizá yt-dlp con `py -m pip install -U --pre "yt-dlp[default,curl-cffi]"`. Los sitios cambian seguido.
- **Instagram pide sesión:** iniciá sesión en Instagram en ese mismo Chrome. La extensión le pasa al ayudante solo las cookies de ese sitio, en tu compu, y se borran apenas termina la bajada.
- **El panel no aparece:** recargá WhatsApp Web (F5). Las pestañas abiertas antes de instalar la extensión no la tienen.

## Privacidad y seguridad

- Todo corre en tu compu. No hay servidores propios, cuentas ni claves de ningún servicio.
- El ayudante solo escucha en `127.0.0.1` y rechaza pedidos de otras páginas web.
- Las cookies solo se usan para bajar el video que pediste, nunca salen de tu compu y se borran al terminar.
- Para mandar el sticker, la extensión usa tu sesión abierta de WhatsApp Web, igual que si lo mandaras vos a mano.

## Créditos y licencias

- **[WA-audio-stickers](https://github.com/Shirtep/WA-audio-stickers)** de Shirtep: el formato del sticker con sonido y el código que lo arma y lo manda desde WhatsApp Web. Está copiado tal cual en `stickers-extension/shirtep/`, bajo la licencia **PolyForm Noncommercial 1.0.0** (uso libre y sin fines comerciales). Ver `stickers-extension/LICENCIA-WA-audio-stickers.md`.
- **[StikSound](https://github.com/SilverFeit/StikSound)** de SilverFeit: inspiró el diseño del panel.
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** y **[FFmpeg](https://ffmpeg.org)**.

El resto del código es de este proyecto, bajo licencia **MIT** (ver `LICENSE`). Como incluye código PolyForm Noncommercial, **el proyecto completo es solo para uso no comercial.**
