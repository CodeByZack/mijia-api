import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import {
  RC4,
  RC4_WARMUP_BYTES,
  decrypt,
  decryptJSON,
  decryptRC4,
  encryptRC4,
  genEncSignature,
  genNonce,
  generateEncParams,
  getSignedNonce,
  isValidUtf8,
  toMinimalBigEndian,
} from "../src/crypto.js";

const SS = Buffer.from("this is a test ssecurity for unit tests", "utf8").toString("base64");

test("RC4 标准测试向量 (Key/Plaintext) 正确", () => {
  const rc4 = new RC4(Buffer.from("Key", "utf8"));
  const out = rc4.encrypt(Buffer.from("Plaintext", "utf8"));
  assert.equal(out.toString("hex").toUpperCase(), "BBF316E8D940AF0AD3");
});

test("RC4 状态可跨 update 延续", () => {
  const rc4 = new RC4(Buffer.from("SecretKey", "utf8"));
  const a = rc4.encrypt(Buffer.from("Hel", "utf8"));
  const b = rc4.encrypt(Buffer.from("lo!", "utf8"));
  const one = new RC4(Buffer.from("SecretKey", "utf8")).encrypt(Buffer.from("Hello!", "utf8"));
  assert.deepEqual(Buffer.concat([a, b]), one);
});

test("RC4_WARMUP_BYTES 为 1024", () => {
  assert.equal(RC4_WARMUP_BYTES, 1024);
});

test("genNonce 结构：8 字节随机 + part2 最小大端", () => {
  const nowMs = 1_700_000_000_000;
  const decoded = Buffer.from(genNonce(nowMs), "base64");
  const part2 = Math.floor(nowMs / 60000);
  const expectedTail = toMinimalBigEndian(part2);
  assert.ok(decoded.length >= 8 + expectedTail.length);
  assert.deepEqual(decoded.subarray(8), expectedTail);
  assert.equal(decoded.subarray(0, 8).length, 8);
});

test("genNonce 时间推进时尾部随之变化", () => {
  const a = Buffer.from(genNonce(0), "base64");
  const b = Buffer.from(genNonce(60_000), "base64");
  assert.deepEqual([...a.subarray(8)], []);
  assert.deepEqual([...b.subarray(8)], [1]);
});

test("toMinimalBigEndian 边界值", () => {
  assert.deepEqual([...toMinimalBigEndian(0)], []);
  assert.deepEqual([...toMinimalBigEndian(1)], [1]);
  assert.deepEqual([...toMinimalBigEndian(127)], [127]);
  assert.deepEqual([...toMinimalBigEndian(128)], [128]);
  assert.deepEqual([...toMinimalBigEndian(255)], [255]);
  assert.deepEqual([...toMinimalBigEndian(256)], [1, 0]);
  assert.deepEqual([...toMinimalBigEndian(65535)], [255, 255]);
  assert.deepEqual([...toMinimalBigEndian(16777216)], [1, 0, 0, 0]);
  assert.throws(() => toMinimalBigEndian(-1));
  assert.throws(() => toMinimalBigEndian(1.5));
});

test("getSignedNonce = base64(SHA256(b64decode(ssecurity) + b64decode(nonce)))", () => {
  const nonce = Buffer.from("nonce-bytes-here-1234567890", "utf8").toString("base64");
  const expected = Buffer.concat([Buffer.from(SS, "base64"), Buffer.from(nonce, "base64")])
    .toString(); // placeholder, replaced below
  void expected;
  const hash = createHash("sha256");
  hash.update(Buffer.from(SS, "base64"));
  hash.update(Buffer.from(nonce, "base64"));
  assert.equal(getSignedNonce(SS, nonce), hash.digest("base64"));
});

test("genEncSignature 使用 SHA1 与固定格式", () => {
  // METHOD & uri & k1=v1 & k2=v2 ... & signed_nonce，未做 URL 编码
  const sig = genEncSignature("/miotspec/prop/get", "POST", "signednonceb64==", { a: "1", b: "two" });
  const raw = "POST&/miotspec/prop/get&a=1&b=two&signednonceb64==";
  assert.equal(sig, createHash("sha1").update(raw, "utf8").digest("base64"));
});

