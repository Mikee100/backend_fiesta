[CmdletBinding()]
param(
    [ValidateSet('Create', 'Verify', 'Connect', 'Start', 'Stop')]
    [string]$Action = 'Verify'
)

$ErrorActionPreference = 'Stop'
$containerName = 'fiesta-workflow-test-pg'
$volumeName = 'fiesta-workflow-test-pg-data'
$networkName = 'fiesta-workflow-test-isolated'
$databaseName = 'fiesta_workflow_test'
$databaseUser = 'fiesta_test_admin'
$databasePort = 55433
$imageName = 'postgres:17'
$purpose = 'workflow-test-only'
$stateDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'FiestaAI\workflow-test-db'
$statePath = Join-Path $stateDirectory 'state.json'

function Assert-NativeSuccess([string]$Message) {
    if ($LASTEXITCODE -ne 0) { throw $Message }
}

function Get-OwnedContainer([switch]$RequireRunning) {
    $labelsText = & docker container inspect --format '{{json .Config.Labels}}' $containerName
    Assert-NativeSuccess 'The dedicated test container was not found.'
    $labels = $labelsText | ConvertFrom-Json
    if ($labels.'com.fiesta.purpose' -ne $purpose -or $labels.'com.fiesta.environment' -ne 'local-isolated') {
        throw 'Container ownership labels do not match. No container was changed.'
    }
    $portConfiguration = & docker container inspect --format '{{json .HostConfig.PortBindings}}' $containerName
    Assert-NativeSuccess 'Could not verify the dedicated port configuration.'
    $bindings = @(($portConfiguration | ConvertFrom-Json).'5432/tcp')
    if ($bindings.Count -ne 1 -or $bindings[0].HostIp -ne '127.0.0.1' -or $bindings[0].HostPort -ne "$databasePort") {
        throw 'The test container is not bound exclusively to the expected loopback port.'
    }
    if ($RequireRunning) {
        $published = @(& docker port $containerName '5432/tcp')
        Assert-NativeSuccess 'The dedicated test port is not published. No database connection was attempted.'
        if ($published.Count -ne 1 -or $published[0].Trim() -ne "127.0.0.1:$databasePort") {
            throw 'The active port publication differs from the isolated target. No database connection was attempted.'
        }
    }
}

function Read-LocalState {
    if (-not (Test-Path -LiteralPath $statePath)) { throw 'No local test-database state exists. Use -Action Create first.' }
    $state = [IO.File]::ReadAllText($statePath) | ConvertFrom-Json
    if ($state.container -ne $containerName -or $state.database -ne $databaseName -or $state.user -ne $databaseUser -or
        $state.port -ne $databasePort -or $state.volume -ne $volumeName -or $state.network -ne $networkName) {
        throw 'Unexpected local database state. No connection or container action was performed.'
    }
    return $state
}

function Invoke-IsolatedPsql([string]$Sql, [switch]$Interactive) {
    $state = Read-LocalState
    Get-OwnedContainer -RequireRunning
    $securePassword = $state.protectedPassword | ConvertTo-SecureString
    $credential = New-Object System.Management.Automation.PSCredential($databaseUser, $securePassword)
    $environmentNames = @('PGPASSWORD', 'PGSERVICE', 'PGSERVICEFILE', 'PGHOSTADDR', 'PGOPTIONS', 'PGSSLMODE', 'PGCONNECT_TIMEOUT', 'PGTARGETSESSIONATTRS')
    $savedEnvironment = @{}
    foreach ($environmentName in $environmentNames) {
        $savedEnvironment[$environmentName] = [Environment]::GetEnvironmentVariable($environmentName, 'Process')
        [Environment]::SetEnvironmentVariable($environmentName, $null, 'Process')
    }
    try {
        $env:PGPASSWORD = $credential.GetNetworkCredential().Password
        $env:PGSSLMODE = 'disable'
        $env:PGCONNECT_TIMEOUT = '5'
        $arguments = @('-h', '127.0.0.1', '-p', "$databasePort", '-U', $databaseUser, '-d', $databaseName,
            '--no-password', '-X', '--set=ON_ERROR_STOP=1')
        if (-not $Interactive) { $arguments += @('-q', '-A', '-t', '-c', $Sql) }
        & psql @arguments
        Assert-NativeSuccess 'The isolated PostgreSQL command failed; no other database was contacted.'
    } finally {
        foreach ($environmentName in $environmentNames) {
            [Environment]::SetEnvironmentVariable($environmentName, $savedEnvironment[$environmentName], 'Process')
        }
        $credential = $null
    }
}

Get-Command docker -ErrorAction Stop | Out-Null
$serverVersion = & docker info --format '{{.ServerVersion}}'
Assert-NativeSuccess 'Docker is not running. Start Docker Desktop and retry; do not run elevated setup.'

