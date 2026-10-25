param()
$ErrorActionPreference = 'Stop'

# Capture CLI output internally. Never print raw site/account API data or environment values.
function Invoke-ReviewNetlifyApi([string]$Method, [hashtable]$Data) {
    $payload = $Data | ConvertTo-Json -Compress
    $raw = (& npx --yes netlify-cli api $Method --data $payload 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "Read-only Netlify API request failed: $Method. No account data printed." }
    $depth = 0; $inString = $false; $escaped = $false; $candidate = $null
    for ($index = 0; $index -lt $raw.Length; $index++) {
        $char = $raw[$index]
        if ($inString) {
            if ($escaped) { $escaped = $false }
            elseif ($char -eq '\') { $escaped = $true }
            elseif ($char -eq '"') { $inString = $false }
            continue
        }
        if ($depth -gt 0 -and $char -eq '"') { $inString = $true; continue }
        if ($char -eq '{') { if ($depth -eq 0) { $start = $index }; $depth++ }
        elseif ($char -eq '}' -and $depth -gt 0) {
            $depth--
            if ($depth -eq 0) {
                try {
                    $parsed = $raw.Substring($start, $index - $start + 1) | ConvertFrom-Json
                    if ($parsed.published_deploy) { $candidate = $parsed }
                } catch { }
            }
        }
    }
    if (-not $candidate) { throw 'No published deploy was found. No raw account data printed.' }
    return $candidate
}

$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location -LiteralPath $project
try {
    $state = Get-Content -LiteralPath '.netlify/state.json' -Raw | ConvertFrom-Json
    if ($state.siteId -notmatch '^[0-9a-f-]{36}$') { throw 'Link the intended Netlify project first.' }
    # A unique output avoids replacing or deleting previous archives and bypasses old local output.
    $output = Join-Path $project ('.netlify/backend-verification-' + [guid]::NewGuid().ToString('N'))
    & npx --yes netlify-cli functions:build --src netlify/functions --functions $output
    if ($LASTEXITCODE -ne 0) { throw 'Fresh function packaging failed.' }
    $archive = Join-Path $output 'report.zip'
    $currentDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    $legacyStoreFound = $false
    try {
        foreach ($entry in $zip.Entries) {
            $reader = [IO.StreamReader]::new($entry.Open())
            try { if ($reader.ReadToEnd().Contains('carta-ai-usage-v1')) { $legacyStoreFound = $true } }
            finally { $reader.Dispose() }
        }
    } finally { $zip.Dispose() }
    if ($legacyStoreFound) { throw 'The freshly packaged function still references the legacy usage store.' }

    $site = Invoke-ReviewNetlifyApi 'getSite' @{ site_id = $state.siteId }
    $function = @($site.published_deploy.available_functions | Where-Object { $_.n -eq 'report' -or $_.name -eq 'report' })
    if ($function.Count -ne 1) { throw 'Expected exactly one deployed report function.' }
    # Netlify uses the compact field d for the uploaded function archive digest, not id.
    $activeDigest = $(if ($function[0].d) { $function[0].d } else { $function[0].sha })
    if ($activeDigest -notmatch '^[a-f0-9]{64}$') { throw 'Netlify did not return a recognized function archive digest.' }
    $oldArchive = Join-Path $project '.netlify/functions/report.zip'
    $oldDigest = $(if (Test-Path -LiteralPath $oldArchive) { (Get-FileHash -Algorithm SHA256 -LiteralPath $oldArchive).Hash.ToLowerInvariant() } else { $null })
    $result = [pscustomobject]@{
        Site = $site.ssl_url
        DeployId = $site.published_deploy.id
        PublishedAt = $site.published_deploy.published_at
        FunctionName = 'report'
        ActiveArchiveSha256 = $activeDigest
        FreshSourceArchiveSha256 = $currentDigest
        ActiveMatchesCurrentSource = $activeDigest -eq $currentDigest
        FreshArchiveReferencesLegacyStore = $legacyStoreFound
        OldLocalArchiveSha256 = $oldDigest
        ActiveMatchesOldLocalArchive = [bool]($oldDigest -and $activeDigest -eq $oldDigest)
        EvidenceFile = (Join-Path $output 'verification.json')
    }
    $result | ConvertTo-Json | Set-Content -LiteralPath $result.EvidenceFile
    $result | ConvertTo-Json
    if (-not $result.ActiveMatchesCurrentSource) {
        throw 'The active function differs from this fresh package. A difference needs investigation; it does not by itself prove old tracking code is live.'
    }
} finally { Pop-Location }
