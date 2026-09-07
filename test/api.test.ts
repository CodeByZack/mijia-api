import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { MijiaApiClient } from "../src/api.js";
import { AuthStore } from "../src/login.js";
import { APIError, LoginError } from "../src/errors.js";
import { decryptRC4, encryptRC4, genEncSignature, getSignedNonce } from "../src/crypto.js";
import { parseQueryString } from "../src/util.js";

const SSECURITY = "TEST-SSECURITY";

function makeStore(dir: string): AuthStore {
  const store = new AuthStore({ authDataPath: join(dir, "auth.json"), locale: "zh_CN" });
  store.authData.ssecurity = SSECURITY;
  store.authData.userId = "111";
  store.authData.cUserId = "222";
  store.authData.serviceToken = "token-abc";
  return store;
}

function encryptedBody(nonce: string, obj: unknown): string {
  return encryptRC4(getSignedNonce(SSECURITY, nonce), gzipSync(JSON.stringify(obj)));
}

function mockFetch(fn: (url: string, init: RequestInit | undefined, body: string) => Response): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => fn(String(url), init, String(init?.body ?? ""))) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function tempDir(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mijia-api-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("callApi 发送正确结构的加密请求并解析明文响应", async () => {
  const t = tempDir();
  try {
    const client = new MijiaApiClient(makeStore(t.dir), { autoRefreshToken: false });
    const uri = "/miotspec/prop/get";
    const data = { params: [{ did: "1234567890", siid: 2, piid: 1 }], datasource: 1 };
    const seen: Array<{ url: string; init: RequestInit | undefined; body: string }> = [];
    const restore = mockFetch((url, init, body) => {
      seen.push({ url, init, body });
      return new Response(JSON.stringify({ code: 0, result: { ok: true } }), { status: 200 });
    });
    try {
      const result = await client.callApi(uri, data);
      assert.deepEqual(result, { ok: true });
      assert.equal(seen.length, 1);
      const req = seen[0];
      assert.equal(req.url, "https://api.mijia.tech/app" + uri);
      assert.equal(req.init?.method, "POST");

      const headers = new Headers(req.init?.headers);
      assert.equal(headers.get("miot-encrypt-algorithm"), "ENCRYPT-RC4");
      assert.equal(headers.get("miot-accept-encoding"), "GZIP");
      assert.equal(headers.get("x-xiaomi-protocal-flag-cli"), "PROTOCAL-HTTP2");
      assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
      assert.match(headers.get("cookie") as string, /serviceToken=token-abc/);
      assert.match(headers.get("cookie") as string, /cUserId=222/);

      const form = parseQueryString(req.body);
      assert.deepEqual(Object.keys(form), ["data", "rc4_hash__", "signature", "ssecurity", "_nonce"]);
      assert.equal(form.ssecurity, SSECURITY);
      assert.ok(form._nonce);

      const signedNonce = getSignedNonce(SSECURITY, form._nonce);
      assert.equal(decryptRC4(signedNonce, form.data).toString("utf8"), JSON.stringify(data));
      assert.equal(decryptRC4(signedNonce, form.rc4_hash__).toString("utf8"), genEncSignature(uri, "POST", signedNonce, { data: JSON.stringify(data) }));
      assert.equal(form.signature, genEncSignature(uri, "POST", signedNonce, { data: form.data, rc4_hash__: form.rc4_hash__ }));
    } finally {
      restore();
    }
  } finally {
    t.done();
  }
});

test("callApi 解密 RC4+gzip 响应", async () => {
  const t = tempDir();
  try {
    const client = new MijiaApiClient(makeStore(t.dir), { autoRefreshToken: false });
    const restore = mockFetch((_url, init) => {
      const nonce = parseQueryString(String(init?.body ?? ""))._nonce;
      return new Response(encryptedBody(nonce, { code: 0, result: { decrypted: true, n: 42 } }), { status: 200 });
    });
    try {
      const result = await client.callApi<{ decrypted: boolean; n: number }>("/x", {});
      assert.deepEqual(result, { decrypted: true, n: 42 });
    } finally {
      restore();
    }
  } finally {
    t.done();
  }
});

test("callApi 在 code 非 0 时抛 APIError", async () => {
  const t = tempDir();
  try {
    const client = new MijiaApiClient(makeStore(t.dir), { autoRefreshToken: false });
    const restore = mockFetch(() => new Response(JSON.stringify({ code: -704030013, desc: "Property不可读" }), { status: 200 }));
    try {
      await assert.rejects(() => client.callApi("/x", {}), (err: unknown) => {
        assert.ok(err instanceof APIError);
        assert.equal(err.code, -704030013);
        assert.match(err.message, /Property不可读/);
        return true;
      });
    } finally {
      restore();
    }
  } finally {
    t.done();
  }
});

test("callApi 在非 200 HTTP 状态抛 APIError", async () => {
  const t = tempDir();
  try {
    const client = new MijiaApiClient(makeStore(t.dir), { autoRefreshToken: false });
    const restore = mockFetch(() => new Response("gateway timeout", { status: 504 }));
    try {
      await assert.rejects(() => client.callApi("/x", {}), (err: unknown) => {
        return err instanceof APIError && err.code === 504;
      });
    } finally {
      restore();
    }
  } finally {
    t.done();
  }
});

test("属性与动作端点使用正确的 URI 和载荷", async () => {
  const t = tempDir();
  try {
    const client = new MijiaApiClient(makeStore(t.dir), { autoRefreshToken: false });
    const calls: Array<{ uri: string; body: string }> = [];
    const restore = mockFetch((url, init, body) => {
      calls.push({ uri: url.slice("https://api.mijia.tech/app".length), body });
      return new Response(JSON.stringify({ code: 0, result: [{ code: 0, value: true }] }), { status: 200 });
    });
    try {
      await client.getDevicesProp({ did: "d1", siid: 2, piid: 1 });
      await client.setDevicesProp({ did: "d1", siid: 2, piid: 1, value: true });
      await client.runAction({ did: "d1", siid: 2, aiid: 1, value: [3] });
      assert.deepEqual(calls.map((c) => c.uri), ["/miotspec/prop/get", "/miotspec/prop/set", "/miotspec/action"]);
      const decoded = calls.map((c) => decryptRC4(getSignedNonce(SSECURITY, parseQueryString(c.body)._nonce), parseQueryString(c.body).data).toString("utf8"));
      assert.deepEqual(JSON.parse(decoded[0]), { params: [{ did: "d1", siid: 2, piid: 1 }], datasource: 1 });
      assert.deepEqual(JSON.parse(decoded[1]), { params: [{ did: "d1", siid: 2, piid: 1, value: true }] });
      assert.deepEqual(JSON.parse(decoded[2]), { params: { did: "d1", siid: 2, aiid: 1, value: [3] } });
    } finally {
      restore();
    }
  } finally {
    t.done();
  }
});

test("缺少凭据时 isAvailable 为 false，ensureToken 抛 LoginError", async () => {
  const t = tempDir();
  try {
    const store = new AuthStore({ authDataPath: join(t.dir, "auth.json"), locale: "zh_CN" });
    assert.equal(store.hasCredentials, false);
    const client = new MijiaApiClient(store);
    assert.equal(await client.isAvailable(), false);
    await assert.rejects(() => client.ensureToken(), (err: unknown) => err instanceof LoginError);
  } finally {
    t.done();
  }
});

test("isAvailable 通过 check_new_msg 判断并缓存结果", async () => {
  const t = tempDir();
  try {
    const client = new MijiaApiClient(makeStore(t.dir), { autoRefreshToken: false });
    let calls = 0;
    const restore = mockFetch((url) => {
      calls++;
      assert.ok(url.endsWith("/v2/message/v2/check_new_msg"));
      return new Response(JSON.stringify({ code: 0, result: {} }), { status: 200 });
    });
    try {
      assert.equal(await client.isAvailable(), true);
      assert.equal(await client.isAvailable(), true);
      assert.equal(calls, 1);
    } finally {
      restore();
    }
  } finally {
    t.done();
  }
});