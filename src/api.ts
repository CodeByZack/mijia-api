/**
 * 米家云端 API 客户端：加密请求 + 全部业务端点。
 */
import { decryptJSON, genNonce, generateEncParams, getSignedNonce } from "./crypto.js";
import { APIError, LoginError } from "./errors.js";
import { API_BASE_URL, getLocation } from "./login.js";
import type { AuthStore } from "./login.js";
import { fetchWithTimeout, toFormUrlEncoded } from "./util.js";
import type {
  ActionItem,
  ActionResult,
  Consumable,
  DeviceInfo,
  Home,
  Logger,
  PropGetItem,
  PropResult,
  PropSetItem,
  Scene,
} from "./types.js";

/** 可用性缓存窗口（与 Python 参考实现一致的 60 秒）。 */
const AVAILABILITY_CACHE_MS = 60 * 1000;

export interface ApiClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** 每次请求前自动检查/刷新 token。默认 true。 */
  autoRefreshToken?: boolean;
  logger?: Logger;
}

export interface CallApiOptions {
  /** 覆盖实例级的 autoRefreshToken。 */
  refreshToken?: boolean;
}

interface HomeResult {
  homelist?: Home[];
  [key: string]: unknown;
}

interface HomeDeviceListResult {
  device_info?: DeviceInfo[];
  max_did?: string;
  has_more?: boolean;
  [key: string]: unknown;
}

interface SharedDeviceListResult {
  list?: DeviceInfo[];
  [key: string]: unknown;
}

interface SceneListResult {
  manual_scene_info_list?: Scene[];
  [key: string]: unknown;
}

interface ConsumableListResult {
  items?: Array<{ consumes_data?: Consumable[] }>;
  [key: string]: unknown;
}

/** 米家云端 API 客户端。 */
export class MijiaApiClient {
  private readonly store: AuthStore;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly autoRefreshToken: boolean;
  private readonly logger: Logger;
  private availableCache: { value: boolean; at: number } | null = null;

  constructor(store: AuthStore, options: ApiClientOptions = {}) {
    this.store = store;
    this.baseUrl = options.baseUrl ?? API_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.autoRefreshToken = options.autoRefreshToken ?? true;
    this.logger = options.logger ?? store.logger;
  }

  /** token 是否有效（60 秒缓存）。 */
  async isAvailable(): Promise<boolean> {
    if (!this.store.hasCredentials) return false;
    const now = Date.now();
    if (this.availableCache && now - this.availableCache.at < AVAILABILITY_CACHE_MS) {
      return this.availableCache.value;
    }
    let ok = false;
    try {
      await this.callApi("/v2/message/v2/check_new_msg", { begin_at: Math.floor(Date.now() / 1000) - 3600 }, { refreshToken: false });
      ok = true;
    } catch {
      ok = false;
    }
    this.availableCache = { value: ok, at: now };
    return ok;
  }

  /** 确保 token 有效：无效则尝试刷新，刷新失败抛 LoginError。 */
  async ensureToken(): Promise<void> {
    if (!this.store.hasCredentials) throw new LoginError(-1, "尚未登录，请先调用 login()");
    if (await this.isAvailable()) return;
    this.logger("debug", "Token 无效，尝试刷新");
    const result = await getLocation(this.store);
    if (result.refreshed) {
      this.availableCache = null;
      return;
    }
    throw new LoginError(result.code ?? -1, "刷新Token失败，请重新登录");
  }

