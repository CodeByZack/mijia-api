/**
 * 通用工具：User-Agent 生成、区域/时区推断、表单编码、并发限制等。
 */
import { randomInt } from "node:crypto";

/** 十六进制（大写）。 */
export const HEX_UPPER = "0123456789ABCDEF";

/** 十六进制（小写）。 */
export const HEX_LOWER = "0123456789abcdef";

/** deviceId 字符集（与 Python 参考实现一致）。 */
export const DEVICE_ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-";

const LOCALE_FALLBACK = "zh_CN";

/**
 * 从环境变量推断区域字符串，例如 zh_CN / en_US。
 * 推断失败时返回 zh_CN。
 */
export function detectLocale(env: NodeJS.ProcessEnv = process.env): string {
  // 按优先级逐个尝试；值形如 "en_US.UTF-8" 或 LANGUAGE 的 "de:en_US" 列表。
  for (const key of ["LC_ALL", "LC_MESSAGES", "LANGUAGE", "LANG"]) {
    const raw = env[key];
    if (!raw) continue;
    const first = raw.split(":")[0] ?? "";
    const m = first.match(/^([a-z]{2})[_.-]([A-Za-z]{2})/i);
    if (m) return m[1].toLowerCase() + "_" + m[2].toUpperCase();
  }
  return LOCALE_FALLBACK;
}

/** 从区域字符串取国家码，例如 zh_CN -> CN。 */
export function countryOf(locale: string): string {
  const m = locale.match(/^(?:[a-z]{2})[_-]([A-Za-z]{2})/);
  return m ? m[1].toUpperCase() : "CN";
}

/** 当前系统时区名，例如 Asia/Shanghai。 */
export function localTimezoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  } catch {
    return "Asia/Shanghai";
  }
}

/** 某个时刻的 UTC 偏移，例如 +08:00。 */
export function utcOffsetString(date: Date = new Date()): string {
  const ms = -date.getTimezoneOffset() * 60 * 1000;
  const sign = ms < 0 ? "-" : "+";
  const abs = Math.abs(ms);
  const h = String(Math.floor(abs / 3600000)).padStart(2, "0");
  const m = String(Math.floor((abs % 3600000) / 60000)).padStart(2, "0");
  return sign + h + ":" + m;
}

/**
 * 判断某时刻是否处于夏令时，并给出偏移量。
 * 通过与「1 月 1 日」「7 月 1 日」的偏移量比较来推断（对北半球/南半球都成立）。
 */
export function daylightInfo(date: Date = new Date()): { isDaylight: boolean; dstOffsetMs: number } {
  const y = date.getFullYear();
  const nowOffset = date.getTimezoneOffset();
  const janOffset = new Date(y, 0, 1).getTimezoneOffset();
  const julOffset = new Date(y, 6, 1).getTimezoneOffset();
  const winterOffset = Math.min(janOffset, julOffset);
  const isDaylight = nowOffset < winterOffset;
  return { isDaylight, dstOffsetMs: isDaylight ? 60 * 60 * 1000 : 0 };
}

/** 从给定字符集中随机取 n 个字符。 */
export function randomChars(chars: string, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += chars[randomInt(chars.length)];
  return out;
}

/** 随机十六进制串。 */
export function randomHex(n: number, lower = false): string {
  return randomChars(lower ? HEX_LOWER : HEX_UPPER, n);
}

/** 随机 deviceId。 */
export function randomDeviceId(): string {
  return randomChars(DEVICE_ID_CHARS, 16);
}

/**
 * 生成米家 Android App 风格的 User-Agent。
 *
 * 格式（与 Python 参考实现一致）：
 *   Android-15-11.0.701-Xiaomi-23046RP50C-OS2.0.212.0.VMYCNXM-
 *   {ua_id1}-{COUNTRY}-{ua_id3}-{ua_id2}-SmartHome-MI_APP_STORE-
 *   {ua_id1}|{ua_id4}|{pass_o}-64
 */
export function buildUserAgent(locale: string, passO: string): string {
  const uaId1 = randomHex(40);
  const uaId2 = randomHex(32);
  const uaId3 = randomHex(32);
  const uaId4 = randomHex(40);
  return (
    "Android-15-11.0.701-Xiaomi-23046RP50C-OS2.0.212.0.VMYCNXM-" +
    uaId1 + "-" + countryOf(locale) + "-" + uaId3 + "-" + uaId2 + 
    "-SmartHome-MI_APP_STORE-" + uaId1 + "|" + uaId4 + "|" + passO + "-64"
  );
}

/** 把参数对象编码为 application/x-www-form-urlencoded 字符串。 */
export function toFormUrlEncoded(params: Record<string, string>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) sp.append(k, v);
  return sp.toString();
}

/** 解析查询字符串为单值 map。 */
export function parseQueryString(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(query)) out[k] = v;
  return out;
}

/** 剥离小米服务返回体前缀的 &&&START&&& 标记。 */
export function stripServiceMarker(text: string): string {
  return text.replace(/&&&START&&&/, "");
}

/** 解析小米服务返回体（可能是 JSON，前面可能带标记）。 */
export function parseServiceRet<T = unknown>(text: string): T {
  return JSON.parse(stripServiceMarker(text)) as T;
}

/**
 * 并发限制执行器（p-limit 语义），用于设备发现等批量请求。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  const size = Math.max(1, Math.min(limit, items.length));
  for (let w = 0; w < size; w++) {
    workers.push(
      (async () => {
        for (;;) {
          const idx = next++;
          if (idx >= items.length) return;
          try {
            results[idx] = { status: "fulfilled", value: await fn(items[idx] as T, idx) };
          } catch (reason) {
            results[idx] = { status: "rejected", reason };
          }
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

/** sleep helper。 */
export function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds * 1000)));
}

/** 带超时的 fetch。 */
export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 30000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("请求超时（" + timeoutMs + "ms）: " + url);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 从 Authorization/Cookie 字符串解析 cookie 键值对。 */
export function parseCookieHeader(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}