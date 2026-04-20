#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# WindsurfAPI v2.0 — macOS installer (arm64 / x86_64)
# ─────────────────────────────────────────────────────
set -e

INSTALL_DIR="$HOME/.windsurfapi"
PLIST_NAME="dev.windsurfapi"
PLIST="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"

echo "╔══════════════════════════════════════════╗"
echo "║    WindsurfAPI v2.0 Installer (macOS)    ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── Check Node.js ───────────────────────────────
if ! command -v node &>/dev/null; then
  echo "❌ Node.js not found. Please install Node.js >= 20:"
  echo "   brew install node"
  echo "   or visit https://nodejs.org/"
  exit 1
fi

NODE_VER=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_VER" -lt 20 ]; then
  echo "❌ Node.js >= 20 required (found v$(node --version))"
  exit 1
fi
echo "✅ Node.js $(node --version)"

# ── Install files ───────────────────────────────
echo "📁 Installing to $INSTALL_DIR ..."
mkdir -p "$INSTALL_DIR"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Copy source
cp -R "$SCRIPT_DIR/../src" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/../package.json" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/../README.md" "$INSTALL_DIR/" 2>/dev/null || true
cp "$SCRIPT_DIR/../CHANGELOG.md" "$INSTALL_DIR/" 2>/dev/null || true

# Create .env if not exists
if [ ! -f "$INSTALL_DIR/.env" ]; then
  API_KEY=$(openssl rand -hex 16)
  DASH_PASS=$(openssl rand -base64 12 | tr -d '=/+' | head -c 16)
  cat > "$INSTALL_DIR/.env" <<EOF
# WindsurfAPI configuration
PORT=3003
API_KEY=sk-windsurf-$API_KEY
DASHBOARD_PASSWORD=$DASH_PASS
DEFAULT_MODEL=claude-sonnet-4.6
LS_BINARY_PATH=/opt/windsurf/language_server_linux_x64
LS_PORT=42100
EOF
  echo "✅ Generated .env with random API key and dashboard password"
  echo "   Dashboard password: $DASH_PASS"
  echo "   API key: sk-windsurf-$API_KEY"
else
  echo "✅ Existing .env preserved"
fi

# ── LaunchAgent (auto-start) ────────────────────
echo ""
read -p "🔧 Set up auto-start on login? [Y/n] " autostart
autostart=${autostart:-Y}

if [[ "$autostart" =~ ^[Yy] ]]; then
  NODE_PATH="$(which node)"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${INSTALL_DIR}/src/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${INSTALL_DIR}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$(dirname "$NODE_PATH"):/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${HOME}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>Crashed</key>
        <true/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>${HOME}/Library/Logs/windsurfapi.out.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME}/Library/Logs/windsurfapi.err.log</string>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
PLISTEOF

  launchctl bootout gui/$(id -u)/${PLIST_NAME} 2>/dev/null || true
  launchctl bootstrap gui/$(id -u) "$PLIST" 2>/dev/null || true
  echo "✅ LaunchAgent installed and started"
  echo "   Logs: ~/Library/Logs/windsurfapi.*.log"
fi

echo ""
echo "════════════════════════════════════════════"
echo "✅ WindsurfAPI v2.0 installed!"
echo ""
echo "   Dashboard: http://localhost:3003/dashboard"
echo "   API:       http://localhost:3003/v1/chat/completions"
echo ""
echo "   Manual start: cd $INSTALL_DIR && node src/index.js"
echo "   Stop:         launchctl bootout gui/\$(id -u)/${PLIST_NAME}"
echo "   Restart:      launchctl kickstart -k gui/\$(id -u)/${PLIST_NAME}"
echo "════════════════════════════════════════════"
