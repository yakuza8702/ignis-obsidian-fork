// Server-backed mirror for the small set of localStorage keys whose loss is
// painful when the browser's site data is cleared: the community-plugin trust
// decision (`enable-plugin-<vaultId>`), the last active vault, and the
// insecure-context acknowledgement. The server persists them in
// <DATA_ROOT>/client-state.json; on boot this module rehydrates the keys into
// localStorage before Obsidian's scripts run, and mirrors qualifying writes
// back to the server so the next browser clear doesn't lose them.
//
// Design notes:
// - Hydration is a synchronous XHR, matching the shim's existing blocking
//   bootstrap pattern, so resolveVaultId() and Obsidian's trust check see the
//   restored values on the very first boot after a browser-data clear.
// - Mirroring wraps localStorage.setItem/removeItem/clear globally and early,
//   so both Ignis code and Obsidian's own code are covered.
// - The server enforces an allowlist; this client also filters to the same
//   list so we don't spam the endpoint with unrelated keys.

export const API_ENDPOINT = "/api/client-state";

export const MIRRORED_KEYS = ["last-vault", "ignis-insecure-ack"];
export const MIRRORED_PREFIXES = ["enable-plugin-"];

const MAX_KEY_LENGTH = 128;

export function isMirroredKey(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) {
    return false;
  }

  return (
    MIRRORED_KEYS.includes(key) ||
    MIRRORED_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

// Debounced writer: buffers mirrored mutations and POSTs them as one batch.
export function createWriteMirror({
  storage = window.localStorage,
  endpoint = API_ENDPOINT,
  flushDelayMs = 500,
  post = (url, body) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {}),
} = {}) {
  const pending = new Map();
  let flushTimer = null;

  function flush() {
    flushTimer = null;

    if (pending.size === 0) {
      return;
    }

    const batch = Object.fromEntries(pending);
    pending.clear();
    post(endpoint, JSON.stringify({ entries: batch }));
  }

  function scheduleFlush() {
    if (flushTimer) {
      return;
    }

    flushTimer = setTimeout(flush, flushDelayMs);
  }

  function setItem(key, value) {
    if (isMirroredKey(key)) {
      pending.set(key, String(value));
      scheduleFlush();
    }
  }

  function removeItem(key) {
    if (isMirroredKey(key)) {
      pending.set(key, null);
      scheduleFlush();
    }
  }

  function clear() {
    // Collect every mirrored key currently present before wiping, so we can
    // delete them server-side too (a clear() is a deliberate reset).
    const deletions = {};
    let hasMirrored = false;

    try {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);

        if (isMirroredKey(key)) {
          deletions[key] = null;
          hasMirrored = true;
        }
      }
    } catch {}

    if (hasMirrored) {
      pending.clear();
      post(endpoint, JSON.stringify({ entries: deletions }));
    }
  }

  return { flush, setItem, removeItem, clear };
}

// Wrap the native Storage methods on the real localStorage so both Ignis code
// and Obsidian's own code are mirrored without either having to know about it.
export function installWriteMirror(storage = window.localStorage) {
  const mirror = createWriteMirror({ storage });

  const nativeSetItem = storage.setItem.bind(storage);
  const nativeRemoveItem = storage.removeItem.bind(storage);
  const nativeClear = storage.clear.bind(storage);

  storage.setItem = function (key, value) {
    nativeSetItem(key, value);
    mirror.setItem(key, value);
  };

  storage.removeItem = function (key) {
    nativeRemoveItem(key);
    mirror.removeItem(key);
  };

  storage.clear = function () {
    mirror.clear();
    nativeClear();
  };

  return mirror;
}

// Pull the persisted state and seed localStorage before Obsidian boots.
// Synchronous (XHR) so boot order is preserved: initialize() reads the keys
// immediately after this returns. Native refs are passed in so hydration
// doesn't go through the write-mirror and echo values back to the server.
export function hydrateFromServer(
  storage = window.localStorage,
  nativeSetItem = storage.setItem.bind(storage),
  nativeGetItem = storage.getItem.bind(storage),
) {
  let state;

  try {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", API_ENDPOINT, false); // synchronous
    xhr.send();

    if (xhr.status === 200) {
      state = JSON.parse(xhr.responseText);
    } else {
      return;
    }
  } catch {
    return;
  }

  if (!state || typeof state !== "object") {
    return;
  }

  for (const [key, value] of Object.entries(state)) {
    if (!isMirroredKey(key) || typeof value !== "string") {
      continue;
    }

    try {
      if (nativeGetItem(key) !== value) {
        nativeSetItem(key, value);
      }
    } catch {
      // Storage may be unavailable (private mode, quota); Obsidian still boots.
    }
  }
}

export function installClientStateMirror() {
  const storage = window.localStorage;

  try {
    storage.setItem("__ignis_probe__", "1");
    storage.removeItem("__ignis_probe__");
  } catch {
    // No localStorage (private mode, blocked); skip the mirror entirely.
    return;
  }

  // In demo mode vaults are ephemeral per-session and pre-trusted by
  // autoTrustDemoVaults; mirroring is unnecessary.
  if (typeof document !== "undefined" && document.body?.dataset?.demoMode === "true") {
    return;
  }

  // Capture the natives before wrapping so hydration below stays native.
  const nativeSetItem = storage.setItem.bind(storage);
  const nativeGetItem = storage.getItem.bind(storage);

  installWriteMirror(storage);
  hydrateFromServer(storage, nativeSetItem, nativeGetItem);
}