switch ($Action) {
    'Create' {
        if (Test-Path -LiteralPath $statePath) { throw 'Local state already exists. Use Verify or Start; no existing data was reset.' }
        $containers = @(& docker container ls --all --format '{{.Names}}')
        Assert-NativeSuccess 'Could not list container names.'
        $volumes = @(& docker volume ls --format '{{.Name}}')
        Assert-NativeSuccess 'Could not list volume names.'
        $networks = @(& docker network ls --format '{{.Name}}')
        Assert-NativeSuccess 'Could not list network names.'
        if ($containers -contains $containerName -or $volumes -contains $volumeName -or $networks -contains $networkName) {
            throw 'A named test resource already exists. No existing container, network or data volume was reused or removed.'
        }
        if (Get-NetTCPConnection -LocalPort $databasePort -State Listen -ErrorAction SilentlyContinue) {
            throw 'The selected loopback port is occupied. No existing service was changed.'
        }
        $randomBytes = New-Object byte[] 32
        $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $generator.GetBytes($randomBytes) } finally { $generator.Dispose() }
        $password = [BitConverter]::ToString($randomBytes).Replace('-', '')
        $protectedPassword = ConvertTo-SecureString -String $password -AsPlainText -Force | ConvertFrom-SecureString
        $state = [ordered]@{ version = 1; container = $containerName; volume = $volumeName; network = $networkName;
            database = $databaseName; user = $databaseUser; host = '127.0.0.1'; port = $databasePort;
            image = $imageName; protectedPassword = $protectedPassword; createdAt = [DateTime]::UtcNow.ToString('o') }
        [IO.Directory]::CreateDirectory($stateDirectory) | Out-Null
        [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
        & docker volume create --label "com.fiesta.purpose=$purpose" $volumeName | Out-Null
        Assert-NativeSuccess 'Could not create the dedicated data volume. Local state is retained for inspection.'
        & docker network create --driver bridge --label "com.fiesta.purpose=$purpose" $networkName | Out-Null
        Assert-NativeSuccess 'Could not create the isolated network. No existing resources were removed.'
        $previousPassword = [Environment]::GetEnvironmentVariable('POSTGRES_PASSWORD', 'Process')
        try {
            $env:POSTGRES_PASSWORD = $password
            & docker run --detach --pull missing --name $containerName --network $networkName `
                --label "com.fiesta.purpose=$purpose" --label 'com.fiesta.environment=local-isolated' `
                --publish "127.0.0.1:${databasePort}:5432" --mount "type=volume,source=$volumeName,target=/var/lib/postgresql/data" `
                --env "POSTGRES_USER=$databaseUser" --env "POSTGRES_DB=$databaseName" --env POSTGRES_PASSWORD `
                --health-cmd "pg_isready -U $databaseUser -d $databaseName" --health-interval 5s --health-timeout 3s --health-retries 10 `
                $imageName | Out-Null
            Assert-NativeSuccess 'Could not start the dedicated container. Created test resources and encrypted state were retained; nothing was reset.'
        } finally {
            [Environment]::SetEnvironmentVariable('POSTGRES_PASSWORD', $previousPassword, 'Process')
            $password = $null
        }
        Write-Output "Created $containerName for $databaseName on 127.0.0.1:$databasePort. Run -Action Verify to test it."
        Write-Output 'No application environment, business schema or live integration was configured.'
    }
    'Verify' {
        Get-Command psql -ErrorAction Stop | Out-Null
        $identity = Invoke-IsolatedPsql "SELECT current_database() || '|' || current_user;"
        if ($identity.Trim() -ne "$databaseName|$databaseUser") { throw 'Database identity did not match the isolated target.' }
        $probe = Invoke-IsolatedPsql 'BEGIN; CREATE TEMP TABLE workflow_isolation_probe (value integer); INSERT INTO workflow_isolation_probe VALUES (42); SELECT value FROM workflow_isolation_probe; ROLLBACK;'
        if ($probe.Trim() -ne '42') { throw 'The temporary transaction probe failed.' }
        $tableCount = Invoke-IsolatedPsql "SELECT count(*) FROM pg_tables WHERE schemaname = 'public';"
        $version = Invoke-IsolatedPsql 'SHOW server_version;'
        Write-Output "Verified isolated database: $databaseName; user: $databaseUser; PostgreSQL: $($version.Trim()); endpoint: 127.0.0.1:$databasePort."
        Write-Output "Temporary read/write probe passed and rolled back. Public permanent tables: $($tableCount.Trim())."
    }
    'Connect' {
        Get-Command psql -ErrorAction Stop | Out-Null
        Invoke-IsolatedPsql '' -Interactive
    }
    'Start' {
        Read-LocalState | Out-Null
        Get-OwnedContainer
        & docker start $containerName | Out-Null
        Assert-NativeSuccess 'Could not start the dedicated test container.'
        Write-Output 'Dedicated test container started. Run -Action Verify.'
    }
    'Stop' {
        Read-LocalState | Out-Null
        Get-OwnedContainer
        & docker stop $containerName | Out-Null
        Assert-NativeSuccess 'Could not stop the dedicated test container.'
        Write-Output 'Dedicated test container stopped; its isolated data volume and encrypted local state are preserved.'
    }
}