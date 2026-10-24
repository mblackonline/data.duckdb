# Entra setup with PowerShell

Run each block in order in the same PowerShell window. Requires Azure CLI. Check the expected output before continuing.

Use an Application Administrator or Cloud Application Administrator account authorized for this setup.

## 1. Sign in

Enter the tenant ID and administrator's sign-in name. Select that account in Microsoft's sign-in window.

~~~powershell
$ErrorActionPreference = 'Stop'
$TenantId = ([guid](Read-Host 'Target tenant ID')).ToString()
$AdminUpn = (Read-Host 'Administrator sign-in name').Trim()
az login --tenant $TenantId --allow-no-subscriptions --output none
if ($LASTEXITCODE -ne 0) { throw 'Sign-in failed.' }
$Context = az account show --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $Context.tenantId -ne $TenantId -or $Context.user.name -ne $AdminUpn) { throw 'Wrong tenant or account.' }
[pscustomobject]@{ Tenant = $Context.tenantId; Account = $Context.user.name }
~~~

Expected: the intended tenant ID and administrator account.

## 2. Set application variables

~~~powershell
$AppPrefix = (Read-Host 'Application prefix (include environment)').Trim()
if ($AppPrefix -notmatch '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$') { throw 'Use letters, numbers, spaces, dots, underscores or hyphens.' }
$RedirectUri = (Read-Host 'Approved exact SPA return URL').Trim()
$ReturnUrl = [uri]$RedirectUri
if (-not $ReturnUrl.IsAbsoluteUri -or $ReturnUrl.UserInfo -or $ReturnUrl.Query -or $ReturnUrl.Fragment -or $RedirectUri.Contains('*') -or
    ($ReturnUrl.Scheme -ne 'https' -and -not ($ReturnUrl.Scheme -eq 'http' -and $ReturnUrl.Host -eq 'localhost'))) { throw 'Use HTTPS or localhost HTTP, without wildcards, credentials, queries or fragments.' }
$ApiName = "$AppPrefix API"
$WebName = "$AppPrefix Web"
$ScopeName = 'Reports.Generate'
$RoleValue = 'AI.ReportUser'
~~~

Check localhost port availability before using the selected return URL.

## 3. Create the API registration

If a name already exists, inspect the existing registration before continuing.

~~~powershell
if ((az account show --query tenantId --output tsv) -ne $TenantId) { throw 'Wrong tenant.' }
foreach ($Name in @($ApiName, $WebName)) {
    $Candidates = az ad app list --display-name $Name --all --output json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'Could not check existing registrations.' }
    $Existing = @($Candidates | Where-Object { $_.displayName -eq $Name })
    if ($Existing.Count) { throw "Registration already exists: $Name. Review before continuing." }
}
$Api = az ad app create --display-name $ApiName --sign-in-audience AzureADMyOrg --requested-access-token-version 2 --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $Api.id) { throw 'API registration failed.' }
[pscustomobject]@{ Audience = $Api.signInAudience; RequestedPermissions = $Api.requiredResourceAccess.Count; Secrets = $Api.passwordCredentials.Count; Certificates = $Api.keyCredentials.Count }
~~~

Expected: AzureADMyOrg and three zero counts.

## 4. Define the API scope and role

JSON request bodies use UTF-8 files to avoid Windows quoting issues. Keep these files local.

~~~powershell
if ((az account show --query tenantId --output tsv) -ne $TenantId) { throw 'Wrong tenant.' }
$ScopeId = [guid]::NewGuid().ToString()
$RoleId = [guid]::NewGuid().ToString()
$ApiUri = 'api://' + $Api.appId
$ApiScope = $ApiUri + '/' + $ScopeName
$Body = @{
    identifierUris = @($ApiUri)
    api = @{ requestedAccessTokenVersion = 2; oauth2PermissionScopes = @(@{
        id = $ScopeId; value = $ScopeName; type = 'Admin'; isEnabled = $true
        adminConsentDisplayName = 'Generate AI reports'
        adminConsentDescription = 'Allow the web application to request AI report generation on behalf of the signed-in user.'
    }) }
    appRoles = @(@{
        id = $RoleId; value = $RoleValue; allowedMemberTypes = @('User'); isEnabled = $true
        displayName = 'AI report user'
        description = 'Allows an explicitly assigned user to request AI report generation.'
    })
} | ConvertTo-Json -Depth 8
$PayloadFile = Join-Path $env:TEMP ('entra-api-' + [guid]::NewGuid() + '.json')
[IO.File]::WriteAllText($PayloadFile, $Body, [Text.UTF8Encoding]::new($false))
az rest --method patch --url ("https://graph.microsoft.com/v1.0/applications/" + $Api.id) --headers 'Content-Type=application/json' --body "@$PayloadFile"
if ($LASTEXITCODE -ne 0) { throw 'API configuration failed.' }
$Api = az ad app show --id $Api.appId --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'API readback failed.' }
[pscustomobject]@{ TokenVersion = $Api.api.requestedAccessTokenVersion; Scope = $Api.api.oauth2PermissionScopes.value; Consent = $Api.api.oauth2PermissionScopes.type; Role = $Api.appRoles.value; Members = $Api.appRoles.allowedMemberTypes -join ',' }
~~~

