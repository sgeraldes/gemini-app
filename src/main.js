const { app, BrowserWindow, Menu, MenuItem, ipcMain, session, shell, clipboard } = require("electron");
const path = require("path");

const passkeyFeatures = [
  "WebAuthentication",
  "WebAuthenticationCableSecondFactor",
  "WebAuthenticationHybridTransport",
  "WebAuthenticationRemoteDesktopSupport"
];
const googlePartition = "persist:google";
const googleAuthCookieNames = new Set(["SID", "HSID", "SSID", "APISID", "SAPISID", "LSID", "__Secure-1PSID", "__Secure-3PSID"]);
let chromeUserAgent;

app.commandLine.appendSwitch("enable-features", passkeyFeatures.join(","));

let mainWindow;

function googleSession() {
  return session.fromPartition(googlePartition);
}

/**
 * Build a Chrome-flavoured User-Agent by stripping every non-Chrome token
 * Electron appends to the default UA. The default looks like:
 *   "Mozilla/5.0 (...) AppleWebKit/537.36 (KHTML, like Gecko)
 *    gemini-desktop/0.1.0 Chrome/130.0.6723.137 Electron/33.0.2 Safari/537.36"
 * Google's makersuite endpoints (alkalimakersuite-pa.clients6.google.com)
 * reject unknown product tokens with HTTP 403 "caller does not have
 * permission", so the UA must look exactly like vanilla Chrome.
 */
