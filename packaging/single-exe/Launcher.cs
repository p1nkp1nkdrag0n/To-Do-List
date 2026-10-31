using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;

namespace ToDoListLauncher
{
    internal static class Program
    {
        private static int Main(string[] args)
        {
            try
            {
                string exePath = Process.GetCurrentProcess().MainModule.FileName;
                string exeDir = Path.GetDirectoryName(exePath);
                string extractionRoot = ChooseTarget(exeDir);
                string target = "";
                string marker = "";

                // 临时文件不能放 %TEMP%：有些机器连用户目录都写不了。
                // 放到「程序目录的同级」，那里刚刚验证过可写。
                string tempZip = Path.Combine(
                    extractionRoot,
                    "payload-" + Guid.NewGuid().ToString("N") + ".zip");
                using (Stream payload = Assembly.GetExecutingAssembly()
                    .GetManifestResourceStream("payload.zip"))
                {
                    if (payload == null) throw new Exception("程序包损坏：找不到内嵌资源。");
                    string fingerprint = Fingerprint(payload);
                    target = Path.Combine(extractionRoot, "versions", fingerprint);
                    marker = Path.Combine(target, ".extracted");
                    string installed = File.Exists(marker) ? File.ReadAllText(marker).Trim() : "";

                    if (installed != fingerprint)
                    {
                        Console.WriteLine(installed.Length == 0
                            ? "首次运行：正在解压程序文件（约 1 分钟，只需一次）…"
                            : "检测到新版本：正在更新程序文件（数据不受影响）…");
                        payload.Position = 0;
                        using (FileStream zipFile = File.Create(tempZip))
                        {
                            payload.CopyTo(zipFile);
                        }
                        // Never delete an earlier installation: older launchers could store
                        // user data inside it. Extract into a fresh staging directory instead.
                        string staging = target + ".staging-" + Guid.NewGuid().ToString("N");
                        Directory.CreateDirectory(staging);
                        int count = Extract(tempZip, staging);
                        string missing = MissingSentinel(staging);
                        if (missing.Length != 0)
                            throw new Exception("解压不完整（缺少 " + missing + "）。原版本和数据未被修改。");
                        File.WriteAllText(Path.Combine(staging, ".extracted"), fingerprint);
                        if (Directory.Exists(target))
                            throw new Exception("目标版本目录已存在但校验标记不符；为保护数据，未覆盖：" + target);
                        Directory.Move(staging, target);
                        Console.WriteLine("准备完成（解压 " + count + " 个文件）。");
                        File.Delete(tempZip);
                    }
                }

                string node = Path.Combine(target, "node.exe");
                string launcher = Path.Combine(target, "launcher", "launch.mjs");
                if (!File.Exists(node) || !File.Exists(launcher))
                {
                    throw new Exception("解压不完整，原数据未改动；请重新下载程序并保留此目录排查：" + target);
                }

                var start = new ProcessStartInfo(node, "\"" + launcher + "\"");
                start.WorkingDirectory = target;
                start.UseShellExecute = false;
                // Preserve discovery of an earlier exe-directory fallback even if
                // LOCALAPPDATA becomes writable and ChooseTarget changes today.
                start.EnvironmentVariables["TODOLIST_EXE_DIR"] = exeDir;
                string oldData = Path.Combine(extractionRoot, "ToDoList-data");
                if (Directory.Exists(oldData))
                    start.EnvironmentVariables["TODOLIST_LEGACY_ROOT"] = oldData;
                using (Process child = Process.Start(start))
                {
                    child.WaitForExit();
                    return child.ExitCode;
                }
            }
            catch (UnauthorizedAccessException)
            {
                Console.Error.WriteLine();
                Console.Error.WriteLine("启动失败：没有权限在程序所在目录写文件。");
                Console.Error.WriteLine("请把 ToDoList.exe 放到「桌面」或「文档」文件夹里再双击。");
                Console.Error.WriteLine();
                Console.Error.WriteLine("按任意键退出…");
                Console.ReadKey(true);
                return 1;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine();
                Console.Error.WriteLine("启动失败：" + error.Message);
                Console.Error.WriteLine("详情：" + error.GetType().Name);
                Console.Error.WriteLine();
                Console.Error.WriteLine("按任意键退出…");
                Console.ReadKey(true);
                return 1;
            }
        }

        /// <summary>.NET Framework 的 ZipFile 只接受路径，这里直接从流里解包。</summary>
        private static int Extract(string zipPath, string target)
        {
            int count = 0;
            using (var archive = ZipFile.OpenRead(zipPath))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string destination = Path.GetFullPath(Path.Combine(target, entry.FullName));
                    if (!destination.StartsWith(Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                    {
                        continue; // 防目录穿越
                    }
                    if (string.IsNullOrEmpty(entry.Name))
                    {
                        Directory.CreateDirectory(destination);
                        continue;
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(destination));
                    using (Stream source = entry.Open())
                    using (FileStream file = File.Create(destination))
                    {
                        source.CopyTo(file);
                    }
                    try { File.SetLastWriteTime(destination, entry.LastWriteTime.DateTime); } catch { }
                    count += 1;
                }
            }
            return count;
        }

        /// <summary>解压后必须存在的几个文件；返回缺失项，空字符串表示完整。</summary>
        private static string MissingSentinel(string target)
        {
            string[] required =
            {
                "node.exe",
                Path.Combine("launcher", "data-root.mjs"),
                Path.Combine("app", "dist-server", "server", "v2.js"),
                Path.Combine("app", "node_modules", "mammoth", "package.json"),
                Path.Combine("app", "node_modules", "express", "package.json"),
            };
            foreach (string relative in required)
            {
                if (!File.Exists(Path.Combine(target, relative))) return relative;
            }
            return "";
        }

        /// <summary>用内容哈希当版本指纹：换了新 exe 就重新解压，旧数据保留。</summary>
        private static string Fingerprint(Stream payload)
        {
            using (var sha = SHA256.Create())
            {
                return BitConverter.ToString(sha.ComputeHash(payload)).Replace("-", "");
            }
        }

        /// <summary>优先 %LOCALAPPDATA%，不可写时退到 exe 同级，再退到临时目录。</summary>
        private static string ChooseTarget(string exeDir)
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string[] candidates =
            {
                Path.Combine(local, "ToDoList", "app"),
                Path.Combine(exeDir, "ToDoList-app"),
                Path.Combine(Path.GetTempPath(), "ToDoList-app"),
            };
            foreach (string candidate in candidates)
            {
                try
                {
                    Directory.CreateDirectory(candidate);
                    string probe = Path.Combine(candidate, ".write-test");
                    File.WriteAllText(probe, "ok");
                    File.Delete(probe);
                    return candidate;
                }
                catch
                {
                    // 换下一个候选。
                }
            }
            throw new Exception("找不到可写目录：请把 exe 放到桌面或文档下再试。");
        }
    }
}
