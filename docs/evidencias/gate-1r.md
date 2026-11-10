# Evidência — Gate 1R (saga: orcamento.reprovado)

Data: 2026-11-10

Objetivo: provar, contra LocalStack (SNS/SQS) + Postgres, que publicar
`orcamento.reprovado` deixa o passo `APROVAR_ORCAMENTO` em `COMPENSADO` e a OS
em `REPROVADA`, via `GET /os/:id/saga`.

## Ambiente

```bash
docker compose up -d localstack          # init-sns.sh cria tópicos/fila/DLQ/assinaturas
# Postgres oficina_db já rodando; banco descartável:
docker exec oficina_db psql -U oficina -d postgres -c "CREATE DATABASE oficina_gate1r"
export DATABASE_URL=postgresql://oficina:oficina@localhost:5432/oficina_gate1r
npx prisma migrate deploy && yarn build
SQS_CONSUMER_ENABLED=true OUTBOX_PUBLISHER_ENABLED=true SAGA_TIMEOUT_ENABLED=true \
  AWS_ENDPOINT_URL=http://localhost:4566 \
  SQS_QUEUE_URL=http://localhost:4566/000000000000/oficina-os-queue \
  SNS_TOPIC_ARN=arn:aws:sns:us-east-1:000000000000:oficina-os-events \
  node dist/src/main &
./scripts/gate-1r.sh                     # exit 0
```

Banco descartável removido ao final; app parada.

## Saída do script (exit 0)

```
==> autenticando como mecanico@oficina.com
==> OS criada: d63b7f4c-739d-403b-b759-6dd8efeeb87e
==> OS em AGUARDANDO_APROVACAO
==> publicado orcamento.gerado (eventId=0f778130-92b5-4dd7-92eb-c7cf16c5df69)
==> publicado orcamento.reprovado (eventId=bb1f8298-55c0-4b6e-85a8-44c177fa255b)
==> aguardando passo APROVAR_ORCAMENTO=COMPENSADO e OS=REPROVADA (timeout 90s)
==> GATE 1R OK: passo APROVAR_ORCAMENTO=COMPENSADO, OS=REPROVADA (osId=d63b7f4c-739d-403b-b759-6dd8efeeb87e)
{
    "id": "f0d32472-4d4a-4e87-82b7-61fabca868c6",
    "osId": "d63b7f4c-739d-403b-b759-6dd8efeeb87e",
    "tipo": "ORDEM_DE_SERVICO",
    "status": "COMPENSADA",
    "correlationId": "da913710-7207-4b50-b904-910731c2977b",
    "iniciadaEm": "2026-11-10T18:23:40.840Z",
    "finalizadaEm": "2026-11-10T18:23:41.610Z",
    "passos": [
        {
            "id": "a6e88ead-cc52-432c-8f8c-c6708fb9e507",
            "sagaId": "f0d32472-4d4a-4e87-82b7-61fabca868c6",
            "ordem": 1,
            "nome": "ABRIR_OS",
            "status": "CONCLUIDO",
            "comando": "os.criada",
            "eventoEsperado": null,
            "expiraEm": null,
            "tentativas": 1,
            "erro": null,
            "createdAt": "2026-11-10T18:23:40.840Z",
            "updatedAt": "2026-11-10T18:23:40.840Z"
        },
        {
            "id": "433cb29b-9b9f-4d32-9aa9-1775ccf7d8c4",
            "sagaId": "f0d32472-4d4a-4e87-82b7-61fabca868c6",
            "ordem": 2,
            "nome": "GERAR_ORCAMENTO",
            "status": "CONCLUIDO",
            "comando": "diagnostico.concluido",
            "eventoEsperado": "orcamento.gerado",
            "expiraEm": null,
            "tentativas": 1,
            "erro": null,
            "createdAt": "2026-11-10T18:23:40.840Z",
            "updatedAt": "2026-11-10T18:23:41.260Z"
        },
        {
            "id": "1739b832-3807-48ef-8d79-f7ba42676a8b",
            "sagaId": "f0d32472-4d4a-4e87-82b7-61fabca868c6",
            "ordem": 3,
            "nome": "APROVAR_ORCAMENTO",
            "status": "COMPENSADO",
            "comando": null,
            "eventoEsperado": "orcamento.aprovado",
            "expiraEm": null,
            "tentativas": 1,
            "erro": "passo APROVAR_ORCAMENTO recebeu orcamento.reprovado",
            "createdAt": "2026-11-10T18:23:40.840Z",
            "updatedAt": "2026-11-10T18:23:41.610Z"
        },
        {
            "id": "3ea5cb10-7fbc-403b-b98e-2911af0b1d1d",
            "sagaId": "f0d32472-4d4a-4e87-82b7-61fabca868c6",
            "ordem": 4,
            "nome": "EXECUTAR",
            "status": "PENDENTE",
            "comando": "os.execucao.solicitada",
            "eventoEsperado": "execucao.concluida",
            "expiraEm": null,
            "tentativas": 0,
            "erro": null,
            "createdAt": "2026-11-10T18:23:40.840Z",
            "updatedAt": "2026-11-10T18:23:40.840Z"
        },
        {
            "id": "fda7d543-425b-453f-902b-5936e8b8faac",
            "sagaId": "f0d32472-4d4a-4e87-82b7-61fabca868c6",
            "ordem": 5,
            "nome": "COBRAR",
            "status": "PENDENTE",
            "comando": "os.cobranca.solicitada",
            "eventoEsperado": "pagamento.confirmado",
            "expiraEm": null,
            "tentativas": 0,
            "erro": null,
            "createdAt": "2026-11-10T18:23:40.840Z",
            "updatedAt": "2026-11-10T18:23:40.840Z"
        },
        {
            "id": "079a2c6e-340f-4d7b-9905-93546c0f9edc",
            "sagaId": "f0d32472-4d4a-4e87-82b7-61fabca868c6",
            "ordem": 6,
            "nome": "CONFIRMAR",
            "status": "PENDENTE",
            "comando": "os.finalizada",
            "eventoEsperado": null,
            "expiraEm": null,
            "tentativas": 0,
            "erro": null,
            "createdAt": "2026-11-10T18:23:40.840Z",
            "updatedAt": "2026-11-10T18:23:40.840Z"
        }
    ]
}
```
