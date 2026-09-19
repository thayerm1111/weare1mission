#!/bin/bash
#
# BUILD THE BRAIN — double-click this file.
#
# It produces "Command Center XAUUSD.app" from the shell in this folder. Nothing here touches the
# trading system: the application it builds is a window around the deployed site, so the only thing
# this script needs is a Rust toolchain and a few minutes.
#
set -u
cd "$(dirname "$0")" || exit 1

say() { printf "\n\033[1;33m%s\033[0m\n" "$*"; }
ok()  { printf "\033[0;32m  ✓ %s\033[0m\n" "$*"; }
bad() { printf "\033[0;31m  ✗ %s\033[0m\n" "$*"; }

say "COMMAND CENTER XAUUSD — building the desktop shell"
printf "  This builds a native window around weare1mission.com.\n"
printf "  It does not run, change or stop any trading. That stays on the server.\n"

# ── Xcode command line tools ────────────────────────────────────────────────
if ! xcode-select -p >/dev/null 2>&1; then
  say "Apple's command line tools are needed first"
  printf "  A system dialog will appear. Click Install, wait for it to finish,\n"
  printf "  then run this file again.\n\n"
  xcode-select --install
  read -r -p "  Press return to close. " _
  exit 0
fi
ok "Apple command line tools"

# ── Rust ────────────────────────────────────────────────────────────────────
if ! command -v cargo >/dev/null 2>&1; then
  [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
fi
if ! command -v cargo >/dev/null 2>&1; then
  say "Rust is not installed — it is what compiles the application"
  printf "  This installs the official toolchain from rust-lang.org into your home\n"
  printf "  folder. Nothing outside ~/.cargo and ~/.rustup is touched.\n\n"
  read -r -p "  Install Rust now? [y/N] " answer
  case "$answer" in
    [yY]*) curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y || { bad "Rust install failed"; read -r -p "  Press return. " _; exit 1; } ;;
    *) bad "Cannot build without it."; read -r -p "  Press return. " _; exit 1 ;;
  esac
  . "$HOME/.cargo/env"
fi
ok "Rust $(cargo --version 2>/dev/null | awk '{print $2}')"

# ── Node ────────────────────────────────────────────────────────────────────
if ! command -v npm >/dev/null 2>&1; then
  bad "Node.js is not installed. Install it from nodejs.org, then run this again."
  read -r -p "  Press return. " _
  exit 1
fi
ok "Node $(node --version)"

# ── build ───────────────────────────────────────────────────────────────────
say "Fetching the build tool"
npm install --silent || { bad "npm install failed"; read -r -p "  Press return. " _; exit 1; }

say "Compiling — the first build takes several minutes, later ones are quick"
npm run build || { bad "Build failed. The output above says why."; read -r -p "  Press return. " _; exit 1; }

APP="src-tauri/target/release/bundle/macos/Command Center XAUUSD.app"
if [ -d "$APP" ]; then
  say "Built"
  ok "$(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")"
  printf "\n  Drag it to your Applications folder, then open it.\n"
  printf "  THE BRAIN appears first; the full Command Center opens behind it on demand.\n\n"
  open "$(dirname "$APP")"
else
  bad "The build finished but the application is not where it was expected."
  printf "  Look in src-tauri/target/release/bundle/\n"
fi

read -r -p "  Press return to close. " _
