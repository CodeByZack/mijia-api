/**
 * 认证会话存储 + 二维码登录流程 + Token 刷新。
 *
 * 登录流程（与 Python 参考实现一致）：
 *   1. GET serviceLogin 判断已有 token 是否仍有效
 *   2. 有效则跟随 location 换取新 cookie 并持久化
 *   3. 无效则用 location 的查询参数请求二维码 URL，打印 QR，长轮询等待扫码
 *   4. 扫码成功后回调 location 换取 cookie，落盘 auth.json
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import QRCode from "qrcode";

import { LoginError } from "./errors.js";
import {
  HEX_LOWER,
  buildUserAgent,
  countryOf,
  daylightInfo,
  detectLocale,
  fetchWithTimeout,
  localTimezoneName,
  parseQueryString,
  parseServiceRet,
  randomChars,
  randomDeviceId,
  utcOffsetString,
} from "./util.js";
import type { AuthData, Logger, LoginOptions, QRLoginData } from "./types.js";

export const API_BASE_URL = "https://api.mijia.tech/app";
export const LOGIN_URL = "https://account.xiaomi.com/longPolling/loginUrl";

const DEFAULT_AUTH_DIR = join(homedir(), ".config", "mijia-node");
const TOKEN_TTL_DAYS = 30;

// ---------------------------------------------------------------------------
// AuthStore
// ---------------------------------------------------------------------------

export interface AuthStoreOptions {
  /** auth.json 路径，或包含 auth.json 的目录。 */
  authDataPath?: string;
  locale?: string;
  /** 自定义 User-Agent（默认自动生成并持久化）。 */
  userAgent?: string;
  logger?: Logger;
}

/** 认证状态容器：持有 auth.json 内容并派生 UA / Cookie 等请求要素。 */
export class AuthStore {
  authData: AuthData = {};
  readonly authDataPath: string;
  readonly locale: string;
  readonly userAgent: string;
  readonly deviceId: string;
  readonly passO: string;
  readonly logger: Logger;

  constructor(options: AuthStoreOptions = {}) {
    this.locale = options.locale ?? detectLocale();
    this.logger = options.logger ?? (() => {});
    this.authDataPath = resolveAuthPath(options.authDataPath);

    if (existsSync(this.authDataPath)) {
      try {
        this.authData = JSON.parse(readFileSync(this.authDataPath, "utf8")) as AuthData;
      } catch {
        this.authData = {};
      }
    }

    this.passO = this.ensureField("pass_o", randomChars(HEX_LOWER, 16));
    this.deviceId = this.ensureField("deviceId", randomDeviceId());
    this.userAgent = options.userAgent ?? this.ensureField("ua", buildUserAgent(this.locale, this.passO));
  }

  /** serviceLogin 地址（带 sid=mijia）。 */
  get serviceLoginUrl(): string {
    return "https://account.xiaomi.com/pass/serviceLogin?_json=true&sid=mijia&_locale=" + this.locale;
  }

  private ensureField<K extends keyof AuthData>(key: K, value: string): string {
    if (this.authData[key] === undefined) {
      this.authData[key] = value as AuthData[K];
      this.save();
    }
    return String(this.authData[key]);
  }

  /** 保存认证数据到磁盘。 */
  save(): void {
    this.authData.saveTime = Date.now();
    mkdirSync(dirname(this.authDataPath), { recursive: true });
    writeFileSync(this.authDataPath, JSON.stringify(this.authData, undefined, 2), "utf8");
    this.logger("debug", "已保存认证数据到 " + this.authDataPath);
  }

  /** 主请求使用的 Cookie 头。 */
  cookieHeader(): string {
    const d = this.authData;
    const tz = daylightInfo();
    return [
      "cUserId=" + (d.cUserId ?? ""),
      "yetAnotherServiceToken=" + (d.serviceToken ?? ""),
      "serviceToken=" + (d.serviceToken ?? ""),
      "timezone_id=" + localTimezoneName(),
      "timezone=GMT" + utcOffsetString(),
      "is_daylight=" + (tz.isDaylight ? 1 : 0),
      "dst_offset=" + tz.dstOffsetMs,
      "channel=MI_APP_STORE",
      "countryCode=" + countryOf(this.locale),
      "PassportDeviceId=" + (d.deviceId ?? this.deviceId),
      "locale=" + this.locale,
    ].join(";");
  }

