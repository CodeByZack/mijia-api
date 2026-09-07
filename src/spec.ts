/**
 * 设备规格获取与解析（miot-spec）。
 *
 * 从 https://home.miot-spec.com/spec/{model} 的页面里取出内嵌 JSON，
 * 解析成带 siid/piid、读写权限、类型、取值范围、枚举值的属性与动作表，
 * 并做磁盘缓存，避免重复请求。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { GetDeviceInfoError } from "./errors.js";
import { fetchWithTimeout } from "./util.js";
import type {
  DeviceAction,
  DeviceProperty,
  DeviceSpec,
  MethodParam,
  PropertyType,
  ValueItem,
} from "./types.js";

/** 缓存格式版本，不匹配则重新拉取。 */
export const DEVICE_INFO_VERSION = 1;

export const SPEC_BASE_URL = "https://home.miot-spec.com/spec/";

const SPEC_USER_AGENT = "mijia-node/0.1.0";

const SPEC_SCRIPT_RE =
  /<script[^>]*data-page=["']app["'][^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/;

export interface SpecOptions {
  /** 缓存目录；不传则不缓存。 */
  cacheDir?: string;
  timeoutMs?: number;
  userAgent?: string;
}

interface SpecService {
  iid: number;
  properties?: SpecProperty[];
  actions?: SpecAction[];
}

interface SpecProperty {
  iid: number;
  type: string;
  format: string;
  description: string;
  access: string[];
  valueRange?: number[];
  valueList?: Array<{ iid?: number; type?: string; value: string | number; description: string; i18nKey?: string }>;
  unit?: string;
}

interface SpecAction {
  iid: number;
  type: string;
  description: string;
  in?: MethodParam[];
  out?: MethodParam[];
}

interface SpecTree {
  services: SpecService[];
}

interface SpecContent {
  props: {
    product: { name: string; model: string };
    tree: SpecTree;
    i18n?: Record<string, Record<string, string>>;
  };
}

/**
 * 获取设备规格信息，支持磁盘缓存。
 */
export async function getDeviceInfo(
  model: string,
  options: SpecOptions = {},
): Promise<DeviceSpec> {
  const cacheFile = options.cacheDir ? join(options.cacheDir, model + ".json") : undefined;
  if (cacheFile && existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as DeviceSpec;
      if (cached.version === DEVICE_INFO_VERSION) return cached;
    } catch {
      /* 缓存损坏则重新拉取 */
    }
  }

  const spec = await fetchSpec(model, options);

  if (cacheFile) {
    mkdirSync(join(cacheFile, ".."), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(spec, undefined, 2), "utf8");
  }
  return spec;
}

/** 从网络拉取并解析设备规格（不使用缓存）。 */
export async function fetchSpec(model: string, options: SpecOptions = {}): Promise<DeviceSpec> {
  const url = SPEC_BASE_URL + model;
  let resp: Response;
  try {
    resp = await fetchWithTimeout(url, { headers: { "User-Agent": options.userAgent ?? SPEC_USER_AGENT } }, options.timeoutMs ?? 20000);
  } catch (err) {
    throw new GetDeviceInfoError(model);
  }
  if (resp.status !== 200) throw new GetDeviceInfoError(model);

  const html = await resp.text();
  return parseSpecHtml(html, model);
}

/** 从 miot-spec 页面 HTML 中解析规格。 */
export function parseSpecHtml(html: string, model: string): DeviceSpec {
  const m = SPEC_SCRIPT_RE.exec(html);
  if (!m) throw new GetDeviceInfoError(model);
  let content: SpecContent;
  try {
    content = JSON.parse(m[1] as string) as SpecContent;
  } catch {
    throw new GetDeviceInfoError(model);
  }
  assertSpecContent(content, model);
  return buildSpec(content, model);
}

