#!/bin/bash
set -e

# Bootstrap script for fresh machine install
# Usage: curl -fsSL https://raw.githubusercontent.com/ryderdavid/obsidian-task-manager/main/bootstrap.sh | bash

PLUGINS_DIR="$HOME/Projects/Obsidian-Plugins"
VAULT="$HOME/Obsidian/Main"

REPOS=(
  "obsidian-task-manager"
  "agent-client-helper"
  "fastmail-ics-helper"
  "day-planner-patch"
  "timeblock-formatter"
  "obsidian-css-snippets"
)

echo "=== Obsidian Plugins Bootstrap ==="
echo ""

# Check prerequisites
if ! command -v git &> /dev/null; then
  echo "Error: git is required"
  exit 1
fi

if ! command -v node &> /dev/null; then
  echo "Error: node is required (for TypeScript plugins)"
  exit 1
fi

if [ ! -d "$VAULT" ]; then
  echo "Warning: Vault not found at $VAULT"
  echo "Create it first or adjust the VAULT variable in this script."
  exit 1
fi

mkdir -p "$PLUGINS_DIR"
cd "$PLUGINS_DIR"

for repo in "${REPOS[@]}"; do
  echo "--- $repo ---"

  if [ -d "$repo" ]; then
    echo "Already exists, pulling latest..."
    cd "$repo"
    git pull
    cd ..
  else
    echo "Cloning..."
    git clone "https://github.com/ryderdavid/$repo.git"
  fi

  cd "$repo"

  if [ -f "package.json" ]; then
    echo "Installing dependencies..."
    npm install --silent
    echo "Building and installing..."
    npm run install-plugin
  elif [ -f "scripts/install.sh" ]; then
    echo "Running install script..."
    ./scripts/install.sh
  fi

  cd "$PLUGINS_DIR"
  echo ""
done

echo "=== Done ==="
echo ""
echo "Installed to: $VAULT/.obsidian/plugins/"
echo "Reload Obsidian to activate plugins."
