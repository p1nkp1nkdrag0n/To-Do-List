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
                string target = ChooseTarget(exeDir);
                string marker = Path.Combine(target, ".extracted");

                // 临时文件不能放 %TEMP%：有些机器连用户目录都写不了。
                // 放到「程序目录的同级」，那里刚刚验证过可写。
                string tempZip = Path.Combine(
                    Path.GetDirectoryName(target.TrimEnd(Path.DirectorySeparatorChar)),
                    "todolist-payload.zip");
                using (Stream payload = Assembly.GetExecutingAssembly()
                    .GetManifestResourceStream("payload.zip"))
                {
                    if (payload == null) throw new Exception("程序包损坏：找不到内嵌资源。");
                    string fingerprint = Fingerprint(payload);
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
                        for (int attempt = 1; attempt <= 2; attempt += 1)
                        {
                            if (Directory.Exists(target)) Directory.Delete(target, true);
                            Directory.CreateDirectory(target);
                            int count = Extract(tempZip, target);
                            string missing = MissingSentinel(target);
                            if (missing.Length == 0)
                            {
                                File.WriteAllText(marker, fingerprint);
                                Console.WriteLine("准备完成（解压 " + count + " 个文件）。");
                                break;
                            }
                            Console.WriteLine("解压不完整（缺少 " + missing + "），重试第 " + attempt + " 次…");
                            if (attempt == 2)
                            {
                                throw new Exception("解压后仍缺少 " + missing + "，可能是磁盘空间不足或杀毒软件拦截。");
                            }
                        }
                        File.Delete(tempZip);
                    }
                }

                string node = Path.Combine(target, "node.exe");
                string launcher = Path.Combine(target, "launcher", "launch.mjs");
                if (!File.Exists(node) || !File.Exists(launcher))
                {
                    throw new Exception("解压不完整，请删除目录后重试：" + target);
                }

                var start = new ProcessStartInfo(node, "\"" + launcher + "\"");
                start.WorkingDirectory = target;
                start.UseShellExecute = false;
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
                    if (!destination.StartsWith(Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase))
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
