# Diagrama de Sequência — Saga da Ordem de Serviço

> Baseado na [RFC 0006](../rfc/0006-saga-pattern.md): Saga
> orquestrada, com o Orquestrador da Saga dentro do OS Service. Mostra
> o caminho feliz em 6 passos, as compensações e o ramo da DLQ.

```mermaid
sequenceDiagram
    actor Staff
    actor Cliente
    box OS Service
        participant OS as "OS Service (API)"
        participant SAGA as "Orquestrador da Saga"
        participant OUTBOX as "tabela outbox"
    end
    participant BUS as "SNS + SQS"
    participant BILL as "Billing Service"
    participant EXEC as "Execução e Produção"
    participant MP as "Mercado Pago"

    Note over OS,OUTBOX: Passo 1 (ABRIR_OS), abertura da OS
    Staff->>OS: POST /os
    OS->>SAGA: inicia saga (chamada interna)
    OS->>OUTBOX: grava os.criada na mesma transação
    Note over SAGA: passo ABRIR_OS CONCLUIDO
    OS-->>Staff: 201 Created
    OUTBOX->>BUS: publisher envia os.criada

    Note over BILL: Passo 2 (GERAR_ORCAMENTO), orçamento gerado
    SAGA->>OUTBOX: grava diagnostico.concluido
    OUTBOX->>BUS: publisher envia diagnostico.concluido
    BUS->>BILL: diagnostico.concluido (fila do Billing)
    BILL->>BILL: gera orçamento
    BILL->>BUS: publica orcamento.gerado
    BUS->>SAGA: orcamento.gerado (fila do OS)
    Note over SAGA: passo GERAR_ORCAMENTO CONCLUIDO

    Note over BILL: Passo 3 (APROVAR_ORCAMENTO), aprovação
    Staff->>BILL: PATCH /orcamentos/{id}/aprovar
    BILL->>BUS: publica orcamento.aprovado
    BUS->>SAGA: orcamento.aprovado (fila do OS)
    Note over SAGA: passo APROVAR_ORCAMENTO CONCLUIDO
    SAGA->>OUTBOX: grava os.execucao.solicitada
    OUTBOX->>BUS: publisher envia os.execucao.solicitada
    BUS->>EXEC: os.execucao.solicitada (fila da Execução)

    Note over EXEC: Passo 4 (EXECUTAR), execução concluída
    EXEC->>BUS: publica execucao.iniciada
    BUS->>SAGA: execucao.iniciada (fila do OS)
    Note over SAGA: passo EXECUTAR segue EM_ANDAMENTO (progresso)
    EXEC->>BUS: publica execucao.concluida
    BUS->>SAGA: execucao.concluida (fila do OS)
    Note over SAGA: passo EXECUTAR CONCLUIDO

    Note over BILL: Passo 5 (COBRAR), cobrança
    SAGA->>OUTBOX: grava os.cobranca.solicitada
    OUTBOX->>BUS: publisher envia os.cobranca.solicitada
    BUS->>BILL: os.cobranca.solicitada (fila do Billing)
    BILL->>MP: cria preference
    MP-->>BILL: preference criada (init_point)
    Note over SAGA: passo COBRAR aguarda o webhook
    Cliente->>MP: paga pelo init_point

    Note over BILL: Passo 6 (CONFIRMAR), pagamento confirmado
    MP->>BILL: webhook de pagamento (x-signature)
    BILL->>BILL: valida x-signature
    BILL->>BUS: publica pagamento.confirmado
    BUS->>SAGA: pagamento.confirmado (fila do OS)
    SAGA->>OUTBOX: grava os.finalizada
    OUTBOX->>BUS: publisher envia os.finalizada
    Note over SAGA: saga CONCLUIDA

    alt orçamento reprovado
        Staff->>BILL: PATCH /orcamentos/{id}/reprovar
        BILL->>BUS: publica orcamento.reprovado
        BUS->>SAGA: orcamento.reprovado (fila do OS)
        Note over OS,SAGA: OS REPROVADA, passo COMPENSADO
        BUS->>EXEC: orcamento.reprovado (fila da Execução)
        EXEC->>EXEC: libera reserva de peças
    else execução falhou
        EXEC->>BUS: publica execucao.falhou
        BUS->>SAGA: execucao.falhou (fila do OS)
        Note over OS,SAGA: OS volta para APROVADA, passo COMPENSADO
        BUS->>BILL: execucao.falhou (fila do Billing)
        BILL->>BILL: cancela orçamento
    else pagamento recusado
        MP->>BILL: webhook de pagamento recusado
        BILL->>BILL: cancela orçamento
        BILL->>BUS: publica pagamento.recusado
        BUS->>SAGA: pagamento.recusado (fila do OS)
        Note over OS,SAGA: saga PENDENTE, OS sem mudança de status
    else passo expirou (timeout)
        SAGA->>SAGA: passo EXPIRADO vira COMPENSADO
        SAGA->>OUTBOX: grava saga.passo.expirado
        OUTBOX->>BUS: publisher envia saga.passo.expirado
        Note over OS,SAGA: saga COMPENSADA, OS sem mudança de status
    else mensagem envenenada
        BUS->>BUS: 3 tentativas falham
        Note over BUS: mensagem vai para a DLQ
        Note over BUS: alerta no New Relic
    end
```

## Notas

- Na saga, os eventos do caminho feliz só avançam os passos
  (`CONCLUIDO`); eles não alteram o status da OS. O status da OS avança
  pelos endpoints REST (`iniciar-execucao`, `finalizar-execucao`,
  `entregar`). Só as compensações `orcamento.reprovado` e
  `execucao.falhou` mudam a OS.
- Idempotência: cada consumidor (OS Service, Billing Service e
  Execução e Produção) mantém a tabela `mensagens_processadas` com o
  `messageId` único e descarta duplicatas. A entrega é at-least-once,
  então a duplicata é esperada.
- `correlationId` e `traceparent` vão nos message attributes, para o
  trace atravessar a fila SNS + SQS sem perder o contexto.
- O `outbox` garante que o evento é gravado na mesma transação do
  agregado. Um publisher periódico envia os registros pendentes ao SNS.
  Sem isso, haveria uma janela em que o agregado fica salvo e o evento
  se perde.
- `COMPENSADO` é status de `saga_passos`, não da OS. `REPROVADA` é
  status da OS. Não trocar os dois.
- Mensagem envenenada: após 3 tentativas falhas, a mensagem vai para a
  DLQ e dispara alerta no New Relic.
- Timeout de passo: o evento `saga.passo.expirado` não está no
  diagrama. Quando um passo estoura o prazo, o orquestrador o compensa e
  marca `saga_passos.status = COMPENSADO`; o status da OS não muda para
  `COMPENSADO`.
- O orquestrador mora dentro do OS Service: ele consome eventos de
  outros serviços pela fila do OS e grava o próximo comando na `outbox`,
  de onde o publisher envia ao SNS e à fila do serviço de destino.
  Nunca há volta pelo barramento para falar consigo mesmo.
- Aprovação e reprovação de orçamento batem no Billing Service, dono do
  módulo `orcamentos` na Fase 4.
- Detalhes e decisão de arquitetura: [RFC 0006](../rfc/0006-saga-pattern.md).
  Inspeção em tempo de execução: `GET /os/{id}/saga`, que devolve a
  instância da saga e seus passos.
