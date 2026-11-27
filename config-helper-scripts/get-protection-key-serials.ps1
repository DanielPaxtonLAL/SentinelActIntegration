param(
  [string]$BaseUrl = 'https://10.6.88.235',
  [switch]$Insecure = $true
)

$ErrorActionPreference = 'Stop'
$baseProductId = '1'
$apiVersion = 'v90'
$spinnerFrames = @('|', '/', '-', '\')
$spinnerIndex = 0
$spinnerVisible = $false
$showSpinner = -not [Console]::IsOutputRedirected
$entitlementCache = [System.Collections.Hashtable]::new([System.StringComparer]::Ordinal)
$productKeyCache = [System.Collections.Hashtable]::new([System.StringComparer]::Ordinal)
$activationCache = [System.Collections.Hashtable]::new([System.StringComparer]::Ordinal)
$customers = $null

function Clear-Spinner {
  if ($script:spinnerVisible) {
    [Console]::Write("`r                              `r")
    $script:spinnerVisible = $false
  }
}

function Show-Spinner {
  if ($script:showSpinner) {
    [Console]::Write("`rLoading protection keys... $($script:spinnerFrames[$script:spinnerIndex % 4])")
    $script:spinnerIndex++
    $script:spinnerVisible = $true
  }
}

function Write-Diagnostic([string]$Message) {
  Clear-Spinner
  [Console]::Error.WriteLine($Message)
}

function Wait-Task($Task) {
  while (-not $Task.IsCompleted) {
    Show-Spinner
    [void]([System.IAsyncResult]$Task).AsyncWaitHandle.WaitOne(120)
  }
  return $Task.GetAwaiter().GetResult()
}

function Invoke-Ems([string]$Path, [string]$Method = 'GET', $Body = $null) {
  $request = [System.Net.Http.HttpRequestMessage]::new(
    [System.Net.Http.HttpMethod]::new($Method), "$script:base$Path")
  try {
    if ($Path -in @('/ems/login.html', '/ems/verifyLogin.html')) {
      $request.Headers.Accept.ParseAdd('*/*')
    } else {
      $request.Headers.Accept.ParseAdd('application/xml')
    }
    if ($null -ne $Body) { $request.Content = $Body }
    $response = Wait-Task ($script:client.SendAsync($request))
    try {
      $content = Wait-Task ($response.Content.ReadAsStringAsync())
      return @{
        Status = [int]$response.StatusCode
        Location = [string]$response.Headers.Location
        Total = if ($response.Headers.Contains('X-Total-Count')) {
          [string](@($response.Headers.GetValues('X-Total-Count'))[0])
        } else { $null }
        Content = $content
      }
    } finally { $response.Dispose() }
  } finally { $request.Dispose() }
}

function Get-Xml($Response, [string]$Description) {
  if ($Response.Status -eq 401 -or $Response.Status -eq 302) {
    throw "EMS session expired while loading $Description."
  }
  if ($Response.Status -lt 200 -or $Response.Status -ge 300) {
    throw "EMS $Description request failed: HTTP $($Response.Status)."
  }
  try {
    return ConvertTo-SafeXml $Response.Content
  } catch {
    throw "EMS returned invalid XML for $Description."
  }
}

function ConvertTo-SafeXml([string]$Content) {
  $settings = [System.Xml.XmlReaderSettings]::new()
  $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
  $settings.XmlResolver = $null
  $reader = [System.Xml.XmlReader]::Create([System.IO.StringReader]::new($Content), $settings)
  try {
    $document = [System.Xml.XmlDocument]::new()
    $document.XmlResolver = $null
    $document.Load($reader)
    return $document
  } finally { $reader.Dispose() }
}

function Get-Text($Node, [string]$Path) {
  if ($null -eq $Node) { return '' }
  $element = $Node.SelectSingleNode($Path)
  if ($null -eq $element) { return '' }
  return $element.InnerText.Trim()
}

function Get-Field($Node, [string]$Name) {
  if ($Node.HasAttribute($Name)) { return $Node.GetAttribute($Name).Trim() }
  return Get-Text $Node $Name
}

function Get-PreferredText($Node, [string[]]$Names) {
  foreach ($name in $Names) {
    $element = $Node.SelectSingleNode($name)
    if ($element) { return $element.InnerText.Trim() }
  }
  return ''
}

function Get-Entitlement([string]$Id) {
  if (-not $script:entitlementCache.ContainsKey($Id)) {
    $response = Invoke-Ems "/ems/$apiVersion/ws/entitlement/$Id.xml"
    $xml = Get-Xml $response 'entitlement'
    if ($xml.DocumentElement.Name -ne 'entitlement') { throw 'EMS returned an invalid entitlement detail.' }
    $script:entitlementCache[$Id] = $xml
  }
  return $script:entitlementCache[$Id]
}

function Get-ProductKey([string]$Id, [string]$EntitlementId) {
  $cacheKey = "$EntitlementId`n$Id"
  if (-not $script:productKeyCache.ContainsKey($cacheKey)) {
    $encoded = [Uri]::EscapeDataString($Id)
    $xml = Get-Xml (Invoke-Ems "/ems/$apiVersion/ws/productKey/$encoded.ws") 'product key'
    if ($xml.DocumentElement.Name -ne 'productKey' -or
        (Get-Text $xml '/productKey/productKeyId') -cne $Id -or
        (Get-Text $xml '/productKey/entitlementId') -cne $EntitlementId) {
      throw 'EMS returned product key details for an unexpected key or entitlement.'
    }
    $references = @(
      foreach ($node in $xml.SelectNodes("//*[translate(local-name(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ_-', 'abcdefghijklmnopqrstuvwxyz')='aid' or translate(local-name(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ_-', 'abcdefghijklmnopqrstuvwxyz')='activationid']")) {
        $aid = $node.InnerText.Trim()
        if ($aid) { [pscustomobject]@{ Aid = $aid; KeyId = $node.GetAttribute('protectionKeyId').Trim() } }
      }
    )
    $script:productKeyCache[$cacheKey] = $references
  }
  return @($script:productKeyCache[$cacheKey])
}

function Get-ActivationKey([string]$Aid) {
  if (-not $script:activationCache.ContainsKey($Aid)) {
    $encoded = [Uri]::EscapeDataString($Aid)
    $xml = Get-Xml (Invoke-Ems "/ems/$apiVersion/ws/activation/$encoded.ws") 'activation'
    $output = $xml.SelectSingleNode('/activation/activationOutput')
    $returnedAid = Get-Text $output 'AID|aid|activationId'
    if (-not $output -or $returnedAid -cne $Aid) {
      throw 'EMS returned activation details for an unexpected Activation ID.'
    }
    $script:activationCache[$Aid] = Get-Text $output 'protectionKeyId'
  }
  return $script:activationCache[$Aid]
}

function Get-Serial($Item, [string]$KeyId) {
  $items = @($Item.OwnerDocument.SelectNodes('/entitlement/entitlementItem') | Where-Object {
    (Get-Text $_ 'lineItemType') -ceq 'Product_Key' -and
      @($_.SelectNodes('productKeyId') | Where-Object { $_.InnerText.Trim() -ceq $KeyId }).Count -gt 0
  })
  $bases = @($items | ForEach-Object { $_.SelectNodes('itemProduct') } | Where-Object {
    (Get-Text $_ 'productId') -ceq $baseProductId
  })
  if ($items.Count -ne 1 -or $bases.Count -ne 1) {
    throw 'Original base product memory is missing or ambiguous.'
  }
  $segments = @($bases[0].SelectNodes('product/memorySegment') | Where-Object {
    (Get-Text $_ 'name') -eq 'Serial Number' -and (Get-Text $_ 'saot') -in @('true', '1')
  })
  if ($segments.Count -ne 1) { throw 'Original Serial Number memory is missing or invalid.' }
  $segment = $segments[0]
  $segmentId = Get-Text $segment 'id'
  $saved = @($items[0].SelectNodes('memorySegments/segment|memorySegments/memorySegment|memorySegments[prdMemorySegmentId or productMemorySegmentId]') | Where-Object {
    $segmentId -and (Get-PreferredText $_ @('prdMemorySegmentId', 'productMemorySegmentId')) -ceq $segmentId
  } | Select-Object -First 1)
  $data = if ($saved.Count -gt 0 -and $saved[0].SelectSingleNode('data|text|content')) {
    Get-PreferredText $saved[0] @('data', 'text', 'content')
  } else { Get-PreferredText $segment @('text', 'content') }
  if ($data -notmatch '^(?:[0-9a-fA-F]{2})+$') {
    throw 'Original Serial Number memory is missing or invalid.'
  }
  $digits = -join @(for ($i = 0; $i -lt $data.Length; $i += 2) {
    [char][Convert]::ToInt32($data.Substring($i, 2), 16)
  })
  if ($digits -notmatch '^[0-9a-fA-F]+$') {
    throw 'Original Serial Number memory is missing or invalid.'
  }
  $number = [System.Numerics.BigInteger]::Parse("0$digits", [System.Globalization.NumberStyles]::AllowHexSpecifier)
  return $number.ToString().PadLeft(5, '0')
}

function Get-KeyEntitlements([string]$KeyId) {
  $encoded = [Uri]::EscapeDataString($KeyId)
  $response = Invoke-Ems "/ems/$apiVersion/ws/target/$encoded/entitlement.ws"
  $xml = Get-Xml $response 'protection key entitlement list'
  $root = $xml.DocumentElement
  if ($root.Name -eq 'entitlementListResponse') {
    $nodes = @($root.SelectNodes('entitlementInstance'))
    $attribute = 'entId'
  } elseif ($root.Name -eq 'listResponse') {
    $nodes = @($root.SelectNodes('instance'))
    $attribute = 'id'
  } else { throw 'EMS returned an invalid protection key entitlement list.' }
  $count = if ($root.HasAttribute('count')) { $root.GetAttribute('count') } else { Get-Text $root 'count' }
  if (-not $count) { $count = $response.Total }
  if ($count -notmatch '^\d+$' -or [System.Numerics.BigInteger]::Parse($count) -ne $nodes.Count -or
      ($null -ne $response.Total -and ($response.Total -notmatch '^\d+$' -or
        [System.Numerics.BigInteger]::Parse($response.Total) -ne [System.Numerics.BigInteger]::Parse($count)))) {
    throw 'EMS returned an incomplete or invalid protection key entitlement list.'
  }
  $ids = @($nodes | ForEach-Object { Get-Field $_ $attribute })
  $uniqueIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  foreach ($id in $ids) {
    if (-not $uniqueIds.Add($id)) { throw 'EMS returned an incomplete or invalid protection key entitlement list.' }
  }
  if (@($ids | Where-Object { $_ -notmatch '^[1-9]\d*$' }).Count -or
      $uniqueIds.Count -ne $ids.Count) {
    throw 'EMS returned an incomplete or invalid protection key entitlement list.'
  }
  return $ids
}

function Get-Counter([string]$KeyId, [string]$Aid) {
  $key = [Uri]::EscapeDataString($KeyId)
  $activation = [Uri]::EscapeDataString($Aid)
  $xml = Get-Xml (Invoke-Ems "/ems/$apiVersion/ws/target/$key/activation.ws?AID=$activation") 'key history'
  $node = $xml.SelectSingleNode('/sentinel_ldk_info/key|/ProtectionKey/ProtectionKeyOutput/C2V/sentinel_ldk_info/key|/ProtectionKey/ProtectionKeyOutput/UpdateInfo/sentinel_ldk_info/key')
  if (-not $node) {
    $update = Get-Text $xml '/ProtectionKey/ProtectionKeyOutput/UpdateInfo'
    if ($update) {
      try { $wrapped = ConvertTo-SafeXml $update } catch { throw 'EMS returned invalid key history.' }
      $node = $wrapped.SelectSingleNode('/sentinel_ldk_info/key')
    }
  }
  $counter = Get-Text $node 'update_counter'
  if ((Get-Text $node 'id') -cne $KeyId -or $counter -notmatch '^\d+$') {
    throw 'EMS returned invalid or unexpected key history.'
  }
  return [System.Numerics.BigInteger]::Parse($counter)
}

function Get-CurrentCustomer([string]$KeyId) {
  $ids = @(Get-KeyEntitlements $KeyId)
  $entries = [System.Collections.Hashtable]::new([System.StringComparer]::Ordinal)
  $originals = @()
  $candidates = @()
  foreach ($id in $ids) {
    $xml = Get-Entitlement $id
    $items = @($xml.SelectNodes('/entitlement/entitlementItem'))
    $types = @($items | ForEach-Object { Get-Text $_ 'lineItemType' })
    if (-not $types.Count -or @($types | Where-Object { -not $_ }).Count) {
      throw 'An entitlement has invalid line item types.'
    }
    $original = $types -ccontains 'Product_Key'
    $update = $types -ccontains 'ProtectionKey_Update'
    if ($original -and $update) { throw 'An entitlement has ambiguous line item types.' }
    if ($original -or $update) { $entries[$id] = $xml }
    if ($original) { $originals += $id }
    $keyIds = @()
    foreach ($item in $items) {
      $type = Get-Text $item 'lineItemType'
      if ($type -cnotin @('Product_Key', 'ProtectionKey_Update')) { continue }
      $itemKeys = @($item.SelectNodes('productKeyId') | ForEach-Object { $_.InnerText.Trim() })
      if ($type -ceq 'ProtectionKey_Update' -and -not $itemKeys.Count) {
        throw 'An entitlement has incomplete activation history.'
      }
      if (@($itemKeys | Where-Object { -not $_ }).Count) { throw 'EMS returned an invalid product key ID.' }
      $keyIds += $itemKeys
    }
    $seenProductKeys = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($productKeyId in $keyIds) {
      if (-not $seenProductKeys.Add($productKeyId)) { continue }
      $references = @(Get-ProductKey $productKeyId $id)
      if (-not $references.Count) { throw 'An entitlement has incomplete activation history.' }
      foreach ($reference in $references) {
        $candidates += [pscustomobject]@{ Aid = $reference.Aid; KeyId = $reference.KeyId; EntitlementId = $id }
      }
    }
  }
  if ($originals.Count -ne 1) { throw 'The original entitlement is missing or ambiguous.' }
  $keysByAid = [System.Collections.Hashtable]::new([System.StringComparer]::Ordinal)
  foreach ($candidate in $candidates) {
    if (-not $keysByAid.ContainsKey($candidate.Aid)) {
      $keysByAid[$candidate.Aid] = [System.Collections.Hashtable]::new([System.StringComparer]::Ordinal)
    }
    $keysByAid[$candidate.Aid][$candidate.KeyId] = $true
  }
  $byAid = [System.Collections.Hashtable]::new([System.StringComparer]::Ordinal)
  foreach ($candidate in $candidates) {
    if (-not $candidate.KeyId -or $keysByAid[$candidate.Aid].Count -ne 1) {
      throw 'An activation has a missing or conflicting protection key ID.'
    }
    if ($candidate.KeyId -cne $KeyId) { continue }
    if ((Get-ActivationKey $candidate.Aid) -cne $KeyId) {
      throw 'An activation has a missing or unexpected protection key ID.'
    }
    $counter = Get-Counter $KeyId $candidate.Aid
    if ($byAid.ContainsKey($candidate.Aid) -and
        ($byAid[$candidate.Aid].EntitlementId -cne $candidate.EntitlementId -or
         $byAid[$candidate.Aid].Counter -ne $counter)) {
      throw 'Activation history contains conflicting records.'
    }
    $byAid[$candidate.Aid] = [pscustomobject]@{ EntitlementId = $candidate.EntitlementId; Counter = $counter }
  }
  $ordered = @($byAid.Values | Sort-Object Counter)
  $coveredIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  foreach ($entry in $ordered) { [void]$coveredIds.Add($entry.EntitlementId) }
  if ($ordered.Count -ne $entries.Count -or -not $ordered.Count -or
      $ordered[0].EntitlementId -cne $originals[0] -or $coveredIds.Count -ne $entries.Count) {
    throw 'Activation counters do not uniquely cover the original and every update.'
  }
  for ($i = 0; $i -lt $ordered.Count; $i++) {
    if ($ordered[$i].Counter -ne $i -or -not $entries.ContainsKey($ordered[$i].EntitlementId)) {
      throw 'Activation counters do not uniquely cover the original and every update.'
    }
  }
  $latest = $entries[$ordered[-1].EntitlementId]
  $customerNode = $latest.SelectSingleNode('/entitlement/customer')
  $customer = if ($customerNode -and -not $customerNode.SelectSingleNode('*')) {
    $customerNode.InnerText.Trim()
  } else { '' }
  if ($customer) { return $customer }
  $customerId = Get-Text $latest '/entitlement/customerId'
  if ($customerId -notmatch '^[1-9]\d*$') { throw 'The latest entitlement customer is unavailable.' }
  if ($null -eq $script:customers) {
    $response = Get-Xml (Invoke-Ems "/ems/$apiVersion/ws/customer.xml") 'customer list'
    if ($response.DocumentElement.Name -ne 'listResponse') { throw 'EMS returned an invalid customer list.' }
    $script:customers = @($response.SelectNodes('/listResponse/instance'))
  }
  $matches = @($script:customers | Where-Object {
    $id = Get-Field $_ 'customerId'
    if (-not $id) { $id = Get-Field $_ 'id' }
    $id -ceq $customerId
  })
  if ($matches.Count -ne 1) { throw "Customer $customerId was not found or is ambiguous." }
  $name = Get-Field $matches[0] 'name'
  if (-not $name) { $name = Get-Field $matches[0] 'customerName' }
  if (-not $name) { throw "Customer $customerId was not found or is ambiguous." }
  return $name
}

try {
  $uri = [Uri]$BaseUrl
  if ($uri.Scheme -notin @('http', 'https') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') {
    throw 'EMS URL must be an HTTP(S) origin without credentials or a path.'
  }
  $base = $uri.AbsoluteUri.TrimEnd('/')
  $credential = Get-Credential -Message 'Enter your EMS credentials'
  if (-not $credential) { throw 'EMS credentials are required.' }

  Add-Type -AssemblyName System.Net.Http
  Add-Type -AssemblyName System.Numerics
  if ($Insecure -and -not ('SentinelSerialsTls' -as [type])) {
    Add-Type -ReferencedAssemblies 'System.Net.Http' -TypeDefinition @'
using System;
using System.Net.Http;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
public static class SentinelSerialsTls {
  public static Func<HttpRequestMessage, X509Certificate2, X509Chain, SslPolicyErrors, bool> Callback {
    get { return Accept; }
  }
  public static bool Accept(HttpRequestMessage request, X509Certificate2 certificate, X509Chain chain, SslPolicyErrors errors) {
    return true;
  }
}
'@
  }
  $handler = [System.Net.Http.HttpClientHandler]::new()
  $handler.AllowAutoRedirect = $false
  $handler.UseCookies = $true
  if ($Insecure) {
    $handler.ServerCertificateCustomValidationCallback = [SentinelSerialsTls]::Callback
  }
  $client = [System.Net.Http.HttpClient]::new($handler)
  $loginPage = Invoke-Ems '/ems/login.html'
  if ($loginPage.Status -lt 200 -or $loginPage.Status -ge 300) { throw "EMS login page failed: HTTP $($loginPage.Status)." }
  $fields = [System.Collections.Generic.Dictionary[string,string]]::new()
  $fields.Add('username', $credential.UserName)
  $fields.Add('password', $credential.GetNetworkCredential().Password)
  $fields.Add('user_type', 'ISV')
  $login = Invoke-Ems '/ems/verifyLogin.html' 'POST' ([System.Net.Http.FormUrlEncodedContent]::new($fields))
  $fields.Clear()
  $credential = $null
  if ($login.Status -ne 302 -or $login.Location -notmatch 'homePage' -or
      -not ($handler.CookieContainer.GetCookies([Uri]"$base/ems/") | Where-Object Name -eq 'JSESSIONID')) {
    throw "EMS did not confirm login (HTTP $($login.Status)). Check the EMS account type and login requirements."
  }

  $entitlements = @()
  $seen = [System.Collections.Hashtable]::new([System.StringComparer]::Ordinal)
  $total = $null
  for ($page = 1; ; $page++) {
    $response = Invoke-Ems "/ems/$apiVersion/ws/entitlement.ws?pageIndex=$page&pageSize=100"
    $xml = Get-Xml $response 'entitlement list'
    if ($xml.DocumentElement.Name -ne 'listResponse' -or $response.Total -notmatch '^\d+$') {
      throw 'EMS returned an invalid entitlement list or count.'
    }
    if ($null -ne $total -and $total -ne $response.Total) { throw 'EMS entitlement count changed while paging; retry.' }
    $total = $response.Total
    $instances = @($xml.SelectNodes('/listResponse/instance'))
    foreach ($instance in $instances) {
      $id = Get-Field $instance 'id'
      if (-not $id) { $id = Get-Field $instance 'entitlementId' }
      if ($id -notmatch '^[1-9]\d*$' -or $seen.ContainsKey($id)) {
        throw 'EMS returned an invalid or duplicate entitlement ID while paging.'
      }
      $seen[$id] = $true
      $entitlements += $id
    }
    if ($entitlements.Count -gt [System.Numerics.BigInteger]::Parse($total) -or
        (-not $instances.Count -and $entitlements.Count -lt [System.Numerics.BigInteger]::Parse($total))) {
      throw 'EMS returned an incomplete entitlement list.'
    }
    if ($entitlements.Count -eq [System.Numerics.BigInteger]::Parse($total)) { break }
  }

  $byKey = [System.Collections.Hashtable]::new([System.StringComparer]::Ordinal)
  $unactivated = 0
  foreach ($id in $entitlements) {
    $xml = Get-Entitlement $id
    $items = @($xml.SelectNodes('/entitlement/entitlementItem'))
    $productKeys = [System.Collections.Hashtable]::new([System.StringComparer]::Ordinal)
    foreach ($item in $items) {
      if ((Get-Text $item 'lineItemType') -cne 'Product_Key') { continue }
      foreach ($keyNode in $item.SelectNodes('productKeyId')) {
        $productKeyId = $keyNode.InnerText.Trim()
        if (-not $productKeyId) { throw 'EMS returned an invalid product key ID.' }
        $productKeys[$productKeyId] = $item
      }
    }
    foreach ($productKeyId in $productKeys.Keys) {
      $references = @(Get-ProductKey $productKeyId $id)
      if (-not $references.Count) { $unactivated++; continue }
      try { $serial = Get-Serial $productKeys[$productKeyId] $productKeyId } catch {
        throw "Entitlement ${id}: $($_.Exception.Message)"
      }
      $seenAids = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
      foreach ($aid in $references.Aid) {
        if (-not $seenAids.Add($aid)) { continue }
        $keyId = Get-ActivationKey $aid
        if (-not $keyId) { throw "Entitlement ${id}: an activation has no protection key ID." }
        if ($byKey.ContainsKey($keyId) -and $byKey[$keyId] -cne $serial) {
          throw "Protection key $keyId has conflicting serial numbers."
        }
        $byKey[$keyId] = $serial
      }
    }
  }
  if ($unactivated) { Write-Diagnostic "$unactivated product key(s) have no activation and were excluded." }
  $rows = @(
    foreach ($id in $byKey.Keys) {
      try { $customer = Get-CurrentCustomer $id } catch {
        $customer = 'Unavailable'
        Write-Diagnostic "Protection key ${id}: current customer unavailable: $($_.Exception.Message)"
      }
      [pscustomobject]@{
        'Serial Number' = $byKey[$id]
        'Protection Key ID' = $id
        'Current Customer' = $customer -replace '[\x00-\x1f\x7f]+', ' '
        SortSerial = [System.Numerics.BigInteger]::Parse($byKey[$id])
      }
    }
  )
  Clear-Spinner
  $columns = @('Serial Number', 'Protection Key ID', 'Current Customer')
  $widths = @($columns | ForEach-Object { $_.Length })
  foreach ($row in $rows) {
    for ($i = 0; $i -lt $columns.Count; $i++) {
      $widths[$i] = [Math]::Max($widths[$i], $row.($columns[$i]).Length)
    }
  }
  $formatRow = {
    param($values)
    $cells = for ($i = 0; $i -lt $columns.Count; $i++) { $values[$i].PadRight($widths[$i]) }
    ($cells -join '  ').TrimEnd()
  }
  Write-Output (& $formatRow $columns)
  Write-Output (($widths | ForEach-Object { '-' * $_ }) -join '  ')
  foreach ($row in @($rows | Sort-Object -Property @{ Expression = 'SortSerial'; Descending = $true }, 'Protection Key ID')) {
    Write-Output (& $formatRow @($row.'Serial Number', $row.'Protection Key ID', $row.'Current Customer'))
  }
} catch {
  Clear-Spinner
  $errorDetail = $_.Exception
  while ($errorDetail.InnerException) { $errorDetail = $errorDetail.InnerException }
  [Console]::Error.WriteLine("Unable to list protection keys: $($errorDetail.Message)")
  exit 1
} finally {
  Clear-Spinner
  if ($client) { $client.Dispose() }
  if ($handler) { $handler.Dispose() }
  $credential = $null
  if ($fields) { $fields.Clear() }
}
