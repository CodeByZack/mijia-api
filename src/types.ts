/**
 * 米家云端 API 的 TypeScript 类型定义。
 */

/** 日志回调。 */
export type Logger = (level: "debug" | "info" | "warn" | "error", message: string) => void;

/** 持久化到 auth.json 的认证数据。 */
export interface AuthData {
  /** 云端会话密钥，用于 RC4 签名与加解密。 */
  ssecurity?: string;
  passToken?: string;
  psecurity?: string;
  nonce?: string;
  userId?: string;
  cUserId?: string;
  serviceToken?: string;
  /** 过期时间（毫秒时间戳）。 */
  expireTime?: number;
  /** 保存时间（毫秒时间戳）。 */
  saveTime?: number;
  /** 生成过的 User-Agent，必须与 Cookie 中保持一致。 */
  ua?: string;
  pass_o?: string;
  deviceId?: string;
  /** serviceLogin 返回的其他 cookie。 */
  cookies?: Record<string, string>;
}

/** 房间。 */
export interface Room {
  id: string;
  name: string;
  dids?: string[];
  [key: string]: unknown;
}

/** 家庭。 */
export interface Home {
  id: string;
  name: string;
  /** 家庭所属用户 ID。 */
  uid: string;
  roomlist?: Room[];
  [key: string]: unknown;
}

/** 云端返回的设备信息。 */
export interface DeviceInfo {
  did: string;
  name?: string;
  model?: string;
  home_id?: string;
  room_id?: string;
  uid?: string;
  is_online?: boolean;
  /** 例如 urn:miot-spec-v2:device:light:0000A014 */
  spec_type?: string;
  extra?: { split?: { parentId?: string } };
  owner?: boolean;
  [key: string]: unknown;
}

/** 手动场景。 */
export interface Scene {
  scene_id: string;
  name?: string;
  home_id?: string;
  [key: string]: unknown;
}

/** 耗材详情。 */
export interface ConsumableDetail {
  id?: string;
  description?: string;
  value?: string;
  consumable_type?: string;
  [key: string]: unknown;
}

/** 耗材。 */
export interface Consumable {
  did?: string;
  name?: string;
  home_id?: string;
  details?: ConsumableDetail | ConsumableDetail[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 设备规格（miot-spec）
// ---------------------------------------------------------------------------

/** 属性数据类型。 */
export type PropertyType = "bool" | "int" | "uint" | "float" | "string";

/** 枚举值项。 */
export interface ValueItem {
  value: string | number;
  desc: string;
  desc_zh_cn?: string;
}

/** 设备属性。 */
export interface DeviceProperty {
  siid: number;
  piid: number;
  /** 属性名，例如 on / brightness / temperature-set */
  name: string;
  desc: string;
  type: PropertyType;
  /** r 可读 / w 可写 / rw 可读写 */
  rw: "" | "r" | "w" | "rw";
  /** [min, max] 或 [min, max, step] */
  range?: number[];
  value_list?: ValueItem[];
  unit?: string;
}

/** 动作入参/出参定义。 */
export interface MethodParam {
  iid: number;
  format: string;
  type: string;
  description: string;
}

/** 设备动作。 */
export interface DeviceAction {
  siid: number;
  aiid: number;
  name: string;
  desc: string;
  in?: MethodParam[];
  out?: MethodParam[];
}

/** 解析后的设备规格。 */
export interface DeviceSpec {
  /** 缓存格式版本。 */
  version: number;
  name: string;
  model: string;
  properties: DeviceProperty[];
  actions: DeviceAction[];
}

// ---------------------------------------------------------------------------
// 请求参数与结果
// ---------------------------------------------------------------------------

/** 读取属性参数。 */
export interface PropGetItem {
  did: string;
  siid: number;
  piid: number;
}

/** 设置属性参数。 */
export interface PropSetItem extends PropGetItem {
  value: string | number | boolean;
}

/** 执行动作参数。 */
export interface ActionItem {
  did: string;
  siid: number;
  aiid: number;
  value?: unknown[];
  [key: string]: unknown;
}

/** 属性读取结果。 */
export interface PropResult {
  did?: string;
  siid?: number;
  piid?: number;
  value?: unknown;
  code: number;
  updateTime?: number;
  message?: string;
  [key: string]: unknown;
}

/** 动作执行结果。 */
export type ActionResult = PropResult;

/** 云端原始响应。 */
export interface CloudResponse<T = unknown> {
  code: number;
  desc?: string;
  message?: string;
  result?: T;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 选项
// ---------------------------------------------------------------------------

/** 主类选项。 */
export interface MijiaAPIOptions {
  /**
   * auth.json 路径。可以是文件路径，也可以是目录（目录下自动使用 auth.json）。
   * 默认 ~/.config/mijia-node/auth.json。
   */
  authDataPath?: string;
  /** 语言区域，默认从环境变量推断，兜底 zh_CN。 */
  locale?: string;
  /** 请求基础地址。 */
  baseUrl?: string;
  /** 自定义 User-Agent（默认自动生成并持久化）。 */
  userAgent?: string;
  /** 设备读写之间的间隔秒数，避免请求过快。默认 0.3（见 DEFAULT_SLEEP_TIME）。 */
  sleepTime?: number;
  /** 单次请求超时毫秒数。默认 30000。 */
  timeoutMs?: number;
  /** 调试日志回调。 */
  logger?: Logger;
  /** 设备规格缓存目录，默认与 auth.json 同目录。 */
  specCacheDir?: string;
}

/** 登录选项。 */
export interface LoginOptions {
  /** 扫码等待超时毫秒数。默认 120000。 */
  timeoutMs?: number;
  /** 是否在终端打印 ASCII 二维码。默认 true。 */
  printQR?: boolean;
  /** QR 码渲染回调（可用于写入图片文件）。 */
  onLoginUrl?: (loginUrl: string) => void;
  /** 状态变化回调。 */
  onStatus?: (status: string) => void;
}

/** 设备构造选项。 */
export interface DeviceOptions {
  /** 按名称查找设备时的匹配值。 */
  name?: string;
  /** 设备读写间隔秒数，覆盖主类默认值。 */
  sleepTime?: number;
}

/** QR 登录流程中「获取二维码」这一步的返回。 */
export interface QRLoginData {
  loginUrl: string;
  /** 二维码图片地址（PNG）。 */
  qr: string;
  /** 长轮询地址。 */
  lp: string;
  [key: string]: unknown;
}

/** 按属性名索引的属性表。 */
export type PropertyMap = Record<string, DeviceProperty>;

/** 按 siid -> piid 索引的属性表。 */
export type SiidPiidMap = Record<number, Record<number, DeviceProperty>>;

/** 按动作名索引的动作表。 */
export type ActionMap = Record<string, DeviceAction>;