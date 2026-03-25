# release.ps1
param(
  [string]$Branch
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "Git no esta en PATH." }
if (-not $Branch) { $Branch = (git rev-parse --abbrev-ref HEAD).Trim() }

# =======================================================================================
# 0) INTEGRACION: traer cambios remotos antes de versionar (con proteccion de cambios)
# =======================================================================================
Write-Host ("== Integracion: {0} con origin/{0} ==" -f $Branch)

# Stash temporal si hay cambios locales sin commitear (incluye untracked)
$dirty = (git status --porcelain).Trim()
$didStash = $false
if ($dirty) {
  Write-Host "Hay cambios locales sin commitear. Haciendo stash temporal..."
  git stash push -u -m ("release.ps1 autostash {0}" -f (Get-Date -Format s)) | Out-Null
  $didStash = $true
}

# Asegurar upstream y traer
try { $up = (git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null).Trim() } catch { $up = "" }
if (-not $up) {
  $up = "origin/$Branch"
  try { git branch --set-upstream-to $up $Branch | Out-Null } catch {}
}

git fetch --prune
git pull --rebase origin $Branch

# Reaplicar stash si lo hicimos
if ($didStash) {
  Write-Host "Reaplicando cambios del stash..."
  try {
    git stash pop
  } catch {
    Write-Warning "Conflictos al aplicar el stash. Resuelvelos y luego:
    - git add -A
    - git rebase --continue   (si el rebase quedo pendiente)
    Vuelve a ejecutar el script cuando tu arbol este limpio."
    exit 1
  }
}

# =================================================
# 1) Mensaje de commit (si hay cambios sin commitear)
# =================================================
$msg = Read-Host "Mensaje de commit"

# ==========================================
# 2) Calcular/normar version a publicar
# ==========================================
$lastTag = (git tag --list "v*" --sort=-v:refname | Select-Object -First 1)
Write-Host "Ultima version detectada: $lastTag"
$verInput = Read-Host "Nueva version (vX.Y.Z) o escribe: auto | major | minor | patch (defecto: auto)"

function Next-Version([string]$last,[string]$mode) {
  if (-not $last) { return "v0.1.0" }
  $n = $last.TrimStart('v').Split('.')
  $maj=[int]$n[0]; $min=[int]$n[1]; $pat=[int]$n[2]
  switch ($mode) {
    "major" { $maj++; $min=0; $pat=0 }
    "minor" { $min++; $pat=0 }
    default { $pat++ }  # patch/auto
  }
  return ("v{0}.{1}.{2}" -f $maj,$min,$pat)
}

if ([string]::IsNullOrWhiteSpace($verInput) -or $verInput -in @("auto","patch","minor","major")) {
  $mode    = if ($verInput) { $verInput } else { "auto" }
  $version = Next-Version $lastTag $mode
} else {
  if ($verInput -notmatch '^v?\d+\.\d+\.\d+$') { throw "Formato invalido. Usa vX.Y.Z" }
  $version = if ($verInput.StartsWith('v')) { $verInput } else { "v$verInput" }
}

