const defaultTools = {
  gemini: {
    title: "Chat",
    url: "https://gemini.google.com/app"
  },
  studio: {
    title: "AI Studio",
    url: "https://aistudio.google.com/apps"
  },
  pomelli: {
    title: "Pomelli",
    url: "https://labs.google.com/u/0/pomelli"
  },
  jules: {
    title: "Jules",
    url: "https://jules.google.com/session"
  },
  stitch: {
    title: "Stitch",
    url: "https://stitch.withgoogle.com/"
  }
};

// Subtle per-tool accent colours. These are NOT brand logos — just a hue that
// tints the active selector and the content-frame accent line so switching
// tools feels alive. Custom tools fall back to a neutral grey.
const toolAccents = {
  gemini: "#74a8ff",
  studio: "#a78bfa",
  pomelli: "#f4915e",
  jules: "#65d89b",
  stitch: "#ef7bb0"
};
const fallbackAccent = "#9aa0a6";

const state = {
  currentTool: localStorage.getItem("currentTool") || "gemini",
  zoom: Number(localStorage.getItem("zoom") || "1"),
  customTools: JSON.parse(localStorage.getItem("customTools") || "[]"),
  signedIn: false,
  profile: null,
  avatarLoading: false
};

// Tracks whether we've already auto-redirected the user to the sign-in page this
// session. Without this, a user who explicitly signs out would be kicked back to
// the sign-in page immediately, which is rude.
let didInitialSignInRedirect = false;

const webviewStack = document.getElementById("webviewStack");
const loadingOverlay = document.getElementById("loadingOverlay");
const customTools = document.getElementById("customTools");
const appMenu = document.getElementById("appMenu");
const appMenuButton = document.getElementById("appMenuButton");
const userMenu = document.getElementById("userMenu");
const userMenuButton = document.getElementById("userMenuButton");
const addToolDialog = document.getElementById("addToolDialog");
const tabIndicator = document.getElementById("tabIndicator");
const toolWebviews = new Map();
let currentFrameUrl = defaultTools[state.currentTool]?.url || defaultTools.gemini.url;
let browserUserAgent = "";

function allTools() {
  return {
    ...defaultTools,
    ...Object.fromEntries(state.customTools.map((tool) => [tool.id, tool]))
  };
}

function createToolWebview(id, tool) {
  if (toolWebviews.has(id)) return toolWebviews.get(id);

  const webview = document.createElement("webview");
  webview.className = "tool-webview";
  webview.dataset.tool = id;
  webview.setAttribute("partition", "persist:google");
  webview.setAttribute("allowpopups", "");
  if (browserUserAgent) {
    webview.setAttribute("useragent", browserUserAgent);
  }
  webview.setAttribute("webpreferences", "contextIsolation=yes,nodeIntegration=no");
  webview.src = tool.url;
  webview.loadedOnce = false;
  webview.currentUrl = tool.url;

  webview.addEventListener("did-start-loading", () => {
    if (state.currentTool === id) {
      showLoadingState(`Loading ${tool.title}`);
    }
  });

  webview.addEventListener("did-stop-loading", async () => {
    webview.loadedOnce = true;
    webview.currentUrl = webview.getURL() || webview.currentUrl;
    if (state.currentTool === id) {
      currentFrameUrl = webview.currentUrl;
      loadingOverlay.classList.add("hidden");
      updateNavButtons();
    }
    await refreshAuthStatus();
    // Even if refreshAuthStatus didn't trigger extraction (e.g. we were
    // already signed in but the webview just navigated to a fresh page that
    // might now expose the avatar img), try once more for this specific
    // webview so it overrides any stale data.
    if (state.currentTool === id && state.signedIn) {
      extractProfileFromActiveWebview();
    }
  });

  webview.addEventListener("did-navigate", (event) => {
    webview.currentUrl = event.url;
    if (state.currentTool === id) {
      currentFrameUrl = event.url;
      updateNavButtons();
    }
  });

  webview.addEventListener("did-navigate-in-page", (event) => {
    webview.currentUrl = event.url;
    if (state.currentTool === id) {
      currentFrameUrl = event.url;
    }
  });

  webview.addEventListener("new-window", (event) => {
    event.preventDefault();
    if (isAllowedCustomUrl(event.url)) {
      webview.loadURL(event.url);
      return;
    }
    window.geminiDesktop.openAppWindow(event.url);
  });

  webviewStack.append(webview);
  toolWebviews.set(id, webview);
  return webview;
}

