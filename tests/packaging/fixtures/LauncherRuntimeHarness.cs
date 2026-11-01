using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Reflection;

// Calls the actual Launcher.cs methods without starting the app or a browser.
internal static class LauncherRuntimeHarness
{
    private static object Call(string method, params object[] args)
    {
        try
        {
            return typeof(ToDoListLauncher.Program)
                .GetMethod(method, BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, args);
        }
        catch (TargetInvocationException error) { throw error.InnerException; }
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }

    private static void Refuses(Action action, bool invalidPath = false)
    {
        try { action(); }
        catch (IOException) { return; }
        catch (NotSupportedException) { if (!invalidPath) throw; return; }
        throw new Exception("Expected the launcher to reject the operation");
    }

    private static MemoryStream Zip(params string[] entries)
    {
        var stream = new MemoryStream();
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Create, true))
        {
            foreach (string name in entries)
            {
                var entry = archive.CreateEntry(name);
                if (!name.EndsWith("/"))
                    using (var writer = new StreamWriter(entry.Open())) writer.Write("synthetic payload");
            }
        }
        stream.Position = 0;
        return stream;
    }

    private static int Main(string[] args)
    {
        try
        {
            string root = Path.GetFullPath(args[1]);
            string stage = (string)Call("CreateStaging", root);
            var owned = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { stage };
            switch (args[0])
            {
                case "exclusive":
                    string existing = Path.Combine(root, "existing");
                    Directory.CreateDirectory(existing);
                    File.WriteAllText(Path.Combine(existing, "saved"), "keep");
                    Require(!(bool)Call("CreateExclusiveDirectory", existing), "Existing directory was claimed");
                    Require(!(bool)Call("CreateExclusiveDirectory", Path.Combine(existing, "saved")), "Existing file was claimed");
                    Require((bool)Call("CreateExclusiveDirectory", Path.Combine(root, "new")), "New directory failed");
                    Require(File.ReadAllText(Path.Combine(existing, "saved")) == "keep", "Existing content changed");
                    break;
                case "extract":
                    using (var zip = Zip("./", "./launcher/", "./launcher/launch.mjs", "./app/dist-server/server/v2.js", "node.exe"))
                        Require((int)Call("Extract", zip, stage, owned) == 3, "Wrong extracted file count");
                    Call("VerifyOwnedTree", stage, owned);
                    Require(File.ReadAllText(Path.Combine(stage, "launcher", "launch.mjs")) == "synthetic payload", "Payload differs");
                    break;
                case "unsafe":
                    using (var zip = Zip(args[2])) Refuses(() => Call("Extract", zip, stage, owned), true);
                    Require(Directory.GetFiles(stage, "*", SearchOption.AllDirectories).Length == 0, "Unsafe file was written");
                    break;
                case "foreign":
                    string foreign = Path.Combine(stage, "node.exe");
                    File.WriteAllText(foreign, "keep");
                    using (var zip = Zip("node.exe")) Refuses(() => Call("Extract", zip, stage, owned));
                    Require(File.ReadAllText(foreign) == "keep", "Foreign file overwritten");
                    Refuses(() => Call("VerifyOwnedTree", stage, owned));
                    break;
                case "junction":
                    Refuses(() => Call("RejectReparseAncestors", Path.Combine(root, "linked", "future-file")));
                    Require(File.ReadAllText(Path.Combine(root, "outside", "saved")) == "keep", "Junction target changed");
                    break;
                case "temp":
                    string temporary;
                    using (var stream = (FileStream)Call("CreatePayloadTemp", root))
                    {
                        temporary = stream.Name;
                        Refuses(() => { using (File.OpenRead(temporary)) { } });
                        stream.WriteByte(1);
                    }
                    Require(!File.Exists(temporary), "Temporary ZIP was not deleted on handle close");
                    break;
                case "length":
                    using (var zip = Zip(new string('a', 240) + ".txt")) Refuses(() => Call("Extract", zip, stage, owned));
                    Require(Directory.GetFiles(stage).Length == 0, "Overlong file was written");
                    break;
                case "sentinels":
                    Require((string)Call("MissingSentinel", stage) == "node.exe", "Empty tree accepted");
                    string[] names = { "node.exe", "launcher/data-root.mjs", "launcher/launcher-data-flow.mjs", "launcher/launch.mjs",
                        "app/dist-server/server/v2.js", "app/node_modules/mammoth/package.json", "app/node_modules/express/package.json" };
                    using (var zip = Zip(names)) Call("Extract", zip, stage, owned);
                    Require((string)Call("MissingSentinel", stage) == "", "Complete tree rejected");
                    File.Delete(Path.Combine(stage, "launcher", "launcher-data-flow.mjs"));
                    Require((string)Call("MissingSentinel", stage) != "", "Missing data-flow helper accepted");
                    break;
                default: throw new Exception("Unknown test case");
            }
            Console.WriteLine("PASS " + args[0]);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
    }
}
