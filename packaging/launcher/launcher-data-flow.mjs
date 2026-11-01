import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pickDataRoot, findLegacyDataRoots, migrateDataRoot } from "./data-root.mjs";

export function pathState(target, io = fs) {
  try { io.lstatSync(target); return "exists"; }
  catch (error) { return error?.code === "ENOENT" ? "missing" : "unknown"; }
}

export function readPointer(pointer, io = fs) {
  // existsSync collapses access-denied into false: never use it for this decision.
  const state = pathState(pointer, io);
  if (state === "missing") return null;
  if (state === "unknown") throw new Error("无法读取数据目录指针，已停止启动：" + pointer);
  const stat = io.lstatSync(pointer);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("数据目录指针必须是普通文件：" + pointer);
  const saved = io.readFileSync(pointer, "utf8").trim();
  if (!saved || !path.isAbsolute(saved)) throw new Error("数据目录指针为空或不是绝对路径：" + pointer);
  return saved;
}

export function writePointer(pointer, value, io = fs) {
  try { io.writeFileSync(pointer, value, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error?.code === "EEXIST" && readPointer(pointer, io) === value) return;
    throw new Error("无法安全保存数据目录选择，已停止启动：" + (error?.message ?? String(error)));
  }
}

/** Double-click console flow. No database is opened before selection/migration finishes.
 * Dependencies are injectable so failures can be tested without actual user paths/UI.
 */
export async function resolveDataDirectory({
  programRoot, env = process.env, platform = process.platform, home = os.homedir(),
  io = fs, ask, isInteractive = false, log = console.log,
  pick = pickDataRoot, findLegacy = findLegacyDataRoots, migrate = migrateDataRoot,
} = {}) {
  const question = async text => {
    if (!isInteractive || !ask) throw new Error("需要明确选择数据目录/迁移；当前不可交互，已停止启动，不会创建空库。");
    return String(await ask(text)).trim();
  };
  const exeDir = env.TODOLIST_EXE_DIR;
  const defaultRoot = platform === "win32"
    ? path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ToDoList")
    : path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "ToDoList");
  const exePointer = exeDir ? path.join(exeDir, "todolist-data-root.txt") : null;
  const defaultPointer = path.join(defaultRoot, "todolist-data-root.txt");
  let pointer = exePointer;
  let savedRoot = null;
  let dataRoot, savePointer = false;
  if (env.TODOLIST_DATA_ROOT) {
    dataRoot = pick({ programRoot, env, platform, home });
  } else {
    const selections = [...new Set([exePointer, defaultPointer].filter(Boolean))]
      .map(p => ({ pointer: p, saved: readPointer(p, io) })).filter(item => item.saved !== null);
    if (new Set(selections.map(item => item.saved)).size > 1)
      throw new Error("数据目录指针冲突，已停止启动，请明确保留哪一个选择。");
    savedRoot = selections[0]?.saved ?? null;
    if (savedRoot !== null) {
      pointer = selections[0].pointer;
      dataRoot = pick({ programRoot, env: { ...env, TODOLIST_DATA_ROOT: savedRoot }, platform, home });
    }
    else {
      try { dataRoot = pick({ programRoot, env, platform, home }); }
      catch (error) {
        if (!["EPERM", "EACCES", "EROFS"].includes(error?.code)) throw error;
        if (pathState(defaultRoot, io) !== "missing") throw new Error("默认数据目录存在或权限未知，已停止启动，避免切换空库：" + defaultRoot);
        if (!exeDir) throw error;
        const fallback = path.join(exeDir, "ToDoList-data");
        const confirmed = await question("默认目录不可写。是否使用以下持久目录？\n目标：" + fallback + "\n输入 YES 确认，其他输入取消：");
        if (!/^yes$/i.test(confirmed)) throw new Error("已取消数据目录选择；未启动服务。");
        dataRoot = pick({ programRoot, env: { ...env, TODOLIST_DATA_ROOT: fallback }, platform, home });
        savePointer = true;
      }
    }
  }
  if (env.TODOLIST_MIGRATE_FROM) {
    if (env.TODOLIST_MIGRATION_OFFLINE !== "1") throw new Error("必须先关闭旧程序并确认离线迁移；未启动服务。");
    migrate(env.TODOLIST_MIGRATE_FROM, dataRoot);
  } else {
    const candidates = findLegacy({ destination: dataRoot, programRoot, env, home });
    if (candidates.length) {
      // In a single-exe install defaultRoot contains app/v/<hash>. It is not an
      // empty migration target. Keep program and migrated user data separated;
      // never loosen the migration non-overwrite/overlap checks.
      if (!env.TODOLIST_DATA_ROOT && savedRoot === null && dataRoot === defaultRoot &&
          io.readdirSync(dataRoot).length > 0) {
        dataRoot = path.join(defaultRoot, "storage");
        pointer = defaultPointer;
        savePointer = true;
      }
      const choice = await question("发现旧数据，不能直接打开空库。\n" + candidates.map((p, i) => `${i + 1}. ${p}`).join("\n") + "\n目标：" + dataRoot + "\n请输入源目录序号（0 或其他输入取消）：");
      if (!/^[1-9]\d*$/.test(choice) || Number(choice) > candidates.length) throw new Error("已取消迁移；旧数据未改动，未启动服务。");
      const source = candidates[Number(choice) - 1];
      const confirm = await question(`复制迁移（保留原件、不覆盖目标）\n源：${source}\n目标：${dataRoot}\n请先关闭所有旧版窗口。确认已关闭并同意复制请输入 MIGRATE，其他输入取消：`);
      if (confirm !== "MIGRATE") throw new Error("已取消迁移；旧数据未改动，未启动服务。");
      migrate(source, dataRoot);
      log("迁移完成，旧数据已保留：" + source);
    }
  }
  // Never persist a fallback selection when migration was cancelled or failed.
  if (savePointer) writePointer(pointer, dataRoot, io);
  return dataRoot;
}
