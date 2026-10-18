const { execFile } = require("child_process");
const http = require("http");
const https = require("https");

const POWERSHELL_CONNECTION_SCRIPT = `
$ErrorActionPreference = 'Stop'
$servers = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -in @('language_server.exe', 'agy.exe') -and
  $_.CommandLine -match '--app_data_dir(?:=|\\s+)antigravity(?:\\s|$)'
})
$connections = foreach ($server in $servers) {
  $token = [regex]::Match($server.CommandLine, '--csrf_token(?:=|\\s+)([a-zA-Z0-9-]+)').Groups[1].Value
  $ports = @(Get-NetTCPConnection -OwningProcess $server.ProcessId -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort -Unique)
  if ($token -and $ports.Count -gt 0) {
    [pscustomobject]@{ ports = $ports; csrfToken = $token }
  }
}
$connections | ConvertTo-Json -Compress
`;

execFile(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_CONNECTION_SCRIPT],
  async (err, stdout, stderr) => {
    if (err) {
      console.error("Exec error:", err);
      return;
    }
    console.log("Raw stdout:", stdout);
    if (!stdout.trim()) {
      console.log("No connections found!");
      return;
    }
    const parsed = JSON.parse(stdout.trim());
    const connections = Array.isArray(parsed) ? parsed : [parsed];
    for (const conn of connections) {
      const ports = Array.isArray(conn.ports) ? conn.ports : [conn.ports];
      for (const port of ports) {
        for (const protocol of ["https", "http"]) {
          try {
            const res = await query(port, conn.csrfToken, protocol);
            console.log(`Port ${port} (${protocol}) SUCCESS:`, JSON.stringify(res, null, 2));
            return;
          } catch (e) {
            console.log(`Port ${port} (${protocol}) failed:`, e.message);
          }
        }
      }
    }
  }
);

function query(port, csrfToken, protocol) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      metadata: { ideName: "antigravity", extensionName: "antigravity", locale: "tr" },
      forceRefresh: true
    });
    const transport = protocol === "https" ? https : http;
    const req = transport.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",
        method: "POST",
        rejectUnauthorized: false,
        timeout: 4000,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "Connect-Protocol-Version": "1",
          "X-Codeium-Csrf-Token": csrfToken
        }
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error("HTTP " + res.statusCode));
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end(body);
  });
}