Expected: 2, Reports.Generate, Admin, AI.ReportUser, User.

## 5. Create the API enterprise application

~~~powershell
if ((az account show --query tenantId --output tsv) -ne $TenantId) { throw 'Wrong tenant.' }
$Body = @{ appId = $Api.appId; appRoleAssignmentRequired = $true } | ConvertTo-Json
$PayloadFile = Join-Path $env:TEMP ('entra-api-sp-' + [guid]::NewGuid() + '.json')
[IO.File]::WriteAllText($PayloadFile, $Body, [Text.UTF8Encoding]::new($false))
$ApiSp = az rest --method post --url 'https://graph.microsoft.com/v1.0/servicePrincipals' --headers 'Content-Type=application/json' --body "@$PayloadFile" --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $ApiSp.id) { throw 'API enterprise application creation failed.' }
$ApiSp = az ad sp show --id $Api.appId --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $ApiSp.appRoleAssignmentRequired -ne $true) { throw 'API assignment requirement not confirmed.' }
$ApiSp | Select-Object displayName, appRoleAssignmentRequired
~~~

Expected: the API name and True.

## 6. Create and configure the web registration

Configure the SPA return URL and request only Reports.Generate.

~~~powershell
if ((az account show --query tenantId --output tsv) -ne $TenantId) { throw 'Wrong tenant.' }
$Web = az ad app create --display-name $WebName --sign-in-audience AzureADMyOrg --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $Web.id) { throw 'Web registration failed.' }
$Body = @{
    spa = @{ redirectUris = @($RedirectUri) }
    web = @{ implicitGrantSettings = @{ enableAccessTokenIssuance = $false; enableIdTokenIssuance = $false } }
    isFallbackPublicClient = $false
    requiredResourceAccess = @(@{ resourceAppId = $Api.appId; resourceAccess = @(@{ id = $ScopeId; type = 'Scope' }) })
} | ConvertTo-Json -Depth 8
$PayloadFile = Join-Path $env:TEMP ('entra-web-' + [guid]::NewGuid() + '.json')
[IO.File]::WriteAllText($PayloadFile, $Body, [Text.UTF8Encoding]::new($false))
az rest --method patch --url ("https://graph.microsoft.com/v1.0/applications/" + $Web.id) --headers 'Content-Type=application/json' --body "@$PayloadFile"
if ($LASTEXITCODE -ne 0) { throw 'Web configuration failed.' }
$Web = az ad app show --id $Web.appId --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Web readback failed.' }
$Resources = @($Web.requiredResourceAccess)
$Permissions = @($Resources.resourceAccess)
if ($Resources.Count -ne 1 -or $Resources[0].resourceAppId -ne $Api.appId -or $Permissions.Count -ne 1 -or
    $Permissions[0].id -ne $ScopeId -or $Permissions[0].type -ne 'Scope') { throw 'Unexpected web API permission request.' }
[pscustomobject]@{ ReturnUrl = $Web.spa.redirectUris -join ','; ImplicitAccessTokens = $Web.web.implicitGrantSettings.enableAccessTokenIssuance; ImplicitIdTokens = $Web.web.implicitGrantSettings.enableIdTokenIssuance; FallbackPublicClient = $Web.isFallbackPublicClient; Secrets = $Web.passwordCredentials.Count; Certificates = $Web.keyCredentials.Count }
~~~

Expected: the approved return URL, three False flags and two zero counts.

## 7. Create the web enterprise application

Ordinary sign-in remains available; API authorization is separate.

~~~powershell
if ((az account show --query tenantId --output tsv) -ne $TenantId) { throw 'Wrong tenant.' }
$WebSp = az ad sp create --id $Web.appId --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $WebSp.id) { throw 'Web enterprise application creation failed.' }
$WebSp = az ad sp show --id $Web.appId --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $WebSp.appRoleAssignmentRequired -ne $false) { throw 'Web sign-in configuration not confirmed.' }
$WebSp | Select-Object displayName, appRoleAssignmentRequired
~~~

Expected: the web name and False.

## 8. Resolve and check the selected staff user

Enter the staff user's sign-in name when prompted.

~~~powershell
$Context = az account show --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $Context.tenantId -ne $TenantId) { throw 'Wrong tenant or context unavailable.' }
$UserUpn = (Read-Host 'Approved ordinary staff user principal name').Trim()
$TestUser = az rest --method get --url ('https://graph.microsoft.com/v1.0/users/' + [uri]::EscapeDataString($UserUpn) + '?$select=id,accountEnabled') --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $TestUser.id -or $TestUser.accountEnabled -ne $true) { throw 'Selected user is missing or disabled.' }
$UserRoles = az rest --method get --url ('https://graph.microsoft.com/v1.0/users/' + $TestUser.id + '/transitiveMemberOf/microsoft.graph.directoryRole?$count=true') --headers 'ConsistencyLevel=eventual' --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $null -eq $UserRoles.'@odata.count' -or $UserRoles.'@odata.count' -ne 0) { throw 'Choose an ordinary user with no active directory roles.' }
[pscustomobject]@{ Enabled = $TestUser.accountEnabled; ActiveDirectoryRoleCount = $UserRoles.'@odata.count' }
~~~

