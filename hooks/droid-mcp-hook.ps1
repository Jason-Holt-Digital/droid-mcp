# Droid hook that posts a compact session event to droid-mcp's POST /events.
# PowerShell 5.1+ for Windows. Never prints and always exits 0: Droid shows hook
# stdout in transcripts and waits for the hook to finish.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Windows PowerShell 5.1 otherwise serializes some arrays as {"value": [...], "Count": n}.
Remove-TypeData System.Array -ErrorAction SilentlyContinue

$TailBytes = 512 * 1024
$TimeoutSec = 3

function Get-HomeDir {
    if ($env:DROID_MCP_HOOK_HOME) { return $env:DROID_MCP_HOOK_HOME }
    return [Environment]::GetFolderPath('UserProfile')
}

function Read-JsonFile([string]$Path) {
    try {
        if (-not [IO.File]::Exists($Path)) { return $null }
        return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) | ConvertFrom-Json
    } catch { return $null }
}

function Get-Str($Value) {
    if ($Value -is [string]) { return $Value }
    return ''
}

function Clip([string]$Text, [int]$Max) {
    if ($Text.Length -le $Max) { return $Text }
    if ([char]::IsHighSurrogate($Text[$Max - 1])) { $Max-- }
    return $Text.Substring(0, $Max)
}

function Get-TextOf($Content) {
    if ($Content -is [string]) { return $Content }
    $parts = @()
    foreach ($b in @($Content)) {
        if ($null -ne $b -and $b.type -eq 'text' -and $b.text -is [string]) { $parts += $b.text }
    }
    return ($parts -join "`n")
}

function Get-LastAssistantText([string]$Path) {
    try {
        $fs = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
        try {
            $start = [Math]::Max([long]0, $fs.Length - $TailBytes)
            [void]$fs.Seek($start, 'Begin')
            $buf = New-Object byte[] ($fs.Length - $start)
            $read = 0
            while ($read -lt $buf.Length) {
                $n = $fs.Read($buf, $read, $buf.Length - $read)
                if ($n -le 0) { break }
                $read += $n
            }
        } finally { $fs.Dispose() }
    } catch { return '' }
    $lines = [Text.Encoding]::UTF8.GetString($buf, 0, $read).Split("`n")
    $first = 0
    if ($start -gt 0) { $first = 1 }  # starts mid-line
    for ($i = $lines.Length - 1; $i -ge $first; $i--) {
        $line = $lines[$i]
        if (-not $line.Contains('"type":"message"')) { continue }
        try { $entry = $line | ConvertFrom-Json } catch { continue }
        $msg = $entry.message
        if ($null -eq $msg -or $msg.role -ne 'assistant') { continue }
        $text = Get-TextOf $msg.content
        if ($text.Trim()) { return $text }
    }
    return ''
}

function Get-StopEvent([string]$Text) {
    $lines = $Text.Split("`n")
    for ($i = 0; $i -lt $lines.Length; $i++) {
        if ($lines[$i].TrimStart().StartsWith('QUESTION:')) {
            return @('question', (($lines[$i..($lines.Length - 1)]) -join "`n").Trim())
        }
    }
    $t = $Text.Trim()
    if ($t.Length -gt 300) { $t = $t.Substring($t.Length - 300) }
    return @('finished', $t)
}

function Read-Header([string]$Path) {
    try {
        $reader = New-Object IO.StreamReader($Path, [Text.Encoding]::UTF8)
        try { $line = $reader.ReadLine() } finally { $reader.Dispose() }
        return $line | ConvertFrom-Json
    } catch { return $null }
}

function Read-Tags([string]$Transcript) {
    if (-not $Transcript.EndsWith('.jsonl')) { return @() }
    $settings = Read-JsonFile ($Transcript.Substring(0, $Transcript.Length - 6) + '.settings.json')
    if ($null -eq $settings -or $null -eq $settings.tags) { return @() }
    $names = @()
    foreach ($t in @($settings.tags)) {
        if ($null -ne $t -and $t.name -is [string] -and $t.name -and $t.name.Length -le 100) { $names += $t.name }
    }
    if ($names.Length -gt 20) { $names = $names[0..19] }
    return $names
}

try {
    $raw = [Console]::In.ReadToEnd()
    try { $hookEvent = $raw | ConvertFrom-Json } catch { exit 0 }
    if ($null -eq $hookEvent) { exit 0 }

    $kind = $null
    $text = ''
    switch ($hookEvent.hook_event_name) {
        'Stop' { $kind = 'stop' }
        'Notification' {
            if ($hookEvent.notification_type -eq 'permission_prompt') { $kind = 'permission' }
            elseif ($hookEvent.notification_type -eq 'elicitation_dialog') { $kind = 'question' }
            $text = Get-Str $hookEvent.message
        }
        'SessionEnd' { $kind = 'ended'; $text = Get-Str $hookEvent.reason }
    }
    if (-not $kind) { exit 0 }

    $homeDir = Get-HomeDir
    $cfg = Read-JsonFile (Join-Path $homeDir '.factory/droid-mcp/hook.json')
    if ($null -eq $cfg) { exit 0 }
    $url = Get-Str $cfg.url
    $token = Get-Str $cfg.token
    if (-not ($url.StartsWith('http://') -or $url.StartsWith('https://')) -or -not $token) { exit 0 }

    $transcript = Get-Str $hookEvent.transcript_path
    if ($kind -eq 'stop') {
        $stop = Get-StopEvent (Get-LastAssistantText $transcript)
        $kind = $stop[0]
        $text = $stop[1]
    }
    $header = $null
    $tags = @()
    if ($transcript) {
        $header = Read-Header $transcript
        $tags = @(Read-Tags $transcript)
    }
    $title = ''
    $cwd = Get-Str $hookEvent.cwd
    if ($null -ne $header) {
        $title = Get-Str $header.title
        if (-not $cwd) { $cwd = Get-Str $header.cwd }
    }

    $payload = [ordered]@{}
    $computer = Read-JsonFile (Join-Path $homeDir '.factory/computer.json')
    if ($null -ne $computer -and $computer.computerId -is [string] -and $computer.computerId) {
        $payload.computerId = $computer.computerId
    }
    $payload.host = [Environment]::MachineName
    $payload.sessionId = Get-Str $hookEvent.session_id
    $payload.kind = $kind
    $payload.title = Clip $title 200
    $payload.text = Clip $text 1000
    $payload.cwd = Clip $cwd 500
    $payload.tags = [object[]]$tags
    $body = ConvertTo-Json -InputObject $payload -Compress -Depth 5

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch {}
    $null = Invoke-WebRequest -Uri $url -Method Post -UseBasicParsing -TimeoutSec $TimeoutSec `
        -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' `
        -Body ([Text.Encoding]::UTF8.GetBytes($body))
} catch {}
exit 0
