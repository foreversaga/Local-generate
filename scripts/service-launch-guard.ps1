function Assert-H3InteractiveServiceLaunch {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,
    [string]$ServiceName = "H3 service"
  )

  $resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
  $expectedProfile = Split-Path -Parent $resolvedProjectRoot
  $expectedUser = Split-Path -Leaf $expectedProfile
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $currentUser = ($identity -split '\\')[-1]
  $currentProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
  $sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId

  $sandboxIdentity = $identity -match '(?i)\\CodexSandbox'
  $wrongUser = -not $currentUser.Equals($expectedUser, [System.StringComparison]::OrdinalIgnoreCase)
  $wrongProfile = -not [string]::Equals(
    [System.IO.Path]::GetFullPath($currentProfile).TrimEnd('\'),
    [System.IO.Path]::GetFullPath($expectedProfile).TrimEnd('\'),
    [System.StringComparison]::OrdinalIgnoreCase
  )
  $nonInteractive = $sessionId -eq 0

  if ($sandboxIdentity -or $wrongUser -or $wrongProfile -or $nonInteractive) {
    throw "$ServiceName launch refused: long-running services must start from the interactive '$expectedUser' user environment. Current identity='$identity', profile='$currentProfile', session=$sessionId."
  }

  Write-Host "$ServiceName launch environment verified: identity=$identity, profile=$currentProfile, session=$sessionId."
}