function buildChromeUserAgent(rawUserAgent) {
  const appProduct = `${app.getName()}/${app.getVersion()}`;
  return rawUserAgent
    .replace(new RegExp(`\\s${appProduct.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u"), "")
    .replace(/\sElectron\/\S+/u, "")
    // Defensive: also remove any other electron-app product tokens we don't know about.
    .replace(/\s\S+\/\S+\s(?=Chrome\/)/u, " ")
    .trim();
}

function setupGoogleSession() {
  chromeUserAgent = buildChromeUserAgent(session.defaultSession.getUserAgent());
  // Apply to both the default session (used by main window chrome) and the persist:google
  // partition (used by all webviews) so every request looks like Chrome.
  session.defaultSession.setUserAgent(chromeUserAgent);
  googleSession().setUserAgent(chromeUserAgent);

  googleSession().setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(["media", "geolocation", "notifications", "clipboard-read"].includes(permission));
  });

  // Notify the renderer whenever a Google auth-related cookie is added/removed so the
  // titlebar avatar & menu can react to sign-in / sign-out happening inside the webview.
  let notifyAuthDebounce;
  googleSession().cookies.on("changed", (_event, cookie) => {
    if (!googleAuthCookieNames.has(cookie.name)) return;
    clearTimeout(notifyAuthDebounce);
    notifyAuthDebounce = setTimeout(() => {
      mainWindow?.webContents.send("auth:changed");
    }, 300);
  });
}

// (Profile/avatar info is read in the renderer via webview.executeJavaScript —
//  the ListAccounts endpoint returned inconsistent data so the renderer now
//  scrapes the user-avatar img straight out of the loaded page instead.)

/**
 * Build & show a right-click context menu for any webContents (main window or
 * any <webview> hosted inside it). Electron does not ship a default context
 * menu, so without this handler right-click is a no-op.
 */
function attachContextMenu(contents) {
  contents.on("context-menu", (_event, params) => {
    const hasSelection = params.selectionText && params.selectionText.trim().length > 0;
    const isEditable = params.isEditable;
    const items = [];

    if (params.linkURL) {
      items.push(
        new MenuItem({
          label: "Open link in browser",
          click: () => shell.openExternal(params.linkURL)
        }),
        new MenuItem({
          label: "Copy link address",
          click: () => clipboard.writeText(params.linkURL)
        }),
        new MenuItem({ type: "separator" })
      );
    }

    if (params.hasImageContents) {
      items.push(
        new MenuItem({
          label: "Copy image",
          click: () => contents.copyImageAt(params.x, params.y)
        }),
        new MenuItem({
          label: "Copy image address",
          click: () => clipboard.writeText(params.srcURL)
        }),
        new MenuItem({ type: "separator" })
      );
    }

    if (isEditable) {
      items.push(
        new MenuItem({ role: "undo" }),
        new MenuItem({ role: "redo" }),
        new MenuItem({ type: "separator" }),
        new MenuItem({ role: "cut", enabled: hasSelection }),
        new MenuItem({ role: "copy", enabled: hasSelection }),
        new MenuItem({ role: "paste" }),
        new MenuItem({ role: "pasteAndMatchStyle" }),
        new MenuItem({ role: "selectAll" })
      );
    } else if (hasSelection) {
      items.push(
        new MenuItem({ role: "copy" }),
        new MenuItem({ role: "selectAll" })
      );
    } else {
      items.push(
        new MenuItem({
          label: "Back",
          enabled: contents.navigationHistory ? contents.navigationHistory.canGoBack() : contents.canGoBack(),
          click: () => contents.navigationHistory ? contents.navigationHistory.goBack() : contents.goBack()
        }),
        new MenuItem({
          label: "Forward",
          enabled: contents.navigationHistory ? contents.navigationHistory.canGoForward() : contents.canGoForward(),
          click: () => contents.navigationHistory ? contents.navigationHistory.goForward() : contents.goForward()
        }),
        new MenuItem({
          label: "Reload",
          click: () => contents.reload()
        }),
        new MenuItem({ type: "separator" }),
        new MenuItem({ role: "selectAll" })
      );
    }

    items.push(
      new MenuItem({ type: "separator" }),
      new MenuItem({
        label: "Inspect element",
        click: () => {
          contents.inspectElement(params.x, params.y);
          if (contents.isDevToolsOpened()) contents.devToolsWebContents?.focus();
        }
      })
    );

    Menu.buildFromTemplate(items).popup({ window: mainWindow ?? undefined });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1420,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#151515",
    title: "Gemini Desktop",
    icon: path.join(__dirname, "assets", "icon.ico"),
    frame: false,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedGoogleUrl(url)) {
      mainWindow.webContents.send("navigate:internal", url);
    } else {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });
}

function isTrustedGoogleUrl(rawUrl) {
  try {
    const { hostname } = new URL(rawUrl);
    return hostname === "google.com" || hostname.endsWith(".google.com") ||
      hostname === "withgoogle.com" || hostname.endsWith(".withgoogle.com") ||
      hostname === "jules.google.com" ||
      hostname === "gemini.google.com" ||
      hostname === "aistudio.google.com";
  } catch {
    return false;
  }
}

app.on("web-contents-created", (_event, contents) => {
  attachContextMenu(contents);
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  setupGoogleSession();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("window:minimize", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});

ipcMain.handle("window:maximize", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return false;
  if (window.isMaximized()) {
    window.unmaximize();
    return false;
  }
  window.maximize();
  return true;
});

ipcMain.handle("window:close", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.handle("window:isMaximized", (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
});

ipcMain.handle("window:devtools", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return false;
  window.webContents.openDevTools({ mode: "detach" });
  return true;
});

ipcMain.handle("auth:status", async () => {
  const cookies = await googleSession().cookies.get({ url: "https://accounts.google.com" });

  return {
    signedIn: cookies.some((cookie) => googleAuthCookieNames.has(cookie.name)),
    cookieNames: cookies.map((cookie) => cookie.name)
  };
});

ipcMain.handle("auth:clear", async () => {
  await googleSession().clearStorageData({
    storages: [
      "cookies",
      "filesystem",
      "indexdb",
      "localstorage",
      "shadercache",
      "websql",
      "serviceworkers",
      "cachestorage"
    ]
  });
  return { signedIn: false };
});

ipcMain.handle("browser:userAgent", () => chromeUserAgent || session.defaultSession.getUserAgent().replace(/\sElectron\/\S+/u, ""));

ipcMain.handle("tool:openAppWindow", (_event, rawUrl) => {
  if (rawUrl) {
    shell.openExternal(rawUrl);
  }
  return { opened: true, external: true };
});
