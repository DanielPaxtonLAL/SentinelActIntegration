param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateNotNullOrEmpty()]
  [string]$BaseUrl
)

$ErrorActionPreference = 'Stop'
$previousCertificateCallback = $null
$restoreCertificateCallback = $false

function Get-ConfigValue([string]$Name) {
  if (Test-Path "Env:$Name") {
    return (Get-Item "Env:$Name").Value
  }

  $envFile = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
  if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
      if ($line -match "^\s*$([regex]::Escape($Name))\s*=\s*(.*?)\s*$") {
        $value = $Matches[1]
        if ($value -match '^([''"])(.*?)\1(?:\s+#.*)?$') {
          return $Matches[2]
        }
        return ($value -replace '\s+#.*$', '')
      }
    }
  }
  return $null
}

function Get-EmsConnectionValue([string]$Name) {
  if ($emsPrefix) { return Get-ConfigValue "${emsPrefix}_EMS_$Name" }
  return Get-ConfigValue "EMS_$Name"
}

try {
  $uri = [Uri]$BaseUrl
  if ($uri.Scheme -notin @('http', 'https')) {
    throw 'Base URL must use http or https.'
  }
  $base = $BaseUrl.TrimEnd('/')
  $matchingPrefixes = @(
    foreach ($prefix in @('PRODUCTION', 'TEST')) {
      $configuredUrl = Get-ConfigValue "${prefix}_EMS_URL"
      if ($configuredUrl) {
        $configuredUri = [Uri]$configuredUrl
        if ([string]::Equals($uri.AbsoluteUri.TrimEnd('/'), $configuredUri.AbsoluteUri.TrimEnd('/'), [StringComparison]::Ordinal)) {
          $prefix
        }
      }
    }
  )
  if ($matchingPrefixes.Count -gt 1) { throw 'The test and production EMS URLs must be different to select helper settings.' }
  $emsPrefix = if ($matchingPrefixes.Count -eq 1) { $matchingPrefixes[0] } else { $null }
  $requestOptions = @{}
  if ($uri.Scheme -eq 'https' -and (Get-EmsConnectionValue 'INSECURE') -eq '1') {
    Write-Warning 'EMS insecure mode disables certificate verification for EMS requests, including redirects. Use only temporarily on a trusted network.'
    $requestOptions.DisableKeepAlive = $true
    if ($PSVersionTable.PSVersion.Major -ge 6) {
      $requestOptions.SkipCertificateCheck = $true
    } else {
      if (-not ('SentinelEmsCertificateValidator' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Net;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;

public sealed class SentinelEmsCertificateValidator {
  private readonly string host;
  private readonly int port;
  private readonly RemoteCertificateValidationCallback previous;

  private SentinelEmsCertificateValidator(string host, int port, RemoteCertificateValidationCallback previous) {
    this.host = host;
    this.port = port;
    this.previous = previous;
  }

  public static RemoteCertificateValidationCallback Create(string host, int port, RemoteCertificateValidationCallback previous) {
    return new RemoteCertificateValidationCallback(new SentinelEmsCertificateValidator(host, port, previous).Validate);
  }

  private bool Validate(object sender, X509Certificate certificate, X509Chain chain, SslPolicyErrors errors) {
    var request = sender as HttpWebRequest;
    if (request != null && request.RequestUri.Port == port &&
        String.Equals(request.RequestUri.Host, host, StringComparison.OrdinalIgnoreCase)) return true;
    return previous != null ? previous(sender, certificate, chain, errors) : errors == SslPolicyErrors.None;
  }
}
'@
      }
      $previousCertificateCallback = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
      [System.Net.ServicePointManager]::ServerCertificateValidationCallback =
        [SentinelEmsCertificateValidator]::Create($uri.Host, $uri.Port, $previousCertificateCallback)
      $restoreCertificateCallback = $true
    }
  }
  $apiVersion = Get-EmsConnectionValue 'API_VERSION'
  if (-not $apiVersion) { $apiVersion = 'v90' }
  if ($apiVersion -notmatch '^v\d+$') { throw 'EMS API version must look like v90.' }

  $vendorId = Get-ConfigValue 'EMS_VENDOR_ID'
  if (-not $vendorId) { $vendorId = '2' }
  if ($vendorId -notmatch '^[1-9]\d*$') { throw 'EMS_VENDOR_ID must be a positive number.' }

  $username = Get-ConfigValue 'EMS_USER'
  $password = Get-ConfigValue 'EMS_PASS'
  $userType = Get-EmsConnectionValue 'USER_TYPE'
  if (-not $userType) { $userType = 'ISV' }
  if (-not $username -or -not $password) {
    $credential = Get-Credential -Message 'Enter your EMS credentials'
    if (-not $credential) { throw 'EMS credentials are required.' }
    $username = $credential.UserName
    $password = $credential.GetNetworkCredential().Password
  }

  # TODO: Revisit this login flow and swap the order of authentication.
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  Invoke-WebRequest -Uri "$base/ems/login.html" -WebSession $session -UseBasicParsing @requestOptions | Out-Null
  $login = Invoke-WebRequest -Uri "$base/ems/verifyLogin.html" `
    -Method Post `
    -ContentType 'application/x-www-form-urlencoded' `
    -Body @{ username = $username; password = $password; user_type = $userType } `
    -WebSession $session `
    -UseBasicParsing @requestOptions

  if ($login.BaseResponse.ResponseUri.AbsolutePath -notmatch 'homePage' -or
      -not ($session.Cookies.GetCookies([Uri]"$base/ems/") | Where-Object Name -eq 'JSESSIONID')) {
    throw 'EMS login failed. Check the URL, credentials, and EMS_USER_TYPE.'
  }

  $products = [System.Collections.Generic.List[object]]::new()
  $seenIds = [System.Collections.Generic.HashSet[string]]::new()
  $pageSize = 100
  for ($page = 1; ; $page++) {
    $productUrl = "$base/ems/$apiVersion/ws/vendor/$vendorId/product.ws?pageIndex=$page&pageSize=$pageSize"
    $response = Invoke-WebRequest -Uri $productUrl -Headers @{ Accept = 'application/xml' } `
      -WebSession $session -UseBasicParsing @requestOptions
    if ($response.BaseResponse.ResponseUri.AbsolutePath -match 'login') {
      throw 'EMS session expired while retrieving products.'
    }

    $document = [xml]$response.Content
    if (-not $document.listResponse) {
      throw "EMS returned an invalid product list on page $page."
    }
    $instances = @($document.SelectNodes('/listResponse/instance'))
    foreach ($instance in $instances) {
      $id = $instance.GetAttribute('id')
      $name = $instance.GetAttribute('name')
      if ($id -notmatch '^[1-9]\d*$' -or -not $name) {
        throw "EMS returned a product with a missing or invalid ID/name on page $page."
      }
      if (-not $seenIds.Add($id)) {
        throw "EMS returned duplicate product ID $id while paging."
      }
      $products.Add([pscustomobject]@{
        InternalId = $id
        Name       = $name
      })
    }
    if ($instances.Count -lt $pageSize) { break }
  }

  if ($products.Count -eq 0) {
    Write-Output 'No products found.'
  } else {
    $products | Sort-Object Name | Format-Table -AutoSize
  }
} catch {
  Write-Error $_.Exception.Message
  exit 1
} finally {
  if ($restoreCertificateCallback) {
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $previousCertificateCallback
  }
}