async function selectTool(id) {
  const tool = allTools()[id];
  if (!tool) return;

  state.currentTool = id;
  localStorage.setItem("currentTool", id);
  setActiveButtons(id);
  updateTabIndicator();

  document.querySelectorAll(".tool-webview").forEach((webview) => {
    webview.classList.toggle("active", webview.dataset.tool === id);
  });

  const webview = createToolWebview(id, tool);
  webview.classList.add("active");
  currentFrameUrl = webview.currentUrl || tool.url;
  updateNavButtons();

  if (!webview.loadedOnce) {
    showLoadingState(`Loading ${tool.title}`);
  } else {
    loadingOverlay.classList.add("hidden");
  }
}

async function refreshAuthStatus() {
  const auth = await window.geminiDesktop.authStatus();
  const wasSignedIn = state.signedIn;
  state.signedIn = Boolean(auth?.signedIn);
  if (!state.signedIn) {
    state.profile = null;
  }
  document.body.classList.toggle("signed-in", state.signedIn);
  document.body.classList.toggle("not-signed-in", !state.signedIn);
  renderUserButton();
  renderUserMenu();

  // If we're signed in but don't have the avatar yet, poll the active webview's
  // DOM until it appears (the Google account avatar img is served from a URL
  // containing "googleusercontent.com/a/"). It can render a beat after the page
  // reports loaded, so a one-shot read often misses it.
  if (state.signedIn && !state.profile?.photoUrl) {
    startAvatarPolling();
  } else if (!state.signedIn) {
    stopAvatarPolling();
  }
  return { signedIn: state.signedIn, wasSignedIn };
}

let avatarPollTimer = null;
let avatarPollCount = 0;

function startAvatarPolling() {
  if (avatarPollTimer) return; // already polling
  avatarPollCount = 0;
  state.avatarLoading = true;
  renderUserButton();
  extractProfileFromActiveWebview(); // try right away
  avatarPollTimer = setInterval(() => {
    avatarPollCount += 1;
    if (!state.signedIn || state.profile?.photoUrl || avatarPollCount > 20) {
      stopAvatarPolling();
      return;
    }
    extractProfileFromActiveWebview();
  }, 1500);
}

function stopAvatarPolling() {
  if (avatarPollTimer) {
    clearInterval(avatarPollTimer);
    avatarPollTimer = null;
  }
  if (state.avatarLoading) {
    state.avatarLoading = false;
    renderUserButton();
  }
}

async function extractProfileFromActiveWebview() {
  const webview = activeWebview();
  if (!webview || typeof webview.executeJavaScript !== "function") return;
  let profile = null;
  try {
    profile = await webview.executeJavaScript(`
      (() => {
        const imgs = Array.from(document.querySelectorAll('img'));
        for (const img of imgs) {
          const src = (img.currentSrc || img.src || '');
          if (src.includes('googleusercontent.com/a/')) {
            return { photoUrl: src, name: img.alt || null };
          }
        }
        return null;
      })()
    `, true);
  } catch {
    profile = null;
  }
  if (profile && profile.photoUrl) {
    state.profile = { ...state.profile, ...profile };
    renderUserButton();
    renderUserMenu();
    stopAvatarPolling();
  }
}

