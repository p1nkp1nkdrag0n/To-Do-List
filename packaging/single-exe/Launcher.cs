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
                        if (Directory.Exists(target)) Directory.Delete(target, true);
                        Directory.CreateDirectory(target);
                        Extract(payload, target);
                        File.WriteAllText(marker, fingerprint);
                        Console.WriteLine("准备完成。");
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
        private static void Extract(Stream payload, string target)
        {
            using (var archive = new ZipArchive(payload, ZipArchiveMode.Read))
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
                }
            }
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
