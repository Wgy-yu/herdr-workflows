# Agent 探测测试运行器：先确认被测脚本存在（红灯基线），再调用无 Pester 测试脚本。
$ErrorActionPreference = "Stop"

$checkAgents = Join-Path $PSScriptRoot "..\skills\herdr-workflows\scripts\check-agents.ps1"
if (-not (Test-Path -LiteralPath $checkAgents)) {
    Write-Output "FAIL: 缺少被测脚本 $checkAgents"
    exit 1
}

& (Join-Path $PSScriptRoot "check-agents.Tests.ps1") -CheckAgentsScript $checkAgents
if (-not $?) {
    exit 1
}
exit 0
