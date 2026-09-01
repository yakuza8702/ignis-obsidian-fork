import { describe, it, expect } from "vitest";
import { isMirroredKey, createWriteMirror } from "./client-state.js";

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));

  return {
    get length() {
      return map.size;
    },
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    key: (i) => [...map.keys()][i] ?? null,
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    _map: map,
  };
}

describe("isMirroredKey", () => {
  it("accepts fixed keys and the trust prefix", () => {
    expect(isMirroredKey("last-vault")).toBe(true);
    expect(isMirroredKey("ignis-insecure-ack")).toBe(true);
    expect(isMirroredKey("enable-plugin-My Vault")).toBe(true);
    expect(isMirroredKey("enable-plugin-demo-abc__notes")).toBe(true);
  });

  it("rejects unrelated or malformed keys", () => {
    expect(isMirroredKey("theme")).toBe(false);
    expect(isMirroredKey("enable-pluginx-vault")).toBe(false);
    expect(isMirroredKey("")).toBe(false);
    expect(isMirroredKey(null)).toBe(false);
    expect(isMirroredKey("a".repeat(129))).toBe(false);
  });
});

describe("createWriteMirror", () => {
  it("mirrors setItem of a trust key to the server as one batched POST", async () => {
    const posts = [];
    const mirror = createWriteMirror({
      storage: makeStorage(),
      flushDelayMs: 50,
      post: (url, body) => {
        posts.push({ url, body });
        return Promise.resolve();
      },
    });

    mirror.setItem("enable-plugin-My Vault", "true");

    await new Promise((r) => setTimeout(r, 80));

    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("/api/client-state");
    expect(JSON.parse(posts[0].body)).toEqual({
      entries: { "enable-plugin-My Vault": "true" },
    });
  });

  it("mirrors removals as null values", async () => {
    const posts = [];
    const mirror = createWriteMirror({
      storage: makeStorage(),
      flushDelayMs: 50,
      post: (url, body) => {
        posts.push(JSON.parse(body));
        return Promise.resolve();
      },
    });

    mirror.setItem("last-vault", "notes");
    await new Promise((r) => setTimeout(r, 80));
    posts.length = 0;

    mirror.removeItem("last-vault");
    await new Promise((r) => setTimeout(r, 80));

    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({ entries: { "last-vault": null } });
  });

  it("does not mirror unrelated keys", async () => {
    const posts = [];
    const mirror = createWriteMirror({
      storage: makeStorage(),
      flushDelayMs: 50,
      post: (url, body) => {
        posts.push(body);
        return Promise.resolve();
      },
    });

    mirror.setItem("some-random-key", "x");
    await new Promise((r) => setTimeout(r, 100));

    expect(posts).toHaveLength(0);
  });

  it("bubbles the whole pre-clear scope of trust keys as deletions on clear", async () => {
    const storage = makeStorage({ "enable-plugin-A": "true", "last-vault": "A" });
    const posts = [];
    const mirror = createWriteMirror({
      storage,
      flushDelayMs: 50,
      post: (url, body) => {
        posts.push(JSON.parse(body).entries);
        return Promise.resolve();
      },
    });

    mirror.clear();
    await new Promise((r) => setTimeout(r, 80));

    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({ "enable-plugin-A": null, "last-vault": null });
  });
});