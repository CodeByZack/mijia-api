import { test } from "node:test";
import assert from "node:assert/strict";

import { MijiaDevice, resolveDevice, validateValue } from "../src/device.js";
import { DeviceActionError, DeviceGetError, DeviceSetError, MultipleDevicesFoundError } from "../src/errors.js";
import type { DeviceApiClient } from "../src/device.js";
import type { DeviceInfo, DeviceProperty, DeviceSpec } from "../src/types.js";

function specOf(): DeviceSpec {
  return {
    version: 1,
    name: "米家台灯",
    model: "yeelink.light.lamp4",
    properties: [
      { siid: 2, piid: 1, name: "on", desc: "开关", type: "bool", rw: "rw" },
      { siid: 2, piid: 2, name: "brightness", desc: "亮度", type: "int", rw: "rw", range: [1, 100] },
      { siid: 2, piid: 3, name: "dimming-speed", desc: "变光速度", type: "uint", rw: "w", range: [1, 255] },
      { siid: 2, piid: 4, name: "mode", desc: "模式", type: "string", rw: "rw", value_list: [{ value: "normal", desc: "普通" }, { value: "reading", desc: "阅读" }] },
      { siid: 2, piid: 5, name: "temperature", desc: "温度", type: "float", rw: "r", range: [-40, 80] },
    ],
    actions: [{ siid: 2, aiid: 1, name: "start", desc: "开始" }],
  };
}

function emptyClient(): DeviceApiClient {
  return { getDevicesProp: async () => [], setDevicesProp: async () => [], runAction: async () => [] };
}

function deviceOf(client: DeviceApiClient, spec = specOf()): MijiaDevice {
  return new MijiaDevice(client, { did: "did-123", name: "客厅台灯", model: "yeelink.light.lamp4" }, spec, 0);
}

test("validateValue 布尔值各种写法归一化", () => {
  const prop: DeviceProperty = { siid: 2, piid: 1, name: "on", desc: "开关", type: "bool", rw: "rw" };
  assert.equal(validateValue(prop, true), true);
  assert.equal(validateValue(prop, false), false);
  assert.equal(validateValue(prop, 1), true);
  assert.equal(validateValue(prop, 0), false);
  assert.equal(validateValue(prop, "true"), true);
  assert.equal(validateValue(prop, "FALSE"), false);
  assert.equal(validateValue(prop, "1"), true);
  assert.equal(validateValue(prop, "0"), false);
  for (const bad of ["yes", "abc", 2, 0.5, null, {}]) {
    assert.throws(() => validateValue(prop, bad), /无效布尔值/);
  }
});

test("validateValue 整型截断与范围校验", () => {
  const prop: DeviceProperty = { siid: 2, piid: 2, name: "brightness", desc: "亮度", type: "int", rw: "rw", range: [1, 100] };
  assert.equal(validateValue(prop, 50), 50);
  assert.equal(validateValue(prop, 50.9), 50);
  assert.equal(validateValue(prop, "50"), 50);
  assert.throws(() => validateValue(prop, 0), /超出数值范围/);
  assert.throws(() => validateValue(prop, 101), /超出数值范围/);
  assert.throws(() => validateValue(prop, "abc"), /无效数值/);
});

test("validateValue 步长校验", () => {
  const prop: DeviceProperty = { siid: 2, piid: 2, name: "b", desc: "b", type: "uint", rw: "rw", range: [0, 100, 5] };
  assert.equal(validateValue(prop, 0), 0);
  assert.equal(validateValue(prop, 10), 10);
  assert.throws(() => validateValue(prop, 7), /步长/);
});

test("validateValue 字符串枚举值校验", () => {
  const prop: DeviceProperty = {
    siid: 2, piid: 4, name: "mode", desc: "模式", type: "string", rw: "rw",
    value_list: [{ value: "normal", desc: "普通" }, { value: "reading", desc: "阅读" }],
  };
  assert.equal(validateValue(prop, "normal"), "normal");
  assert.throws(() => validateValue(prop, "party"), /无效值/);
  assert.throws(() => validateValue(prop, 5), /无效字符串值/);
});

test("validateValue 不支持的类型抛错", () => {
  const prop: DeviceProperty = { siid: 2, piid: 1, name: "x", desc: "x", type: "struct" as never, rw: "rw" };
  assert.throws(() => validateValue(prop, {}), /不支持的类型/);
});

test("MijiaDevice 索引：名称别名与 siid->piid 映射", () => {
  const dev = deviceOf(emptyClient());
  assert.equal(dev.did, "did-123");
  assert.equal(dev.name, "客厅台灯");
  assert.ok(dev.properties["dimming-speed"]);
  assert.ok(dev.properties["dimming_speed"]);
  assert.equal(dev.properties["dimming_speed"].piid, 3);
  assert.equal(dev.props[2][3].name, "dimming-speed");
  assert.ok(dev.actions["start"]);
  assert.deepEqual([...dev.readableProperties].sort(), ["brightness", "mode", "on", "temperature"]);
  assert.ok(dev.writableProperties.includes("dimming-speed"));
  assert.ok(!dev.readableProperties.includes("dimming-speed"));
});

