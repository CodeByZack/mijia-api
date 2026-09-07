/**
 * 示例：设备属性读写与动作执行。
 *
 * 运行： npx tsx examples/control.ts [设备名片段]
 *
 * 属性名来自设备规格（miot-spec），例如灯泡常见 on / brightness / mode；
 * 名称中含 '-' 的属性同时可以用 '_' 访问（dimming-speed → dimming_speed）。
 */
import { MijiaAPI } from "mijia-node";

const query = process.argv[2] ?? "";
const mijia = new MijiaAPI({});

const devices = await mijia.getDevices();
console.log("共发现 " + devices.length + " 台设备：");
for (const d of devices) console.log("- " + d.name + " (" + d.model + ")");

const target = devices.find((d) => d.name.includes(query)) ?? devices[0];
if (!target) {
  console.error("没有可用设备，请先登录： npx tsx examples/login.ts");
  process.exit(1);
}

console.log("");
console.log("选中设备：" + target);
console.log("可读属性：", target.readableProperties.join(", "));
console.log("可写属性：", target.writableProperties.join(", "));
console.log("可用动作：", Object.keys(target.actions).join(", "));

if (target.readableProperties.includes("on")) {
  const before = await target.get("on");
  console.log("当前开关状态：" + before);
  await target.set("on", !before);
  console.log("已切换到：" + !before);
}

if (target.writableProperties.includes("brightness")) {
  await target.set("brightness", 80);
  console.log("亮度已设为 80");
}

const firstAction = Object.keys(target.actions)[0];
if (firstAction) {
  try {
    console.log("执行动作 " + firstAction + " ...");
    console.log(await target.runAction(firstAction, [1]));
  } catch (err) {
    console.error("动作执行失败：", err instanceof Error ? err.message : err);
  }
}
