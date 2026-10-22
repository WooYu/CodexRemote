using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Xml;
using System.Collections.Generic;

// Built locally with the Windows .NET Framework compiler; no downloaded wrapper.
public sealed class RemoteService : ServiceBase
{
    readonly List<Process> children = new List<Process>();
    readonly object logLock = new object();
    string root;
    volatile bool stopping;
    public RemoteService() { ServiceName = "CodexRemote"; CanStop = true; AutoLog = true; }
    void Log(string line) {
        if (line == null) return;
        lock (logLock) {
            try { File.AppendAllText(Path.Combine(root, ".windows-service", "logs", DateTime.Now.ToString("yyyy-MM-dd") + ".log"), DateTime.Now.ToString("s") + " " + line + Environment.NewLine); }
            catch { /* Logging failures must not crash output callbacks. */ }
        }
    }
    protected override void OnStart(string[] args) {
        root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".."));
        Directory.CreateDirectory(Path.Combine(root, ".windows-service", "logs"));
        var config = new XmlDocument();
        config.Load(Path.Combine(root, ".windows-service", "config.xml"));
        try {
            StartNode(config, "server.mjs --terminal", "8789", false);
            StartNode(config, "scripts/start-history.mjs", "8790", true);
        } catch { OnStop(); throw; }
    }
    void StartNode(XmlDocument config, string args, string port, bool gateway) {
        var info = new ProcessStartInfo(config.SelectSingleNode("/service/node").InnerText, args);
        info.WorkingDirectory = root;
        info.UseShellExecute = false; info.CreateNoWindow = true;
        info.RedirectStandardOutput = true; info.RedirectStandardError = true;
        // Do not inherit Codex agent session markers into resumed terminals.
        var remove = new List<string>();
        foreach (string key in info.EnvironmentVariables.Keys)
            if (key.StartsWith("CODEX_", StringComparison.OrdinalIgnoreCase)) remove.Add(key);
        foreach (string key in remove) info.EnvironmentVariables.Remove(key);
        foreach (XmlNode item in config.SelectNodes("/service/env"))
            info.EnvironmentVariables[item.Attributes["name"].Value] = item.InnerText;
        info.EnvironmentVariables["PORT"] = port;
        info.EnvironmentVariables["HOST"] = "127.0.0.1";
        info.EnvironmentVariables.Remove("TERMINAL_UPSTREAM");
        if (gateway) info.EnvironmentVariables["TERMINAL_UPSTREAM"] = "http://127.0.0.1:8789";
        var child = new Process(); child.StartInfo = info;
        child.OutputDataReceived += (s, e) => Log("[" + port + "] " + e.Data);
        child.ErrorDataReceived += (s, e) => Log("[" + port + "] " + e.Data);
        child.EnableRaisingEvents = true;
        child.Exited += (s, e) => {
            if (!stopping) {
                Log("Node exited unexpectedly; restarting service through SCM.");
                OnStop(); Environment.Exit(1);
            }
        };
        children.Add(child);
        child.Start(); child.BeginOutputReadLine(); child.BeginErrorReadLine();
    }
    protected override void OnStop() {
        stopping = true;
        foreach (var child in children) {
            try {
                if (child.HasExited) continue;
                var kill = Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "taskkill.exe"), "/PID " + child.Id + " /T /F") { UseShellExecute = false, CreateNoWindow = true });
                if (kill != null) { kill.WaitForExit(10000); kill.Dispose(); }
                child.WaitForExit(5000);
            } catch (Exception ex) { Log(ex.Message); }
        }
    }
    public static void Main() { ServiceBase.Run(new RemoteService()); }
}
