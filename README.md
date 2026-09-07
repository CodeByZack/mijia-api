# mijia-node

米家（Mijia）云端 API 的**纯 Node.js** 客户端：直接调用 `api.mijia.tech`，
无需 Python 环境、无需 Home Assistant 桥接。

参考实现：<https://github.com/Do1e/mijia-api>（Python）。

## 特性

- 纯 Node.js（>= 18.17），唯一运行时依赖是 `qrcode`（终端 ASCII 二维码）
- 完整的 RC4 + SHA1 签名 + gzip 加解密协议（纯 TS 实现的 ARC4，不依赖 OpenSSL legacy provider）
- 终端二维码扫码登录，凭据持久化到 `~/.config/mijia-node/auth.json`，30 天内免登录
- 家庭 / 设备 / 共享设备 / 场景 / 耗材 / 用电统计
- 设备规格（miot-spec）自动拉取并磁盘缓存，按属性名读写（`get` / `set` / `runAction`）
- 完整的 TypeScript 类型定义，ESM + CJS 双产物
- 63 个单元测试，含与 Python/PyCryptodome 对齐的加密向量校验

## 安装

```bash
npm install mijia-node
```

## 快速开始

```ts
import { MijiaAPI } from "mijia-node";

const mijia = new MijiaAPI();

// 1. 首次使用需要扫码登录（之后凭据持久化，无需重复）
await mijia.login();

// 2. 列出家庭与设备
const homes = await mijia.getHomesList();
const devices = await mijia.getDeviceInfoList(homes[0]?.id);

// 3. 拿到设备对象，按属性名读写
const [lamp] = await mijia.getDevices();
console.log(await lamp.get("on"));      // 读
await lamp.set("on", true);            // 写
await lamp.set("brightness", 80);      // 写，自动做类型/范围/步长校验
await lamp.runAction("start", [1]);    // 执行动作
```

## 登录

```ts
import { MijiaAPI } from "mijia-node";

const mijia = new MijiaAPI({
  authDataPath: "~/.config/mijia-node/auth.json", // 可省略，用默认值
  locale: "zh_CN",                                // 可省略，从环境变量推断
  logger: (level, msg) => console.log(level, msg),
});

await mijia.login({
  timeoutMs: 120_000,
  printQR: true,
  onStatus: (s) => console.log(s),
  onLoginUrl: (url) => console.log(url),
});
```

登录流程与米家 App 一致：先尝试用已有 token 刷新，失败则打印终端 ASCII 二维码并长轮询等待扫码。
凭据写入 `auth.json` 后，`expireTime` 为当前时间 + 30 天。

也可以自己只取二维码、稍后完成登录：

```ts
import { AuthStore, getLocation, requestLoginData, completeLogin, printQR } from "mijia-node";

const store = new AuthStore();
const data = await requestLoginData(store); // { loginUrl, qr, lp }
process.stdout.write(await printQR(data.loginUrl));
// 稍后（例如后台定时重试）：
await completeLogin(store, data, { timeoutMs: 120_000 });
```

## 设备控制

```ts
const devices = await mijia.getDevices();          // 带规格的完整设备对象
const dev = await mijia.getDevice(undefined, { name: "客厅台灯" });

dev.name;                 // 设备名
dev.did;                  // 设备 ID
dev.readableProperties;   // ["on", "brightness", "mode", ...]
dev.writableProperties;   // 可写属性名
Object.keys(dev.actions); // 可用动作名

await dev.get("on");
await dev.set("brightness", 60);
await dev.runAction("start", [3], { source: "app" });
```

- 属性名来自 miot-spec，同名属性自动去重（先追加 `-siid`，仍重复再追加 `-piid` / `-aiid`）
- 名称含 `-` 的属性同时可用 `_` 访问：`dimming-speed` → `dimming_speed`
- `set` 会按规格校验类型（bool/int/uint/float/string）、`range`、步长与 `value_list`
- 相邻读写默认间隔 `sleepTime`（默认 0.3s，可配），避免触发限流

### 按 siid/piid 直接读写（不走规格）

