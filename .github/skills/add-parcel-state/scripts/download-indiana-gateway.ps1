param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot "../../../../assets/indiana"),
  [string]$PayYear = "2025"
)

$ErrorActionPreference = "Stop"
$baseUrl = "https://gateway.ifionline.org/public/download.aspx"
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

# Gateway uses an ASP.NET Web Forms POST that returns each selected county as a ZIP.
$initialSession = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
$initialHtml = (Invoke-WebRequest -Uri $baseUrl -WebSession $initialSession -UseBasicParsing -TimeoutSec 90).Content
$countySelect = [regex]::Match($initialHtml, '(?s)<select[^>]*id="ctl00_ContentPlaceHolder1_DropDownList3"[^>]*>(.*?)</select>')
if (-not $countySelect.Success) { throw "Could not find the Gateway county selector." }
$options = [regex]::Matches($countySelect.Groups[1].Value, '<option[^>]*value="([^"]*)"[^>]*>(.*?)</option>')
$counties = foreach ($option in $options) {
  $code = $option.Groups[1].Value
  $name = [System.Net.WebUtility]::HtmlDecode(([regex]::Replace($option.Groups[2].Value, '<[^>]+>', '')).Trim())
  if ($code -match '^\d{2}$') { [pscustomobject]@{ Code = $code; Name = $name } }
}
if (@($counties).Count -ne 92) { throw "Expected 92 Indiana counties; Gateway returned $(@($counties).Count). No downloads started." }

$completed = 0
$totalBytes = 0L
$failures = [System.Collections.Generic.List[string]]::new()
foreach ($county in $counties) {
  $gatewayName = if ($county.Code -eq '71') { 'st.joseph' } else { $county.Name }
  $expectedPrefix = "realparcel_$($gatewayName)_$($county.Code)_$($PayYear)p$([int]$PayYear + 1)"
  $existing = Get-ChildItem -LiteralPath $OutputDirectory -Filter ($expectedPrefix + ".zip") -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($existing -and $existing.Length -gt 1000) {
    $completed += 1
    $totalBytes += $existing.Length
    Write-Output ("SKIP {0} {1}: already present ({2} bytes)" -f $county.Code, $county.Name, $existing.Length)
    continue
  }

  $session = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
  $temporaryPath = Join-Path $env:TEMP ("gateway-realparcel-{0}.zip" -f $county.Code)
  try {
    $html = (Invoke-WebRequest -Uri $baseUrl -WebSession $session -UseBasicParsing -TimeoutSec 90).Content
    $fields = @{}
    foreach ($tag in [regex]::Matches($html, '<input\b[^>]*>')) {
      $nameMatch = [regex]::Match($tag.Value, '\bname="([^"]*)"')
      $valueMatch = [regex]::Match($tag.Value, '\bvalue="([^"]*)"')
      if ($nameMatch.Success -and $valueMatch.Success) {
        $fields[[System.Net.WebUtility]::HtmlDecode($nameMatch.Groups[1].Value)] = [System.Net.WebUtility]::HtmlDecode($valueMatch.Groups[1].Value)
      }
    }
    $fields['ctl00$ContentPlaceHolder1$DropDownList1'] = '5'
    $fields['ctl00$ContentPlaceHolder1$DropDownList2'] = $PayYear
    $fields['ctl00$ContentPlaceHolder1$DropDownList3'] = $county.Code
    $fields['ctl00$ContentPlaceHolder1$button2'] = 'Download'

    $response = Invoke-WebRequest -Uri $baseUrl -Method Post -WebSession $session -Body $fields -ContentType 'application/x-www-form-urlencoded' -UseBasicParsing -OutFile $temporaryPath -PassThru -TimeoutSec 900
    $item = Get-Item -LiteralPath $temporaryPath
    $prefix = [System.IO.File]::ReadAllBytes($temporaryPath)
    $signature = if ($prefix.Length -ge 2) { [System.Text.Encoding]::ASCII.GetString($prefix, 0, 2) } else { '' }
    if ($item.Length -lt 1000 -or $signature -ne 'PK' -or $response.Headers['Content-Type'] -notmatch 'octet-stream|zip') {
      throw ("Gateway returned a non-ZIP response (type={0}, bytes={1})." -f $response.Headers['Content-Type'], $item.Length)
    }

    $contentDisposition = [string]$response.Headers['Content-Disposition']
    $fileMatch = [regex]::Match($contentDisposition, 'filename\*?="?([^";]+)"?', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    $fileName = if ($fileMatch.Success) { [uri]::UnescapeDataString($fileMatch.Groups[1].Value) } else { $expectedPrefix + '.zip' }
    if ($county.Code -eq '01') { $fileName = 'RealParcel_Adams_01_{0}P{1}.zip' -f $PayYear, ([int]$PayYear + 1) }
    $fileName = $fileName -replace '[<>:"/\\|?*]', '_'
    Move-Item -LiteralPath $temporaryPath -Destination (Join-Path $OutputDirectory $fileName) -Force
    $completed += 1
    $totalBytes += $item.Length
    Write-Output ("OK {0} {1}: {2:N0} bytes ({3})" -f $county.Code, $county.Name, $item.Length, $fileName)
  } catch {
    if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue }
    $failures.Add(("{0} {1}: {2}" -f $county.Code, $county.Name, $_.Exception.Message))
    Write-Output ("FAIL {0} {1}: {2}" -f $county.Code, $county.Name, $_.Exception.Message)
  }
}

Write-Output ("Finished: {0}/92 county ZIPs available; {1:N0} total bytes." -f $completed, $totalBytes)
if ($failures.Count) {
  Write-Output "Failures:"
  $failures | ForEach-Object { Write-Output "  $_" }
  exit 1
}
