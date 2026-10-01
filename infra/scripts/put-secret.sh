#!/usr/bin/env bash
# Store an AI provider API key in Secrets Manager without it touching a file, an argument list,
# shell history or Terraform state.
#
#   infra/scripts/put-secret.sh docuchat/prod/openai-api-key
#   pbpaste | infra/scripts/put-secret.sh docuchat/prod/anthropic-api-key   # or any stdin
#
# The secret container is created by Terraform (secrets.tf); this fills it. Run it again with a
# new value to rotate: ECS picks the new value up on the next task start (force a new deployment).
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <secret-name>   (value is read from a hidden prompt or from stdin)" >&2
  exit 2
fi
name="$1"

if [ -t 0 ]; then
  read -r -s -p "Value for ${name} (input hidden): " value
  echo >&2
else
  value="$(cat)"
fi

if [ -z "${value}" ]; then
  echo "empty value, nothing stored" >&2
  exit 1
fi

# The value goes in through stdin (file:///dev/stdin), not as an argument: arguments are visible to
# every user on the machine in the process list.
printf %s "${value}" | aws secretsmanager put-secret-value --secret-id "${name}" \
  --secret-string file:///dev/stdin --query VersionId --output text
unset value
echo "stored a new version of ${name}" >&2