test("MijiaDevice.get 返回值并透传错误码", async () => {
  const calls: unknown[] = [];
  const dev = deviceOf({
    getDevicesProp: async (d) => {
      calls.push(d);
      return { code: 0, value: true, updateTime: 1 };
    },
    setDevicesProp: async () => [],
    runAction: async () => [],
  });
  assert.equal(await dev.get("on"), true);
  assert.deepEqual(calls, [{ did: "did-123", siid: 2, piid: 1 }]);

  const failing = deviceOf({
    getDevicesProp: async () => ({ code: -704030013 } as never),
    setDevicesProp: async () => [],
    runAction: async () => [],
  });
  await assert.rejects(() => failing.get("on"), (err: unknown) => err instanceof DeviceGetError && err.code === -704030013);
  await assert.rejects(() => dev.get("nope"), /不支持的属性/);
});

test("MijiaDevice.set 校验后写入并透传错误", async () => {
  const calls: unknown[] = [];
  const dev = deviceOf({
    getDevicesProp: async () => [],
    setDevicesProp: async (d) => {
      calls.push(d);
      return { code: 0, message: "成功" };
    },
    runAction: async () => [],
  });
  await dev.set("brightness", "75");
  assert.deepEqual(calls, [{ did: "did-123", siid: 2, piid: 2, value: 75 }]);
  await assert.rejects(() => dev.set("brightness", 500), /超出数值范围/);
  await assert.rejects(() => dev.set("mode", "party"), /无效值/);

  const failing = deviceOf({
    getDevicesProp: async () => [],
    setDevicesProp: async () => ({ code: -704030023 } as never),
    runAction: async () => [],
  });
  await assert.rejects(() => failing.set("brightness", 50), (err: unknown) => err instanceof DeviceSetError);
});

test("MijiaDevice.runAction 组装参数并拒绝保留字段", async () => {
  const calls: unknown[] = [];
  const dev = deviceOf({
    getDevicesProp: async () => [],
    setDevicesProp: async () => [],
    runAction: async (d) => {
      calls.push(d);
      return { code: 0 };
    },
  });
  await dev.runAction("start", [3], { source: "app" });
  assert.deepEqual(calls, [{ did: "did-123", siid: 2, aiid: 1, value: [3], source: "app" }]);
  await assert.rejects(() => dev.runAction("start", [], { did: "x" }), /无效的参数/);
  await assert.rejects(() => dev.runAction("nope"), /不支持的动作/);
});

test("runAction 云端报错时抛 DeviceActionError", async () => {
  const dev = deviceOf({
    getDevicesProp: async () => [],
    setDevicesProp: async () => [],
    runAction: async () => ({ code: -704220025 } as never),
  });
  await assert.rejects(() => dev.runAction("start"), (err: unknown) => err instanceof DeviceActionError);
});

test("只读/只写属性拒绝反向操作", async () => {
  const dev = deviceOf(emptyClient());
  await assert.rejects(() => dev.set("temperature", 25), /不可写入/);
  await assert.rejects(() => dev.get("dimming-speed"), /不可读取/);
});

test("resolveDevice 按 did/name 定位并处理异常", async () => {
  const devices: DeviceInfo[] = [
    { did: "d1", name: "A", model: "m.a" },
    { did: "d2", name: "B", model: "m.b" },
  ];
  const fetcher = async () => specOf();
  assert.equal((await resolveDevice(devices, { did: "d1" }, fetcher)).info.did, "d1");
  assert.equal((await resolveDevice(devices, { name: "B" }, fetcher)).spec.model, "yeelink.light.lamp4");
  await assert.rejects(() => resolveDevice(devices, {}, fetcher), /必须提供/);
  await assert.rejects(() => resolveDevice(devices, { did: "nope" }, fetcher), /未找到/);
  await assert.rejects(() => resolveDevice([...devices, { did: "d3", name: "B", model: "m.c" }], { name: "B" }, fetcher), MultipleDevicesFoundError);
  await assert.rejects(() => resolveDevice([{ did: "d1", name: "A" } as DeviceInfo], { did: "d1" }, fetcher), /model/);
});

test("toString 输出设备与属性摘要", () => {
  const dev = deviceOf(emptyClient());
  const text = String(dev);
  assert.match(text, /客厅台灯/);
  assert.match(text, /yeelink.light.lamp4/);
  assert.match(text, /brightness/);
  assert.match(text, /start/);
});