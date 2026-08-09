$ErrorActionPreference = "Stop"

$checks = @(
  @{ Name = "ComfyUI tunnel"; Uri = "http://127.0.0.1:18188/system_stats" },
  @{ Name = "Ollama tunnel"; Uri = "http://127.0.0.1:11435/api/tags" },
  @{ Name = "H3 Studio"; Uri = "http://127.0.0.1:8787/app/api/health" }
)

foreach ($check in $checks) {
  try {
    $response = Invoke-WebRequest -Uri $check.Uri -UseBasicParsing -TimeoutSec 5
    [pscustomobject]@{ Service = $check.Name; Online = $response.StatusCode -eq 200; Uri = $check.Uri }
  } catch {
    [pscustomobject]@{ Service = $check.Name; Online = $false; Uri = $check.Uri }
  }
}
