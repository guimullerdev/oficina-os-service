#!/usr/bin/env bash
#
# Gate 1R da saga (Fase 5): publicar `orcamento.reprovado` deve deixar o passo
# APROVAR_ORCAMENTO em COMPENSADO e a OS em REPROVADA.
#
# Pré-requisitos: app rodando localmente com SQS_CONSUMER_ENABLED=true e
# apontando para o LocalStack (init-sns.sh já aplicado), `aws` CLI, curl, python3.
#
# Uso:
#   ./scripts/gate-1r.sh
#   BASE_URL=http://localhost:3000 TIMEOUT_S=60 ./scripts/gate-1r.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}"
AWS_REGION="${AWS_REGION:-us-east-1}"
BILLING_TOPIC_ARN="${BILLING_TOPIC_ARN:-arn:aws:sns:${AWS_REGION}:000000000000:oficina-billing-events}"
TIMEOUT_S="${TIMEOUT_S:-90}"
POLL_INTERVAL_S="${POLL_INTERVAL_S:-1}"

# Credenciais dummy do LocalStack (mesmas do manual-test.http / .env.example).
STAFF_EMAIL="${STAFF_EMAIL:-mecanico@oficina.com}"
STAFF_PASSWORD="${STAFF_PASSWORD:-senha123}"

export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_DEFAULT_REGION="$AWS_REGION"

log() { echo "==> $*" >&2; }
die() { echo "!! $*" >&2; exit 1; }

# json <campo> : lê JSON do stdin e imprime o campo (vazio se ausente).
json() { python3 -c "import sys,json;print(json.load(sys.stdin).get('$1',''))" 2>/dev/null || true; }

uuid() { python3 -c 'import uuid;print(uuid.uuid4())'; }

# CPF válido (dígitos verificadores) a partir de 9 dígitos aleatórios.
cpf_valido() {
  python3 - <<'PY'
import random
d = [random.randint(0, 9) for _ in range(9)]
if len(set(d)) == 1:
    d[0] = (d[0] + 1) % 10
for n in (9, 10):
    s = sum(v * (n + 1 - i) for i, v in enumerate(d))
    d.append((s * 10 % 11) % 10)
print(''.join(map(str, d)))
PY
}

api() { # api <método> <path> [corpo-json]
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$BASE_URL$path" -H 'content-type: application/json' \
      -H "authorization: Bearer ${TOKEN:-}" -d "$body"
  else
    curl -sS -X "$method" "$BASE_URL$path" -H "authorization: Bearer ${TOKEN:-}"
  fi
}

publicar() { # publicar <evento> <osId>
  local evento=$1 os=$2 eid corr
  eid=$(uuid); corr=$(uuid)
  aws --endpoint-url "$AWS_ENDPOINT_URL" sns publish \
    --topic-arn "$BILLING_TOPIC_ARN" \
    --message "{\"osId\":\"$os\"}" \
    --message-attributes "{\"evento\":{\"DataType\":\"String\",\"StringValue\":\"$evento\"},\"eventId\":{\"DataType\":\"String\",\"StringValue\":\"$eid\"},\"correlationId\":{\"DataType\":\"String\",\"StringValue\":\"$corr\"}}" \
    >/dev/null
  log "publicado $evento (eventId=$eid)"
}

# --- autenticação (register é público; se já existir, cai no login) --------
log "autenticando como $STAFF_EMAIL"
CRED="{\"email\":\"$STAFF_EMAIL\",\"password\":\"$STAFF_PASSWORD\"}"
TOKEN=$(api POST /auth/register "$CRED" | json accessToken)
[ -n "$TOKEN" ] || TOKEN=$(api POST /auth/login "$CRED" | json accessToken)
[ -n "$TOKEN" ] || die "não consegui obter token em $BASE_URL"

# --- cliente / veículo / OS -------------------------------------------------
SUF=$(python3 -c 'import random,string;print("".join(random.choices(string.ascii_uppercase,k=3)))')
NUM=$(python3 -c 'import random;print(random.randint(1000,9999))')
CPF=$(cpf_valido)

RESP=$(api POST /clientes "{\"nome\":\"Gate 1R\",\"documento\":\"$CPF\",\"email\":\"gate1r-$CPF@example.com\",\"telefone\":\"11999990000\"}" )
CLIENTE_ID=$(printf '%s' "$RESP" | json id)
[ -n "$CLIENTE_ID" ] || die "falha ao criar cliente: $RESP"

RESP=$(api POST /veiculos "{\"placa\":\"$SUF$NUM\",\"marca\":\"Fiat\",\"modelo\":\"Uno\",\"ano\":2018,\"cor\":\"Branco\",\"kmAtual\":75000,\"clienteId\":\"$CLIENTE_ID\"}" )
VEICULO_ID=$(printf '%s' "$RESP" | json id)
[ -n "$VEICULO_ID" ] || die "falha ao criar veículo: $RESP"

RESP=$(api POST /os "{\"clienteId\":\"$CLIENTE_ID\",\"veiculoId\":\"$VEICULO_ID\",\"descricaoProblema\":\"Gate 1R - orcamento reprovado\"}" )
OS_ID=$(printf '%s' "$RESP" | json id)
[ -n "$OS_ID" ] || die "falha ao criar OS: $RESP"
log "OS criada: $OS_ID"

api PATCH "/os/$OS_ID/iniciar-diagnostico" >/dev/null
api PATCH "/os/$OS_ID/concluir-diagnostico" >/dev/null

STATUS=$(api GET "/os/$OS_ID" | json status)
[ "$STATUS" = "AGUARDANDO_APROVACAO" ] || die "OS deveria estar AGUARDANDO_APROVACAO, está '$STATUS'"
log "OS em $STATUS"

# --- eventos de billing -----------------------------------------------------
publicar orcamento.gerado "$OS_ID"
publicar orcamento.reprovado "$OS_ID"

# --- polling com timeout explícito -----------------------------------------
passo_status() { # lê JSON da saga no stdin e imprime o status do passo APROVAR_ORCAMENTO
  python3 -c "
import sys,json
try:
    s=json.load(sys.stdin)
    print(next((p.get('status','') for p in s.get('passos',[]) if p.get('nome')=='APROVAR_ORCAMENTO'),''))
except Exception:
    print('')"
}

log "aguardando passo APROVAR_ORCAMENTO=COMPENSADO e OS=REPROVADA (timeout ${TIMEOUT_S}s)"
DEADLINE=$(( $(date +%s) + TIMEOUT_S ))
SAGA=""; PASSO=""; STATUS=""
while :; do
  SAGA=$(api GET "/os/$OS_ID/saga" || true)
  PASSO=$(printf '%s' "$SAGA" | passo_status)
  STATUS=$(api GET "/os/$OS_ID" | json status || true)
  if [ "$PASSO" = "COMPENSADO" ] && [ "$STATUS" = "REPROVADA" ]; then
    break
  fi
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "!! TIMEOUT após ${TIMEOUT_S}s: passo APROVAR_ORCAMENTO='$PASSO' (esperado COMPENSADO), OS='$STATUS' (esperado REPROVADA)" >&2
    echo "saga: $SAGA" >&2
    exit 1
  fi
  sleep "$POLL_INTERVAL_S"
done

log "GATE 1R OK: passo APROVAR_ORCAMENTO=COMPENSADO, OS=REPROVADA (osId=$OS_ID)"
printf '%s' "$SAGA" | python3 -m json.tool
