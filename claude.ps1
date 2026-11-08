# Launch Claude Code against the local opencode2api gateway.
# Does NOT touch ~/.claude; these env vars apply only to this process.
#
# Usage:  .\claude.ps1            (interactive)
#         .\claude.ps1 -p "hi"    (args forwarded to claude)

$env:ANTHROPIC_BASE_URL   = "http://127.0.0.1:10000"
$env:ANTHROPIC_AUTH_TOKEN = "oc_sk_8b88bcce5828_55lbicimQ8dCXoQLG44OeRgy4WJKXyd-"   # = API_KEY in config.json
$env:ANTHROPIC_MODEL      = "opencode/big-pickle"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL   = "opencode/big-pickle"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = "opencode/big-pickle"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL  = "opencode/big-pickle"
$env:ANTHROPIC_SMALL_FAST_MODEL     = "opencode/big-pickle"

# Don't let Claude Code fall back to api.anthropic.com for background traffic.
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"

& claude @args
