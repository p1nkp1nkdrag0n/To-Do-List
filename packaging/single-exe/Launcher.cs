using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

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

                using (Stream payload = Assembly.GetExecutingAssembly()
                    .GetManifestResourceStream("payload.zip"))
                {
                    if (payload == null) throw new Exception("程序包损坏：找不到内嵌资源。");
                    string fingerprint = Fingerprint(payload);
                    // Windows 默认 MAX_PATH 260：完整 64 位指纹会把 node_modules 深层路径顶爆。
                    // 目录只用前 8 位；完整 SHA256 仍写在 .extracted 里做校验。
                    target = Path.Combine(extractionRoot, "v", fingerprint.Substring(0, 8));
                    marker = Path.Combine(target, ".extracted");
                    Console.WriteLine("[stage] extractionRoot=" + extractionRoot + " len=" + extractionRoot.Length);
                    Console.WriteLine("[stage] target=" + target + " len=" + target.Length);
                    RejectReparseAncestors(extractionRoot);
                    RejectReparseAncestors(target);
                    RejectReparseAncestors(marker);
                    string installed = File.Exists(marker) ? File.ReadAllText(marker).Trim() : "";

                    if (installed != fingerprint)
                    {
                        Console.WriteLine(installed.Length == 0
                            ? "首次运行：正在解压程序文件（约 1 分钟，只需一次）…"
                            : "检测到新版本：正在更新程序文件（数据不受影响）…");
                        string staging = CreateStaging(extractionRoot);
                        var owned = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                        owned.Add(Path.GetFullPath(staging));
                        try
                        {
                            string claim = Path.Combine(staging, ".claim");
                            // Check before the first write, and never delete the claim by name.
                            RejectReparseAncestors(staging);
                            using (var file = new FileStream(claim, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                                file.WriteByte(0);
                            owned.Add(Path.GetFullPath(claim));
                            // The exclusive temp handle owns deletion, including CopyTo failure.
                            // Never reopen by pathname or delete a name that may now be foreign.
                            using (FileStream zipFile = CreatePayloadTemp(extractionRoot))
                            {
                                payload.Position = 0;
                                payload.CopyTo(zipFile);
                                zipFile.Flush();
                                zipFile.Position = 0;
                                int count = Extract(zipFile, staging, owned);
                                string missing = MissingSentinel(staging);
                                if (missing.Length != 0)
                                    throw new Exception("解压不完整（缺少 " + missing + "）。原版本和数据未被修改。");
                                string stagedMarker = Path.Combine(staging, ".extracted");
                                using (var file = new FileStream(stagedMarker, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                                using (var writer = new StreamWriter(file))
                                    writer.Write(fingerprint);
                                owned.Add(Path.GetFullPath(stagedMarker));
                                VerifyOwnedTree(staging, owned);
                                string versions = Path.GetDirectoryName(target);
                                RejectReparseAncestors(versions);
                                Directory.CreateDirectory(versions);
                                RejectReparseAncestors(versions);
                                if (Directory.Exists(target) || File.Exists(target))
                                    throw new Exception("目标版本目录已存在；为保护数据，未覆盖：" + target);
                                Directory.Move(staging, target);
                                Console.WriteLine("准备完成（解压 " + count + " 个文件）。");
                            }
                        }
                        catch
                        {
                            // Even a directory we created can acquire foreign entries later.
                            // Do not recursively clean it, follow junctions, or delete by name.
                            Console.Error.WriteLine("解压失败；保留隔离目录供检查，未删除任何原版本或外来文件：" + staging);
                            throw;
                        }
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
                // Console /target:exe; inherit stdin/stdout/stderr for the Node
                // migration prompt rather than creating redirected anonymous pipes.
                start.RedirectStandardInput = false;
                start.RedirectStandardOutput = false;
                start.RedirectStandardError = false;
                start.CreateNoWindow = false;
                // Preserve discovery of an earlier exe-directory fallback even if
                // LOCALAPPDATA becomes writable and ChooseTarget changes today.
                start.EnvironmentVariables["TODOLIST_EXE_DIR"] = exeDir;
                string oldData = Path.Combine(extractionRoot, "ToDoList-data");
                if (Directory.Exists(oldData))
                    start.EnvironmentVariables["TODOLIST_LEGACY_ROOT"] = oldData;
                using (Process child = Process.Start(start))
                {
                    child.WaitForExit();
                    if (child.ExitCode != 0) PauseOnError();
                    return child.ExitCode;
                }
            }
            catch (UnauthorizedAccessException)
            {
                Console.Error.WriteLine();
                Console.Error.WriteLine("启动失败：没有权限在程序所在目录写文件。");
                Console.Error.WriteLine("请把 ToDoList.exe 放到「桌面」或「文档」文件夹里再双击。");
                Console.Error.WriteLine();
                PauseOnError();
                return 1;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine();
                Console.Error.WriteLine("启动失败：" + error.Message);
                Console.Error.WriteLine("详情：" + error.ToString());
                Console.Error.WriteLine();
                PauseOnError();
                return 1;
            }
        }

        private static void PauseOnError()
        {
            // Double-click users need time to read the child's error. Redirected
            // automation/CI must receive the exit code without waiting for input.
            if (Console.IsInputRedirected || !Environment.UserInteractive) return;
            try
            {
                Console.Error.WriteLine("按任意键退出…");
                Console.ReadKey(true);
            }
            catch (InvalidOperationException) { }
            catch (IOException) { }
        }

        [DllImport("kernel32.dll", EntryPoint = "CreateDirectoryW", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateDirectoryW(string path, IntPtr securityAttributes);

        // CreateDirectoryW fails for an existing directory; Directory.CreateDirectory
        // does not, and cannot establish exclusive ownership of a candidate.
        private static bool CreateExclusiveDirectory(string path)
        {
            if (CreateDirectoryW(path, IntPtr.Zero)) return true;
            int error = Marshal.GetLastWin32Error();
            if (error == 183 || error == 80) return false;
            throw new Win32Exception(error);
        }

        private static void RejectReparseAncestors(string value)
        {
            string current = Path.GetFullPath(value);
            while (!String.IsNullOrEmpty(current))
            {
                try
                {
                    if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                        throw new IOException("拒绝重解析点路径：" + current);
                }
                // Missing paths are expected before exclusive creation. Unknown
                // access/IO failures are not evidence of safety and must propagate.
                catch (FileNotFoundException) { }
                catch (DirectoryNotFoundException) { }
                current = Path.GetDirectoryName(current);
            }
        }

        private static string CreateStaging(string root)
        {
            for (int attempt = 0; attempt < 8; attempt++)
            {
                RejectReparseAncestors(root);
                string candidate = Path.Combine(root, "s-" + Guid.NewGuid().ToString("N").Substring(0, 8));
                if (!CreateExclusiveDirectory(candidate)) continue;
                // Validate BEFORE writing any claim or payload into the new directory.
                RejectReparseAncestors(candidate);
                if (Directory.GetFileSystemEntries(candidate).Length != 0)
                    throw new IOException("临时目录包含外来条目，拒绝接管：" + candidate);
                return candidate;
            }
            throw new IOException("无法独占创建解压目录；未修改已有目录。");
        }

        private static FileStream CreatePayloadTemp(string root)
        {
            for (int attempt = 0; attempt < 8; attempt++)
            {
                RejectReparseAncestors(root);
                string candidate = Path.Combine(root, "p-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".zip");
                try
                {
                    return new FileStream(candidate, FileMode.CreateNew, FileAccess.ReadWrite,
                        FileShare.None, 4096, FileOptions.DeleteOnClose);
                }
                catch (IOException)
                {
                    if (!File.Exists(candidate) && !Directory.Exists(candidate)) throw;
                }
            }
            throw new IOException("无法独占创建临时压缩包；未覆盖已有文件。");
        }

        private static void EnsureOwnedDirectory(string directory, string root, HashSet<string> owned)
        {
            directory = Path.GetFullPath(directory);
            if (owned.Contains(directory))
            {
                RejectReparseAncestors(directory);
                return;
            }
            if (directory.Equals(Path.GetFullPath(root), StringComparison.OrdinalIgnoreCase))
                throw new IOException("解压根目录不属于当前操作。");
            EnsureOwnedDirectory(Path.GetDirectoryName(directory), root, owned);
            if (!CreateExclusiveDirectory(directory))
                throw new IOException("拒绝接管外来目录：" + directory);
            RejectReparseAncestors(directory);
            owned.Add(directory);
        }

        private static void VerifyOwnedTree(string directory, HashSet<string> owned)
        {
            RejectReparseAncestors(directory);
            foreach (string item in Directory.GetFileSystemEntries(directory))
            {
                RejectReparseAncestors(item);
                if (!owned.Contains(Path.GetFullPath(item)))
                    throw new IOException("解压目录出现外来条目，拒绝发布：" + item);
                if (Directory.Exists(item)) VerifyOwnedTree(item, owned);
            }
        }

        private static int Extract(Stream zip, string target, HashSet<string> owned)
        {
            int count = 0;
            using (var archive = new ZipArchive(zip, ZipArchiveMode.Read, true))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string destination = Path.GetFullPath(Path.Combine(target, entry.FullName));
                    if (!destination.StartsWith(Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                        throw new IOException("压缩包路径越界：" + entry.FullName);
                    if (destination.Length > 250)
                        throw new IOException("解压路径超过 Windows 限制；请使用更短的程序路径：" + destination);
                    // Reject alternate data streams and Windows reserved device names.
                    foreach (string part in entry.FullName.Split(new char[] { '/', '\\' }, StringSplitOptions.RemoveEmptyEntries))
                    {
                        string name = part.Split('.')[0].ToUpperInvariant();
                        if (part.Contains(":") || part.EndsWith(".") || part.EndsWith(" ") ||
                            name == "CON" || name == "PRN" || name == "AUX" || name == "NUL" ||
                            (name.Length == 4 && (name.StartsWith("COM") || name.StartsWith("LPT")) &&
                             name[3] >= '0' && name[3] <= '9'))
                            throw new IOException("压缩包包含不安全的 Windows 文件名。");
                    }
                    if (String.IsNullOrEmpty(entry.Name))
                    {
                        EnsureOwnedDirectory(destination, target, owned);
                        continue;
                    }
                    EnsureOwnedDirectory(Path.GetDirectoryName(destination), target, owned);
                    RejectReparseAncestors(destination);
                    using (Stream source = entry.Open())
                    using (FileStream file = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    {
                        owned.Add(destination);
                        source.CopyTo(file);
                    }
                    count++;
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
                Path.Combine("launcher", "launcher-data-flow.mjs"),
                Path.Combine("launcher", "launch.mjs"),
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
                    RejectReparseAncestors(candidate);
                    Directory.CreateDirectory(candidate);
                    RejectReparseAncestors(candidate);
                    string probe = Path.Combine(candidate, ".probe-" + Guid.NewGuid().ToString("N"));
                    using (var file = new FileStream(probe, FileMode.CreateNew, FileAccess.Write,
                        FileShare.None, 4096, FileOptions.DeleteOnClose)) file.WriteByte(0);
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
