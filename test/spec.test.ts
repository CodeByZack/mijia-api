import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GetDeviceInfoError } from "../src/errors.js";
import { DEVICE_INFO_VERSION, buildSpec, fetchSpec, getDeviceInfo, parseSpecHtml } from "../src/spec.js";

type SpecContent = Parameters<typeof buildSpec>[0];

function loadFixture(name: string): SpecContent {
  return JSON.parse(readFileSync(new URL("./fixtures/" + name, import.meta.url), "utf8"));
}

const fixture = loadFixture("miot-spec-fixture.json");

function htmlOf(content: unknown): string {
  return (
    "<!DOCTYPE html><html><body>" +
    '<script data-page="app" type="application/json">' +
    JSON.stringify(content) +
    "</script></body></html>"
  );
}

test("buildSpec 解析属性：名称/描述/类型/读写/范围", () => {
  const spec = buildSpec(fixture, fixture.props.product.model);
  assert.equal(spec.version, DEVICE_INFO_VERSION);
  assert.equal(spec.name, "米家台灯 1S");
  assert.equal(spec.model, "yeelink.light.lamp4");

  const on = spec.properties.find((p) => p.siid === 2 && p.piid === 1);
  assert.ok(on);
  assert.equal(on.name, "on-2");
  assert.equal(on.type, "bool");
  assert.equal(on.rw, "rw");
  assert.equal(on.desc, "On Off / 开关");

  const bright = spec.properties.find((p) => p.siid === 2 && p.piid === 2);
  assert.ok(bright);
  assert.equal(bright.name, "brightness");
  assert.equal(bright.type, "int");
  assert.deepEqual(bright.range, [1, 100, 1]);

  const speed = spec.properties.find((p) => p.siid === 2 && p.piid === 3);
  assert.ok(speed);
  assert.equal(speed.type, "uint");
  assert.equal(speed.rw, "w");
  assert.equal(speed.name, "dimming-speed");
});

test("buildSpec 解析枚举值列表并合并中文描述", () => {
  const spec = buildSpec(fixture, "model");
  const mode = spec.properties.find((p) => p.siid === 2 && p.piid === 4);
  assert.ok(mode);
  assert.equal(mode.type, "string");
  assert.ok(mode.value_list);
  assert.equal(mode.value_list.length, 2);
  assert.equal(mode.value_list[0].value, "normal");
  assert.equal(mode.value_list[0].desc, "Normal");
  assert.equal(mode.value_list[0].desc_zh_cn, "关");
  assert.equal(mode.value_list[1].desc_zh_cn, "开");
});

test("buildSpec 解析动作及其入参定义", () => {
  const spec = buildSpec(fixture, "model");
  const act = spec.actions.find((a) => a.siid === 2 && a.aiid === 1);
  assert.ok(act);
  assert.equal(act.name, "start-2");
  assert.equal(act.desc, "Start / 开灯");
  assert.ok(act.in);
  assert.equal(act.in[0].type, "brightness");
  assert.equal(act.in[0].format, "int");
});

test("跨服务重复属性名会追加 -siid", () => {
  const spec = buildSpec(fixture, "model");
  const ons = spec.properties.filter((p) => p.name.startsWith("on"));
  assert.deepEqual(ons.map((p) => p.name), ["on-2", "on-3"]);
  const acts = spec.actions.filter((a) => a.name.startsWith("start"));
  assert.deepEqual(acts.map((a) => a.name), ["start-2", "start-3"]);
});

test("同服务内重复名称会追加 -piid", () => {
  const dupFixture = loadFixture("miot-spec-dup.json");
  const spec = buildSpec(dupFixture, "m.x");
  assert.deepEqual(spec.properties.map((p) => p.name), ["on-2-1", "on-2-2"]);
});

test("parseSpecHtml 从 script 标签提取 JSON", () => {
  const spec = parseSpecHtml(htmlOf(fixture), "yeelink.light.lamp4");
  assert.equal(spec.model, "yeelink.light.lamp4");
  assert.equal(spec.properties.length, 5);
});

test("parseSpecHtml 缺少 script 标签或结构不符时抛错", () => {
  assert.throws(() => parseSpecHtml("<html><body>nothing</body></html>", "m.x"), GetDeviceInfoError);
  assert.throws(() => parseSpecHtml(htmlOf({ nope: true }), "m.x"), GetDeviceInfoError);
});

test("getDeviceInfo 写入并命中磁盘缓存", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mijia-spec-"));
  try {
    const original = globalThis.fetch;
    let calls = 0;
    try {
      globalThis.fetch = (async () => {
        calls++;
        return new Response(htmlOf(fixture), { status: 200 });
      }) as typeof fetch;
      const first = await getDeviceInfo("yeelink.light.lamp4", { cacheDir: dir });
      const second = await getDeviceInfo("yeelink.light.lamp4", { cacheDir: dir });
      assert.equal(calls, 1);
      assert.equal(second.name, first.name);
      assert.ok(existsSync(join(dir, "yeelink.light.lamp4.json")));
    } finally {
      globalThis.fetch = original;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchSpec 非 200 响应抛 GetDeviceInfoError", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    await assert.rejects(() => fetchSpec("no.such.model"), GetDeviceInfoError);
  } finally {
    globalThis.fetch = original;
  }
});