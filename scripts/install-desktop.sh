#!/usr/bin/env bash
# Gives the game's window its own icon under WSLg (and a "TUI RPG" entry in the Windows Start menu).
#
# WSLg shows a window's icon from the desktop entry whose name matches the window's app id ("tui-rpg", set in
# src/electron/window.ts), and it only reads entries from /usr/share/applications: with none, it shows a
# penguin. So this needs root:   sudo bash scripts/install-desktop.sh
# The icon goes beside it in /usr/share, where WSLg can read it. Run it again after changing the icon.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install -Dm644 "$here/electron/icon.png" /usr/share/icons/hicolor/512x512/apps/tui-rpg.png
cat > /usr/share/applications/tui-rpg.desktop <<DESKTOP
[Desktop Entry]
Type=Application
Name=TUI RPG
Comment=A text adventure with an AI narrator
Exec=bash -lc "cd '$here' && npm run electron"
Icon=/usr/share/icons/hicolor/512x512/apps/tui-rpg.png
StartupWMClass=tui-rpg
Categories=Game;
Terminal=false
DESKTOP
chmod 644 /usr/share/applications/tui-rpg.desktop
echo "Installed /usr/share/applications/tui-rpg.desktop and its icon."
echo "Start the game again; if the penguin's still there, restart WSL once (in Windows: wsl --shutdown)."
