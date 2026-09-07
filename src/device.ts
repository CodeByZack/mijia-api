/**
 * 设备对象封装：按属性名/动作名读写。
 */
import {
  DeviceActionError,
  DeviceGetError,
  DeviceNotFoundError,
  DeviceSetError,
  MijiaError,
  MultipleDevicesFoundError,
} from "./errors.js";
import { sleep } from "./util.js";
import type {
  ActionItem,
  ActionResult,
  DeviceInfo,
  DeviceProperty,
  DeviceSpec,
  PropResult,
  ActionMap,
  PropertyMap,
  SiidPiidMap,
} from "./types.js";

/** 设备读写默认间隔（秒）。 */
export const DEFAULT_SLEEP_TIME = 0.3;

export interface DeviceLookupOptions {
  /** 按 did 查找。 */
  did?: string;
  /** 按设备名查找。 */
  name?: string;
  /** 读写间隔秒数，覆盖主类默认值。 */
  sleepTime?: number;
}

/** 提供属性读写能力的客户端接口。 */
export interface DeviceApiClient {
  getDevicesProp(d: { did: string; siid: number; piid: number }): Promise<PropResult | PropResult[]>;
  setDevicesProp(d: { did: string; siid: number; piid: number; value: string | number | boolean }): Promise<PropResult | PropResult[]>;
  runAction(d: ActionItem): Promise<ActionResult | ActionResult[]>;
}

/** 设备对象。 */
export class MijiaDevice {
  readonly did: string;
  readonly model: string;
  readonly name: string;
  readonly spec: DeviceSpec;

  /** 按属性名索引（同时注册 name 与 name.replace(-, _) 两个别名）。 */
  readonly properties: PropertyMap = {};

  /** 按 siid -> piid 索引。 */
  readonly props: SiidPiidMap = {};

  /** 按动作名索引。 */
  readonly actions: ActionMap = {};

  private readonly client: DeviceApiClient;
  private readonly sleepTime: number;

  constructor(client: DeviceApiClient, info: DeviceInfo, spec: DeviceSpec, sleepTime: number) {
    this.client = client;
    this.did = info.did;
    this.model = info.model ?? spec.model;
    this.name = info.name ?? spec.name;
    this.spec = spec;
    this.sleepTime = sleepTime;

    for (const prop of spec.properties) {
      this.properties[prop.name] = prop;
      if (prop.name.includes("-")) this.properties[prop.name.replace("-", "_")] = prop;
      (this.props[prop.siid] ?? (this.props[prop.siid] = {}))[prop.piid] = prop;
    }
    for (const act of spec.actions) this.actions[act.name] = act;
  }

  /** 列出可读属性名。 */
  get readableProperties(): string[] {
    return Object.keys(this.properties).filter((k) => this.properties[k].rw.includes("r"));
  }

  /** 列出可写属性名。 */
  get writableProperties(): string[] {
    return Object.keys(this.properties).filter((k) => this.properties[k].rw.includes("w"));
  }

  /** 按属性名读取。 */
  async get(name: string): Promise<unknown> {
    const prop = this.properties[name];
    if (!prop) throw new MijiaError("不支持的属性: " + name + ", 可用属性: " + Object.keys(this.properties).join(", "));
    if (!prop.rw.includes("r")) throw new MijiaError("属性 " + name + " 不可读取");

    const result = await this.client.getDevicesProp({ did: this.did, siid: prop.siid, piid: prop.piid });
    const one = Array.isArray(result) ? result[0] : result;
    if (!one || (one.code ?? 0) !== 0) throw new DeviceGetError(this.name, name, one ? one.code : -1);
    await sleep(this.sleepTime);
    return one.value;
  }

  /** 按属性名写入。 */
  async set(name: string, value: unknown): Promise<PropResult> {
    const prop = this.properties[name];
    if (!prop) throw new MijiaError("不支持的属性: " + name + ", 可用属性: " + Object.keys(this.properties).join(", "));
    if (!prop.rw.includes("w")) throw new MijiaError("属性 " + name + " 不可写入");

    const coerced = validateValue(prop, value);
    const result = await this.client.setDevicesProp({ did: this.did, siid: prop.siid, piid: prop.piid, value: coerced });
    const one = Array.isArray(result) ? result[0] : result;
    if (!one || (one.code ?? 0) !== 0) throw new DeviceSetError(this.name, name, one ? one.code : -1);
    await sleep(this.sleepTime);
    return one;
  }

