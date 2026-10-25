# Entra setup with PowerShell

Run each block in order in the same PowerShell window. Requires Azure CLI. Check the expected output before continuing.

Use your organization's chosen Microsoft Entra tenant as the target tenant throughout this runbook. Create separate application registrations for each environment, using your own application names, user accounts and callback URLs. Each deployment uses a single tenant; external users join that tenant as guests.

Use an Application Administrator or Cloud Application Administrator account authorized for this setup.

## 1. Sign in

Enter these values when prompted:

| Prompt | What to enter |
| --- | --- |
| Target tenant ID | Your organization's chosen Entra tenant GUID, a 36-character ID containing hyphens. Do not enter its display name. |
| Administrator sign-in email | Email used on Microsoft's sign-in screen. |

If Azure CLI is already signed into the intended tenant, read its ID with `az account show --query tenantId --output tsv`. This shows the currently selected tenant only.

Select the same administrator account in Microsoft's sign-in window. If a command fails, correct the input and restart this step before continuing.

~~~powershell
$ErrorActionPreference = 'Stop'
$TenantId = ([guid](Read-Host 'Target tenant ID (GUID, not display name)')).ToString()
$AdminUpn = (Read-Host 'Administrator Microsoft sign-in email').Trim()
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

## 8. Resolve and check the selected user

For a guest, invite them into the target tenant and have them accept the invitation first. Use their object ID or guest user principal name from this tenant, not their home tenant.

For each additional user, reuse the existing registrations and repeat steps 8 through 10 in the same PowerShell window. Invitation, API role assignment and individual consent are all required for guest AI access.

~~~powershell
$Context = az account show --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $Context.tenantId -ne $TenantId) { throw 'Wrong tenant or context unavailable.' }
$UserUpn = (Read-Host 'Approved ordinary user principal name or tenant user object ID').Trim()
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

Run on your local Windows machine, signed into the target tenant selected in step 1. Confirm that `$TenantId`, the application registrations and the selected user all belong to that tenant before continuing.

Use the direct Microsoft Graph requests below to create only the selected user's consent and verify that existing grants remain unchanged. Avoid `az ad app permission grant` for this procedure. Do not use the portal's **Grant admin consent** button, which grants tenant-wide consent.

`clientId` and `resourceId` below are enterprise application (service principal) object IDs, not application/client IDs. An existing matching grant is left unchanged; unexpected scopes or tenant-wide consent stop the procedure for review. The administrator's CLI session needs Graph access to manage consent; do not add Graph permissions to the web or API registration.

~~~powershell
if ((az account show --query tenantId --output tsv) -ne $TenantId) { throw 'Wrong tenant.' }
foreach ($Id in @($WebSp.id, $ApiSp.id, $TestUser.id)) { [void][guid]::Parse($Id) }
function Get-WebConsentGrants {
    $Filter = [uri]::EscapeDataString("clientId eq '$($WebSp.id)'")
    $Url = 'https://graph.microsoft.com/v1.0/oauth2PermissionGrants?$filter=' + $Filter
    do {
        $Page = az rest --method get --url $Url --output json | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0 -or $null -eq $Page.value) { throw 'Could not read consent grants.' }
        $Page.value | Select-Object id, clientId, resourceId, principalId, consentType, scope
        $Url = $Page.'@odata.nextLink'
    } while ($Url)
}
$Before = @(Get-WebConsentGrants)
if (@($Before | Where-Object { $_.resourceId -eq $ApiSp.id -and $_.consentType -eq 'AllPrincipals' }).Count) {
    throw 'Tenant-wide API consent exists. Review it before continuing.'
}
$Selected = @($Before | Where-Object { $_.clientId -eq $WebSp.id -and $_.resourceId -eq $ApiSp.id -and
    $_.principalId -eq $TestUser.id -and $_.consentType -eq 'Principal' })
if ($Selected.Count -gt 1 -or ($Selected.Count -eq 1 -and $Selected[0].scope -cne $ScopeName)) {
    throw 'Unexpected consent for this user. Review the grant; do not replace it.'
}
if ($Selected.Count -eq 0) {
    $Body = @{ clientId = $WebSp.id; resourceId = $ApiSp.id; principalId = $TestUser.id
        consentType = 'Principal'; scope = $ScopeName } | ConvertTo-Json
    $PayloadFile = Join-Path $env:TEMP ('entra-user-consent-' + [guid]::NewGuid() + '.json')
    [IO.File]::WriteAllText($PayloadFile, $Body, [Text.UTF8Encoding]::new($false))
    az rest --method post --url 'https://graph.microsoft.com/v1.0/oauth2PermissionGrants' --headers 'Content-Type=application/json' --body "@$PayloadFile" --output none
    if ($LASTEXITCODE -ne 0) { throw 'Consent creation failed. Read existing grants before retrying.' }
}
$After = @(Get-WebConsentGrants)
$Verified = @($After | Where-Object { $_.clientId -eq $WebSp.id -and $_.resourceId -eq $ApiSp.id -and
    $_.principalId -eq $TestUser.id -and $_.consentType -eq 'Principal' -and $_.scope -ceq $ScopeName })
if ($Verified.Count -ne 1 -or $After.Count -ne ($Before.Count + [int]($Selected.Count -eq 0))) {
    throw 'Unexpected consent readback. Inspect all grants before continuing.'
}
foreach ($Previous in $Before) {
    $Current = @($After | Where-Object { $_.id -eq $Previous.id })
    if ($Current.Count -ne 1 -or ($Current[0] | ConvertTo-Json -Compress) -cne ($Previous | ConvertTo-Json -Compress)) {
        throw 'An existing consent grant changed or disappeared. Inspect grants before continuing.'
    }
}
[pscustomobject]@{ ConsentType = $Verified[0].consentType; Scope = $Verified[0].scope; ExistingGrantsPreserved = $true }
~~~

Expected: Principal, Reports.Generate, True. Other users' grants remain present with the same IDs and values. Graph readbacks can lag; on failure, re-read grants before retrying a write. Do not continue onboarding until verification passes.

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
- [List delegated consent grants](https://learn.microsoft.com/en-us/graph/api/oauth2permissiongrant-list?view=graph-rest-1.0)
- [Create a delegated consent grant](https://learn.microsoft.com/en-us/graph/api/oauth2permissiongrant-post?view=graph-rest-1.0)


