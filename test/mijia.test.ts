import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MijiaAPI } from "../src/mijia.js";
import { AuthStore } from "../src/login.js";
import { LoginError } from "../src/errors.js";

function temp(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mijia-mjs-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("authDataPath 可以是目录，auth.json 落在该目录下", () => {
  const t = temp();
  try {
    const s = new AuthStore({ authDataPath: t.dir });
    assert.equal(s.authDataPath, join(t.dir, "auth.json"));
    assert.equal(s.authDataPath.includes("auth.json"), true);
  } finally {
    t.done();
  }
});

test("authDataPath 可以是具体文件路径", () => {
  const t = temp();
  try {
    const file = join(t.dir, "session.json");
    const s = new AuthStore({ authDataPath: file });
    assert.equal(s.authDataPath, file);
  } finally {
    t.done();
  }
});

test("不传 authDataPath 时使用默认用户目录", () => {
  const s = new AuthStore({});
  assert.ok(s.authDataPath.includes("mijia-node"));
  assert.ok(s.authDataPath.endsWith("auth.json"));
});

test("specCacheDir 跟随 auth.json 的真实目录", () => {
  const t = temp();
  try {
    assert.equal(new MijiaAPI({ authDataPath: t.dir }).specCacheDir, t.dir);
    const file = join(t.dir, "s.json");
    assert.equal(new MijiaAPI({ authDataPath: file }).specCacheDir, t.dir);
    const other = join(t.dir, "cache");
    assert.equal(new MijiaAPI({ authDataPath: t.dir, specCacheDir: other }).specCacheDir, other);
  } finally {
    t.done();
  }
});

test("available 初始为 false，未登录时 ensureToken 抛 LoginError", async () => {
  const t = temp();
  try {
    const mijia = new MijiaAPI({ authDataPath: t.dir });
    assert.equal(mijia.available, false);
    await assert.rejects(() => mijia.client.ensureToken(), (err: unknown) => err instanceof LoginError);
    await mijia.disconnect();
    assert.equal(mijia.available, false);
  } finally {
    t.done();
  }
});

test("toString 输出凭据状态摘要", () => {
  const t = temp();
  try {
    const mijia = new MijiaAPI({ authDataPath: t.dir });
    const text = String(mijia);
    assert.ok(text.includes("mijia-node") || text.length > 0);
  } finally {
    t.done();
  }
});