  /** 主请求使用的固定请求头。 */
  headers(): Record<string, string> {
    return {
      "User-Agent": this.userAgent,
      "accept-encoding": "identity",
      "Content-Type": "application/x-www-form-urlencoded",
      "miot-accept-encoding": "GZIP",
      "miot-encrypt-algorithm": "ENCRYPT-RC4",
      "x-xiaomi-protocal-flag-cli": "PROTOCAL-HTTP2",
      "Cookie": this.cookieHeader(),
    };
  }

  /** 登录/刷新流程使用的请求头。 */
  authHeaders(): Record<string, string> {
    const d = this.authData;
    return {
      "User-Agent": this.userAgent,
      "Connection": "keep-alive",
      "Accept-Encoding": "gzip",
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": [
        "deviceId=" + (d.deviceId ?? this.deviceId),
        "pass_o=" + (d.pass_o ?? this.passO),
        "passToken=" + (d.passToken ?? ""),
        "userId=" + (d.userId ?? ""),
        "cUserId=" + (d.cUserId ?? ""),
        "uLocale=" + this.locale,
      ].join(";"),
    };
  }

  /** ssecurity，加密签名所需。缺失时抛错。 */
  ssecurity(): string {
    const s = this.authData.ssecurity;
    if (!s) throw new LoginError(-1, "缺少 ssecurity，请先登录");
    return s;
  }

  /** 是否具备最小必需凭据。 */
  get hasCredentials(): boolean {
    const d = this.authData;
    return Boolean(d.ssecurity && d.userId && d.cUserId && d.serviceToken);
  }
}

function resolveAuthPath(authDataPath?: string): string {
  if (!authDataPath) return join(DEFAULT_AUTH_DIR, "auth.json");
  if (!authDataPath.includes("/") && !authDataPath.endsWith("auth.json")) {
    return join(authDataPath, "auth.json");
  }
  try {
    if (statSync(authDataPath).isDirectory()) return join(authDataPath, "auth.json");
  } catch {
    return resolve(authDataPath);
  }
  return resolve(authDataPath);
}

// ---------------------------------------------------------------------------
// 登录流程
// ---------------------------------------------------------------------------

interface ServiceRet {
  code: number;
  desc?: string;
  message?: string;
  location?: string;
  ssecurity?: string;
  [key: string]: unknown;
}

async function handleRet(resp: Response, verifyCode = true): Promise<ServiceRet> {
  if (resp.status !== 200) {
    const text = await resp.text().catch(() => "");
    throw new LoginError(resp.status, text.slice(0, 300));
  }
  const data = parseServiceRet<ServiceRet>(await resp.text());
  if (verifyCode && (data.code ?? 0) !== 0) {
    throw new LoginError(data.code, data.desc ?? data.message ?? "未知错误");
  }
  return data;
}

/** 从响应头收集 Set-Cookie。 */
function collectCookies(resp: Response, jar: Record<string, string>): void {
  for (const c of resp.headers.getSetCookie()) {
    const eq = c.indexOf("=");
    if (eq < 0) continue;
    const name = c.slice(0, eq).trim();
    const rest = c.slice(eq + 1);
    const semi = rest.indexOf(";");
    const value = (semi >= 0 ? rest.slice(0, semi) : rest).trim();
    if (name) jar[name] = value;
  }
}

/** serviceLogin 的结果：token 仍有效，或返回二维码相关查询参数。 */
export interface LocationResult {
  refreshed: boolean;
  code: number;
  /** 未刷新时，location 里的查询参数。 */
  locationData: Record<string, string>;
}

/** 访问 serviceLogin，判断已有 token 是否有效并尝试刷新。 */
export async function getLocation(store: AuthStore): Promise<LocationResult> {
  const resp = await fetchWithTimeout(store.serviceLoginUrl, { method: "GET", headers: store.authHeaders() });
  const data = await handleRet(resp, false);
  const location = data.location as string | undefined;
  if (!location) return { refreshed: false, code: data.code ?? -1, locationData: {} };

  if (data.code === 0) {
    const cb = await fetchWithTimeout(location, { method: "GET" });
    const body = await cb.text();
    if (cb.status === 200 && body === "ok") {
      const jar: Record<string, string> = {};
      collectCookies(cb, jar);
      Object.assign(store.authData.cookies ?? (store.authData.cookies = {}), jar);
      if (jar.serviceToken) store.authData.serviceToken = jar.serviceToken;
      if (data.ssecurity) store.authData.ssecurity = data.ssecurity;
      store.save();
      store.logger("info", "刷新Token成功");
      return { refreshed: true, code: 0, locationData: {} };
    }
  }

  const query = location.includes("?") ? location.slice(location.indexOf("?") + 1) : "";
  return { refreshed: false, code: data.code ?? -1, locationData: parseQueryString(query) };
}

