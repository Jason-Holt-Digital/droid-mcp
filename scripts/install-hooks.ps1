<#
Install or remove the droid-mcp Droid hook on Windows (PowerShell 5.1+).

  .\scripts\install-hooks.ps1 -Url URL [-TokenStdin] [-Uninstall] [-HomeDir DIR]

The token comes from DROID_MCP_EVENTS_TOKEN, stdin (-TokenStdin) or a hidden
prompt. It is written to ~\.factory\droid-mcp\hook.json, readable only by the
current user, and never printed.
#>
param(
    [string]$Url,
    [switch]$TokenStdin,
    [switch]$Uninstall,
    [string]$HomeDir
)
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 otherwise serializes some arrays as {"value": [...], "Count": n}.
Remove-TypeData System.Array -ErrorAction SilentlyContinue

$Events = @('Stop', 'Notification', 'SessionEnd')
$Markers = @('droid-mcp/droid_mcp_hook', 'droid-mcp\droid_mcp_hook', 'droid-mcp-hook.ps1')
$ScriptName = 'droid-mcp-hook.ps1'
$Source = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) "hooks/$ScriptName"
$RestartNote = 'Droid snapshots hooks at startup, so new sessions pick this up.'
$Utf8 = New-Object Text.UTF8Encoding $false

function Fail([string]$Message) {
    [Console]::Error.WriteLine("install-hooks: $Message")
    exit 2
}

function Test-Ours($Group) {
    if ($null -eq $Group -or $null -eq $Group.hooks) { return $false }
    foreach ($h in @($Group.hooks)) {
        if ($null -ne $h -and $h.command -is [string]) {
            foreach ($m in $Markers) { if ($h.command.Contains($m)) { return $true } }
        }
    }
    return $false
}

function Remove-Ours($Config, [bool]$DropEmptied) {
    foreach ($p in @($Config.PSObject.Properties)) {
        if ($p.Value -isnot [array]) { continue }
        $groups = @($p.Value)
        $kept = @($groups | Where-Object { -not (Test-Ours $_) })
        if ($kept.Length -eq $groups.Length) { continue }
        if ($kept.Length -eq 0 -and $DropEmptied) {
            $Config.PSObject.Properties.Remove($p.Name)
        } else {
            $Config.($p.Name) = [object[]]$kept
        }
    }
}

function Read-Hooks([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        $text = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
        $config = $text | ConvertFrom-Json
    } catch { Fail "cannot read $Path ($($_.Exception.Message)); left it unchanged" }
    if ($config -isnot [Management.Automation.PSCustomObject]) { Fail "$Path is not a JSON object; left it unchanged" }
    return $config
}

function To-Json($Config) {
    if (@($Config.PSObject.Properties).Length -eq 0) { return "{}`n" }
    return (ConvertTo-Json -InputObject $Config -Depth 64) + "`n"
}

function Save-Hooks([string]$Path, [string]$Before, $After) {
    # Returns the backup path, '' when the file is new, $null when unchanged.
    $text = To-Json $After
    if ($null -ne $Before -and $Before -eq $text) { return $null }
    $saved = ''
    if ($null -ne $Before) {
        $stamp = Get-Date -Format 'yyyyMMddHHmmss'
        $saved = "$Path.bak-droid-mcp-$stamp"
        $n = 1
        while (Test-Path -LiteralPath $saved) { $saved = "$Path.bak-droid-mcp-$stamp-$n"; $n++ }
        Copy-Item -LiteralPath $Path -Destination $saved
    }
    $tmp = "$Path.tmp-droid-mcp"
    [IO.File]::WriteAllText($tmp, $text, $Utf8)
    Move-Item -LiteralPath $tmp -Destination $Path -Force
    return $saved
}

function Describe($Saved) {
    if ($null -eq $Saved) { return 'unchanged' }
    if ($Saved) { return "updated (backup $Saved)" }
    return 'created'
}

function Read-Token {
    $token = $env:DROID_MCP_EVENTS_TOKEN
    if (-not $token -and $TokenStdin) { $token = [Console]::In.ReadLine() }
    if (-not $token -and -not $TokenStdin) {
        $secure = Read-Host -Prompt 'droid-mcp events token' -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    }
    if ($token) { $token = $token.Trim() }
    if (-not $token) { Fail 'no token (set DROID_MCP_EVENTS_TOKEN, pass -TokenStdin, or type it at the prompt)' }
    return $token
}

function Protect-File([string]$Path) {
    if ($PSVersionTable.PSVersion.Major -ge 6 -and -not $IsWindows) { return }
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

if (-not $HomeDir) { $HomeDir = [Environment]::GetFolderPath('UserProfile') }
$HomeDir = [IO.Path]::GetFullPath($HomeDir)
$factory = Join-Path $HomeDir '.factory'
$dest = Join-Path $factory 'droid-mcp'
$hooksPath = Join-Path $factory 'hooks.json'

$before = Read-Hooks $hooksPath
$beforeText = $null
if ($null -ne $before) { $beforeText = To-Json $before }

if ($Uninstall) {
    $saved = $null
    if ($null -ne $before) {
        Remove-Ours $before $true
        $saved = Save-Hooks $hooksPath $beforeText $before
    }
    if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
    Write-Output "droid-mcp hook removed from $dest; $hooksPath $(Describe $saved). $RestartNote"
    exit 0
}

if (-not $Url -or -not ($Url.StartsWith('http://') -or $Url.StartsWith('https://'))) { Fail '-Url must be an http:// or https:// URL' }
if (-not (Test-Path -LiteralPath $Source)) { Fail "hook script not found at $Source" }
$token = Read-Token

New-Item -ItemType Directory -Force -Path $dest | Out-Null
$hookScript = Join-Path $dest $ScriptName
Copy-Item -LiteralPath $Source -Destination $hookScript -Force
$config = Join-Path $dest 'hook.json'
[IO.File]::WriteAllText($config, (ConvertTo-Json -InputObject ([ordered]@{ url = $Url; token = $token }) -Compress) + "`n", $Utf8)
Protect-File $config

# Unquoted when it has no spaces so the command works whether Droid runs it through cmd or PowerShell.
$shell = ''
if ($env:SystemRoot) { $shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }
if (-not $shell -or -not (Test-Path -LiteralPath $shell)) { $shell = (Get-Process -Id $PID).Path }
if ($shell.Contains(' ')) { $shell = "`"$shell`"" }
$command = "$shell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$hookScript`""
$after = $before
if ($null -eq $after) { $after = New-Object psobject }
Remove-Ours $after $false
foreach ($name in $Events) {
    $group = [pscustomobject][ordered]@{ hooks = [object[]]@([pscustomobject][ordered]@{ type = 'command'; command = $command; timeout = 5 }) }
    $existing = $after.PSObject.Properties[$name]
    if ($null -ne $existing -and $existing.Value -is [array]) {
        $after.$name = [object[]](@($existing.Value) + $group)
    } else {
        $after | Add-Member -NotePropertyName $name -NotePropertyValue ([object[]]@($group)) -Force
    }
}
$saved = Save-Hooks $hooksPath $beforeText $after
Write-Output "droid-mcp hook installed in $dest for $($Events -join ', '); $hooksPath $(Describe $saved). $RestartNote"
