/**
 * MijiaAPI —— 主类：认证、连接、设备管理。
 */
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { MijiaApiClient } from "./api.js";
import { DEFAULT_SLEEP_TIME, MijiaDevice, resolveDevice } from "./device.js";
import { APIError } from "./errors.js";
import { AuthStore, loginQR } from "./login.js";
import { getDeviceInfo } from "./spec.js";
import { mapWithConcurrency } from "./util.js";
import type {
  ActionItem,
  ActionResult,
  Consumable,
  DeviceInfo,
  DeviceOptions,
  DeviceSpec,
  Home,
  Logger,
  LoginOptions,
  MijiaAPIOptions,
  PropResult,
  Scene,
} from "./types.js";

const HOME_DEVICE_CONCURRENCY = 4;

/** 米家云端 API 主类。 */
export class MijiaAPI {
  readonly store: AuthStore;
  readonly client: MijiaApiClient;
  readonly logger: Logger;
  readonly sleepTime: number;
  readonly specCacheDir: string;

  private _available: boolean | null = null;
  private _homes: Home[] | null = null;
  private _deviceInfos: DeviceInfo[] | null = null;
  private _devices: Map<string, MijiaDevice> | null = null;
  private readonly specCache = new Map<string, DeviceSpec>();

  constructor(options: MijiaAPIOptions = {}) {
    this.logger = options.logger ?? (() => {});
    this.sleepTime = options.sleepTime ?? DEFAULT_SLEEP_TIME;

    this.store = new AuthStore({
      authDataPath: options.authDataPath,
      locale: options.locale,
      userAgent: options.userAgent,
      logger: this.logger,
    });

    // 规格缓存默认落在 auth.json 的真实所在目录（用解析后的路径计算，
    // 而不是对入参直接 dirname —— 传入目录时 dirname 会错指到上一级）。
    this.specCacheDir = options.specCacheDir ?? dirname(this.store.authDataPath);

    this.client = new MijiaApiClient(this.store, {
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
      logger: this.logger,
    });
  }

  /** 已缓存的 token 可用性（未检查过时为 false）。 */
  get available(): boolean {
    return this._available === true;
  }

  /** 检查 token 是否有效（网络调用，60 秒缓存）。 */
  async isAvailable(): Promise<boolean> {
    this._available = await this.client.isAvailable();
    return this._available;
  }

  /** 二维码登录。已有有效 token 时直接返回；否则打印二维码并等待扫码。 */
  async login(options: LoginOptions = {}): Promise<void> {
    await loginQR(this.store, { onStatus: (s) => this.logger("info", s), ...options });
    this.clearCache();
  }

  /** 清空内存缓存（不删除 auth.json）。 */
  async disconnect(): Promise<void> {
    this.clearCache();
  }

  private clearCache(): void {
    this._available = null;
    this._homes = null;
    this._deviceInfos = null;
    this._devices = null;
  }

  /** 家庭列表。 */
  async getHomesList(): Promise<Home[]> {
    if (!this._homes) this._homes = await this.client.getHomesList();
    return this._homes;
  }

  /** 云端原始设备信息列表。 */
  async getDeviceInfoList(homeId?: string | number): Promise<DeviceInfo[]> {
    if (homeId !== undefined) return this.client.getDevicesList(homeId);
    if (!this._deviceInfos) this._deviceInfos = await this.client.getDevicesList();
    return this._deviceInfos;
  }

  /** 被共享给当前账号的设备。 */
  async getSharedDevicesList(): Promise<DeviceInfo[]> {
    return this.client.getSharedDevicesList();
  }

  /** 重新拉取设备列表与规格。 */
  async refreshDevices(): Promise<MijiaDevice[]> {
    this._deviceInfos = null;
    this._devices = null;
    return this.getDevices();
  }

