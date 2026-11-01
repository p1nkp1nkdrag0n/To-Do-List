/**
 * 把「所有项目的排期」清空，只留成员与可用时间。
 *
 *   npm run demo:reset
 *
 * 为什么需要：演示前必须保证“登录进去一片空白”，
 * 不然上一个测试项目（比如飞天探微）里的任务会留在甘特图上，
 * 看起来像“什么都没做却已经有排期”。
 */
import { loadEnvFile } from "../server/config/dotenv.js";
import { parseConfig } from "../server/config/env.js";
import { openV2Database } from "../server/db/database.js";
import { migrateV2Database } from "../server/db/migrations.js";
import { resolveDependencies } from "../server/http/dependencies.js";
import { clearProjectSchedule } from "../server/meeting/demo-reset.js";

loadEnvFile();
const config = parseConfig();
const database = openV2Database(config.dbPath);
migrateV2Database(database);
const dependencies = resolveDependencies({
  database,
  sessionSecret: "reset-schedules-secret-not-for-production",
  cookieSecure: false,
  bootstrapCode: "reset-schedules-bootstrap",
});

const projects = database.all<{ id: string; name: string }>(
  "SELECT id, name FROM projects WHERE deleted_at IS NULL ORDER BY name",
);

let total = 0;
for (const project of projects) {
  const cleared = clearProjectSchedule(dependencies, project.id);
  total += cleared.removedTasks;
  console.log(`- ${project.name}：清掉 ${cleared.removedTasks} 个任务`);
}

console.log(`\n共清空 ${total} 个任务，成员与可用时间保留。`);
database.close();
