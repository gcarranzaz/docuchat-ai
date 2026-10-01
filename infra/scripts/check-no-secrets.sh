#!/usr/bin/env bash
# CI guard: fail if something that looks like a real credential is committed.
# Not a replacement for a scanner such as gitleaks; it catches the common, costly mistakes.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fail=0
check() {
  local label="$1" pattern="$2"
  # Placeholders in .env.example, docs and tests are written as sk-... or sk-xxxx; require real length
  if git grep -nIE "$pattern" -- . ':!infra/scripts/check-no-secrets.sh' ':!package-lock.json' ':!**/package-lock.json' >/tmp/secret-hits.txt 2>/dev/null; then
    echo "FOUND ${label}:" >&2
    sed -E 's/(.{0,80}).*/\1/' /tmp/secret-hits.txt >&2
    fail=1
  fi
}

check "Anthropic key"       'sk-ant-[A-Za-z0-9_-]{20,}'
check "OpenAI key"          'sk-(proj-)?[A-Za-z0-9]{32,}'
check "AWS access key id"   'AKIA[0-9A-Z]{16}'
check "private key block"   '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----'

# Terraform must not take secrets as input or hold them as literals
if git grep -nIE '(password|secret|api_key|token)[a-z_]*[[:space:]]*=[[:space:]]*"[^"$]{8,}"' -- 'infra/terraform/*.tf' 'infra/terraform/*.tfvars*' \
  | grep -vE 'secret_string_wo_version|auth_token_wo_version|description|name[[:space:]]*=' >/tmp/secret-hits.txt; then
  echo "FOUND literal secret-like value in Terraform:" >&2
  cat /tmp/secret-hits.txt >&2
  fail=1
fi

if git ls-files | grep -E '(^|/)\.env($|\.[^e])|\.tfstate|\.tfvars$' | grep -v example >/tmp/secret-hits.txt; then
  echo "FOUND tracked env/state/tfvars file:" >&2
  cat /tmp/secret-hits.txt >&2
  fail=1
fi

[ "$fail" -eq 0 ] && echo "no committed secrets found"
exit "$fail"