/** 用已有 token 刷新 serviceToken，成功返回 true。 */
export async function refreshToken(store: AuthStore): Promise<boolean> {
  const result = await getLocation(store);
  return result.refreshed;
}

/** 请求二维码登录数据（不阻塞等待扫码）。 */
export async function requestLoginData(store: AuthStore): Promise<QRLoginData> {
  const result = await getLocation(store);
  if (result.refreshed) throw new LoginError(0, "Token 仍然有效，无需重新登录");

  const params = {
    ...result.locationData,
    theme: "",
    bizDeviceType: "",
    _hasLogo: "false",
    _qrsize: "240",
    _dc: String(Date.now()),
  };
  const url = LOGIN_URL + "?" + new URLSearchParams(params).toString();
  const loginData = await handleRet(await fetchWithTimeout(url, { method: "GET", headers: store.authHeaders() }));

  const loginUrl = String(loginData.loginUrl ?? "");
  const lp = String(loginData.lp ?? "");
  const qr = String(loginData.qr ?? "");
  if (!loginUrl || !lp) throw new LoginError(-1, "服务端未返回 loginUrl / lp 字段");
  return Object.assign({ loginUrl, lp, qr }, loginData) as QRLoginData;
}

/** 渲染终端 ASCII 二维码。 */
export async function printQR(loginUrl: string): Promise<string> {
  return QRCode.toString(loginUrl, { type: "terminal", errorCorrectionLevel: "L" });
}

/** 长轮询等待扫码并完成登录。 */
export async function completeLogin(store: AuthStore, data: QRLoginData, options: LoginOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 120000;
  options.onStatus?.("等待扫码...");

  let lpResp: Response;
  try {
    lpResp = await fetchWithTimeout(data.lp, { method: "GET", headers: store.authHeaders() }, timeoutMs);
  } catch (err) {
    if (err instanceof Error && err.message.includes("超时")) {
      throw new LoginError(-1, "等待扫码超时，请重试");
    }
    throw err;
  }

  const lpData = await handleRet(lpResp);
  const keys = ["psecurity", "nonce", "ssecurity", "passToken", "userId", "cUserId"] as const;
  for (const k of keys) {
    const v = lpData[k];
    if (v === undefined || v === null || v === "") throw new LoginError(-1, "扫码响应缺少字段: " + k);
    store.authData[k] = String(v);
  }

  const callbackUrl = String(lpData.location ?? "");
  if (callbackUrl) {
    options.onStatus?.("已扫码，正在获取会话...");
    const cb = await fetchWithTimeout(callbackUrl, { method: "GET", headers: store.authHeaders() });
    const jar: Record<string, string> = {};
    collectCookies(cb, jar);
    Object.assign(store.authData.cookies ?? (store.authData.cookies = {}), jar);
    if (jar.serviceToken) store.authData.serviceToken = jar.serviceToken;
  }

  store.authData.expireTime = Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
  store.save();
  store.logger("info", "登录成功");
  options.onStatus?.("登录成功");
}

/**
 * 二维码登录入口。
 *
 * 先尝试用已有 token 刷新；失败则打印二维码并等待扫码。
 */
export async function loginQR(store: AuthStore, options: LoginOptions = {}): Promise<AuthData> {
  try {
    if (await refreshToken(store)) return store.authData;
  } catch (err) {
    store.logger("debug", "自动刷新失败，转入扫码流程: " + String(err));
  }

  store.logger("info", "请使用米家APP扫描下方二维码");
  options.onStatus?.("正在请求二维码...");
  const data = await requestLoginData(store);
  options.onLoginUrl?.(data.loginUrl);

  if (options.printQR !== false) process.stdout.write(await printQR(data.loginUrl));
  if (data.qr) process.stdout.write("\n也可以访问链接查看二维码图片: " + data.qr + "\n");

  await completeLogin(store, data, options);
  return store.authData;
}

/** auth.json 是否已过期（过期后建议重新扫码）。 */
export function isAuthExpired(store: AuthStore): boolean {
  const exp = store.authData.expireTime;
  return typeof exp === "number" && exp > 0 && Date.now() > exp;
}