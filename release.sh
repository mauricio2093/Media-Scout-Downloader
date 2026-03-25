#!/usr/bin/env bash
set -euo pipefail

branch="${1:-}"
if ! command -v git >/dev/null 2>&1; then
  echo "Error: git no está en PATH." >&2
  exit 1
fi
if [[ -z "$branch" ]]; then
  branch="$(git rev-parse --abbrev-ref HEAD | tr -d '\r\n')"
fi
echo "== Integración: $branch con origin/$branch =="

dirty="$(git status --porcelain)"
did_stash=0
if [[ -n "$dirty" ]]; then
  echo "Hay cambios locales sin commitear. Guardando stash temporal..."
  git stash push -u -m "release.sh autostash $(date -Is)" >/dev/null
  did_stash=1
fi

if ! git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  git branch --set-upstream-to "origin/$branch" "$branch" >/dev/null 2>&1 || true
fi

git fetch --prune
git pull --rebase origin "$branch"

if [[ "$did_stash" == "1" ]]; then
  echo "Reaplicando cambios del stash..."
  if ! git stash pop; then
    echo "Conflictos al aplicar el stash. Resuélvelos manualmente y vuelve a ejecutar el script." >&2
    exit 1
  fi
fi

read -rp "Mensaje de commit: " commit_msg

last_tag="$(git tag --list 'v*' --sort=-v:refname | head -n1)"
echo "Última versión detectada: ${last_tag:-ninguna}"
read -rp "Nueva versión (vX.Y.Z) o escribe: auto | major | minor | patch (defecto: auto): " ver_input

next_version() {
  local last="$1" mode="$2"
  if [[ -z "$last" ]]; then
    echo "v0.1.0"
    return
  fi
  IFS='.' read -r maj min pat <<<"${last#v}"
  case "$mode" in
    major) ((maj++)); min=0; pat=0 ;;
    minor) ((min++)); pat=0 ;;
    *)     ((pat++)) ;;
  esac
  printf "v%d.%d.%d" "$maj" "$min" "$pat"
}

if [[ -z "$ver_input" || "$ver_input" =~ ^(auto|patch|minor|major)$ ]]; then
  mode="${ver_input:-auto}"
  version="$(next_version "$last_tag" "$mode")"
else
  if [[ ! "$ver_input" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Formato inválido. Usa vX.Y.Z" >&2
    exit 1
  fi
  version="${ver_input#v}"
  version="v$version"
fi

echo "Generando sección de changelog para $version..."
changelog_section() {
  local from="$1" to="$2"
  local range log_lines
  if [[ -n "$from" ]]; then
    range="$from..HEAD"
  else
    range="HEAD"
  fi
  mapfile -t log_lines < <(git log "$range" --no-merges --pretty=format:'%h%x09%s')

  declare -A titles
  titles=(
    [feat]="Nuevas funcionalidades"
    [fix]="Correcciones"
    [perf]="Rendimiento"
    [refactor]="Refactor"
    [docs]="Documentación"
    [test]="Tests"
    [build]="Build"
    [ci]="CI"
    [style]="Estilo"
    [chore]="Chore"
    [revert]="Reverts"
    [other]="Otros"
  )
  declare -A groups
  for key in "${!titles[@]}"; do
    groups["$key"]=""
  done

  for line in "${log_lines[@]}"; do
    [[ -z "$line" ]] && continue
    sha="${line%%$'\t'*}"
    subject="${line#*$'\t'}"
    type="other"
    text="$subject"
    breaking=0
    if [[ "$subject" =~ ^([A-Za-z]+)(\([^\)]*\))?(!)?:[[:space:]]+(.*)$ ]]; then
      type="${BASH_REMATCH[1],,}"
      [[ -n "${BASH_REMATCH[3]}" ]] && breaking=1
      text="${BASH_REMATCH[4]}"
    fi
    [[ -n "${titles[$type]}" ]] || type="other"
    if [[ "$breaking" == "1" ]]; then
      text="BREAKING: $text"
    fi
    groups["$type"]+=$'- '"$text"' ('"$sha"$')\n'
  done

  printf '## %s - %s\n\n' "$to" "$(date +%Y-%m-%d)"
  any=0
  for key in feat fix perf refactor docs test build ci style chore revert other; do
    entries="${groups[$key]}"
    if [[ -n "$entries" ]]; then
      any=1
      printf '### %s\n%s\n' "${titles[$key]}" "$entries"
    fi
  done
  if [[ "$any" == "0" ]]; then
    printf 'Sin cambios en commits (solo versionado).\n\n'
  fi
}

section="$(changelog_section "$last_tag" "$version")"
changelog="CHANGELOG.md"
if [[ -f "$changelog" ]]; then
  tail_content="$(sed '1d' "$changelog")"
  printf '# Changelog\n\n%s\n%s\n' "$section" "$tail_content" > "$changelog.tmp"
else
  printf '# Changelog\n\n%s\n' "$section" > "$changelog.tmp"
fi
mv "$changelog.tmp" "$changelog"

tag_msg_file="$(mktemp)"
printf 'Release %s - %s\n\n%s\n' "$version" "$commit_msg" "$section" > "$tag_msg_file"

git add -A
if git diff --cached --quiet; then
  echo "No hay cambios para commitear; se continuará con tags/push."
else
  git commit -m "$commit_msg"
fi

if [[ -n "$last_tag" ]]; then
  prev_sha="$(git rev-parse "$last_tag" | tr -d '\r\n')"
  git tag -f previous "$prev_sha" >/dev/null
  echo "Auto-guardado: tag 'previous' -> $last_tag ($prev_sha)"
fi

git tag -a "$version" -F "$tag_msg_file"
git tag -f latest >/dev/null

git push origin "$branch"
git push origin "$version"
git push origin latest --force
if [[ -n "$last_tag" ]]; then
  git push origin previous --force
fi

echo "Listo: $version publicado en '$branch'. Último tag era ${last_tag:-ninguno}."
