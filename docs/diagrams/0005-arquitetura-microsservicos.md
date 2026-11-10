# Diagrama de Arquitetura — Microsserviços (Fase 4)

> Mostra a arquitetura final: entrada pelo API Gateway, roteamento por
> path no nginx-ingress do EKS, três microsserviços, cada um com o seu
> banco, barramento SNS + SQS, Mercado Pago e New Relic.

```mermaid
flowchart TB
    Cliente["Cliente / Staff"]

    subgraph AWS["AWS"]
        direction TB
        APIGW["AWS API Gateway (7eu2kz40xj)"]
        LAMBDA["Lambda oficina-auth-cpf"]
        VPCL["VPC Link → NLB interno"]
    end

    subgraph EKS["Cluster EKS"]
        direction TB
        ING["nginx-ingress"]
        subgraph SVC["Microsserviços"]
            direction LR
            OS["OS Service<br/>hospeda o Saga Orchestrator"]
            BILL["Billing Service"]
            EXEC["Execução e Produção"]
        end
    end

    subgraph DADOS["Dados"]
        direction LR
        subgraph RDS["RDS (uma instância SQL)"]
            direction LR
            DBOS[("oficina_os")]
            DBBILL[("oficina_billing")]
        end
        DDB[("DynamoDB (NoSQL)")]
    end

    BUS["SNS + SQS<br/>3 tópicos, 3 filas, 3 DLQs"]
    MP["Mercado Pago (Checkout Pro)"]
    NR["New Relic (conta 8510401)"]

    Cliente --> APIGW
    APIGW -->|"/auth/cpf"| LAMBDA
    APIGW -->|"{proxy+}"| VPCL
    VPCL --> ING
    ING -->|"/os/*"| OS
    ING -->|"/billing/*"| BILL
    ING -->|"/execucao/*"| EXEC

    OS --> DBOS
    BILL --> DBBILL
    EXEC --> DDB

    OS -->|"publica"| BUS
    BILL -->|"publica"| BUS
    EXEC -->|"publica"| BUS
    BUS -->|"fila oficina-os-queue"| OS
    BUS -->|"fila oficina-billing-queue"| BILL
    BUS -->|"fila oficina-execucao-queue"| EXEC

    BILL -->|"cria preference (Checkout Pro)"| MP
    MP -->|"webhook de pagamento"| BILL

    LAMBDA -.->|"lê clientes (dívida: acesso cruzado)"| DBOS

    OS -.->|"observabilidade"| NR
    BILL -.->|"observabilidade"| NR
    EXEC -.->|"observabilidade"| NR
```

## Notas

- **Entrada**: o cliente e o staff chegam pelo API Gateway
  (id `7eu2kz40xj`). `/auth/cpf` vai para a Lambda
  `oficina-auth-cpf`; `{proxy+}` vai para o NLB interno, via VPC Link.
- **Roteamento**: o nginx-ingress no EKS roteia por path: `/os/*`,
  `/billing/*` e `/execucao/*`.
- **Saga**: o orquestrador da Saga roda dentro do OS Service. Não há
  serviço separado para ele.
- **Bancos**: cada serviço liga só ao próprio banco. `oficina_os` e
  `oficina_billing` são dois bancos lógicos na mesma instância RDS.
  Execução usa DynamoDB, que é NoSQL.
- **Eventos**: o barramento SNS + SQS tem 3 tópicos, 3 filas e 3 DLQs,
  ligado aos três serviços.
- **Pagamento**: o Billing Service cria a preference no Mercado Pago
  (Checkout Pro) e recebe o webhook de pagamento.
- **Dívida declarada**: a Lambda `oficina-auth-cpf` lê a tabela
  `clientes` direto em `oficina_os`, de que o OS Service é dono. É o
  único acesso cruzado restante (ver ADR 0008); a correção, consultar o
  OS Service por HTTP, fica fora desta fase.
- **Eventos (direção)**: cada serviço publica no barramento e consome da
  própria fila.
- **Observabilidade**: o New Relic (conta 8510401) observa os três
  serviços.
