# 本机 Agent 探测：对每个 Herdr kind 输出结构化 JSON 数组。
# 只运行 Get-Command、--version、--help 和目录存在性检查；
# 不启动 Agent、不安装软件、不猜测未经验证的参数。
# 适配器 YAML 通过 Node 结构化解析（config-tool.mjs to-json），不在 PowerShell 中解析 YAML。
[CmdletBinding()]
param(
    # 显式注入 kind（测试用）；缺省时从 `herdr agent start --help` 的 possible values 解析。
    [string[]]$SupportedKinds,
    # 适配器 YAML 路径（测试用）；缺省用插件内置 agent-adapters.yaml。
    [string]$AdapterPath,
    # 额外命令搜索目录（测试用），会前置到 PATH。
    [string[]]$CommandRoots
)

$ErrorActionPreference = "Continue"

# 探测结果：value 为合并后的输出文本，probe 为机器可判定的 ok|empty|failed|skipped。
# 子命令的 stdout 与 stderr 都重定向到临时文件，完整捕获且不向脚本 stdout/stderr 泄漏
#（部分 CLI 如 opencode/yargs 把帮助写到 stderr，必须一并捕获）。
function Get-CommandProbe {
    param(
        [System.Management.Automation.CommandInfo]$CommandInfo,
        [string[]]$ProbeArgs
    )
    $result = [ordered]@{ value = $null; probe = "skipped" }
    $stdoutFile = Join-Path $env:TEMP ("herdr-probe-out-" + [System.Guid]::NewGuid().ToString("N") + ".txt")
    $stderrFile = Join-Path $env:TEMP ("herdr-probe-err-" + [System.Guid]::NewGuid().ToString("N") + ".txt")
    try {
        try {
            & $CommandInfo @ProbeArgs 1>$stdoutFile 2>$stderrFile
        } catch {
            # 命令无法执行（如占位 EXE）或运行时抛出终止错误：视为探测失败。
            $result.probe = "failed"
            return $result
        }
        $stdoutText = ""
        $stderrText = ""
        if (Test-Path -LiteralPath $stdoutFile) {
            $stdoutText = Get-Content -LiteralPath $stdoutFile -Raw -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $stderrFile) {
            $stderrText = Get-Content -LiteralPath $stderrFile -Raw -ErrorAction SilentlyContinue
        }
        if ($null -eq $stdoutText) { $stdoutText = "" }
        if ($null -eq $stderrText) { $stderrText = "" }
        $text = ($stdoutText + $stderrText).Trim()
        if ([string]::IsNullOrEmpty($text)) {
            $result.probe = "empty"
        } else {
            $result.probe = "ok"
            $result.value = $text
        }
        return $result
    } finally {
        Remove-Item -LiteralPath $stdoutFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
    }
}

# Node 与配置工具：适配器 YAML 必须结构化解析。
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
    Write-Output "NODE_NOT_FOUND"
    exit 1
}
$configTool = Join-Path $PSScriptRoot "config-tool.mjs"

if ([string]::IsNullOrEmpty($AdapterPath)) {
    $AdapterPath = Join-Path $PSScriptRoot "..\references\agent-adapters.yaml"
}
$adaptersJson = (& $nodeCommand.Source $configTool to-json --file $AdapterPath | Out-String)
if ($LASTEXITCODE -ne 0) {
    exit 1
}
$adapters = ConvertFrom-Json -InputObject $adaptersJson