```ts
await mijia.getPropValue(did, 2, 1);
await mijia.setDevicesProp(did, 2, 2, 80);   // 返回 boolean
await mijia.runAction(did, 2, 1, [1]);

// 批量
const values = await mijia.getDevicesPropBatch([{ did, siid: 2, piid: 1 }, { did, siid: 2, piid: 2 }]);
const results = await mijia.setDevicesPropBatch([{ did, siid: 2, piid: 1, value: true }]);
```

## 场景 / 耗材 / 统计

```ts
const scenes = await mijia.getScenesList(homeId);
await mijia.runScene(scenes[0].scene_id, homeId);

const consumables = await mijia.getConsumableItems(homeId);
const stats = await mijia.getStatistics({ did, start_time, end_time });

await mijia.checkNewMsg();          // 也可用于校验 token 是否有效
await mijia.getSharedDevicesList(); // 别人共享给我的设备
```

## 底层 API 客户端

需要调用任意端点时可以直接用 `MijiaApiClient`（加解密、签名、错误处理都已内置）：

```ts
import { AuthStore, MijiaApiClient } from "mijia-node";

const store = new AuthStore();
const client = new MijiaApiClient(store, { timeoutMs: 30_000 });

await client.ensureToken();                        // token 无效会自动刷新
const data = await client.callApi("/miotspec/prop/get", { params: [{ did, siid: 2, piid: 1 }], datasource: 1 });
```

加解密原语也全部导出，可用于互操作验证：

```ts
import {
  RC4, RC4_WARMUP_BYTES, genNonce, getSignedNonce, genEncSignature,
  generateEncParams, encryptRC4, decryptRC4, decrypt, decryptJSON,
} from "mijia-node";
```

## 与 Python 参考实现的差异

整体协议、端点、UA 格式与参考实现保持一致，以下几处是本库的有意调整：

| 项 | 说明 |
| --- | --- |
| `available` | 改为同步的**缓存** getter；真正联网校验请用 `isAvailable()`（60s 缓存） |
| `homes` / `devices` | 改为 async 方法 `getHomesList()` / `getDeviceInfoList()` / `getDevices()`（需要联网） |
| `getDevicesProp` | 返回完整 `PropResult`；只要值请用 `getPropValue()` |
| `setDevicesProp` | 返回 `boolean`（`code` 为 0/1 视为成功），失败抛 `APIError` |
| `runAction` | 返回 `ActionResult`，失败抛 `DeviceActionError` |
| RC4 | 纯 TS 实现（Node 24 + OpenSSL 3 禁用了 RC4），已与 PyCryptodome 逐字节对齐 |
| 端点 | 使用真实端点：`/v2/homeroom/gethome_merged`、`/home/home_device_list`（分页）、`/v2/home/device_list_page`、`/appgateway/miot/appsceneservice/...`、`/miotspec/prop/get|set`、`/miotspec/action` |

## 加密协议

1. `nonce` = base64(8 字节随机 + floor(毫秒/60000) 的最小大端整数)
2. `signed_nonce` = base64(SHA256(base64decode(ssecurity) ++ base64decode(nonce)))
3. `data` = base64(RC4(signed_nonce, JSON(data)))，`rc4_hash__` 同理
4. `signature` = base64(SHA1("POST&uri&data=...&rc4_hash__=..."))
5. 表单键序固定为 `data, rc4_hash__, signature, ssecurity, _nonce`
6. RC4 使用前先做 1024 字节热身（warmup），丢弃前 1024 个输出字节
7. 响应可能是明文 JSON 或 RC4(gzip(JSON))，按 gzip 魔数自动判别

请求头固定为 `miot-encrypt-algorithm: ENCRYPT-RC4`、`miot-accept-encoding: GZIP`、
`x-xiaomi-protocal-flag-cli: PROTOCAL-HTTP2`、`accept-encoding: identity`，
Cookie 中携带 `serviceToken`、`timezone`、`is_daylight`、`countryCode` 等字段。

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node:test，63 个用例
npm run build       # tsup：ESM + CJS + .d.ts
```

示例（需先登录）：

```bash
npx tsx examples/login.ts     # 扫码登录
npm run example               # 列出家庭与设备
npx tsx examples/control.ts   # 属性读写与动作
npx tsx examples/scenes.ts    # 场景
```

## 许可

MIT