  /**
   * 发起一次加密 API 调用。
   *
   * @param uri  端点，例如 /miotspec/prop/get
   * @param data 业务数据对象（会被 JSON 序列化进 data 字段）
   */
  async callApi<T = unknown>(uri: string, data: unknown, options: CallApiOptions = {}): Promise<T> {
    const refresh = options.refreshToken ?? this.autoRefreshToken;
    if (refresh) await this.ensureToken();

    const url = this.baseUrl + uri;
    const nonce = genNonce();
    const ssecurity = this.store.ssecurity();
    const params = generateEncParams(uri, "POST", getSignedNonce(ssecurity, nonce), nonce, { data: JSON.stringify(data) }, ssecurity);

    this.logger("debug", "请求 " + uri);
    const resp = await fetchWithTimeout(url, { method: "POST", headers: this.store.headers(), body: toFormUrlEncoded(params) }, this.timeoutMs);

    const text = await resp.text();
    if (resp.status !== 200) {
      throw new APIError(resp.status, "HTTP " + resp.status + " " + text.slice(0, 200));
    }

    let retData: { code?: number; desc?: unknown; message?: unknown; result?: T };
    try {
      retData = JSON.parse(text) as typeof retData;
    } catch {
      retData = decryptJSON(ssecurity, nonce, text) as typeof retData;
    }

    if ((retData.code ?? 0) !== 0 || !("result" in retData)) {
      throw new APIError(retData.code ?? -1, String(retData.desc ?? retData.message ?? "未知错误"));
    }
    this.logger("debug", "响应 " + uri);
    return retData.result as T;
  }

  /** 校验 token 有效性（对应 Python 的 check_new_msg）。 */
  async checkNewMsg(beginAt?: number): Promise<unknown> {
    return this.callApi("/v2/message/v2/check_new_msg", { begin_at: beginAt ?? Math.floor(Date.now() / 1000) - 3600 }, { refreshToken: false });
  }

  /** 家庭列表。 */
  async getHomesList(): Promise<Home[]> {
    const ret = await this.callApi<HomeResult>("/v2/homeroom/gethome_merged", {
      fg: true,
      fetch_share: true,
      fetch_share_dev: true,
      fetch_cariot: true,
      limit: 300,
      app_ver: 7,
      plat_form: 0,
    });
    return ret.homelist ?? [];
  }

  /** 家庭所属用户 ID。 */
  async getHomeOwner(homeId: string | number): Promise<number> {
    const homes = await this.getHomesList();
    const id = String(homeId);
    const home = homes.find((h) => String(h.id) === id);
    if (!home) throw new APIError(-1, "未找到 home_id=" + id + " 的家庭信息");
    return Number(home.uid);
  }

  private async getDevicesOfHome(homeId: string | number): Promise<DeviceInfo[]> {
    const homeOwner = await this.getHomeOwner(homeId);
    const homeIdNum = Number(homeId);
    const devices: DeviceInfo[] = [];
    let startDid = "";
    let hasMore = true;
    while (hasMore) {
      const ret = await this.callApi<HomeDeviceListResult>("/home/home_device_list", {
        home_owner: homeOwner,
        home_id: homeIdNum,
        limit: 200,
        start_did: startDid,
        get_split_device: true,
        support_smart_home: true,
        get_cariot_device: true,
        get_third_device: true,
      });
      if (ret.device_info && ret.device_info.length > 0) {
        devices.push(...ret.device_info);
        startDid = ret.max_did ?? "";
        hasMore = Boolean(ret.has_more) && startDid !== "";
      } else {
        hasMore = false;
      }
    }
    for (const d of devices) d.home_id = String(homeId);
    return devices
  }

  /** 设备列表。不传 homeId 则返回所有家庭的设备。 */
  async getDevicesList(homeId?: string | number): Promise<DeviceInfo[]> {
    if (homeId !== undefined) return this.getDevicesOfHome(homeId);
    const homes = await this.getHomesList();
    const devices: DeviceInfo[] = [];
    for (const home of homes) devices.push(...(await this.getDevicesOfHome(home.id)));
    return devices;
  }

  /** 被共享给当前账号的设备列表。 */
  async getSharedDevicesList(): Promise<DeviceInfo[]> {
    const ret = await this.callApi<SharedDeviceListResult>("/v2/home/device_list_page", {
      ssid: "<unknown ssid>",
      bssid: "02:00:00:00:00:00",
      getVirtualModel: true,
      getHuamiDevices: 1,
      get_split_device: true,
      support_smart_home: true,
      get_cariot_device: true,
      get_third_device: true,
      get_phone_device: true,
      get_miwear_device: true,
    });
    const devices = (ret.list ?? []).filter((d) => d.owner === true);
    for (const d of devices) d.home_id = "shared";
    return devices;
  }

