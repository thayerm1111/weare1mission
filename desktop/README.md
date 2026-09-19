# COMMAND CENTER XAUUSD — desktop shell

A native window around the application that already exists. It is deliberately thin.

## What this is not

It is not a second Command Center, and it is not where trading lives. The shell owns windows, a
keyboard shortcut and native notifications. Market monitoring, strategy evaluation, trade management,
execution and reconciliation all stay on the server, which is what makes the system indifferent to
this computer sleeping, crashing or being closed mid-trade.

## Why it loads a URL instead of bundling a frontend

The windows point at `https://weare1mission.com`. That single decision avoids:

- a second UI codebase to keep in step with the first,
- a second deploy that can silently fall behind the website,
- re-solving authentication for a client with no cookie jar for the site.

Tauri injects its IPC bridge into remote pages; the Rust side then answers only what
`capabilities/remote-command-center.json` grants. A fix shipped to the web is a fix in the app the
moment it reloads.

## Windows

| label | content | behaviour |
|---|---|---|
| `companion` | `/companion` | floating, borderless, transparent, always-on-top by default |
| `main` | `/command-center` | the full application, created hidden and raised on demand |

## Build

Requires Rust (`rustup`) and Xcode command line tools on macOS.

```
cd desktop
npm install
npm run dev      # runs against the live site
npm run build    # → src-tauri/target/release/bundle/{macos,dmg}
```

A build you produce and run on your own machine needs no code signing; macOS only demands it for
software that arrives with a quarantine attribute, which a local build does not have.

`macOSPrivateApi` is on, because the companion window is transparent. That is incompatible with Mac
App Store distribution and irrelevant to direct distribution.
