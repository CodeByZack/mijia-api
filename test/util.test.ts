import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEVICE_ID_CHARS,
  HEX_LOWER,
  HEX_UPPER,
  buildUserAgent,
  countryOf,
  daylightInfo,
  detectLocale,
  fetchWithTimeout,
  localTimezoneName,
  mapWithConcurrency,
  parseCookieHeader,
  parseQueryString,
  parseServiceRet,
  randomChars,
  randomDeviceId,
  randomHex,
  sleep,
  stripServiceMarker,
  toFormUrlEncoded,
  utcOffsetString,
} from "../src/util.js";

test("detectLocale 归一化各种输入", () => {
  assert.equal(detectLocale({ LANG: "en_US.UTF-8" }), "en_US");
  assert.equal(detectLocale({ LANG: "en_US.utf8" }), "en_US");
  assert.equal(detectLocale({ LANG: "en-US" }), "en_US");
  assert.equal(detectLocale({ LC_ALL: "zh_CN.UTF-8", LANG: "en_US" }), "zh_CN");
  assert.equal(detectLocale({ LANGUAGE: "de", LANG: "en_US" }), "en_US");
  assert.equal(detectLocale({ LANG: "C" }), "zh_CN");
  assert.equal(detectLocale({}), "zh_CN");
});

test("countryOf 取国家码", () => {
  assert.equal(countryOf("zh_CN"), "CN");
  assert.equal(countryOf("en-US"), "US");
  assert.equal(countryOf("en_us"), "US");
  assert.equal(countryOf("C"), "CN");
});

test("utcOffsetString 与 getTimezoneOffset 自洽", () => {
  const d = new Date(2026, 0, 1, 12, 0, 0);
  const ms = -d.getTimezoneOffset() * 60000;
  const s = utcOffsetString(d);
  const m = s.match(/^([+-])(\d\d):(\d\d)$/);
  assert.ok(m);
  const parsed = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60) * 1000;
  // UTC 时区下 getTimezoneOffset() 返回 -0，而 0 与 -0 在 Object.is 语义下不相等
  // （GitHub runner 正好是 UTC，本地时区不是，所以这个坑只在 CI 上暴露）。
  // 断言的是数值相等，转成字符串后两者都是 "0"。
  assert.equal(String(parsed), String(ms));
});

test("daylightInfo 与偏移量自洽", () => {
  const y = new Date().getFullYear();
  const jan = new Date(y, 0, 1);
  const jul = new Date(y, 6, 1);
  const ji = daylightInfo(jan);
  const ju = daylightInfo(jul);
  assert.equal(ji.dstOffsetMs, ji.isDaylight ? 3600000 : 0);
  assert.equal(ju.dstOffsetMs, ju.isDaylight ? 3600000 : 0);
  const minOff = Math.min(jan.getTimezoneOffset(), jul.getTimezoneOffset());
  if (jan.getTimezoneOffset() === jul.getTimezoneOffset()) {
    assert.equal(ji.isDaylight, false);
    assert.equal(ju.isDaylight, false);
  } else {
    const winterIsJan = jan.getTimezoneOffset() === minOff;
    assert.equal(ji.isDaylight, !winterIsJan);
    assert.equal(ju.isDaylight, winterIsJan);
  }
});

test("localTimezoneName 返回合法时区名", () => {
  const tz = localTimezoneName();
  assert.ok(tz.length > 0);
  // 容器/CI 环境常常不设 TZ：此时返回 "UTC"（不含 /）或 "Etc/Unknown"，
  // 正常桌面环境才是 Asia/Shanghai 这类 IANA 名。断言形状而不是断言含 "/"。
  assert.match(tz, /^[A-Za-z_][\w+.\-/]*$/);
});

test("randomChars 长度与字符集", () => {
  const s = randomChars("abc", 12);
  assert.equal(s.length, 12);
  assert.match(s, /^[abc]+$/);
  assert.equal(randomChars("xyz", 0), "");
});

test("randomHex 与 randomDeviceId", () => {
  assert.match(randomHex(40), /^[0-9A-F]{40}$/);
  assert.match(randomHex(32, true), /^[0-9a-f]{32}$/);
  assert.equal(HEX_UPPER.length, 16);
  assert.equal(HEX_LOWER.length, 16);
  const id = randomDeviceId();
  assert.equal(id.length, 16);
  for (const ch of id) assert.ok(DEVICE_ID_CHARS.includes(ch));
});

test("buildUserAgent 结构与米家 App 风格一致", () => {
  const passO = "0123456789abcdef";
  const ua = buildUserAgent("zh_CN", passO);
  assert.match(ua, /^Android-15-11\.0\.701-Xiaomi-23046RP50C-OS2\.0\.212\.0\.VMYCNXM-/);
  assert.match(ua, /-[0-9A-F]{40}-CN-[0-9A-F]{32}-[0-9A-F]{32}-SmartHome-MI_APP_STORE-/);
  assert.match(ua, /-[0-9A-F]{40}\|[0-9A-F]{40}\|0123456789abcdef-64$/);
});

test("toFormUrlEncoded 正确百分号编码 base64 字符", () => {
  const enc = toFormUrlEncoded({ data: "a+b/c=d", _nonce: "x=y" });
  assert.equal(enc, "data=a%2Bb%2Fc%3Dd&_nonce=x%3Dy");
});

test("parseQueryString 解析单值查询串", () => {
  assert.deepEqual(parseQueryString("a=1&b=two&c=hello%20world"), { a: "1", b: "two", c: "hello world" });
});

test("stripServiceMarker / parseServiceRet 处理 &&&START&&& 前缀", () => {
  assert.equal(stripServiceMarker('&&&START&&&{"a":1}'), '{"a":1}');
  assert.deepEqual(parseServiceRet('&&&START&&&{"code":0}'), { code: 0 });
  assert.deepEqual(parseServiceRet('{"code":0}'), { code: 0 });
});

test("parseCookieHeader 解析 Cookie 头", () => {
  assert.deepEqual(parseCookieHeader(null), {});
  assert.deepEqual(parseCookieHeader(""), {});
  assert.deepEqual(parseCookieHeader("a=1; b=2;  c = three ;"), { a: "1", b: "2", c: "three" });
});

test("sleep 大约等待指定秒数", async () => {
  const t0 = Date.now();
  await sleep(0.05);
  assert.ok(Date.now() - t0 >= 45);
});

test("mapWithConcurrency 保持顺序并限制并发", async () => {
  let active = 0;
  let peak = 0;
  const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 10;
  });
  assert.equal(peak, 3);
  assert.deepEqual(out.map((r) => (r.status === "fulfilled" ? r.value : null)), [10, 20, 30, 40, 50, 60, 70]);
});

test("mapWithConcurrency 保留失败项且不影响其他项", async () => {
  const out = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error("boom");
    return n;
  });
  assert.deepEqual(out.map((r) => (r.status === "fulfilled" ? r.value : String(r.reason))), [1, "Error: boom", 3]);
});

test("fetchWithTimeout 超时抛错", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      await new Promise((_resolve, rej) => {
        const t = setTimeout(() => rej(new Error("never")), 5000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          const e = new Error("aborted");
          e.name = "AbortError";
          rej(e);
        });
      });
      return new Response("ok");
    }) as typeof fetch;
    await assert.rejects(() => fetchWithTimeout("http://x", {}, 20));
  } finally {
    globalThis.fetch = original;
  }
});