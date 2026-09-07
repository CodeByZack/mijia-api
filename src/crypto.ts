/**
 * 米家云端的 RC4 加解密、nonce 生成与签名。
 *
 * 协议与 Python 参考实现 mijiaAPI/miutils.py 逐字节兼容（已用 PyCryptodome 生成的
 * 测试向量逐字节比对，见 test/vectors.gen.ts）。
 *
 * 实现说明：Node.js 24 + OpenSSL 3 把 RC4 移到了 legacy provider，需要
 * --openssl-legacy-provider 启动参数才能使用 crypto.createCipheriv(rc4, ...)。
 * 为了让库在任何环境下都能直接运行，这里用纯 TypeScript 实现标准 ARC4，
 * 零外部依赖、行为可移植。
 */
import { createHash, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";

/** ARC4 预热字节数（与 Python 参考实现一致）。 */
export const RC4_WARMUP_BYTES = 1024;

const WARMUP_BYTES = Buffer.alloc(RC4_WARMUP_BYTES);

/** 标准 ARC4 流密码（KSA + PRGA）。可跨多次 process 调用保持状态。 */
export class RC4 {
  private readonly s = new Uint8Array(256);
  private i = 0;
  private j = 0;

  constructor(key: Uint8Array) {
    if (key.length === 0) throw new Error("RC4: empty key");
    const s = this.s;
    for (let k = 0; k < 256; k++) s[k] = k;
    let jj = 0;
    const keyLen = key.length;
    for (let k = 0; k < 256; k++) {
      jj = (jj + s[k] + key[k % keyLen]) & 0xff;
      const t = s[k];
      s[k] = s[jj];
      s[jj] = t;
    }
  }

  /** 加密/解密：输出写入 output，output.length 必须 >= input.length。 */
  process(input: Uint8Array, output: Uint8Array): void {
    if (output.length < input.length) throw new Error("RC4: output too small");
    const s = this.s;
    let i = this.i;
    let j = this.j;
    for (let n = 0; n < input.length; n++) {
      i = (i + 1) & 0xff;
      j = (j + s[i]) & 0xff;
      const t = s[i];
      s[i] = s[j];
      s[j] = t;
      output[n] = input[n] ^ s[(s[i] + s[j]) & 0xff];
    }
    this.i = i;
    this.j = j;
  }

  /** 便捷封装：内部分配 output 并返回结果。 */
  encrypt(input: Uint8Array): Buffer {
    const output = Buffer.allocUnsafe(input.length);
    this.process(input, output);
    return output;
  }
}

/** 用密码（base64 字符串）初始化一个已预热的 RC4 流。 */
function createWarmRC4(password: string): RC4 {
  const stream = new RC4(Buffer.from(password, "base64"));
  stream.process(WARMUP_BYTES, WARMUP_BYTES); // 丢弃前 1024 字节密钥流
  return stream;
}

/**
 * 生成 nonce。
 *
 * 结构：8 字节随机（大端有符号 int64） ++ floor(millis/60000) 的最小大端字节，
 * 整体 base64 编码。
 *
 * @param nowMs 毫秒时间戳，默认 Date.now()。可注入以便测试。
 */
export function genNonce(nowMs: number = Date.now()): string {
  const millis = Math.floor(nowMs);
  const head = randomBytes(8);
  const part2 = Math.floor(millis / 60000);
  return Buffer.concat([head, toMinimalBigEndian(part2)]).toString("base64");
}

/**
 * 把非负整数编码为「最小字节数」的大端无符号字节序列。
 * 等价于 Python 的 n.to_bytes((n.bit_length() + 7) // 8, big)（n=0 时为空字节）。
 */
export function toMinimalBigEndian(n: number): Buffer {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("toMinimalBigEndian: expected non-negative integer, got " + n);
  }
  if (n === 0) return Buffer.alloc(0);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.from(bytes);
}

/** signed_nonce = base64( SHA256( base64_decode(ssecurity) ++ base64_decode(nonce) ) ) */
export function getSignedNonce(ssecurity: string, nonce: string): string {
  const hash = createHash("sha256")
    .update(Buffer.from(ssecurity, "base64"))
    .update(Buffer.from(nonce, "base64"))
    .digest();
  return hash.toString("base64");
}

/**
 * 签名 = base64( SHA1( METHOD & uri & k1=v1 & k2=v2 ... & signed_nonce ) )
 *
 * 注意：参数按对象插入顺序参与签名（对应 Python dict 顺序语义），
 * 且签名字符串不做 URL 编码。
 */
export function genEncSignature(
  uri: string,
  method: string,
  signedNonce: string,
  params: Record<string, string>,
): string {
  const parts = [method.toUpperCase(), uri];
  for (const [k, v] of Object.entries(params)) parts.push(k + "=" + v);
  parts.push(signedNonce);
  return createHash("sha1").update(parts.join("&"), "utf8").digest("base64");
}