function renderUserButton() {
  const button = userMenuButton;
  button.replaceChildren();
  button.classList.toggle("signed-out-pill", !state.signedIn);

  if (state.signedIn && state.profile?.photoUrl) {
    const img = document.createElement("img");
    img.src = state.profile.photoUrl;
    img.alt = state.profile.name || state.profile.email || "Account";
    img.className = "user-avatar";
    img.referrerPolicy = "no-referrer";
    button.append(img);
    button.title = state.profile.email || "Account";
    button.setAttribute("aria-label", state.profile.email ? `Account: ${state.profile.email}` : "Account");
  } else if (state.signedIn && state.avatarLoading) {
    const spinner = document.createElement("div");
    spinner.className = "avatar-loading";
    button.append(spinner);
    button.title = "Loading account…";
    button.setAttribute("aria-label", "Loading account");
  } else if (state.signedIn) {
    button.textContent = (state.profile?.email || "?").slice(0, 1).toUpperCase();
    button.title = state.profile?.email || "Account";
    button.setAttribute("aria-label", state.profile?.email ? `Account: ${state.profile.email}` : "Account");
  } else {
    button.textContent = "Sign in";
    button.title = "Sign in to Google";
    button.setAttribute("aria-label", "Sign in to Google");
  }
}

function renderUserMenu() {
  userMenu.replaceChildren();

  if (state.signedIn) {
    if (state.profile?.email) {
      const info = document.createElement("div");
      info.className = "user-menu-info";

      const name = document.createElement("div");
      name.className = "user-menu-name";
      name.textContent = state.profile.name || state.profile.email;
      info.append(name);

      if (state.profile.name && state.profile.email) {
        const email = document.createElement("div");
        email.className = "user-menu-email";
        email.textContent = state.profile.email;
        info.append(email);
      }
      userMenu.append(info);

      const separator = document.createElement("div");
      separator.className = "menu-separator";
      userMenu.append(separator);
    }

    userMenu.append(buildMenuItem("Manage Google account", () => {
      window.geminiDesktop.openAppWindow("https://myaccount.google.com/");
      closeMenus();
    }));

    userMenu.append(buildMenuItem("Sign out", async () => {
      closeMenus();
      await window.geminiDesktop.clearGoogleSession();
      state.signedIn = false;
      state.profile = null;
      await refreshAuthStatus();
      toolWebviews.forEach((webview) => webview.reload());
    }));
  } else {
    userMenu.append(buildMenuItem("Sign in", () => {
      closeMenus();
      navigateToSignIn();
    }));
    userMenu.append(buildMenuItem("Create account", () => {
      closeMenus();
      window.geminiDesktop.openAppWindow("https://accounts.google.com/signup");
    }));
  }
}

