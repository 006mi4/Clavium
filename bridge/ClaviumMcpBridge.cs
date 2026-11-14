// clavium-mcp.exe — stdio <-> Streamable HTTP bridge for MCP clients that only
// support stdio servers (Claude Desktop, Codex, ...). It forwards each JSON-RPC line
// from stdin to the MCP endpoint of the running Clavium app on 127.0.0.1 and writes
// the responses to stdout. It holds no secrets itself: the token comes from the
// CLAVIUM_MCP_TOKEN environment variable set in the AI client's configuration.
//
// Deliberately C# 5 / .NET Framework 4.x so it compiles with the csc.exe that ships
// with every Windows 10/11 installation (no SDK required).
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

internal static class ClaviumMcpBridge
{
    private static readonly object OutLock = new object();
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
    private static Stream _stdout;
    private static string _url;
    private static string _token;
    private static string _dataDir;
    private static int _launched;

    private static int Main(string[] args)
    {
        ServicePointManager.DefaultConnectionLimit = 32;
        ServicePointManager.Expect100Continue = false;
        ServicePointManager.UseNagleAlgorithm = false;

        _token = Environment.GetEnvironmentVariable("CLAVIUM_MCP_TOKEN") ?? "";
        _dataDir = Environment.GetEnvironmentVariable("CLAVIUM_DATA_DIR");
        if (string.IsNullOrEmpty(_dataDir))
            _dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Clavium");
        _url = Environment.GetEnvironmentVariable("CLAVIUM_MCP_URL");
        if (string.IsNullOrEmpty(_url)) _url = "http://127.0.0.1:" + ReadPort() + "/mcp";

        if (args.Length > 0 && (args[0] == "--version" || args[0] == "-v"))
        {
            Console.Error.WriteLine("clavium-mcp bridge -> " + _url);
            return 0;
        }
        if (_token.Length == 0)
            Log("CLAVIUM_MCP_TOKEN is not set. Copy the configuration from Clavium > AI Access.");

        _stdout = Console.OpenStandardOutput();
        var stdin = new StreamReader(Console.OpenStandardInput(), Utf8);
        var pending = new CountdownEvent(1);
        string line;
        while ((line = stdin.ReadLine()) != null)
        {
            if (line.Trim().Length == 0) continue;
            var captured = line;
            pending.AddCount();
            ThreadPool.QueueUserWorkItem(delegate
            {
                try { Handle(captured); }
                catch (Exception e) { Log("unexpected: " + e.Message); }
                finally { pending.Signal(); }
            });
        }
        pending.Signal();
        pending.Wait();
        return 0;
    }

    private static int ReadPort()
    {
        try
        {
            var file = Path.Combine(_dataDir, "settings.json");
            if (File.Exists(file))
            {
                var m = Regex.Match(File.ReadAllText(file), "\"mcpPort\"\\s*:\\s*(\\d{2,5})");
                if (m.Success) return int.Parse(m.Groups[1].Value);
            }
        }
        catch (Exception) { }
        return 47821;
    }

    private static void Log(string msg)
    {
        try { Console.Error.WriteLine("[clavium-mcp] " + msg); } catch (Exception) { }
    }

    private static void Write(string json)
    {
        var bytes = Utf8.GetBytes(json.Trim() + "\n");
        lock (OutLock)
        {
            _stdout.Write(bytes, 0, bytes.Length);
            _stdout.Flush();
        }
    }

    private static void TryLaunchApp()
    {
        if (Interlocked.Exchange(ref _launched, 1) == 1) return;
        try
        {
            var pathFile = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "clavium-app-path.txt");
            if (!File.Exists(pathFile)) return;
            var exe = File.ReadAllText(pathFile).Trim();
            if (exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && File.Exists(exe))
            {
                Log("Clavium is not running - starting it");
                Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true });
            }
        }
        catch (Exception e) { Log("could not start Clavium: " + e.Message); }
    }

    private static HttpWebResponse Post(byte[] body)
    {
        var deadline = DateTime.UtcNow.AddSeconds(25);
        while (true)
        {
            var req = (HttpWebRequest)WebRequest.Create(_url);
            req.Method = "POST";
            req.Proxy = null; // never route localhost traffic through a proxy
            req.ContentType = "application/json";
            req.Accept = "application/json, text/event-stream";
            req.Headers["Authorization"] = "Bearer " + _token;
            req.Timeout = Timeout.Infinite; // tool calls may wait for the user's approval
            req.ReadWriteTimeout = Timeout.Infinite;
            req.KeepAlive = true;
            try
            {
                using (var s = req.GetRequestStream()) s.Write(body, 0, body.Length);
                return (HttpWebResponse)req.GetResponse();
            }
            catch (WebException ex)
            {
                if (ex.Response != null) return (HttpWebResponse)ex.Response; // HTTP error with JSON body
                if (ex.Status != WebExceptionStatus.ConnectFailure || DateTime.UtcNow > deadline) throw;
                TryLaunchApp();
                Thread.Sleep(750);
            }
        }
    }

    private static void Handle(string line)
    {
        var idMatch = Regex.Match(line, "\"id\"\\s*:\\s*(\"(?:[^\"\\\\]|\\\\.)*\"|-?\\d+)");
        try
        {
            using (var res = Post(Utf8.GetBytes(line)))
            using (var reader = new StreamReader(res.GetResponseStream(), Utf8))
            {
                var text = reader.ReadToEnd();
                if ((int)res.StatusCode == 202 || text.Trim().Length == 0) return;
                var ct = res.ContentType ?? "";
                if (ct.IndexOf("text/event-stream", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    foreach (var l in text.Split('\n'))
                    {
                        var t = l.TrimEnd('\r');
                        if (t.StartsWith("data:")) Write(t.Substring(5));
                    }
                    return;
                }
                // Error replies without an id (e.g. 401) get the request's id so the client can match them.
                if ((int)res.StatusCode >= 400 && idMatch.Success && text.Contains("\"id\":null"))
                    text = text.Replace("\"id\":null", "\"id\":" + idMatch.Groups[1].Value);
                Write(text);
            }
        }
        catch (Exception e)
        {
            Log(e.Message);
            if (!idMatch.Success) return;
            var msg = "Clavium is not reachable (" + e.Message.Replace("\"", "'") +
                      "). Start Clavium, unlock it and enable the MCP server.";
            Write("{\"jsonrpc\":\"2.0\",\"id\":" + idMatch.Groups[1].Value +
                  ",\"error\":{\"code\":-32000,\"message\":\"" + msg.Replace("\\", "\\\\") + "\"}}");
        }
    }
}
