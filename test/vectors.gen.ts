/**
 * 一次性校验脚本（不属于正式测试套件）：
 * 把 src/crypto.ts 的输出与 /tmp/vectors.json（Python 参考实现 mijiaAPI/miutils.py 生成）逐字节比对。
 */
import { readFileSync } from "node:fs";
import { createCipheriv, randomBytes } from "node:crypto";
import {
  decrypt,
  decryptJSON,
  decryptRC4,
  encryptRC4,
  genEncSignature,
  genNonce,
  generateEncParams,
  getSignedNonce,
  toMinimalBigEndian,
} from "../src/crypto.js";

const vectors = JSON.parse(readFileSync(process.argv[2], "utf8")) as Record<string, unknown>;
const check: string[] = [];
let failures = 0;

function eq(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    check.push("PASS " + label);
  } else {
    failures++;
    check.push("FAIL " + label + "\n  actual  " + a + "\n  expect  " + e);
  }
}

const ssecurity = "aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3Qgc2VjcmV0IHN0cmluZw==";
const nonce = "MEowMEowMEAwMEAwMEAwMEAwMEAwMEAwMEAwMEAwMEAw";
const uri = "/miotspec/prop/get";

eq("getSignedNonce", getSignedNonce(ssecurity, nonce), vectors.signed_nonce);

const signedNonce = vectors.signed_nonce as string;

eq(
  "generateEncParams",
  generateEncParams(uri, "POST", signedNonce, nonce, {
    data: '{"params":[{"did":"1234567890","siid":2,"piid":1}],"datasource":1}',
    extra: "hello world",
  }, ssecurity),
  vectors.enc_params,
);

eq(
  "generateEncParams key order",
  Object.keys(
    generateEncParams(uri, "POST", signedNonce, nonce, {
      data: "x",
      extra: "y",
    }, ssecurity),
  ),
  vectors.enc_params_key_order,
);

eq("encryptRC4", encryptRC4(signedNonce, vectors.rc4_dec as string), vectors.rc4_enc);
eq("decryptRC4", decryptRC4(signedNonce, vectors.rc4_enc as string).toString("utf8"), vectors.rc4_dec);
eq("decrypt plain", decrypt(ssecurity, nonce, vectors.rc4_enc as string), vectors.decrypt_plain);
eq("decrypt gzip", decrypt(ssecurity, nonce, vectors.rc4_enc_gzip as string), vectors.decrypt_gzip);
eq(
  "decryptJSON (ciphertext)",
  decryptJSON(ssecurity, nonce, vectors.rc4_enc as string),
  JSON.parse(vectors.rc4_dec as string),
);
eq("encryptRC4 cjk", encryptRC4(signedNonce, vectors.cjk as string), vectors.rc4_enc_cjk);
eq("genEncSignature plain", genEncSignature(uri, "POST", signedNonce, { a: "1", b: "two" }), vectors.sig_plain);
eq(
  "genEncSignature encrypted subset",
  genEncSignature(uri, "POST", signedNonce, {
    data: (vectors.enc_params as Record<string, string>).data,
    rc4_hash__: (vectors.enc_params as Record<string, string>).rc4_hash__,
  }),
  vectors.sig_encrypted,
);

// genNonce 结构：确定性验证尾部，随机头部长度
const n = Buffer.from(genNonce(1700000000123), "base64");
eq("genNonce total length", n.length, vectors.nonce_len);
eq("genNonce tail", [...n.subarray(8)], vectors.nonce_tail);

const n0 = Buffer.from(genNonce(0), "base64");
eq("genNonce zero-clock total length", n0.length, vectors.nonce_zero_len);
eq("genNonce zero-clock tail", [...n0.subarray(8)], vectors.nonce_zero_tail);

// 头部必须是 8 字节且非全零（随机）
let allZeroHead = 0;
for (let i = 0; i < 200; i++) {
  const b = Buffer.from(genNonce(1700000000000 + i), "base64");
  if (b.length !== 12) throw new Error("unexpected nonce length " + b.length);
  if (Buffer.compare(b.subarray(0, 8), Buffer.alloc(8)) === 0) allZeroHead++;
}
check.push(allZeroHead === 0 ? "PASS genNonce random head (200 samples)" : "FAIL genNonce random head: " + allZeroHead);
if (allZeroHead !== 0) failures++;

// toMinimalBigEndian
eq(
  "toMinimalBigEndian",
  Object.fromEntries(
    (["0", "1", "127", "128", "255", "256", "65535", "16777216", "28333333"] as string[]).map((k) => [
      k,
      [...toMinimalBigEndian(Number(k))],
    ]),
  ),
  vectors.be,
);

console.log(check.join("\n"));
console.log(failures === 0 ? "\nALL " + check.length + " CHECKS PASSED" : "\n" + failures + " FAILURES");
process.exit(failures === 0 ? 0 : 1);
