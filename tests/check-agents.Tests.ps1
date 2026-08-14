# Agent 探测脚本测试：无外部 Pester 依赖。
# 在临时目录中创建伪命令与适配器夹具，通过 -SupportedKinds/-AdapterPath/-CommandRoots
# 注入被测脚本，验证命令缺失、原生 EXE（版本探测失败）、PowerShell shim、版本探测为空、
# 未知适配器和最大权限参数未验证六种场景，以及 diagnostics 机器可判定字段。
# 每个断言失败抛出包含用例名的异常；全部通过输出 CHECK_AGENTS_TESTS_PASS。
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$CheckAgentsScript
)

$ErrorActionPreference = "Stop"

function Assert-True {
    param(
        [bool]$Condition,
        [string]$CaseName,
        [string]$Detail
    )
    if (-not $Condition) {
        throw "断言失败：$CaseName：$Detail"
    }
}

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("check-agents-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempDir | Out-Null

try {
    # 伪命令：nativeagent.exe（原生、不可执行的占位文件）、shimagent.ps1（shim，版本探测成功）、
    # noversion.ps1（版本探测为空）、noelevated.ps1（帮助文本不含最大权限参数）。
    New-Item -ItemType File -Path (Join-Path $tempDir "nativeagent.exe") | Out-Null
    Set-Content -Path (Join-Path $tempDir "shimagent.ps1") -Encoding UTF8 -Value @'
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)
if ($Rest -contains "--version") { Write-Output "shimagent 1.0.0"; exit 0 }
Write-Output "shimagent help"
Write-Output "--fake-elevated"
'@
    Set-Content -Path (Join-Path $tempDir "noversion.ps1") -Encoding UTF8 -Value @'
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)
# 只响应帮助，不输出版本信息。
if ($Rest -contains "--help") { Write-Output "noversion help" }
'@
    Set-Content -Path (Join-Path $tempDir "noelevated.ps1") -Encoding UTF8 -Value @'
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)
if ($Rest -contains "--version") { Write-Output "noelevated 1.0.0"; exit 0 }
Write-Output "noelevated help"
'@
    # 双流噪声 shim：version/help 探测同时写 stdout 和 stderr（模拟 opencode/yargs 行为），
    # 探测必须完整捕获两个流且不得向脚本 stdout/stderr 泄漏。
    Set-Content -Path (Join-Path $tempDir "loudagent.ps1") -Encoding UTF8 -Value @'
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)
if ($Rest -contains "--version") {
    Write-Output "loudagent 1.0.0"
    Write-Error "noise-err-version"
    exit 0
}
if ($Rest -contains "--help") {
    Write-Output "loudagent help"
    Write-Error "noise-err-help"
    Write-Output "--loud-elevated"
    exit 0
}
'@

    # 适配器夹具：missingagent 有适配器但无命令；unknownagent 无适配器。
    $adapterYaml = Join-Path $tempDir "adapters.yaml"
    Set-Content -Path $adapterYaml -Encoding UTF8 -Value @'
# 测试夹具适配器：只包含本测试需要的字段。
nativeagent:
  kind: nativeagent
  commands: [nativeagent]
  elevated_args: []
shimagent:
  kind: shimagent
  commands: [shimagent]
  elevated_args: []
noversion:
  kind: noversion
  commands: [noversion]
  elevated_args: []
loudagent:
  kind: loudagent
  commands: [loudagent]
  elevated_args: [--loud-elevated]
missingagent:
  kind: missingagent
  commands: [missingagent]
  elevated_args: []
noelevated:
  kind: noelevated
  commands: [noelevated]
  elevated_args: [--max-permission]