function buildMenuItem(label, onClick) {
  const button = document.createElement("button");
  button.setAttribute("role", "menuitem");
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function navigateToSignIn() {
  const tool = allTools()[state.currentTool] || allTools().gemini;
  const continueUrl = encodeURIComponent(tool.url);
  const signInUrl = `https://accounts.google.com/AccountChooser?continue=${continueUrl}`;
  const webview = activeWebview();
  if (webview) {
    webview.loadURL(signInUrl);
  }
}

function showLoadingState(message) {
  loadingOverlay.classList.remove("external");
  loadingOverlay.querySelector("span").textContent = message;
  loadingOverlay.classList.remove("hidden");
}

function setActiveButtons(id) {
  document.querySelectorAll("[data-tool]").forEach((button) => {
    if (button.classList.contains("tool-webview")) return;
    button.classList.toggle("active", button.dataset.tool === id);
  });
}

function accentFor(id) {
  return toolAccents[id] || fallbackAccent;
}

function hexToRgba(hex, alpha) {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Slide the selector under the active tab and tint it (plus the content-frame
// accent line) with the active tool's colour. animate=false snaps without a
// transition — used on first paint and on resize so it never visibly drifts.
function updateTabIndicator(animate = true) {
  if (!tabIndicator) return;
  const active = document.querySelector(".tool-switcher .mode-tab.active");
  if (!active) {
    tabIndicator.style.opacity = "0";
    return;
  }

  const accent = accentFor(state.currentTool);
  document.documentElement.style.setProperty("--active-accent", accent);

  const apply = () => {
    tabIndicator.style.opacity = "1";
    tabIndicator.style.width = `${active.offsetWidth}px`;
    tabIndicator.style.transform = `translateX(${active.offsetLeft}px)`;
    tabIndicator.style.backgroundColor = hexToRgba(accent, 0.2);
    tabIndicator.style.boxShadow = `inset 0 0 0 1px ${hexToRgba(accent, 0.55)}`;
  };

  if (animate) {
    apply();
    return;
  }
  const previous = tabIndicator.style.transition;
  tabIndicator.style.transition = "none";
  apply();
  void tabIndicator.offsetWidth; // force reflow so the snap isn't animated
  tabIndicator.style.transition = previous;
}

// Reflect the active webview's navigation state on the back/forward arrows.
function updateNavButtons() {
  const webview = activeWebview();
  const back = document.getElementById("backButton");
  const forward = document.getElementById("forwardButton");
  let canBack = false;
  let canForward = false;
  try {
    canBack = Boolean(webview && webview.canGoBack && webview.canGoBack());
    canForward = Boolean(webview && webview.canGoForward && webview.canGoForward());
  } catch {
    canBack = false;
    canForward = false;
  }
  if (back) back.disabled = !canBack;
  if (forward) forward.disabled = !canForward;
}

// Pin a dropdown directly beneath its trigger button. side="left" aligns the
// menu's left edge to the button (top-left app menu); side="right" aligns the
// right edges (avatar menu). Offsets are relative to .titlebar (offsetParent).
function positionMenu(menu, button, side) {
  const bar = button.offsetParent;
  if (!bar) return;
  if (side === "left") {
    menu.style.left = `${button.offsetLeft}px`;
    menu.style.right = "auto";
  } else {
    menu.style.right = `${bar.offsetWidth - (button.offsetLeft + button.offsetWidth)}px`;
    menu.style.left = "auto";
  }
}

function renderCustomTools() {
  customTools.replaceChildren();
  state.customTools.forEach((tool) => {
    const tab = document.createElement("button");
    tab.className = "mode-tab custom-tool";
    tab.dataset.tool = tool.id;
    // Static SVG only; the user-supplied title goes in via textContent below so
    // there's no injection surface.
    tab.innerHTML =
      '<svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>';
    const label = document.createElement("span");
    label.textContent = tool.title;
    tab.append(label);
    tab.addEventListener("click", () => selectTool(tool.id));
    customTools.append(tab);
  });
  setActiveButtons(state.currentTool);
  updateTabIndicator(false);
}

function persistCustomTools() {
  localStorage.setItem("customTools", JSON.stringify(state.customTools));
}

function activeWebview() {
  return toolWebviews.get(state.currentTool);
}

function setZoom(nextZoom) {
  state.zoom = Math.min(1.5, Math.max(0.7, nextZoom));
  localStorage.setItem("zoom", String(state.zoom));
  toolWebviews.forEach((webview) => {
    if (typeof webview.setZoomFactor === "function") {
      webview.setZoomFactor(state.zoom);
    }
  });
}

function isAllowedCustomUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" &&
      (parsed.hostname.endsWith(".google.com") ||
        parsed.hostname === "google.com" ||
        parsed.hostname.endsWith(".withgoogle.com") ||
        parsed.hostname === "withgoogle.com");
  } catch {
    return false;
  }
}

function setMenuOpen(menu, button, open) {
  menu.classList.toggle("open", open);
  button.setAttribute("aria-expanded", String(open));
}

function closeMenus() {
  setMenuOpen(appMenu, appMenuButton, false);
  setMenuOpen(userMenu, userMenuButton, false);
}

function openCurrentUrlExternal() {
  window.geminiDesktop.openAppWindow(currentFrameUrl || allTools()[state.currentTool].url);
}

document.querySelectorAll("[data-tool]").forEach((button) => {
  button.addEventListener("click", () => selectTool(button.dataset.tool));
});

appMenuButton.addEventListener("click", (event) => {
  event.stopPropagation();
  const willOpen = !appMenu.classList.contains("open");
  if (willOpen) positionMenu(appMenu, appMenuButton, "left");
  setMenuOpen(appMenu, appMenuButton, willOpen);
  setMenuOpen(userMenu, userMenuButton, false);
});

userMenuButton.addEventListener("click", (event) => {
  event.stopPropagation();
  const willOpen = !userMenu.classList.contains("open");
  if (willOpen) positionMenu(userMenu, userMenuButton, "right");
  setMenuOpen(userMenu, userMenuButton, willOpen);
  setMenuOpen(appMenu, appMenuButton, false);
});

document.addEventListener("click", (event) => {
  if (!appMenu.contains(event.target) &&
      !userMenu.contains(event.target) &&
      event.target !== appMenuButton &&
      event.target !== userMenuButton) {
    closeMenus();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeMenus();
    if (addToolDialog.open) addToolDialog.close();
  }
});

document.getElementById("backButton").addEventListener("click", () => {
  const webview = activeWebview();
  if (webview?.canGoBack()) webview.goBack();
});

document.getElementById("forwardButton").addEventListener("click", () => {
  const webview = activeWebview();
  if (webview?.canGoForward()) webview.goForward();
});

document.getElementById("menuReload").addEventListener("click", () => {
  activeWebview()?.reload();
  closeMenus();
});

document.getElementById("menuOpenExternal").addEventListener("click", () => {
  openCurrentUrlExternal();
  closeMenus();
});

document.getElementById("menuActualSize").addEventListener("click", () => {
  setZoom(1);
  closeMenus();
});

document.getElementById("menuZoomIn").addEventListener("click", () => {
  setZoom(state.zoom + 0.1);
  closeMenus();
});

document.getElementById("menuZoomOut").addEventListener("click", () => {
  setZoom(state.zoom - 0.1);
  closeMenus();
});

document.getElementById("menuDevTools").addEventListener("click", () => {
  const webview = activeWebview();
  if (webview?.openDevTools) {
    webview.openDevTools();
  } else {
    window.geminiDesktop.openDevTools();
  }
  closeMenus();
});

document.getElementById("addToolButton").addEventListener("click", () => {
  addToolDialog.showModal();
  document.getElementById("customToolName").focus();
});

document.getElementById("cancelAddTool").addEventListener("click", () => {
  addToolDialog.close();
});

document.getElementById("customToolForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const nameInput = document.getElementById("customToolName");
  const urlInput = document.getElementById("customToolUrl");
  const title = nameInput.value.trim();
  const url = urlInput.value.trim();

  if (!title || !isAllowedCustomUrl(url)) {
    urlInput.setCustomValidity("Use a valid https Google or withgoogle.com URL.");
    urlInput.reportValidity();
    return;
  }

  urlInput.setCustomValidity("");
  const id = `custom-${Date.now()}`;
  state.customTools.push({ id, title, url });
  persistCustomTools();
  renderCustomTools();
  nameInput.value = "";
  urlInput.value = "";
  addToolDialog.close();
  selectTool(id);
});

