/**
 * 示例：列出家庭与设备（npm run example 默认运行此文件）。
 *
 * 运行： npm run example
 *
 * 需要先跑过 examples/login.ts 完成扫码登录。
 */
import { MijiaAPI } from "mijia-node";

const mijia = new MijiaAPI({
  logger: (level, msg) => console.log("[log] " + level + " " + msg),
});

if (!(await mijia.isAvailable())) {
  console.error("凭据无效或已过期，请先运行： npx tsx examples/login.ts");
  process.exit(1);
}

const homes = await mijia.getHomesList();
console.log("家庭数量：", homes.length);
for (const h of homes) {
  console.log("- [" + h.id + "] " + h.name);
}

const homeId = homes[0]?.id;
const devices = await mijia.getDeviceInfoList(homeId);
console.log("");
console.log("设备数量：" + devices.length);
for (const d of devices) {
  console.log("- " + d.name + " (" + d.model + ") did=" + d.did);
}

const shared = await mijia.getSharedDevicesList();
console.log("共享给我的设备：" + shared.length + " 台");
for (const d of shared.slice(0, 10)) console.log("- " + d.name + " (" + d.model + ")");