# kind 发现：优先使用注入的列表，否则解析当前 Herdr 帮助。
if ($null -eq $SupportedKinds -or $SupportedKinds.Count -eq 0) {
    $herdr = Get-Command herdr -ErrorAction SilentlyContinue
    if ($null -eq $herdr) {
        Write-Output "HERDR_NOT_FOUND"
        exit 1
    }
    $helpText = ((& $herdr.Source agent start --help 2>&1 | Out-String))
    # 兼容两种格式：`possible values: a, b, c]`（clap 的 [possible values: ...] 写法）
    # 和 `possible values: [a, b, c]`。
    $match = [regex]::Match($helpText, "possible values:\s*\[?([^\]\r\n]+)\]")
    if (-not $match.Success) {
        Write-Output "HERDR_KINDS_PARSE_FAILED"
        exit 1
    }
    $SupportedKinds = @($match.Groups[1].Value -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

if ($null -ne $CommandRoots -and $CommandRoots.Count -gt 0) {
    $env:PATH = (($CommandRoots -join ";") + ";" + $env:PATH)
}

$results = @()
foreach ($kind in $SupportedKinds) {
    $item = [ordered]@{
        kind               = $kind
        command            = $null
        command_type       = $null
        version            = $null
        status             = "unknown"
        launch_method      = $null
        adapter_status     = "missing"
        elevated_args      = @()
        elevated_verified  = $false
        superpowers_status = "unknown"
        diagnostics        = [ordered]@{ version_probe = "skipped"; help_probe = "skipped" }
    }

    $adapter = $null
    $property = $adapters.PSObject.Properties | Where-Object { $_.Name -eq $kind }
    if ($null -ne $property) {
        $adapter = $property.Value
    }

    if ($null -eq $adapter) {
        $item.status = "unsupported_adapter"
        $results += $item
        continue
    }
    $item.adapter_status = "known"

    $commandName = $kind
    $adapterCommands = @($adapter.commands | Where-Object { $_ })
    if ($adapterCommands.Count -gt 0) {
        $commandName = [string]$adapterCommands[0]
    }
    $item.command = $commandName

    $cmd = Get-Command $commandName -ErrorAction SilentlyContinue
    if ($null -eq $cmd) {
        $item.status = "not_installed"
        $results += $item
        continue
    }

    if ($cmd.CommandType -eq [System.Management.Automation.CommandTypes]::ExternalScript) {
        $item.command_type = "ps1_shim"
        $item.launch_method = "pane_run"
    } else {
        $item.command_type = "native"
        $item.launch_method = "agent_start"
    }

    $versionArgs = @($adapter.version_args | Where-Object { $_ })
    if ($versionArgs.Count -eq 0) {
        $versionArgs = @("--version")
    }
    $versionProbe = Get-CommandProbe $cmd $versionArgs
    $item.diagnostics.version_probe = $versionProbe.probe
    $item.version = $versionProbe.value

    $super = $adapter.superpowers
    if ($null -ne $super -and -not [string]::IsNullOrEmpty([string]$super.detect_dir)) {
        $dir = [Environment]::ExpandEnvironmentVariables([string]$super.detect_dir)
        $check = $dir
        if (-not [string]::IsNullOrEmpty([string]$super.detect_pattern)) {
            $check = Join-Path $dir ([string]$super.detect_pattern)
        }
        if (Test-Path -Path $check -ErrorAction SilentlyContinue) {
            $item.superpowers_status = "present"
        } else {
            $item.superpowers_status = "absent"
        }
    }

    # 最大权限参数验证：帮助探测成功且包含全部参数，否则视为未验证、不使用。
    $elevated = @($adapter.elevated_args | Where-Object { $_ })
    if ($elevated.Count -gt 0) {
        $helpProbe = Get-CommandProbe $cmd @("--help")
        $item.diagnostics.help_probe = $helpProbe.probe
        $allPresent = $helpProbe.probe -eq "ok"
        if ($allPresent) {
            foreach ($arg in $elevated) {
                if ($helpProbe.value -notlike "*$arg*") {
                    $allPresent = $false
                    break
                }
            }
        }
        if ($allPresent) {
            $item.elevated_args = @($elevated)
            $item.elevated_verified = $true
        }
    }

    # 命令存在但版本探测为空或失败：不标记纯 available，也不使用 launch_error
    #（check 不启动 Agent，用 available_with_warnings 表达启动前需人工确认）。
    if ($item.diagnostics.version_probe -eq "ok") {
        $item.status = "available"
    } else {
        $item.status = "available_with_warnings"
    }
    $results += $item
}

ConvertTo-Json -InputObject $results -Depth 6 -Compress
