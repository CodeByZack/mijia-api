/**
 * 示例：米家扫码登录。
 *
 * 运行： npx tsx examples/login.ts
 *
 * 首次运行会打印终端 ASCII 二维码，用米家 APP 扫码后凭据写入
 * ~/.config/mijia-node/auth.json；之后所有示例都不需要重复扫码（token 有效期 30 天）。
 */
import { MijiaAPI } from "mijia-node";

const mijia = new MijiaAPI({
  locale: "zh_CN",
  logger: (level, message) => console.log("[log]", level, message),
});

try {
  await mijia.login({
    timeoutMs: 120_000,
    onStatus: (status) => console.log("[status]", status),
    onLoginUrl: (url) => console.log("[loginUrl]", url),
  });
  console.log("登录成功，凭据已持久化。");
} catch (err) {
  console.error("登录失败：", err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