# ===========================================================
# 3) Generar CHANGELOG desde $lastTag..HEAD (o todo si no hay)
# ===========================================================
function New-ChangeLogSection([string]$fromTag,[string]$toVersion) {
  # Obtener commits (sin merges). Si no hay tag previo, usa HEAD (todos).
  $range = if ($fromTag) { "$fromTag..HEAD" } else { "HEAD" }
  $logLines = @()
  try {
    $logLines = git log $range --no-merges --pretty=format:'%h%x09%s'
  } catch { $logLines = @() }

  # Grupos por tipo (conventional commits)
  $order = [ordered]@{
    feat      = "Nuevas funcionalidades"
    fix       = "Correcciones"
    perf      = "Rendimiento"
    refactor  = "Refactor"
    docs      = "Documentacion"
    test      = "Tests"
    build     = "Build"
    ci        = "CI"
    style     = "Estilo"
    chore     = "Chore"
    revert    = "Reverts"
    other     = "Otros"
  }
  $groups = @{}
  foreach ($k in $order.Keys) { $groups[$k] = New-Object System.Collections.Generic.List[string] }

  foreach ($line in $logLines) {
    if (-not $line) { continue }
    $parts = $line -split "`t", 2
    if ($parts.Count -lt 2) { continue }
    $sha = $parts[0]
    $subject = $parts[1]

    $type = "other"; $text = $subject
    $breaking = $false

    if ($subject -match '^([A-Za-z]+)(\([^\)]*\))?(!)?:\s+(.*)$') {
      $type = $matches[1].ToLower()
      if ($matches[3]) { $breaking = $true }
      $text = $matches[4]
    }

    if (-not $order.Contains($type)) { $type = "other" }
    if ($breaking) { $text = ("BREAKING: {0}" -f $text) }
    $groups[$type].Add(("- {0} ({1})" -f $text,$sha))
  }

  $sb = New-Object System.Text.StringBuilder
  $null = $sb.AppendLine(("## {0} - {1}" -f $toVersion,(Get-Date -Format 'yyyy-MM-dd')))
  $null = $sb.AppendLine("")

  $any = $false
  foreach ($k in $order.Keys) {
    $items = $groups[$k]
    if ($items.Count -gt 0) {
      $any = $true
      $null = $sb.AppendLine(("### {0}" -f $order[$k]))
      foreach ($i in $items) { $null = $sb.AppendLine($i) }
      $null = $sb.AppendLine("")
    }
  }

  if (-not $any) {
    $null = $sb.AppendLine("Sin cambios en commits (solo versionado).")
    $null = $sb.AppendLine("")
  }

  return $sb.ToString()
}

$section = New-ChangeLogSection -fromTag $lastTag -toVersion $version

# Escribir/actualizar CHANGELOG.md (prepend)
$changelogPath = Join-Path (Get-Location) "CHANGELOG.md"
if (Test-Path $changelogPath) {
  $lines = Get-Content $changelogPath
  if ($lines.Length -gt 0 -and $lines[0] -match '^# Changelog') {
    $rest = ($lines | Select-Object -Skip 1) -join [Environment]::NewLine
    $newContent = "# Changelog`r`n`r`n$section`r`n$rest"
  } else {
    $old = $lines -join [Environment]::NewLine
    $newContent = "# Changelog`r`n`r`n$section`r`n$old"
  }
} else {
  $newContent = "# Changelog`r`n`r`n$section"
}
Set-Content -Path $changelogPath -Value $newContent -Encoding UTF8

# Archivo temporal para el mensaje del tag (usa el mismo changelog de la seccion)
$tagMsgPath = Join-Path $env:TEMP ("tagmsg_{0}_{1}.txt" -f $version.TrimStart('v'), (Get-Date -Format 'yyyyMMddHHmmss'))
$tagMsg = ("Release {0} - {1}`r`n`r`n{2}" -f $version,$msg,$section)
Set-Content -Path $tagMsgPath -Value $tagMsg -Encoding UTF8

# ===========================================================
# 3.5) Commit con el changelog actualizado (si hay cambios)
# ===========================================================
git add -A
$changes = git status --porcelain
if ($changes) {
  git commit -m "$msg"
} else {
  Write-Host "No hay cambios; se continuara con tags/push."
}

# ===========================================================
# 4) Auto-guardado de version anterior y crear tag + latest
# ===========================================================
if ($lastTag) {
  $prevSha = (git rev-parse $lastTag).Trim()
  git tag -f previous $prevSha | Out-Null
  Write-Host ("Auto-guardado: tag 'previous' -> {0} ({1})" -f $lastTag,$prevSha)
}

git tag -a $version -F $tagMsgPath
git tag -f latest | Out-Null

# =============================
# 5) Push branch y todos los tags
# =============================
git push origin $Branch
git push origin $version
git push origin latest --force
if ($lastTag) { git push origin previous --force }

Write-Host ("Listo: {0} publicado en '{1}'. Ultimo tag era {2}." -f $version,$Branch,$lastTag)
