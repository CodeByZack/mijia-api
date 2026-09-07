/**
 * 示例：查看并执行米家场景。
 *
 * 运行： npx tsx examples/scenes.ts [场景名片段]
 */
import { MijiaAPI } from "mijia-node";

const mijia = new MijiaAPI({});
const homeId = (await mijia.getHomesList())[0]?.id;
if (!homeId) {
  console.error("没有家庭，请先登录： npx tsx examples/login.ts");
  process.exit(1);
}

const scenes = await mijia.getScenesList(homeId);
console.log("场景数量：" + scenes.length);
for (const sc of scenes) console.log("- [" + sc.scene_id + "] " + (sc.name ?? "(未命名)"));

const want = process.argv[2] ?? "";
const pick = want ? scenes.find((sc) => (sc.name ?? "").includes(want)) : undefined;
const target = pick ?? scenes[0];
if (!target) {
  console.log("当前家庭没有场景。");
} else {
  if (!pick) console.log("未指定场景名，执行第一个场景「" + (target.name ?? target.scene_id) + "」");
  console.log(await mijia.runScene(target.scene_id, homeId));
}