  /** 获取全部设备对象（解析规格，磁盘缓存）。 */
  async getDevices(): Promise<MijiaDevice[]> {
    if (this._devices) return [...this._devices.values()];
    const infos = await this.getDeviceInfoList();
    const devices = new Map<string, MijiaDevice>();
    const results = await mapWithConcurrency(infos, HOME_DEVICE_CONCURRENCY, async (info) => {
      if (!info.model) return undefined;
      const spec = await this.fetchSpec(info.model);
      return new MijiaDevice(this.client, info, spec, this.sleepTime);
    });
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) devices.set(r.value.did, r.value);
      else if (r.status === "rejected") this.logger("warn", "设备规格解析失败: " + String(r.reason));
    }
    this._devices = devices;
    return [...devices.values()];
  }

  /** 获取单个设备对象。可按 did 或设备名查找。 */
  async getDevice(did?: string, options: DeviceOptions = {}): Promise<MijiaDevice> {
    const infos = await this.getDeviceInfoList();
    const { info, spec } = await resolveDevice(infos, { did, name: options.name }, (m) => this.fetchSpec(m));
    return new MijiaDevice(this.client, info, spec, options.sleepTime ?? this.sleepTime);
  }

  private async fetchSpec(model: string): Promise<DeviceSpec> {
    if (!model) throw new APIError(-1, "设备缺少 model 字段");
    const hit = this.specCache.get(model);
    if (hit) return hit;
    const spec = await getDeviceInfo(model, { cacheDir: this.specCacheDir });
    this.specCache.set(model, spec);
    return spec;
  }

  /** 读取单个设备属性，返回完整结果。 */
  async getDevicesProp(did: string, siid: number, piid: number): Promise<PropResult> {
    const r = await this.client.getDevicesProp({ did, siid, piid });
    return Array.isArray(r) ? (r[0] as PropResult) : r;
  }

  /** 读取设备属性值（便捷方法）。 */
  async getPropValue(did: string, siid: number, piid: number): Promise<unknown> {
    return (await this.getDevicesProp(did, siid, piid)).value;
  }

  /** 设置设备属性。返回 true 表示云端已接受（code 0 或 1）。 */
  async setDevicesProp(did: string, siid: number, piid: number, value: string | number | boolean): Promise<boolean> {
    const r = await this.client.setDevicesProp({ did, siid, piid, value });
    const one = Array.isArray(r) ? (r[0] as PropResult) : r;
    if (one.code === 1) this.logger("warn", "网关已接收指令，无法判断是否设置成功");
    if (one.code !== 0 && one.code !== 1) throw new APIError(one.code, one.message ?? "设置属性失败");
    return true;
  }

  /** 执行设备动作。 */
  async runAction(did: string, siid: number, aiid: number, params?: unknown[], extra?: Record<string, unknown>): Promise<ActionResult> {
    const item: ActionItem = { did, siid, aiid };
    if (params !== undefined) item.value = params;
    if (extra) Object.assign(item, extra);
    const r = await this.client.runAction(item);
    return Array.isArray(r) ? (r[0] as ActionResult) : r;
  }

  /** 批量读取属性。 */
  async getDevicesPropBatch(items: Array<{ did: string; siid: number; piid: number }>): Promise<PropResult[]> {
    return (await this.client.getDevicesProp(items)) as PropResult[];
  }

  /** 批量设置属性。 */
  async setDevicesPropBatch(items: Array<{ did: string; siid: number; piid: number; value: string | number | boolean }>): Promise<PropResult[]> {
    return (await this.client.setDevicesProp(items)) as PropResult[];
  }

  /** 场景列表。 */
  async getScenesList(homeId?: string | number): Promise<Scene[]> {
    return this.client.getScenesList(homeId);
  }

  /** 执行手动场景。 */
  async runScene(sceneId: string, homeId: string | number): Promise<unknown> {
    return this.client.runScene(sceneId, homeId);
  }

  /** 耗材列表。 */
  async getConsumableItems(homeId?: string | number): Promise<Consumable[]> {
    return this.client.getConsumableItems(homeId);
  }

  /** 设备统计数据（耗电量等）。 */
  async getStatistics(data: Record<string, unknown> | Record<string, unknown>[]): Promise<unknown> {
    return this.client.getStatistics(data);
  }

  /** 校验 token（等价于 Python 的 check_new_msg）。 */
  async checkNewMsg(beginAt?: number): Promise<unknown> {
    return this.client.checkNewMsg(beginAt);
  }

  toString(): string {
    return (
      "MijiaAPI {\n" +
      "  authDataPath: " + this.store.authDataPath + ",\n" +
      "  locale: " + this.store.locale + ",\n" +
      "  available: " + this.available + "\n}"
    );
  }
}