document.getElementById("minimizeWindow").addEventListener("click", () => window.geminiDesktop.minimize());
document.getElementById("maximizeWindow").addEventListener("click", () => window.geminiDesktop.maximize());
document.getElementById("closeWindow").addEventListener("click", () => window.geminiDesktop.close());

window.geminiDesktop.onInternalNavigate((url) => {
  const webview = activeWebview();
  if (webview && isAllowedCustomUrl(url)) {
    webview.loadURL(url);
  }
});

async function initialize() {
  browserUserAgent = await window.geminiDesktop.browserUserAgent();
  renderCustomTools();
  await refreshAuthStatus();
  await selectTool(state.currentTool);
  setZoom(state.zoom);

  // Snap the selector into place without an opening slide, and keep it aligned
  // (plus any open dropdown) whenever the window resizes.
  updateTabIndicator(false);
  let resizeRaf;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      updateTabIndicator(false);
      if (appMenu.classList.contains("open")) positionMenu(appMenu, appMenuButton, "left");
      if (userMenu.classList.contains("open")) positionMenu(userMenu, userMenuButton, "right");
    });
  });

  // Re-render account UI whenever sign-in / sign-out happens inside a webview.
  window.geminiDesktop.onAuthChanged(() => {
    refreshAuthStatus();
  });

  // If we start up without an authenticated Google session, send the user
  // straight to the account chooser. We only do this once per session so a
  // deliberate Sign Out doesn't trap the user on the login page.
  if (!state.signedIn && !didInitialSignInRedirect) {
    didInitialSignInRedirect = true;
    navigateToSignIn();
  }
}

initialize();
