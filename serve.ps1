# Tiny static file server so the page can run at http://localhost:8000/ (no installs needed).
# Usage: powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 8000]
# -AllowSave (off by default) also accepts POST /save/<name>.json and writes it to .\audit\ (used to export audit bundles).
param([int]$Port = 8000, [switch]$AllowSave)
$root = $PSScriptRoot
$types = @{ '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.css'='text/css; charset=utf-8'; '.json'='application/json'; '.svg'='image/svg+xml'; '.png'='image/png'; '.ico'='image/x-icon' }
$l = New-Object System.Net.HttpListener
$l.Prefixes.Add("http://localhost:$Port/")
$l.Start()
Write-Host "Serving $root at http://localhost:$Port/  (Ctrl+C to stop)"
try {
  while ($l.IsListening) {
    $ctx = $l.GetContext()
    $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
    if ($path -eq '') { $path = 'index.html' }
    $file = [IO.Path]::GetFullPath((Join-Path $root $path))
    $res = $ctx.Response
    try {
      if ($AllowSave -and $ctx.Request.HttpMethod -eq 'POST' -and $path -match '^save/([A-Za-z0-9_-]{1,60}\.json)$') {
        # Plain file names only, always inside .\audit\ (no paths, no other extensions).
        $dir = Join-Path $root 'audit'
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
        $reader = New-Object IO.StreamReader($ctx.Request.InputStream, [Text.Encoding]::UTF8)
        [IO.File]::WriteAllText((Join-Path $dir $Matches[1]), $reader.ReadToEnd(), (New-Object Text.UTF8Encoding($false)))
        $res.StatusCode = 204
      } elseif ($file.StartsWith($root) -and (Test-Path $file -PathType Leaf)) {
        $bytes = [IO.File]::ReadAllBytes($file)
        $ext = [IO.Path]::GetExtension($file).ToLower()
        $res.ContentType = if ($types[$ext]) { $types[$ext] } else { 'application/octet-stream' }
        $res.Headers.Add('Cache-Control', 'no-store')
        $res.ContentLength64 = $bytes.Length
        if ($ctx.Request.HttpMethod -ne 'HEAD') { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
      } else { $res.StatusCode = 404 }
    } catch { Write-Host "Request failed: $_" }
    finally { try { $res.Close() } catch {} }
  }
} finally { $l.Stop() }