'@

    $kinds = @("nativeagent", "shimagent", "noversion", "loudagent", "missingagent", "unknownagent", "noelevated")
    # stderr 单独落盘：探测子命令的 stdout+stderr 都必须被完整捕获，脚本 stderr 不得有泄漏。
    $stderrCapture = Join-Path $tempDir "script-stderr.txt"
    $raw = (& $CheckAgentsScript -SupportedKinds $kinds -AdapterPath $adapterYaml -CommandRoots @($tempDir) 2>$stderrCapture | Out-String)
    if ($LASTEXITCODE -ne 0) {
        throw "断言失败：全部用例：check-agents.ps1 返回非零退出码 $LASTEXITCODE"
    }
    if ([string]::IsNullOrWhiteSpace($raw)) {
        throw "断言失败：全部用例：脚本未输出 JSON 数组"
    }
    $items = @(ConvertFrom-Json -InputObject $raw)
    Assert-True ($items.Count -eq 7) "全部用例" "期望 7 项输出，实际 $($items.Count)"
    # stdout 只允许 JSON 数组本身（Out-String 会附加尾随空行，按非空行计数）。
    $rawLines = @($raw -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    Assert-True ($rawLines.Count -eq 1) "stdout 纯净" ("stdout 应只有一行 JSON 数组，实际非空行数 " + $rawLines.Count)
    $leaked = Get-Content -LiteralPath $stderrCapture -Raw -ErrorAction SilentlyContinue
    Assert-True ([string]::IsNullOrWhiteSpace($leaked)) "stderr 无泄漏" ("探测子命令的 stdout/stderr 未完整捕获，泄漏内容：[" + $leaked + "]")

    $native = $items | Where-Object { $_.kind -eq "nativeagent" }
    Assert-True ($null -ne $native) "原生 EXE" "缺少 nativeagent 输出项"
    Assert-True ($native.status -eq "available_with_warnings") "原生 EXE" "status 应为 available_with_warnings，实际 $($native.status)"
    Assert-True ($native.command_type -eq "native") "原生 EXE" "command_type 应为 native，实际 $($native.command_type)"
    Assert-True ($native.launch_method -eq "agent_start") "原生 EXE" "launch_method 应为 agent_start，实际 $($native.launch_method)"
    Assert-True ($native.diagnostics.version_probe -eq "failed") "原生 EXE" "diagnostics.version_probe 应为 failed，实际 $($native.diagnostics.version_probe)"

    $shim = $items | Where-Object { $_.kind -eq "shimagent" }
    Assert-True ($null -ne $shim) "PowerShell shim" "缺少 shimagent 输出项"
    Assert-True ($shim.status -eq "available") "PowerShell shim" "status 应为 available，实际 $($shim.status)"
    Assert-True ($shim.command_type -eq "ps1_shim") "PowerShell shim" "command_type 应为 ps1_shim，实际 $($shim.command_type)"
    Assert-True ($shim.launch_method -eq "pane_run") "PowerShell shim" "launch_method 应为 pane_run，实际 $($shim.launch_method)"
    Assert-True ($shim.diagnostics.version_probe -eq "ok") "PowerShell shim" "diagnostics.version_probe 应为 ok，实际 $($shim.diagnostics.version_probe)"

    $noVersion = $items | Where-Object { $_.kind -eq "noversion" }
    Assert-True ($null -ne $noVersion) "版本探测为空" "缺少 noversion 输出项"
    Assert-True ($noVersion.status -eq "available_with_warnings") "版本探测为空" "status 应为 available_with_warnings，实际 $($noVersion.status)"
    Assert-True ($noVersion.diagnostics.version_probe -eq "empty") "版本探测为空" "diagnostics.version_probe 应为 empty，实际 $($noVersion.diagnostics.version_probe)"

    $missing = $items | Where-Object { $_.kind -eq "missingagent" }
    Assert-True ($null -ne $missing) "缺少命令" "缺少 missingagent 输出项"
    Assert-True ($missing.status -eq "not_installed") "缺少命令" "status 应为 not_installed，实际 $($missing.status)"
    Assert-True ($missing.diagnostics.version_probe -eq "skipped") "缺少命令" "diagnostics.version_probe 应为 skipped，实际 $($missing.diagnostics.version_probe)"

    $unknown = $items | Where-Object { $_.kind -eq "unknownagent" }
    Assert-True ($null -ne $unknown) "无适配器 kind" "缺少 unknownagent 输出项"
    Assert-True ($unknown.status -eq "unsupported_adapter") "无适配器 kind" "status 应为 unsupported_adapter，实际 $($unknown.status)"
    Assert-True ($unknown.adapter_status -eq "missing") "无适配器 kind" "adapter_status 应为 missing，实际 $($unknown.adapter_status)"

    $loud = $items | Where-Object { $_.kind -eq "loudagent" }
    Assert-True ($null -ne $loud) "双流噪声 shim" "缺少 loudagent 输出项"
    Assert-True ($loud.status -eq "available") "双流噪声 shim" "status 应为 available，实际 $($loud.status)"
    Assert-True ($loud.diagnostics.version_probe -eq "ok") "双流噪声 shim" "diagnostics.version_probe 应为 ok，实际 $($loud.diagnostics.version_probe)"
    Assert-True ($loud.diagnostics.help_probe -eq "ok") "双流噪声 shim" "diagnostics.help_probe 应为 ok，实际 $($loud.diagnostics.help_probe)"
    Assert-True ($loud.elevated_verified -eq $true) "双流噪声 shim" "help 同时写 stdout+stderr，参数应从合并文本中验证通过"

    $noElevated = $items | Where-Object { $_.kind -eq "noelevated" }
    Assert-True ($null -ne $noElevated) "帮助不含最大权限参数" "缺少 noelevated 输出项"
    Assert-True ($noElevated.status -eq "available") "帮助不含最大权限参数" "status 应为 available，实际 $($noElevated.status)"
    Assert-True ($noElevated.elevated_verified -eq $false) "帮助不含最大权限参数" "elevated_verified 应为 false，实际 $($noElevated.elevated_verified)"
    Assert-True (@($noElevated.elevated_args).Count -eq 0) "帮助不含最大权限参数" "未验证时 elevated_args 应为空，实际 $($noElevated.elevated_args -join ',')"
    Assert-True ($noElevated.diagnostics.help_probe -eq "ok") "帮助不含最大权限参数" "diagnostics.help_probe 应为 ok，实际 $($noElevated.diagnostics.help_probe)"

    Write-Output "CHECK_AGENTS_TESTS_PASS"
}
finally {
    Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
