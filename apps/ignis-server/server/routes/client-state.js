const express = require("express");
const fs = require("fs");
const path = require("path");
const config = require("../config");

// Server-backed mirror of the small set of browser localStorage keys that
// Obsidian/Ignis rely on for cross-session behavior. Clearing browser data
// wipes localStorage; this mirror lets the client rehydrate those keys on the
// next boot so plugin trust and the last active vault survive.
//
// Only a fixed set of keys is accepted (blocklist of prefixes avoids storing
// large or fast-changing state). Values are strings, as localStorage stores.

const router = express.Router();

const STATE_FILE = () => path.join(config.dataRoot, "client-state.json");

// Keys mirrored server-side. Keep this list tight: it is security-relevant
// surface (a hostile request could otherwise write arbitrary origin state).
const ALLOWED_KEYS = [
  "last-vault", // last active vault id (shim init.js, vault-service.js)
  "ignis-insecure-ack", // insecure-context modal acknowledged (ui/bootstrap.js)
];

// Anything matching these prefixes is accepted on top of ALLOWED_KEYS.
// Obsidian writes the community-plugin trust decision per vault.
const ALLOWED_PREFIXES = ["enable-plugin-"];

const MAX_KEY_LENGTH = 128;
const MAX_VALUE_LENGTH = 4096;
const MAX_ENTRIES = 256;

function isAllowedKey(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) {
    return false;
  }

  return (
    ALLOWED_KEYS.includes(key) ||
    ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE(), "utf-8"));

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    // Re-validate on read so a hand-edited file can't inject junk.
    const clean = {};
    let count = 0;

    for (const [key, value] of Object.entries(parsed)) {
      if (!isAllowedKey(key) || typeof value !== "string") {
        continue;
      }

      if (value.length > MAX_VALUE_LENGTH || count >= MAX_ENTRIES) {
        continue;
      }

      clean[key] = value;
      count += 1;
    }

    return clean;
  } catch {
    return {};
  }
}

function saveState(state) {
  // Atomic write: temp file + rename so a crash can't leave truncated JSON.
  const file = STATE_FILE();
  const tmp = file + ".tmp";

  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

router.get("/", (req, res) => {
  // In demo mode, shared client-state would leak one visitor's trust/vault
  // selection to another. Demo pre-trusts vaults client-side instead.
  if (config.demoMode) {
    return res.status(403).json({ error: "Disabled in demo mode" });
  }

  res.json(loadState());
});

router.post("/", (req, res) => {
  if (config.demoMode) {
    return res.status(403).json({ error: "Disabled in demo mode" });
  }

  const body = req.body || {};

  if (!body.entries || typeof body.entries !== "object" || Array.isArray(body.entries)) {
    return res.status(400).json({ error: "entries must be an object" });
  }

  const state = loadState();
  let applied = 0;

  for (const [key, value] of Object.entries(body.entries)) {
    if (!isAllowedKey(key)) {
      continue;
    }

    if (value === null) {
      // null deletes the key.
      delete state[key];
      applied += 1;
      continue;
    }

    if (typeof value !== "string" || value.length > MAX_VALUE_LENGTH) {
      continue;
    }

    if (!(key in state) && Object.keys(state).length >= MAX_ENTRIES) {
      continue;
    }

    state[key] = value;
    applied += 1;
  }

  try {
    saveState(state);
  } catch {
    return res.status(500).json({ error: "Failed to persist client state" });
  }

  res.json({ ok: true, applied });
});

// Delete the whole mirror (e.g. a user deliberately resetting trust).
router.delete("/", (req, res) => {
  if (config.demoMode) {
    return res.status(403).json({ error: "Disabled in demo mode" });
  }

  try {
    fs.rmSync(STATE_FILE(), { force: true });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to clear client state" });
  }
});

module.exports = router;
module.exports.isAllowedKey = isAllowedKey;
module.exports.loadState = loadState;
