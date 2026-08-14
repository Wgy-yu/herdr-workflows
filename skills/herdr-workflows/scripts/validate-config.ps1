# 配置校验入口：只解析参数并调用同目录 config-tool.mjs（Node）。
# 不得在本脚本中用正则或字符串拼接解析 YAML。
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("global", "project")]
    [string]$Scope,

    [Parameter(Mandatory = $true)]
    [string]$Path
)

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
    Write-Output "NODE_NOT_FOUND"
    exit 1
}

$configTool = Join-Path $PSScriptRoot "config-tool.mjs"
& $nodeCommand.Source $configTool validate --scope $Scope --file $Path
exit $LASTEXITCODE
