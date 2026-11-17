#!/bin/sh
# Claude Dock one-line installer:
#   curl -fsSL https://raw.githubusercontent.com/krugerrgabriel/claude-dock/main/install.sh | sh
# Downloads the latest release into ~/.local/share/claude-dock and runs install.py.
# Running it again updates to the newest version.
set -eu

REPO="krugerrgabriel/claude-dock"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/claude-dock"
URL="https://github.com/$REPO/releases/latest/download/claude-dock.tar.gz"

need_apt=""
python3 -c "import gi; gi.require_version('Gtk','3.0'); gi.require_version('WebKit2','4.1'); from gi.repository import WebKit2" 2>/dev/null || need_apt="yes"
command -v wmctrl >/dev/null 2>&1 || need_apt="yes"

if [ -n "$need_apt" ]; then
  echo "Claude Dock needs a few system packages: python3-gi gir1.2-webkit2-4.1 wmctrl"
  if command -v apt-get >/dev/null 2>&1; then
    echo "Installing them with apt (you may be asked for your password)..."
    sudo apt-get install -y python3-gi gir1.2-webkit2-4.1 wmctrl </dev/tty
  else
    echo "Install the equivalents for your distro and run this again." >&2
    exit 1
  fi
fi

echo "Downloading the latest release..."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$URL" | tar xz -C "$tmp"

# para a versão antiga (se houver) e troca os arquivos
pkill -f "^python3 -m claude_dock" 2>/dev/null || true
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
mv "$tmp/claude-dock" "$DEST"

python3 "$DEST/install.py"
