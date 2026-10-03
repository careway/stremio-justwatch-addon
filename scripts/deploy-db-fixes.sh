#!/usr/bin/env bash
# Ships the Postgres connection fixes to BeamUp and switches the addon to the
# non-superuser `omnicatalogs_app` role.
#
#   1. Commits src/infra/warmCache.js + src/domain/catalog.js on the current
#      branch (only those two files — the rest of the working tree is left alone).
#   2. Cherry-picks that commit onto the `beamup` branch (the one production
#      runs) in a temporary worktree, and runs the test suite there.
#   3. Points DATABASE_URL and DATABASE_URL_POOLED on BeamUp at the new role
#      (DATABASE_URL_BEAMUP in .env).
#   4. Deploys the `beamup` branch (git push beamup beamup:master --force).
#   5. Checks that production restarted and is connected as omnicatalogs_app.
#
# Usage: scripts/deploy-db-fixes.sh [--dry-run] [--yes]
#   --dry-run  print what would run, change nothing
#   --yes      don't ask before each production-facing step
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DRY=0; YES=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --yes|-y) YES=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

FILES=(src/infra/warmCache.js src/domain/catalog.js)
DEPLOY_BRANCH=beamup
APP_ROLE=omnicatalogs_app

c_step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
c_ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }
die()    { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
run()    { if ((DRY)); then echo "  [dry-run] $*"; else "$@"; fi; }
confirm() {
  ((YES || DRY)) && return 0
  read -r -p "$1 [s/N] " ans
  [[ "$ans" =~ ^[sSyY]$ ]] || die "cancelado"
}
envval() { grep -E "^$1=" .env | tail -1 | cut -d= -f2-; }

# ─── Pre-flight ───────────────────────────────────────────────────────────────
c_step "Comprobaciones previas"
[[ -f .env ]] || die "no hay .env"
DB_URL="$(envval DATABASE_URL_BEAMUP)"
PUBLIC_URL="$(envval ADDON_PUBLIC_URL)"
INV_KEY="$(envval INV_KEY)"
PG_SUPER="$(envval POSTGRES_USER)"
PG_DB="$(envval POSTGRES_DB)"
[[ -n "$DB_URL" ]] || die "falta DATABASE_URL_BEAMUP en .env"
[[ -n "$PUBLIC_URL" && -n "$INV_KEY" ]] || die "faltan ADDON_PUBLIC_URL / INV_KEY en .env"
BEAMUP_REMOTE="$(git remote get-url beamup 2>/dev/null)" || die "no existe el remote 'beamup'"
# dokku@a.baby-beamup.club:5cfe2edf73d5/omnicatalogs → host + <hash>/<app>
BEAMUP_HOST="$(sed -E 's#^[^@]+@([^:]+):.*#\1#' <<<"$BEAMUP_REMOTE")"
BEAMUP_APP="$(sed -E 's#^[^:]+:##; s#\.git$##' <<<"$BEAMUP_REMOTE")"
git rev-parse --verify -q "$DEPLOY_BRANCH" >/dev/null || die "no existe la rama '$DEPLOY_BRANCH'"
docker ps --format '{{.Names}}' | grep -qx omnicatalogs-db || die "el contenedor omnicatalogs-db no está corriendo"

# Same path BeamUp takes: public DuckDNS hostname, TLS, new role.
docker exec omnicatalogs-db psql "$DB_URL" -Atc "select current_user" | grep -qx "$APP_ROLE" \
  || die "no se puede conectar como $APP_ROLE con DATABASE_URL_BEAMUP"
c_ok "conexión como $APP_ROLE por $(sed -E 's#.*@([^:/]+).*#\1#' <<<"$DB_URL") con SSL"

STARTED_BEFORE="$(curl -fsS -m 20 "$PUBLIC_URL/api/stats/$INV_KEY" | sed -nE 's/.*"startedAt":"([^"]+)".*/\1/p' || true)"
c_ok "producción arrancada en: ${STARTED_BEFORE:-desconocido}"

# ─── 1. Commit on the current branch ─────────────────────────────────────────
c_step "1/5 Commit de ${FILES[*]} en $(git branch --show-current)"
if git diff --quiet HEAD -- "${FILES[@]}"; then
  echo "  sin cambios pendientes en esos archivos — se usa el último commit que los tocó"
  FIX_COMMIT="$(git log -1 --format=%H -- "${FILES[@]}")"
else
  git --no-pager diff --stat HEAD -- "${FILES[@]}"
  confirm "¿Hacer commit solo de esos dos archivos?"
  run git commit -q -m "fix: batch warm-cache writes and stop pinning Postgres connections

The request path fired ~4 single-row queries per served catalog against a
4-connection pool; a manifest load (every catalog at once) queued them past
connectionTimeoutMillis -> 'timeout exceeded when trying to connect'. Writes
are now buffered and flushed in bulk every 2s, tick() claims rows with a
lease instead of holding a transaction open across the upstream fetch (and
no longer wedges forever if connect() fails), idle connections live 5 min,
and cache writes skip the per-commit fsync (synchronous_commit=off, not on
Neon).

Also: a short catalog no longer gets the 'Oh No! This catalog is empty'
placeholder appended on page 2+ — empty past page 1 is just end-of-catalog.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- "${FILES[@]}"
  FIX_COMMIT="$( ((DRY)) && echo DRY-RUN || git rev-parse HEAD)"
fi
c_ok "commit: ${FIX_COMMIT:0:10}"

# ─── 2. Cherry-pick onto the deploy branch + tests ───────────────────────────
c_step "2/5 Llevar el arreglo a la rama '$DEPLOY_BRANCH' y pasar los tests"
WT="$(mktemp -d)/wt"
cleanup() { git worktree remove --force "$WT" >/dev/null 2>&1 || true; }
trap cleanup EXIT
if ((DRY)); then
  echo "  [dry-run] git worktree add $WT $DEPLOY_BRANCH && git cherry-pick $FIX_COMMIT && npm test"
else
  # Names of the failing tests in the worktree, one per line. `|| true`: node
  # exits 1 when any test fails, which under pipefail would kill the script
  # here silently; a docker failure still exits non-zero.
  failing() {
    docker run --rm -e NODE_ENV=test -v "$WT":/app -v "$ROOT/node_modules":/app/node_modules -w /app \
      node:20-alpine sh -c 'node --test test/*.test.js 2>&1 || true' | sed -nE 's/^ *not ok [0-9]+ - //p' | sort -u
  }
  # Detached: the branch may be checked out in the main repo, and git refuses
  # to check out one branch in two worktrees.
  git worktree add -q --detach "$WT" "$DEPLOY_BRANCH"
  # The deploy branch may already carry failing tests of its own; only a
  # failure the fix *introduces* blocks the deploy.
  BEFORE="$(failing)"
  if git -C "$WT" merge-base --is-ancestor "$FIX_COMMIT" HEAD 2>/dev/null; then
    echo "  ya está en $DEPLOY_BRANCH"
  else
    git -C "$WT" cherry-pick -x "$FIX_COMMIT" >/dev/null \
      || { git -C "$WT" cherry-pick --abort || true; die "el cherry-pick tiene conflictos — resuélvelo a mano en la rama $DEPLOY_BRANCH"; }
  fi
  AFTER="$(failing)"
  NEW="$(comm -13 <(echo "$BEFORE") <(echo "$AFTER") | sed '/^$/d')"
  [[ -n "$BEFORE" ]] && { echo "  fallos que ya tenía $DEPLOY_BRANCH (se ignoran):"; sed 's/^/    - /' <<<"$BEFORE"; }
  [[ -z "$NEW" ]] || { sed 's/^/    ✗ /' <<<"$NEW"; die "el arreglo rompe tests nuevos en $DEPLOY_BRANCH — no se despliega"; }
  # Move the branch onto the tested commit, or step 4 pushes it without the fix.
  TESTED="$(git -C "$WT" rev-parse HEAD)"
  if [[ "$TESTED" != "$(git rev-parse "$DEPLOY_BRANCH")" ]]; then
    if [[ "$(git branch --show-current)" == "$DEPLOY_BRANCH" ]]; then
      git merge -q --ff-only "$TESTED" || die "no se pudo avanzar $DEPLOY_BRANCH a ${TESTED:0:10}"
    else
      git branch -f "$DEPLOY_BRANCH" "$TESTED"
    fi
  fi
  c_ok "sin fallos nuevos en $DEPLOY_BRANCH ($(git rev-parse --short "$DEPLOY_BRANCH"))"
fi

# ─── 3. Secrets on BeamUp ────────────────────────────────────────────────────
c_step "3/5 DATABASE_URL y DATABASE_URL_POOLED en BeamUp → $APP_ROLE"
# The addon reads DATABASE_URL_POOLED first, so both must change or the old
# superuser URL keeps winning. This is what `beamup-cli secrets` runs, minus
# npm (not on the host): both in one config:set so the app restarts once.
# Dokku escapes `?` when it stores a value and the container gets the escape
# literally (DB name `omnicatalogs\`), so the query string is dropped: the app
# forces TLS through pg's `ssl` option and strips sslmode anyway.
BEAMUP_DB_URL="${DB_URL%%\?*}"
confirm "¿Cambiar las variables en BeamUp? (reinicia la app)"
if ((DRY)); then
  echo "  [dry-run] ssh dokku@$BEAMUP_HOST config:set $BEAMUP_APP DATABASE_URL=<..> DATABASE_URL_POOLED=<..>"
else
  ssh "dokku@$BEAMUP_HOST" config:set "$BEAMUP_APP" \
    "DATABASE_URL=$BEAMUP_DB_URL" "DATABASE_URL_POOLED=$BEAMUP_DB_URL" >/dev/null \
    || die "no se pudieron poner DATABASE_URL / DATABASE_URL_POOLED en BeamUp"
  c_ok "DATABASE_URL y DATABASE_URL_POOLED actualizados"
fi

# ─── 4. Deploy ───────────────────────────────────────────────────────────────
c_step "4/5 Desplegar la rama '$DEPLOY_BRANCH' en BeamUp"
confirm "¿git push beamup $DEPLOY_BRANCH:master --force?"
run git push beamup "$DEPLOY_BRANCH:master" --force

# ─── 5. Verify ───────────────────────────────────────────────────────────────
c_step "5/5 Verificación"
if ((DRY)); then
  echo "  [dry-run] esperar a que cambie startedAt y a ver $APP_ROLE conectado desde fuera"
  exit 0
fi
for i in $(seq 1 40); do
  STARTED_NOW="$(curl -fsS -m 20 "$PUBLIC_URL/api/stats/$INV_KEY" 2>/dev/null | sed -nE 's/.*"startedAt":"([^"]+)".*/\1/p' || true)"
  [[ -n "$STARTED_NOW" && "$STARTED_NOW" != "$STARTED_BEFORE" ]] && break
  sleep 15
done
[[ -n "${STARTED_NOW:-}" && "$STARTED_NOW" != "$STARTED_BEFORE" ]] \
  || die "producción no ha reiniciado tras 10 min — revisa: ssh dokku@$BEAMUP_HOST logs ${BEAMUP_APP/\//-} -t"
c_ok "producción reiniciada: $STARTED_NOW"

sleep 20 # let the pools open
REMOTE="$(docker exec omnicatalogs-db psql -U "$PG_SUPER" -d "$PG_DB" -Atc \
  "select usename || ' desde ' || host(client_addr) from pg_stat_activity
    where client_addr is not null and not (client_addr << '172.16.0.0/12')")"
echo "$REMOTE" | sed 's/^/  /'
grep -q "^$APP_ROLE " <<<"$REMOTE" || die "BeamUp no aparece conectado como $APP_ROLE"
grep -q "^$PG_SUPER " <<<"$REMOTE" && echo "  (aún queda alguna conexión vieja como $PG_SUPER; se cerrará sola)"
c_ok "BeamUp conectado como $APP_ROLE"

echo
echo "Hecho. En unas horas revisa que en $PUBLIC_URL/api/stats/<INV_KEY> no aparezca"
echo "'timeout exceeded when trying to connect' en recentErrors."
echo "Opcional: git push origin $DEPLOY_BRANCH"