/** 校验 miot-spec 内容具备必需结构，否则统一抛 GetDeviceInfoError。 */
function assertSpecContent(content: unknown, model: string): void {
  const c = content as { props?: { product?: unknown; tree?: unknown } } | null | undefined;
  if (!c || typeof c !== "object") throw new GetDeviceInfoError(model);
  if (!c.props || typeof c.props !== "object") throw new GetDeviceInfoError(model);
  if (!c.props.product || typeof c.props.product !== "object") throw new GetDeviceInfoError(model);
  if (!c.props.tree || typeof c.props.tree !== "object") throw new GetDeviceInfoError(model);
}

/** 把 miot-spec 的 tree 结构归一化为 DeviceSpec。 */
export function buildSpec(content: SpecContent, model: string): DeviceSpec {
  assertSpecContent(content, model);
  const product = content.props.product;
  const i18nZh = content.props.i18n?.zh_cn ?? {};
  const services = content.props.tree.services ?? [];

  const spec: DeviceSpec = {
    version: DEVICE_INFO_VERSION,
    name: product.name,
    model: product.model,
    properties: [],
    actions: [],
  };

  for (const svc of services) {
    const siid = svc.iid;
    for (const prop of svc.properties ?? []) {
      const piid = prop.iid;
      const type = normalizeType(prop.format);
      const rw = prop.access.includes("read") && prop.access.includes("write")
        ? "rw"
        : prop.access.includes("read")
          ? "r"
          : prop.access.includes("write")
            ? "w"
            : "";
      const zhCn = i18nZh["service:" + pad3(siid) + ":property:" + pad3(piid)] ?? "";

      const item: DeviceProperty = {
        siid,
        piid,
        name: prop.type,
        desc: joinDescription(prop.description, zhCn),
        type,
        rw,
        range: prop.valueRange,
      };

      if (prop.valueList && prop.valueList.length > 0) {
        item.value_list = prop.valueList.map((vl) => {
          const entry: ValueItem = {
            value: vl.value,
            desc: vl.description,
          };
          if (vl.i18nKey) {
            const vZh = i18nZh[vl.i18nKey];
            if (vZh) entry.desc_zh_cn = vZh;
          }
          return entry;
        });
      }
      spec.properties.push(item);
    }

    for (const act of svc.actions ?? []) {
      const aiid = act.iid;
      const zhCn = i18nZh["service:" + pad3(siid) + ":action:" + pad3(aiid)] ?? "";
      const action: DeviceAction = {
        siid,
        aiid,
        name: act.type,
        desc: joinDescription(act.description, zhCn),
        in: act.in,
        out: act.out,
      };
      spec.actions.push(action);
    }
  }

  dedupeNames(spec.properties, "piid");
  dedupeNames(spec.actions, "aiid");
  return spec;
}

/** 重复属性名先追加 -siid，仍重复再追加 -piid/-aiid。 */
function dedupeNames<T extends { name: string; siid: number; piid?: number; aiid?: number }>(
  items: T[],
  iidKey: "piid" | "aiid",
): void {
  // 第一轮：追加 siid
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.name] = (counts[item.name] ?? 0) + 1;
  for (const item of items) {
    if ((counts[item.name] ?? 0) > 1) item.name = item.name + "-" + item.siid;
  }
  // 第二轮：仍重复则追加 piid / aiid
  const counts2: Record<string, number> = {};
  for (const item of items) counts2[item.name] = (counts2[item.name] ?? 0) + 1;
  for (const item of items) {
    if ((counts2[item.name] ?? 0) > 1) item.name = item.name + "-" + Number(item[iidKey] ?? 0);
  }
}

/** miot-spec 的 format 归一化为库内使用的类型。 */
function normalizeType(format: string): PropertyType {
  if (format.startsWith("int")) return "int";
  if (format.startsWith("uint")) return "uint";
  switch (format) {
    case "bool":
    case "string":
    case "float":
      return format;
    default:
      return "string";
  }
}

function joinDescription(description: string, zhCn: string): string {
  return (description + " / " + zhCn).replace(/[ /]+$/, "");
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}