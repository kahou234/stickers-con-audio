#!/bin/sh
# Stickers con audio: quita lo que puso instalar-ayudante.command.
cd "$(dirname "$0")" && python3 stickers.py desinstalar
