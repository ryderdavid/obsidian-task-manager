#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PLUGIN_NAME="task-manager"
VAULT="$1"
if [ -z "$VAULT" ]; then
  echo "Usage: $0 <vault-path>"
  exit 1
fi
DEST="$VAULT/.obsidian/plugins/$PLUGIN_NAME"

cd "$PROJECT_DIR"

echo "Building $PLUGIN_NAME..."
npm run build

echo "Installing to $DEST..."
mkdir -p "$DEST"
cp main.js manifest.json "$DEST/"
[ -f styles.css ] && cp styles.css "$DEST/"

echo "✓ Installed $PLUGIN_NAME. Reload Obsidian to see changes."
