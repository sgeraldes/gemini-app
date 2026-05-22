# Gemini Desktop

A Windows desktop client for Google's AI suite. Gemini Desktop bundles Gemini,
Google AI Studio, Pomelli, Jules, and Stitch into a single native-feeling
window where one Google sign-in is shared across every tool — the way a desktop
client should work, instead of living scattered across browser tabs.

It is built on Electron: each tool is hosted in its own persistent `<webview>`,
and they all share a single Google session via the `persist:google` partition.

## Features

- **Unified tool switcher** — switch between Gemini (Chat), AI Studio, Pomelli,
  Jules, and Stitch from a centered tab strip in the title bar. Each tool keeps
  its own subtle, monochrome icon and a per-tool accent colour that propagates to
  the active selector and the top edge of the content frame.
- **Animated selector** — the active-tab pill slides between tools and the accent
  colour cross-fades on switch.
- **Shared Google session** — sign in once; every tool reuses the same account
  via the `persist:google` Electron partition.
- **Account avatar** — the top-right button shows your Google profile photo when
  signed in (with an animated loading state while it resolves), or a **Sign in**
  pill when signed out.
- **Custom tools** — pin additional Google tools with the **+** button. Only
  `https` URLs on `google.com` / `withgoogle.com` are accepted.
- **Native-style title bar** — frameless window with a custom title bar: the
  app icon opens the application menu (standard Windows behaviour), browser-style
  back/forward arrows sit beside the tabs, and standard minimize / maximize /
  close caption buttons live top-right.
- **Right-click context menu** — copy, paste, open/copy links, copy images, back /
  forward / reload, and inspect element across the main window and every webview.
- **Chrome-flavoured User-Agent** — the Electron and app product tokens are
  stripped from the UA so Google endpoints (notably AI Studio's makersuite APIs,
  which otherwise return `403 PERMISSION_DENIED`) treat the app like Chrome.
- **Passkey / WebAuthn support** — hybrid transport and remote-desktop WebAuthn
  features are enabled for Google sign-in.

## Requirements

- Windows
- Node.js 18+ and npm

## Run (development)

```powershell
npm install
npm start
```

## Build

Build the Windows installer (NSIS):

```powershell
npm run dist
```

The installer is written to `release/Gemini Desktop Setup <version>.exe` and
installs per-user to `%LOCALAPPDATA%\Programs\Gemini Desktop`.

To produce only the unpacked build (no installer):

```powershell
npm run pack
```

The unpacked Windows build is written to `release/win-unpacked`.

## Included tools

| Tool      | Tab label | URL                                        |
| --------- | --------- | ------------------------------------------ |
| Gemini    | Chat      | `https://gemini.google.com/app`            |
| AI Studio | AI Studio | `https://aistudio.google.com/apps`         |
| Pomelli   | Pomelli   | `https://labs.google.com/u/0/pomelli`      |
| Jules     | Jules     | `https://jules.google.com/session`         |
| Stitch    | Stitch    | `https://stitch.withgoogle.com/`           |

Custom tools added with the **+** button are persisted locally and must be
served from `google.com` or `withgoogle.com` over `https`.

## Google sign-in

On first launch, if no Google session is detected the app navigates to the
Google account chooser. Signing in uses the shared Electron partition
`persist:google`, so Gemini, AI Studio, Pomelli, Jules, Stitch, and any custom
Google tools reuse the same account session.

Use **Sign out** in the account menu (the avatar button, top-right) to clear that
shared local session. The auto-redirect to sign-in only happens once per launch,
so a deliberate sign-out won't trap you on the login page.

## Project structure

```
src/
  main.js       Electron main process: window, session/UA, context menu, IPC
  preload.js    contextBridge API exposed to the renderer
  renderer.js   Tool switching, title bar UI, auth/avatar, custom tools
  index.html    App shell markup
  styles.css    Title bar, tool switcher, and content-frame styling
  assets/       App icon
build/          electron-builder resources (icon.ico)
```

## License

MIT