/**
 * RC4 加密：base64( RC4( base64_decode(password), payload ) )，含 1024 字节预热。
 *
 * payload 传字符串时按 utf-8 编码后加密；传 Uint8Array 时按原始字节加密
 * （例如先 gzip 再加密的场景）。
 */
export function encryptRC4(password: string, payload: string | Uint8Array): string {
  const stream = createWarmRC4(password);
  const input = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
  const output = Buffer.alloc(input.length);
  stream.process(input, output);
  return output.toString("base64");
}

/** RC4 解密，返回原始字节（可能是 utf-8 文本，也可能是 gzip 压缩包）。 */
export function decryptRC4(password: string, payload: string): Buffer {
  const stream = createWarmRC4(password);
  const input = Buffer.from(payload, "base64");
  const output = Buffer.alloc(input.length);
  stream.process(input, output);
  return output;
}

/**
 * 解密云端响应：先 RC4 解密，再按 gzip / utf-8 二选一解包。
 *
 * 服务端返回体要么是明文 JSON，要么是 RC4 密文；密文解开后要么是 utf-8 文本，
 * 要么是 gzip 压缩包（以 0x1f 0x8b 魔数开头）。这里两种都覆盖。
 */
export function decrypt(ssecurity: string, nonce: string, payload: string): string {
  const decrypted = decryptRC4(getSignedNonce(ssecurity, nonce), payload);
  if (decrypted.length >= 2 && decrypted[0] === 0x1f && decrypted[1] === 0x8b) {
    return gunzipSync(decrypted).toString("utf8");
  }
  if (isValidUtf8(decrypted)) return decrypted.toString("utf8");
  return gunzipSync(decrypted).toString("utf8");
}

/**
 * 解密 + JSON 解析云端响应体。
 *
 * 服务端可能直接返回明文 JSON，也可能返回 RC4 密文，这里两种都覆盖。
 */
export function decryptJSON(ssecurity: string, nonce: string, payload: string): unknown {
  const trimmed = payload.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(payload);
    } catch {
      /* 明文解析失败则回退到解密路径 */
    }
  }
  return JSON.parse(decrypt(ssecurity, nonce, payload)) as unknown;
}

/**
 * 组装一次加密请求的完整表单参数。
 *
 * 顺序（Python dict 插入序语义，签名依赖于此）：
 *   1. 原始业务参数（例如 data）
 *   2. rc4_hash__ = 签名(原始参数)
 *   3. 上述所有 key 的 value 逐个 RC4 加密（就地替换，顺序不变）
 *   4. signature = 签名(加密后参数)
 *   5. ssecurity
 *   6. _nonce
 */
export function generateEncParams(
  uri: string,
  method: string,
  signedNonce: string,
  nonce: string,
  params: Record<string, string>,
  ssecurity: string,
): Record<string, string> {
  const out: Record<string, string> = { ...params };
  out.rc4_hash__ = genEncSignature(uri, method, signedNonce, out);
  for (const key of Object.keys(out)) {
    out[key] = encryptRC4(signedNonce, out[key] as string);
  }
  out.signature = genEncSignature(uri, method, signedNonce, out);
  out.ssecurity = ssecurity;
  out._nonce = nonce;
  return out;
}

/** 严格 UTF-8 校验，用于区分「明文 JSON」与「gzip 压缩体」。 */
export function isValidUtf8(buf: Buffer): boolean {
  const n = buf.length;
  let i = 0;
  while (i < n) {
    const c0 = buf[i++];
    if (c0 < 0x80) continue; // ASCII

    let bytes: number;
    let min: number;
    let code: number;
    if ((c0 & 0xe0) === 0xc0) {
      bytes = 2;
      min = 0x80;
      code = c0 & 0x1f;
    } else if ((c0 & 0xf0) === 0xe0) {
      bytes = 3;
      min = 0x800;
      code = c0 & 0x0f;
    } else if ((c0 & 0xf8) === 0xf0) {
      bytes = 4;
      min = 0x10000;
      code = c0 & 0x07;
    } else {
      return false; // 续字节出现在起始位，或起始字节 > 0xF7
    }

    if (i + bytes - 1 > n) return false;
    for (let k = 1; k < bytes; k++) {
      const c = buf[i++];
      if ((c & 0xc0) !== 0x80) return false;
      code = (code << 6) | (c & 0x3f);
    }
    if (code < min) return false; // overlong 编码
    if (code > 0x10ffff) return false;
    if (code >= 0xd800 && code <= 0xdfff) return false; // UTF-16 surrogate
  }
  return true;
}