  /**
   * 按动作名执行。
   *
   * @param value 位置参数数组（对应动作定义的 in 参数）
   * @param extra 额外字段
   */
  async runAction(name: string, value?: unknown[], extra?: Record<string, unknown>): Promise<ActionResult> {
    const act = this.actions[name];
    if (!act) throw new MijiaError("不支持的动作: " + name + ", 可用动作: " + Object.keys(this.actions).join(", "));

    const item: ActionItem = { did: this.did, siid: act.siid, aiid: act.aiid };
    if (value !== undefined) item.value = value;
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        if (k === "did" || k === "siid" || k === "aiid") {
          throw new MijiaError("无效的参数: " + k + ". 请勿使用以下参数 (did, siid, aiid)");
        }
        item[k] = v;
      }
    }

    const result = await this.client.runAction(item);
    const one = Array.isArray(result) ? result[0] : result;
    if (!one || (one.code ?? 0) !== 0) throw new DeviceActionError(this.name, name, one ? one.code : -1);
    await sleep(this.sleepTime);
    return one;
  }

  toString(): string {
    const props = Object.entries(this.properties)
      .filter(([k]) => !k.includes("_"))
      .map(([k, p]) => "  " + k + ": " + p.desc + " (" + p.type + ", " + p.rw + ")")
      .join("\n");
    const acts = Object.values(this.actions)
      .map((a) => "  " + a.name + ": " + a.desc)
      .join("\n");
    return (
      this.name + " (" + this.model + ")\n" +
      "Properties:\n" + (props || "No properties available") + "\n" +
      "Actions:\n" + (acts || "No actions available")
    );
  }
}

/**
 * 从云端设备列表定位设备并解析规格。
 */
export async function resolveDevice(
  devices: DeviceInfo[],
  lookup: { did?: string; name?: string },
  specFetcher: (model: string) => Promise<DeviceSpec>,
): Promise<{ info: DeviceInfo; spec: DeviceSpec }> {
  if (!lookup.did && !lookup.name) throw new MijiaError("必须提供 did 或 name 参数之一");

  const matches = lookup.did
    ? devices.filter((d) => d.did === lookup.did)
    : devices.filter((d) => d.name === lookup.name);

  if (matches.length === 0) throw new DeviceNotFoundError(String(lookup.did ?? lookup.name));
  if (matches.length > 1) {
    throw new MultipleDevicesFoundError("找到多个匹配的设备，请使用 did 精确指定");
  }

  const info = matches[0] as DeviceInfo;
  const model = info.model ?? "";
  if (!model) throw new MijiaError("设备 " + info.did + " 缺少 model 字段，无法获取规格");

  const spec = await specFetcher(model);
  return { info, spec };
}

// ---------------------------------------------------------------------------
// 取值校验
// ---------------------------------------------------------------------------

/** 按规格校验并规整设置值。 */
export function validateValue(prop: DeviceProperty, value: unknown): string | number | boolean {
  let out: string | number | boolean;

  switch (prop.type) {
    case "bool": {
      if (typeof value === "boolean") out = value;
      else if (typeof value === "number") {
        if (value === 0) out = false;
        else if (value === 1) out = true;
        else throw new MijiaError("无效布尔值: " + value);
      } else if (typeof value === "string") {
        const lower = value.toLowerCase();
        if (lower === "true") out = true;
        else if (lower === "false") out = false;
        else if (value === "0") out = false;
        else if (value === "1") out = true;
        else throw new MijiaError("无效布尔值: " + value);
      } else {
        throw new MijiaError("无效布尔值: " + String(value));
      }
      break;
    }
    case "int":
    case "uint": {
      out = Math.trunc(Number(value));
      if (Number.isNaN(out)) throw new MijiaError("无效数值: " + String(value));
      break;
    }
    case "float": {
      out = Number(value);
      if (Number.isNaN(out)) throw new MijiaError("无效数值: " + String(value));
      break;
    }
    case "string": {
      if (typeof value !== "string") throw new MijiaError("无效字符串值: " + String(value));
      out = value;
      break;
    }
    default:
      throw new MijiaError("不支持的类型: " + prop.type + ", 可选类型: bool, int, uint, float, string");
  }

  checkRange(prop, out);
  checkValueList(prop, out);
  return out;
}

function checkRange(prop: DeviceProperty, value: string | number | boolean): void {
  const range = prop.range;
  if (!range || typeof value !== "number") return;

  const min = range[0] ?? 0;
  const max = range[1] ?? Number.MAX_SAFE_INTEGER;
  if (value < min || value > max) {
    throw new MijiaError(value + " 超出数值范围, 应该在 " + min + " 到 " + max + " 之间");
  }

  const step = range[2];
  if (step === undefined || step === 1) return;

  if (prop.type === "int" || prop.type === "uint") {
    if (Math.trunc((value - min) / step) * step !== value - min) {
      throw new MijiaError("无效的值: " + value + ", 应该在范围 " + min + "-" + max + " 内且步长为 " + step);
    }
  } else if (Number.isInteger(step)) {
    if (Math.trunc(Math.trunc(value - min) / step) * step !== Math.trunc(value - min)) {
      throw new MijiaError("无效的值: " + value + ", 应该在范围 " + min + "-" + max + " 内且步长为 " + step);
    }
  }
}

function checkValueList(prop: DeviceProperty, value: string | number | boolean): void {
  const list = prop.value_list;
  if (!list || list.length === 0) return;
  const values: Array<string | number | boolean> = list.map((i) => i.value);
  if (!values.includes(value)) {
    throw new MijiaError("无效值: " + String(value) + ", 请使用 " + JSON.stringify(values));
  }
}