  /** 读取设备属性（支持批量）。 */
  async getDevicesProp(data: PropGetItem | PropGetItem[]): Promise<PropResult | PropResult[]> {
    const params = Array.isArray(data) ? data : [data];
    const ret = await this.callApi<PropResult[]>("/miotspec/prop/get", { params, datasource: 1 });
    if (!Array.isArray(data) && ret.length === 1) return ret[0] as PropResult;
    return ret;
  }

  /** 设置设备属性（支持批量）。 */
  async setDevicesProp(data: PropSetItem | PropSetItem[]): Promise<PropResult | PropResult[]> {
    const params = Array.isArray(data) ? data : [data];
    const ret = await this.callApi<PropResult[]>("/miotspec/prop/set", { params });
    for (const r of ret) r.message = r.code === 0 || r.code === 1 ? "成功" : "失败(code=" + r.code + ")";
    if (!Array.isArray(data) && ret.length === 1) return ret[0] as PropResult;
    return ret;
  }

  /** 执行设备动作（支持批量，逐条请求）。 */
  async runAction(data: ActionItem | ActionItem[]): Promise<ActionResult | ActionResult[]> {
    const params = Array.isArray(data) ? data : [data];
    const rets: ActionResult[] = [];
    for (const p of params) rets.push(await this.callApi<ActionResult>("/miotspec/action", { params: p }));
    for (const r of rets) r.message = r.code === 0 || r.code === 1 ? "成功" : "失败(code=" + r.code + ")";
    if (!Array.isArray(data) && rets.length === 1) return rets[0] as ActionResult;
    return rets;
  }

  /** 场景列表。 */
  async getScenesList(homeId?: string | number): Promise<Scene[]> {
    if (homeId !== undefined) return this.getScenesOfHome(homeId);
    const homes = await this.getHomesList();
    const scenes: Scene[] = [];
    for (const home of homes) scenes.push(...(await this.getScenesOfHome(home.id)));
    return scenes;
  }

  private async getScenesOfHome(homeId: string | number): Promise<Scene[]> {
    const owner = await this.getHomeOwner(homeId);
    const ret = await this.callApi<SceneListResult>("/appgateway/miot/appsceneservice/AppSceneService/GetSimpleSceneList", {
      app_version: 12,
      get_type: 2,
      home_id: String(homeId),
      owner_uid: owner,
    });
    const scenes = ret.manual_scene_info_list ?? [];
    for (const s of scenes) s.home_id = String(homeId);
    return scenes;
  }

  /** 执行手动场景。 */
  async runScene(sceneId: string, homeId: string | number): Promise<unknown> {
    const owner = await this.getHomeOwner(homeId);
    return this.callApi("/appgateway/miot/appsceneservice/AppSceneService/NewRunScene", {
      scene_id: sceneId,
      scene_type: 2,
      phone_id: "null",
      home_id: String(homeId),
      owner_uid: owner,
    });
  }

  /** 耗材列表。 */
  async getConsumableItems(homeId?: string | number): Promise<Consumable[]> {
    if (homeId !== undefined) return this.getConsumablesOfHome(homeId);
    const homes = await this.getHomesList();
    const items: Consumable[] = [];
    for (const home of homes) items.push(...(await this.getConsumablesOfHome(home.id)));
    return items;
  }

  private async getConsumablesOfHome(homeId: string | number): Promise<Consumable[]> {
    const owner = await this.getHomeOwner(homeId);
    const ret = await this.callApi<ConsumableListResult>("/v2/home/standard_consumable_items", {
      home_id: Number(homeId),
      owner_id: owner,
      filter_ignore: true,
    });
    const items = ret.items?.[0]?.consumes_data ?? [];
    for (const item of items) {
      const details = item.details;
      if (Array.isArray(details) && details.length === 1) item.details = details[0] as never;
      item.home_id = String(homeId);
    }
    return items;
  }

  /** 设备统计数据（耗电量等）。 */
  async getStatistics(data: Record<string, unknown> | Record<string, unknown>[]): Promise<unknown> {
    const params = Array.isArray(data) ? data : [data];
    const rets: unknown[] = [];
    for (const p of params) rets.push(await this.callApi("/v2/user/statistics", p));
    if (!Array.isArray(data) && rets.length === 1) return rets[0];
    return rets;
  }
}