Expected: True and 0. This checks active directory roles, not inactive PIM eligibility.

## 9. Assign only the API user role

~~~powershell
if ((az account show --query tenantId --output tsv) -ne $TenantId) { throw 'Wrong tenant.' }
$Body = @{ principalId = $TestUser.id; resourceId = $ApiSp.id; appRoleId = $RoleId } | ConvertTo-Json
$PayloadFile = Join-Path $env:TEMP ('entra-user-role-' + [guid]::NewGuid() + '.json')
[IO.File]::WriteAllText($PayloadFile, $Body, [Text.UTF8Encoding]::new($false))
az rest --method post --url ("https://graph.microsoft.com/v1.0/servicePrincipals/" + $ApiSp.id + "/appRoleAssignedTo") --headers 'Content-Type=application/json' --body "@$PayloadFile" --output none
if ($LASTEXITCODE -ne 0) { throw 'Role assignment failed.' }
$Assignments = az rest --method get --url ("https://graph.microsoft.com/v1.0/servicePrincipals/" + $ApiSp.id + "/appRoleAssignedTo") --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Assignment readback failed.' }
$Assigned = @($Assignments.value | Where-Object { $_.principalId -eq $TestUser.id -and $_.resourceId -eq $ApiSp.id -and $_.appRoleId -eq $RoleId })
if ($Assigned.Count -ne 1) { throw 'Expected one matching user assignment.' }
'Verified: selected user assigned AI.ReportUser.'
~~~

## 10. Grant consent for that user only

Principal consent restricts this grant to the selected user.

~~~powershell
if ((az account show --query tenantId --output tsv) -ne $TenantId) { throw 'Wrong tenant.' }
$GrantList = az ad app permission list-grants --id $WebSp.id --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Could not read existing consent.' }
$ExistingGrants = @($GrantList | Where-Object { $null -ne $_ })
if ($ExistingGrants.Count -gt 0) { throw 'Consent already exists. Review it before creating another grant.' }
az ad app permission grant --id $WebSp.id --api $ApiSp.id --scope $ScopeName --consent-type Principal --principal-id $TestUser.id --output none
if ($LASTEXITCODE -ne 0) { throw 'Consent grant failed.' }
$GrantList = az ad app permission list-grants --id $WebSp.id --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Consent readback failed.' }
$Grants = @($GrantList | Where-Object { $null -ne $_ })
if ($Grants.Count -ne 1) { throw 'Expected exactly one consent grant.' }
$Grant = $Grants[0]
if ($Grant.clientId -ne $WebSp.id -or $Grant.resourceId -ne $ApiSp.id -or $Grant.principalId -ne $TestUser.id -or
    $Grant.consentType -ne 'Principal' -or $Grant.scope -cne $ScopeName) { throw 'Consent does not match the intended user, client, API and scope.' }
[pscustomobject]@{ ConsentType = $Grant.consentType; Scope = $Grant.scope; OnlySelectedUser = $true }
~~~

Expected: Principal, Reports.Generate, True. On failure, inspect existing objects before retrying.

## 11. Save nonsecret configuration

Save application configuration to a new file outside the repository.

~~~powershell
$ConfigPath = Read-Host 'Full path for a new local configuration JSON file outside the repository'
if ($ConfigPath -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])' -or (Test-Path -LiteralPath $ConfigPath)) { throw 'Use a new absolute file path.' }
$Config = @{
    tenantId = $TenantId; webClientId = $Web.appId; apiClientId = $Api.appId
    apiScope = $ApiScope; requiredRole = $RoleValue; redirectUri = $RedirectUri
    consentType = 'Principal'
} | ConvertTo-Json
[IO.File]::WriteAllText($ConfigPath, $Config, [Text.UTF8Encoding]::new($false))
if ([IO.File]::ReadAllText($ConfigPath) -cne $Config) { throw 'Configuration readback failed.' }
'Configuration saved and verified.'
~~~

Neither application needs Microsoft Graph permissions, credentials or Azure resource roles.

After integration, test authorized and unassigned users. The backend must validate the access token's signature, issuer, lifetime, tenant, audience, scope, role and approved client. Require the application role even for administrators.

For additional staff, create individual role assignments and Principal consent, preserving existing grants. Add hosting return URLs as exact HTTPS URLs.

## References

- [Azure CLI sign-in](https://learn.microsoft.com/en-us/cli/azure/authenticate-azure-cli-interactively)
- [Azure CLI application registration](https://learn.microsoft.com/en-us/cli/azure/ad/app)
- [Application property updates](https://learn.microsoft.com/en-us/graph/api/application-update?view=graph-rest-1.0)
- [User application-role assignment](https://learn.microsoft.com/en-us/graph/api/serviceprincipal-post-approleassignedto?view=graph-rest-1.0)
- [Single-user consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-consent-single-user)