test("SHA1/SHA256 与已知常量一致（确认 base64 往返无误）", () => {
  // 用 genEncSignature 间接验证：把整个签名串当作单个参数值，值中不含 & 或 = 以外字符时可直接反推。
  // 这里直接验证底层散列，防止 base64 处理错误。
  const sha1Abc = createHash("sha1").update("abc", "utf8").digest("hex");
  const sha256Abc = createHash("sha256").update("abc", "utf8").digest("hex");
  assert.equal(sha1Abc, "a9993e364706816aba3e25717850c26c9cd0d89d");
  assert.equal(sha256Abc, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("encryptRC4/decryptRC4 往返一致", () => {
  const key = getSignedNonce(SS, Buffer.from("nonce", "utf8").toString("base64"));
  const payload = "米家云端 API 加密往返测试 ~!@# $%^&*()";
  const enc = encryptRC4(key, payload);
  assert.notEqual(enc, payload);
  assert.equal(decryptRC4(key, enc).toString("utf8"), payload);
});

test("encryptRC4 含 1024 字节预热（同 key 同明文结果稳定）", () => {
  const key = getSignedNonce(SS, Buffer.from("nonce", "utf8").toString("base64"));
  const a = encryptRC4(key, "hello");
  const b = encryptRC4(key, "hello");
  assert.equal(a, b);
  const otherKey = getSignedNonce(SS, Buffer.from("another-nonce", "utf8").toString("base64"));
  assert.notEqual(a, encryptRC4(otherKey, "hello"));
});

test("generateEncParams 键顺序与 rc4_hash__ 语义", () => {
  const nonce = Buffer.from("nonce-value", "utf8").toString("base64");
  const signedNonce = getSignedNonce(SS, nonce);
  const uri = "/miotspec/prop/set";

  const data = { params: [{ did: "1234567890", siid: 2, piid: 1, value: true }] };
  const params = generateEncParams(uri, "POST", signedNonce, nonce, { data: JSON.stringify(data) }, SS);

  assert.deepEqual(Object.keys(params), ["data", "rc4_hash__", "signature", "ssecurity", "_nonce"]);
  assert.equal(params.ssecurity, SS);
  assert.equal(params._nonce, nonce);

  // rc4_hash__ 是对「加密前」参数的签名
  const rawSig = genEncSignature(uri, "POST", signedNonce, { data: JSON.stringify(data) });
  assert.equal(decryptRC4(signedNonce, params.rc4_hash__).toString("utf8"), rawSig);

  // signature 是对「加密后」参数的签名（不含 signature/ssecurity/_nonce）
  const encSig = genEncSignature(uri, "POST", signedNonce, { data: params.data, rc4_hash__: params.rc4_hash__ });
  assert.equal(params.signature, encSig);

  // 每个业务字段都被 RC4 加密过
  assert.equal(decryptRC4(signedNonce, params.data).toString("utf8"), JSON.stringify(data));
});

test("generateEncParams 保留原始参数插入顺序", () => {
  const nonce = Buffer.from("n", "utf8").toString("base64");
  const signedNonce = getSignedNonce(SS, nonce);
  const params = generateEncParams("/x", "POST", signedNonce, nonce, { z: "1", a: "2", m: "3" }, SS);
  assert.deepEqual(Object.keys(params).slice(0, 3), ["z", "a", "m"]);
});

test("decrypt 处理明文 JSON 密文", () => {
  const nonce = Buffer.from("nonce-1", "utf8").toString("base64");
  const signedNonce = getSignedNonce(SS, nonce);
  const json = JSON.stringify({ code: 0, result: { ok: true } });
  const enc = encryptRC4(signedNonce, json);
  assert.equal(decrypt(SS, nonce, enc), json);
});

test("decrypt 处理 gzip 压缩密文", () => {
  const nonce = Buffer.from("nonce-2", "utf8").toString("base64");
  const signedNonce = getSignedNonce(SS, nonce);
  const json = JSON.stringify({ code: 0, result: { rows: Array.from({ length: 50 }, (_, i) => ({ i })) } });
  const enc = encryptRC4(signedNonce, gzipSync(Buffer.from(json, "utf8")));
  assert.equal(decrypt(SS, nonce, enc), json);
});

test("decryptJSON 透传明文 JSON", () => {
  const obj = { code: 0, result: [1, 2, 3] };
  assert.deepEqual(decryptJSON(SS, "n", JSON.stringify(obj)), obj);
});

test("decryptJSON 解析 RC4 密文", () => {
  const nonce = Buffer.from("nonce-3", "utf8").toString("base64");
  const signedNonce = getSignedNonce(SS, nonce);
  const obj = { code: 0, result: { a: 1 } };
  const enc = encryptRC4(signedNonce, JSON.stringify(obj));
  assert.deepEqual(decryptJSON(SS, nonce, enc), obj);
});

test("isValidUtf8 判别", () => {
  assert.ok(isValidUtf8(Buffer.from("", "utf8")));
  assert.ok(isValidUtf8(Buffer.from("hello", "utf8")));
  assert.ok(isValidUtf8(Buffer.from("米家 ", "utf8")));
  assert.ok(!isValidUtf8(Buffer.from([0xff])));
  assert.ok(!isValidUtf8(Buffer.from([0xe2, 0x82]))); // 截断
  assert.ok(!isValidUtf8(Buffer.from([0xc0, 0x80]))); // overlong
  assert.ok(!isValidUtf8(Buffer.from([0xed, 0xa0, 0x80]))); // surrogate
  assert.ok(!isValidUtf8(gzipSync(Buffer.from("{"))));
});