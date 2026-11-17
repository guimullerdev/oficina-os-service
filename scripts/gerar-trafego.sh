#!/usr/bin/env bash
#
# Gera tráfego contra o ambiente para os painéis do New Relic terem o que
# mostrar antes de gravar. Duas partes por ciclo:
#
#   1. Aquecimento (só leitura e recusas): latência, códigos HTTP e os
#      desfechos da autenticação por CPF. Usa a massa de prisma/seed-demo.sql;
#      se o login por CPF falhar, esta parte é pulada.
#   2. Fluxo pelos 3 serviços: roda o scripts/e2e-prod.sh do
#      oficina-billing-service, que abre OSs e leva cada uma por OS, Billing e
#      Execução nos desfechos da saga (CONCLUIDA, COMPENSADA, PENDENTE).
#      O fluxo vive num script só, no Billing, para não manter duas cópias.
#
# Uso:
#   export BASE_URL=https://7eu2kz40xj.execute-api.us-east-1.amazonaws.com/prod
#   export OS_EMAIL=<staff>              # usuário staff do serviço de OS
#   ./scripts/gerar-trafego.sh [ciclos]  # pede a senha sem eco se OS_PASSWORD não existir
#
# Variáveis opcionais:
#   BILLING_REPO  caminho do clone do oficina-billing-service
#                 (default: ../oficina-billing-service, ao lado deste repo)
#   SCENARIOS     cenários do e2e por ciclo (default: "feliz reprovado recusado")
#
# A senha nunca aparece em argumento de linha de comando nem em arquivo: vem
# por variável de ambiente ou por `read -s`.
set -uo pipefail

BASE_URL="${BASE_URL:?defina BASE_URL com o endpoint do stage}"
CICLOS="${1:-3}"
SCENARIOS="${SCENARIOS:-feliz reprovado recusado}"
BILLING_REPO="${BILLING_REPO:-$(cd "$(dirname "$0")/../.." && pwd)/oficina-billing-service}"
E2E="$BILLING_REPO/scripts/e2e-prod.sh"
CPF_ATIVO="${CPF_ATIVO:-69759054876}"
CPF_INATIVO="${CPF_INATIVO:-38405253149}"
CPF_INEXISTENTE="${CPF_INEXISTENTE:-11144477735}"

# Da massa de demonstração (prisma/seed-demo.sql).
OS_DO_CLIENTE="${OS_DO_CLIENTE:-dddddddd-2222-4222-8222-dddddddddddd}"
OS_ENCERRADA="${OS_ENCERRADA:-dddddddd-1111-4111-8111-dddddddddddd}"
OS_DE_OUTRO="${OS_DE_OUTRO:-dddddddd-3333-4333-8333-dddddddddddd}"

[ -x "$E2E" ] || [ -f "$E2E" ] || {
  echo "!! não achei $E2E — clone o oficina-billing-service ao lado deste repo ou defina BILLING_REPO"
  exit 1
}

: "${OS_EMAIL:?defina OS_EMAIL com o usuário staff do serviço de OS}"
if [ -z "${OS_PASSWORD:-}" ]; then
  read -rsp "Senha de $OS_EMAIL (não aparece): " OS_PASSWORD
  echo
fi
export OS_EMAIL OS_PASSWORD

json() { python3 -c "import sys,json;print(json.load(sys.stdin).get('$1',''))" 2>/dev/null; }

chamar() { # método url [token] [body]
  local metodo="$1" url="$2" token="${3:-}" body="${4:-}"
  local args=(-s -o /dev/null -w '%{http_code}' -X "$metodo" "${BASE_URL}${url}"
              -H "x-request-id: carga-$(date +%s)-$RANDOM")
  [ -n "$token" ] && args+=(-H "authorization: Bearer $token")
  [ -n "$body" ] && args+=(-H 'content-type: application/json' -d "$body")
  curl "${args[@]}"
}

echo "==> autenticando cliente por CPF (aquecimento)"
TOKEN_CLIENTE=$(curl -s -X POST "$BASE_URL/auth/cpf" -H 'content-type: application/json' \
  -d "{\"cpf\":\"$CPF_ATIVO\"}" | json accessToken)
[ -z "$TOKEN_CLIENTE" ] && echo "-- sem token de cliente (massa de demo ausente?): pulando o aquecimento"

FALHAS=0
for i in $(seq 1 "$CICLOS"); do
  printf '\n== ciclo %s/%s\n' "$i" "$CICLOS"

  if [ -n "$TOKEN_CLIENTE" ]; then
    # Latência, códigos HTTP e rotas mais lentas: qualquer tráfego variado serve.
    printf '  health=%s  os/me=%s  status=%s  acompanhamento=%s\n' \
      "$(chamar GET /health)" \
      "$(chamar GET /os/me "$TOKEN_CLIENTE")" \
      "$(chamar GET "/os/$OS_DO_CLIENTE/status" "$TOKEN_CLIENTE")" \
      "$(chamar GET "/os/$OS_ENCERRADA/acompanhamento" "$TOKEN_CLIENTE")"

    # Recusas: alimentam o painel por status HTTP e provam o isolamento.
    printf '  os-de-outro=%s  sem-token=%s  staff-only=%s\n' \
      "$(chamar GET "/os/$OS_DE_OUTRO/status" "$TOKEN_CLIENTE")" \
      "$(chamar GET /os/me)" \
      "$(chamar GET /os "$TOKEN_CLIENTE")"

    # Os três desfechos da autenticação por CPF.
    printf '  cpf-inativo=%s  cpf-inexistente=%s  cpf-malformado=%s\n' \
      "$(chamar POST /auth/cpf '' "{\"cpf\":\"$CPF_INATIVO\"}")" \
      "$(chamar POST /auth/cpf '' "{\"cpf\":\"$CPF_INEXISTENTE\"}")" \
      "$(chamar POST /auth/cpf '' '{"cpf":"123"}')"
  fi

  # Fluxo pelos 3 serviços (OS, Billing, Execução), um desfecho por cenário.
  # Só o resumo final de cada execução, para o terminal não virar ruído.
  if API_BASE="$BASE_URL" SCENARIOS="$SCENARIOS" CHECK_DLQ=0 bash "$E2E" >"/tmp/gerar-trafego-$$.log" 2>&1; then
    echo "  e2e ($SCENARIOS): ok — $(grep -cE '^\[(feliz|reprovado|recusado|falhou)\]' "/tmp/gerar-trafego-$$.log") cenário(s)"
  else
    FALHAS=$((FALHAS + 1))
    echo "  !! e2e falhou neste ciclo — últimas linhas:"
    tail -n 8 "/tmp/gerar-trafego-$$.log" | sed 's/^/     /'
  fi
done
rm -f "/tmp/gerar-trafego-$$.log"
unset OS_PASSWORD

echo
echo "Pronto ($FALHAS ciclo(s) com falha). Os painéis levam ~1 min para refletir."
[ "$FALHAS" -eq 0 ]
