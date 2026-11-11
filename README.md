# Oficina Mecânica — Serviço de OS — Tech Challenge Fase 4

Microsserviço de **Ordens de Serviço (OS)** da Fase 4: API REST de gestão de
uma oficina mecânica (OS, clientes, veículos e autenticação) e orquestrador da
Saga que coordena os serviços de Billing e Execução. Evolução das fases
anteriores, rodando em **infraestrutura real na AWS**, com autenticação de cliente
por CPF via função serverless, deploy automatizado em Kubernetes e
observabilidade ponta a ponta.

**Stack:** NestJS · Prisma 7 · PostgreSQL (RDS) · Docker · Kubernetes (EKS) ·
AWS API Gateway · AWS Lambda · Terraform · GitHub Actions · New Relic

Este é um dos **6 repositórios** da Fase 4:

| Repositório | Papel |
|---|---|
| **`oficina-os-service`** (aqui; antigo `TECH-CHALLENGE-FASE-ONE`) | microsserviço de OS: aplicação, orquestrador da Saga, manifestos Kubernetes e pipeline de deploy |
| [`oficina-billing-service`](https://github.com/guimullerdev/oficina-billing-service) | microsserviço de orçamento e pagamento |
| [`oficina-execucao-service`](https://github.com/guimullerdev/oficina-execucao-service) | microsserviço de execução do serviço e estoque de peças |
| [`oficina-auth-lambda`](https://github.com/guimullerdev/oficina-auth-lambda) | função serverless de autenticação por CPF |
| [`oficina-infra-k8s`](https://github.com/guimullerdev/oficina-infra-k8s) | cluster EKS, API Gateway e observabilidade |
| [`oficina-infra-db`](https://github.com/guimullerdev/oficina-infra-db) | banco de dados gerenciado (RDS) |

---

## Deploy ativo

A aplicação é alcançada **pelo API Gateway**, não diretamente. No cluster, o
`Service` é do tipo `ClusterIP` e o tráfego entra pelo `Ingress` nginx
([`k8s/ingress.yaml`](k8s/ingress.yaml)), atrás do NLB único que o
`oficina-infra-k8s` provisiona e que o API Gateway acessa via VPC Link (ver
ADR 0006). Há um único ambiente, `prod` (ver ADR 0009).

| Ambiente | Endpoint |
|---|---|
| Produção (`prod`) | https://7eu2kz40xj.execute-api.us-east-1.amazonaws.com/prod |

- **Swagger**: https://7eu2kz40xj.execute-api.us-east-1.amazonaws.com/prod/api
- **Healthcheck**: https://7eu2kz40xj.execute-api.us-east-1.amazonaws.com/prod/health
- **Dashboard de observabilidade**: https://onenr.io/0qwykVVv1jn

Exemplo de ponta a ponta — CPF vira JWT, JWT abre as rotas do cliente:

```bash
BASE=https://7eu2kz40xj.execute-api.us-east-1.amazonaws.com/prod

TOKEN=$(curl -s -X POST "$BASE/auth/cpf" \
  -H 'content-type: application/json' \
  -d '{"cpf":"69759054876"}' | jq -r .accessToken)

curl -s "$BASE/os/me" -H "authorization: Bearer $TOKEN"
```

> Infraestrutura de curso, provisionada para a avaliação e destruída depois.
> Se os endpoints não responderem, é porque o `terraform destroy` já rodou —
> todo o provisionamento está versionado nos repositórios de infraestrutura.

---

## Objetivos da Fase 3

- **Autenticação de cliente por CPF** via função serverless, com JWT aceito
  pela mesma API que já autentica o staff por e-mail/senha — dois atores
  distintos convivendo (ver RFC 0003).
- **Infraestrutura gerenciada na AWS**: EKS para o cluster, RDS para o banco,
  Lambda para a autenticação e API Gateway como porta de entrada única.
- **Deploy automatizado em ambiente único**: a `main` publica a imagem e faz o
  deploy no namespace `prod`; a `develop` só builda e testa (ADR 0009).
- **Observabilidade**: logs estruturados em JSON com correlation-id,
  distributed tracing, dashboards, alertas e monitoramento externo de uptime.
- **Documentação arquitetural**: RFCs, ADRs e diagramas em [`docs/`](docs/).

### Objetivos da Fase 2 (histórico)

- **Refatoração** aplicando Clean Architecture (camadas
  `domain` / `application` / `infrastructure` / `presentation` por módulo) e
  Clean Code, com testes automatizados cobrindo os fluxos críticos.
- **Evolução das APIs de OS**: abertura de OS, consulta de status, aprovação de
  orçamento via notificação externa, listagem priorizada com exclusão lógica e
  atualização de status por ator externo.
- **Infraestrutura como código e automação**: conteinerização, manifestos
  Kubernetes com HPA, provisionamento via Terraform e pipeline de CI/CD que
  builda, testa e faz o deploy de ponta a ponta.

### Escopo da Fase 2

Esta fase cobre só o núcleo de OS: `service-orders`, `customers`, `vehicles` e
`auth`. `servicoId` e `pecaId` são **referências fracas**: não são validados
contra um catálogo, e o preço vem informado na própria requisição
(`precoUnitario`).

**Gap funcional deliberado:** a OS não gera orçamento nem controla estoque
nesta fase. Concluir o diagnóstico só muda o status para `AGUARDANDO_APROVACAO`,
e a aprovação ou reprovação chega pelo webhook de notificação. Orçamento e
estoque passam a viver nos serviços **Billing** e **Execução**, que ainda não
existem.

---

## Arquitetura

### Visão dos microsserviços

A Fase 4 divide o antigo monólito em três serviços, cada um com seu banco e sua
própria infraestrutura, que conversam por eventos (SNS + SQS). Diagramas:
[arquitetura de microsserviços](docs/diagrams/0005-arquitetura-microsservicos.md)
e [sequência da Saga](docs/diagrams/0006-sequencia-saga-os.md).

| Serviço | Dono de | Tópico que publica |
|---|---|---|
| **OS** (este repo) | OS, clientes, veículos, autenticação e o estado da Saga | `oficina-os-events` |
| **Billing** | orçamento e pagamento | `oficina-billing-events` |
| **Execução** | execução do serviço e estoque de peças | `oficina-execucao-events` |

Papel deste serviço: é dono de OS, clientes, veículos e auth; **hospeda o
orquestrador da Saga**; publica eventos via outbox → SNS (tópico
`oficina-os-events`) e consome a própria fila SQS (`oficina-os-queue`). Os
tópicos vivem no `oficina-infra-k8s`; a fila, a DLQ e as subscriptions vivem em
[`terraform/`](terraform/) deste repo (ADR
[0007](docs/adr/0007-propriedade-topicos-filas.md)).

### Saga orquestrada

A Saga do sistema é **orquestrada**, com o orquestrador dentro do OS Service
(decisão da [RFC 0006](docs/rfc/0006-saga-pattern.md); propriedade de tópicos e
filas na [ADR 0007](docs/adr/0007-propriedade-topicos-filas.md)).

**Por que orquestrada e não coreografada:**

- **Visibilidade central:** `GET /os/:id/saga` devolve a instância e todos os
  passos (`saga_instancias` / `saga_passos`) num só lugar.
- **Compensações e timeouts explícitos:** cada falha mapeia para uma compensação
  declarada, e cada passo tem timeout próprio (`saga.passo.expirado`).
- **Um único lugar para a máquina de estados:** a definição vive em
  `saga-definicao.ts`, em vez de espalhada por três repositórios.
- **Fácil de evidenciar e testar:** o caminho feliz e o compensado são cobertos
  por um cenário BDD de ponta a ponta (ver [Testes BDD](#testes-bdd-compensação-da-saga)).

**Trade-offs da Saga coreografada:** o fluxo fica implícito, emergindo de reações
encadeadas; é difícil de rastrear e de demonstrar; o rollback fica implícito; e
os serviços tendem a depender ciclicamente uns dos eventos dos outros.

**Custo da escolha:** o OS Service vira coordenador e ponto único de lógica do
fluxo. Se ele ficar indisponível, as sagas em andamento paralisam; nenhum dado
se perde, porque os eventos pendentes ficam no `outbox` e saem quando o serviço
volta.

### Eventos

Publicados por este serviço no tópico `oficina-os-events` (fonte:
`src/modules/service-orders/application/saga/saga-definicao.ts`):

| Evento | Passo da Saga | Quando |
|---|---|---|
| `os.criada` | `ABRIR_OS` | abertura da OS |
| `diagnostico.concluido` | `GERAR_ORCAMENTO` | diagnóstico concluído |
| `os.execucao.solicitada` | `EXECUTAR` | orçamento aprovado |
| `os.cobranca.solicitada` | `COBRAR` | execução concluída |
| `os.finalizada` | `CONFIRMAR` | pagamento confirmado |
| `saga.passo.expirado` | qualquer | timeout do passo (ver [Time-out de passos da saga](#time-out-de-passos-da-saga)) |

Consumidos pela fila `oficina-os-queue` (filter policy em `terraform/main.tf`,
atributo `evento`):

| Origem | Evento | Efeito na Saga |
|---|---|---|
| `oficina-billing-events` | `orcamento.gerado` | conclui `GERAR_ORCAMENTO` |
| `oficina-billing-events` | `orcamento.aprovado` | conclui `APROVAR_ORCAMENTO` |
| `oficina-billing-events` | `orcamento.reprovado` | compensação `OS_REPROVADA`: passo `COMPENSADO`, saga `COMPENSADA` |
| `oficina-billing-events` | `pagamento.confirmado` | conclui `COBRAR` |
| `oficina-billing-events` | `pagamento.recusado` | compensação `PAGAMENTO_PENDENTE`: passo `FALHOU`, saga `PENDENTE` |
| `oficina-execucao-events` | `execucao.iniciada` | progresso de `EXECUTAR` (não conclui o passo) |
| `oficina-execucao-events` | `execucao.concluida` | conclui `EXECUTAR` |
| `oficina-execucao-events` | `execucao.falhou` | compensação `OS_VOLTA_APROVADA`: passo `COMPENSADO`, saga `COMPENSADA` |

### Filas

- Fila `oficina-os-queue`, com DLQ `oficina-os-dlq` e redrive
  `maxReceiveCount = 3` (`terraform/variables.tf`).
- Entrega at-least-once: a idempotência é por `eventId`. Detalhes em
  [Publicação de eventos (outbox → SNS)](#publicação-de-eventos-outbox--sns) e
  [Consumo de eventos (SQS)](#consumo-de-eventos-sqs).

### Componentes da aplicação

Monólito NestJS organizado em módulos, cada um em Clean Architecture:

```
src/
├── modules/
│   ├── auth/            # autenticação JWT + guards (JWT, Roles, Webhook)
│   ├── customers/       # clientes
│   ├── vehicles/        # veículos
│   └── service-orders/  # ciclo de vida da OS (+ webhook de notificação externa)
├── common/health/       # GET /health (liveness/readiness)
└── prisma/              # PrismaService
```

- Cada módulo isola regras de negócio no `domain` (entidades, value objects,
  interfaces de repositório = *ports*) e a persistência no `infrastructure`
  (repositórios Prisma = *adapters*). `application` (use cases) depende só das
  interfaces; `presentation` (controllers) só dos use cases.

![img.png](components.png)

### Infraestrutura provisionada

O cluster EKS é provisionado pelo `oficina-infra-k8s`, e o banco é um RDS
PostgreSQL (`oficina-infra-db`), fora do cluster. A aplicação roda no namespace
`prod`:

```
Cluster EKS (oficina-infra-k8s)
├── kube-system
│   └── metrics-server          # métricas de CPU para o HPA
└── namespace: prod
    ├── ConfigMap + Secret       # NODE_ENV, JWT, DATABASE_URL, WEBHOOK_SECRET
    ├── Ingress (nginx)          # /os, /clientes, /veiculos, /auth, /api, /health
    └── oficina-os-service       # Deployment (2 pods) + Service ClusterIP + HPA (2→5, CPU 70%)
```

- Atores externos acessam a API pelo API Gateway; o cliente pode consultar o
  status da OS publicamente e um sistema externo aprova/reprova a OS pelo
  webhook (`POST /os/webhook/notificacao`, autenticado por `WEBHOOK_SECRET`).

![img_1.png](infra.png)

### Fluxo de deploy (CI/CD)

Pipeline no GitHub Actions (`.github/workflows/ci-cd.yml`), disparado por push
em `main` e `develop` (ignorando mudanças só em `docs/` e `*.md`), por
pull_request para essas branches e manualmente (`workflow_dispatch`), rodando
em runner `ubuntu-latest`:

1. **build-and-test** — `yarn install --frozen-lockfile`, `yarn lint:ci`,
   `yarn build`, `yarn test:cov` (com threshold de cobertura) e a análise do
   SonarQube Cloud. Roda em `main` e `develop`. Detalhes na seção
   [Qualidade de código](#qualidade-de-código-lint-e-sonarqube-cloud).
2. **terraform-check** — `terraform fmt -check`, `init -backend=false` e
   `validate`, só checagens estáticas, sem credenciais AWS. Roda em `main` e
   `develop`.
3. **docker-build-push** — só na `main`: builda a imagem e publica no GHCR com
   a tag do SHA do commit (e `latest`).
4. **deploy** — só na `main`, no environment `prod`: atualiza o kubeconfig do
   cluster EKS e aplica os manifestos no namespace `prod`.

Na `develop` o pipeline para em build, testes e checagem do Terraform: não
publica imagem e não faz deploy. Sem secrets de AWS, o job `deploy` só emite
um aviso e não publica nada no cluster.

---

## Execução local (Docker Compose)

```bash
cp .env.example .env
docker compose up
```

- PostgreSQL na porta `5432`, API na porta `3000` (com hot-reload), migrações
  aplicadas automaticamente no start.
- API em **http://localhost:3000** · Swagger em **http://localhost:3000/api**.

```bash
docker compose down      # para o stack
docker compose down -v   # para e apaga o volume do banco
```

---

## Deploy em Kubernetes

A partir da Fase 3 o `infra/` (Terraform de cluster e banco) **saiu deste
repositório**. A divisão é:

| Onde | Responsabilidade |
|---|---|
| `oficina-infra-k8s` | Provisiona o cluster EKS (node groups, rede, add-ons, namespaces), o NLB único e o API Gateway |
| `oficina-infra-db` | Provisiona o RDS PostgreSQL |
| **Este repo (`k8s/`)** | `Deployment`, `Service`, `Ingress`, `HPA`, `ConfigMap` e o Job de migration — e o pipeline que aplica tudo isso |

A fronteira segue a ADR 0001: o repo de infraestrutura provisiona o
ambiente, e o ciclo de vida da aplicação (incluindo o deploy dela) pertence
a quem é dono do código.

### Pré-requisitos e avisos

- **A migration `fronteira_dados` é destrutiva e irreversível.** Ela faz
  `DROP TABLE` em `movimentacoes_estoque`, `orcamentos`, `pecas` e `servicos`,
  e não há migration de rollback. Só rodar contra o banco `oficina_os`
  **vazio**: com dados, eles se perdem.
- **O pacote da imagem no GHCR precisa ser público.** Os manifestos não têm
  `imagePullSecrets`, então o cluster puxa `ghcr.io/.../oficina-os-service:<sha>`
  sem credencial; com o pacote privado, o rollout não sobe.

### Como o deploy acontece

O pipeline deste repo, depois de publicar a imagem:

1. `aws eks update-kubeconfig` — autentica no cluster provisionado pelo
   `oficina-infra-k8s`
2. Confere se a `DATABASE_URL` do environment `prod` aponta para o banco
   `oficina_os` e **aborta se não apontar**; a mensagem de erro não imprime o
   valor do secret
3. Cria o `Secret` a partir dos secrets do environment (`DATABASE_URL`,
   `JWT_SECRET`, …) — nunca de arquivo versionado
4. Aplica `ConfigMap`, `Service` e `Ingress` (`k8s/ingress.yaml`)
5. Aplica o **Job de migration e espera terminar** — se o schema falhar, o
   rollout é abortado e a versão nova nunca sobe contra um banco
   desatualizado (ADR 0005)
6. Só então aplica `Deployment` e `HPA`, e aguarda o rollout

Há um único ambiente, o namespace `prod`, e só a `main` faz deploy (ADR 0009).
A imagem é sempre a tag do **SHA** do commit, nunca `latest`, para o rollout
apontar exatamente para o que aquele build produziu.

Os secrets ficam no **GitHub Environment** `prod`, não no escopo do repositório.
É o environment que faz `secrets.DATABASE_URL` resolver para o banco certo. Os
secrets lidos pelo pipeline são:

| Secret | Uso |
|---|---|
| `DATABASE_URL` | Conexão com o banco `oficina_os` (RDS); o passo 2 recusa outro nome de banco |
| `JWT_SECRET` | Chave de assinatura do JWT |
| `WEBHOOK_SECRET` | Autenticação do webhook de notificação externa |
| `NEW_RELIC_LICENSE_KEY` | Envio de telemetria ao New Relic |
| `SNS_TOPIC_ARN` | Tópico SNS que recebe os eventos do outbox |
| `SQS_QUEUE_URL` | Fila SQS consumida pela aplicação |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Credenciais AWS (`configure-aws-credentials`) |
| `AWS_SESSION_TOKEN` | Opcional; só para credencial temporária (AWS Academy Learner Lab) |

### Manifestos (`k8s/`)

| Arquivo | O que é |
|---|---|
| `deployment.yaml` | Deployment da API (2 réplicas, probes em `/health`) |
| `service.yaml` | Service `ClusterIP` na porta 80, apontando para a 3000 do pod |
| `ingress.yaml` | Ingress nginx: roteia `/os`, `/clientes`, `/veiculos`, `/auth` e `/api` (prefixo) e `/health` (exato) para o Service, sem rewrite |
| `hpa.yaml` | HPA de 2 a 5 réplicas a 70% de CPU (ADR 0003) |
| `configmap.yaml` | Config não sensível (`NODE_ENV`, `PORT`, …) |
| `migration-job.yaml` | Job que roda `prisma migrate deploy` dentro do cluster |
| `secret.example.yaml` | **Exemplo apenas** — mostra o formato esperado; o Secret real é criado pelo pipeline |

Nenhum manifesto declara `namespace`: o mesmo arquivo serve aos dois
ambientes, e o `kubectl apply -n` do pipeline decide qual. `${APP_IMAGE}` e
`${NAMESPACE}` são substituídos via `envsubst` na hora do deploy.

### Rodando os manifestos à mão

```bash
export APP_IMAGE=ghcr.io/guimullerdev/oficina-os-service:<sha>
export NAMESPACE=prod
export MIGRATION_JOB_NAME=oficina-migrate-manual

kubectl apply -n "$NAMESPACE" -f k8s/configmap.yaml -f k8s/service.yaml -f k8s/ingress.yaml
envsubst < k8s/migration-job.yaml | kubectl apply -n "$NAMESPACE" -f -
kubectl wait -n "$NAMESPACE" --for=condition=complete job/$MIGRATION_JOB_NAME --timeout=300s
envsubst < k8s/deployment.yaml  | kubectl apply -n "$NAMESPACE" -f -
kubectl apply -n "$NAMESPACE" -f k8s/hpa.yaml
```

O `Secret` precisa existir antes — crie com `kubectl create secret generic
oficina-os-service-secret` (ver o formato em `k8s/secret.example.yaml`).

---

## APIs

- **Swagger / OpenAPI:** `http://localhost:3000/api` (com a aplicação rodando).
- Coleção de exemplos de requisições: [`manual-test.http`](manual-test.http).

Destaques da Fase 2:

- `POST /os` — abertura de OS retornando o identificador único.
- `GET /os/:id/status` — consulta do status da OS.
- `GET /os` — listagem ordenada por prioridade de status (Em Execução >
  Aguardando Aprovação > Diagnóstico > Recebida), mais antigas primeiro, com
  exclusão lógica das arquivadas.
- `POST /os/webhook/notificacao` — webhook externo que aprova/reprova uma OS em
  `AGUARDANDO_APROVACAO` e devolve o `statusAtual` pós-ação (autenticado por
  `WEBHOOK_SECRET`).

### Autenticação: dois fluxos, dois atores

A partir da Fase 3 existem **dois** caminhos de autenticação, para dois
atores diferentes. Os dois emitem um JWT assinado com o mesmo `JWT_SECRET`,
e o `JwtAuthGuard` valida qualquer um deles do mesmo jeito.

| | Cliente da oficina | Staff (ADMIN / ATENDENTE / MECANICO) |
|---|---|---|
| Como autentica | CPF, via `POST /auth/cpf` no API Gateway | Email + senha, via `POST /auth/login` |
| Quem emite o token | `oficina-auth-lambda` (Function Serverless) | A própria aplicação |
| Claim `role` | `CLIENTE` | `ADMIN`, `ATENDENTE` ou `MECANICO` |
| O que é o `sub` | `id` do `Cliente` | `id` do `User` |
| Tem senha? | Não, nunca | Sim (bcrypt) |

O cliente **não** existe como `User` no banco — por isso `CLIENTE` fica fora
do enum `UserRole`, que mapeia a tabela `users`. Detalhes na RFC 0003 e na
ADR 0001.

### Rotas por perfil

**Públicas (sem token).** São só as que realmente não podem exigir
autenticação:

| Rota | Por que é pública |
|---|---|
| `POST /auth/login`, `/auth/register`, `/auth/refresh` | É onde o token é obtido |
| `GET /health` | Healthcheck consumido pelo Kubernetes e pelo monitoramento |
| `GET /api` | Swagger |
| `POST /os/webhook/notificacao` | Integração externa — tem validação própria via `WEBHOOK_SECRET`, não JWT |
| `GET /os/consulta?numero=&documento=` | Página pública de acompanhamento, no modelo de rastreio de encomenda — ver abaixo |

Sobre a consulta pública: ela exige o **par** número da OS + documento do
cliente, e o use case só devolve a OS se os dois baterem. É uma decisão de
produto deliberada (o cliente acompanha o serviço sem precisar de conta),
com o par funcionando como credencial de baixa fricção — o mesmo modelo de
um código de rastreio.

**Do cliente (token com `role: CLIENTE`).** Todas restritas ao próprio
`sub` do token — não há como ver dado de outro cliente trocando um
parâmetro:

| Rota | Escopo |
|---|---|
| `GET /os/me` | Só as OS do cliente do token |
| `GET /os/:id/status` | 404 se a OS não for dele |
| `GET /os/:id/acompanhamento` | 404 se a OS não for dele |

As duas últimas eram públicas e passaram a exigir token: diferente da
`/os/consulta`, elas aceitavam **só o UUID**, sem nenhuma conferência de
dono — quem tivesse o identificador lia a OS de qualquer pessoa.

> O 404 (em vez de 403) é deliberado: responder "existe, mas não é sua"
> confirmaria a existência da OS para quem não deveria saber.

**Do staff (token com role interna).** Todo o resto — CRUD de clientes,
veículos, e o ciclo de vida da OS (diagnóstico → aguardando aprovação →
execução → entrega). Algumas operações exigem
perfil específico, por exemplo:

| Rota | Perfis |
|---|---|
| `PATCH /os/:id/servicos/:itemId/realizar` | `MECANICO`, `ADMIN` |
| `PATCH /os/:id/pecas/:itemId/utilizar` | `MECANICO`, `ADMIN` |
| `GET /os` (listagem geral) | Qualquer perfil de staff |

### Todas as rotas

| Método | Rota | Descrição |
|---|---|---|
| `GET`  | `/health` | Health check (liveness/readiness) |
| `POST` | `/auth/register` | Registrar usuário |
| `POST` | `/auth/login` | Autenticar e emitir tokens |
| `POST` | `/auth/refresh` | Renovar o access token |
| `POST` | `/clientes` | Criar cliente |
| `GET`  | `/clientes` | Listar clientes |
| `GET`  | `/clientes/:id` | Buscar cliente por ID |
| `PUT`  | `/clientes/:id` | Atualizar cliente |
| `DELETE` | `/clientes/:id` | Remover cliente |
| `POST` | `/veiculos` | Cadastrar veículo |
| `GET`  | `/veiculos` | Listar veículos |
| `GET`  | `/veiculos/:id` | Buscar veículo por ID |
| `PUT`  | `/veiculos/:id` | Atualizar veículo |
| `DELETE` | `/veiculos/:id` | Remover veículo |
| `POST` | `/os` | Abrir ordem de serviço (itens inline exigem `precoUnitario`) |
| `GET`  | `/os` | Listar OS (priorizada, exclui arquivadas) |
| `GET`  | `/os/consulta` | Consulta pública da OS |
| `GET`  | `/os/:id` | Buscar OS por ID |
| `GET`  | `/os/:id/status` | Consultar status da OS |
| `GET`  | `/os/:id/acompanhamento` | Acompanhamento da OS |
| `POST` | `/os/webhook/notificacao` | Webhook externo — aprova/reprova a OS e devolve `statusAtual` |
| `POST` | `/os/:id/servicos` | Adicionar serviço à OS (`{ servicoId, precoUnitario }`) |
| `DELETE` | `/os/:id/servicos/:itemId` | Remover serviço da OS |
| `PATCH` | `/os/:id/servicos/:itemId/realizar` | Registrar execução de serviço |
| `POST` | `/os/:id/pecas` | Adicionar peça à OS (`{ pecaId, quantidade, precoUnitario }`) |
| `DELETE` | `/os/:id/pecas/:itemId` | Remover peça da OS |
| `PATCH` | `/os/:id/pecas/:itemId/utilizar` | Marcar peça como utilizada |
| `PATCH` | `/os/:id/iniciar-diagnostico` | Iniciar diagnóstico |
| `PATCH` | `/os/:id/concluir-diagnostico` | Concluir diagnóstico (status → `AGUARDANDO_APROVACAO`) |
| `PATCH` | `/os/:id/iniciar-execucao` | Iniciar execução |
| `PATCH` | `/os/:id/finalizar-execucao` | Finalizar execução |
| `PATCH` | `/os/:id/liberar-veiculo` | Liberar veículo |
| `PATCH` | `/os/:id/entregar` | Entregar veículo |

---

## Variáveis de ambiente

| Variável | Descrição | Default |
|---|---|---|
| `DATABASE_URL` | String de conexão do PostgreSQL | `postgresql://oficina:oficina@localhost:5432/oficina_db` |
| `DB_USER` | Usuário do Postgres (Docker Compose) | `oficina` |
| `DB_PASSWORD` | Senha do Postgres (Docker Compose) | `oficina` |
| `DB_NAME` | Nome do banco (Docker Compose) | `oficina_db` |
| `JWT_SECRET` | Chave de assinatura do JWT | `dev_secret_key` |
| `JWT_EXPIRES_IN` | Validade do token | `8h` |
| `WEBHOOK_SECRET` | Segredo do webhook de notificação externa | `dev_webhook_secret` |
| `NODE_ENV` | Ambiente da aplicação | `development` |
| `SNS_TOPIC_ARN` | ARN do tópico SNS que recebe os eventos do outbox | — |
| `OUTBOX_PUBLISHER_ENABLED` | Liga o publisher periódico do outbox (`true`); desligado se ausente | — |
| `OUTBOX_PUBLISH_INTERVAL_MS` | Intervalo entre lotes do publisher | `5000` |
| `OUTBOX_BATCH_SIZE` | Linhas por lote | `50` |
| `SAGA_TIMEOUT_ENABLED` | Liga o scheduler que expira passos de saga vencidos (`true`); desligado se ausente | — |
| `SAGA_TIMEOUT_INTERVAL_MS` | Intervalo entre execuções do scheduler de time-out | `30000` |
| `SAGA_TIMEOUT_<PASSO>_MS` | Prazo do passo (`ABRIR_OS`, `GERAR_ORCAMENTO`, `APROVAR_ORCAMENTO`, `EXECUTAR`, `COBRAR`, `CONFIRMAR`) | 1h (`APROVAR_ORCAMENTO`: 24h) |

### Publicação de eventos (outbox → SNS)

O `OutboxPublisher` (`src/shared/messaging/`) varre a tabela `outbox` a cada
`OUTBOX_PUBLISH_INTERVAL_MS` e publica as linhas pendentes no tópico SNS, com os
atributos `evento` (usado pela filter policy), `eventId` (id da linha),
`correlationId` e `traceparent`.

- **At-least-once:** `published_at` só é preenchido depois que o SNS confirma,
  na mesma transação do lote. Se a transação falhar após o publish, o evento
  é reenviado, então os consumidores devem deduplicar por `eventId`. Falhas
  incrementam `tentativas` e gravam `ultimo_erro`; o lote segue.
- **`FOR UPDATE SKIP LOCKED`:** cada lote bloqueia as linhas que pegou e as
  réplicas simultâneas pulam as linhas já bloqueadas, sem publicar o mesmo
  evento em paralelo.

### Consumo de eventos (SQS)

O `SqsConsumerService` (`src/shared/messaging/sqs/`) roda no próprio processo
HTTP, ligado por `SQS_CONSUMER_ENABLED=true` e `SQS_QUEUE_URL`. Faz long poll
(`SQS_WAIT_TIME_SECONDS`, `SQS_VISIBILITY_TIMEOUT_SECONDS`, `SQS_MAX_MESSAGES`)
e despacha cada mensagem ao handler do `evento` via `IdempotentProcessor`.

- **Duas réplicas, mesma fila Standard:** uma mensagem pode ser entregue mais
  de uma vez, o que é aceitável porque a idempotência por `eventId` descarta
  as duplicatas.
- **Mensagem envenenada:** JSON inválido, `evento` ausente ou desconhecido e
  erro do handler não removem a mensagem da fila; após 3 recebimentos a
  `redrive_policy` a move para a DLQ. Só sucesso (ou duplicata) apaga a mensagem.

### Time-out de passos da saga

O `SagaTimeoutScheduler` (`src/modules/service-orders/application/saga/`) roda no
próprio processo HTTP, ligado por `SAGA_TIMEOUT_ENABLED=true`. A cada
`SAGA_TIMEOUT_INTERVAL_MS` ele chama `SagaOrchestrator.expirarVencidos`, que
procura passos `EM_ANDAMENTO` com `expira_em` no passado (até 50 por execução).
Cada passo vencido passa por `EXPIRADO` e termina `COMPENSADO`, a saga vira
`COMPENSADA` e o evento `saga.passo.expirado` entra no outbox. A OS não é alterada.

- **`FOR UPDATE SKIP LOCKED` com 2 réplicas:** as duas rodam o scheduler, mas a
  seleção trava os passos que pegou e a outra réplica pula as linhas travadas,
  então cada passo expira uma única vez (um só `saga.passo.expirado`). A escrita
  ainda é condicional ao status `EM_ANDAMENTO`: se um evento da saga concluiu o
  passo no meio do caminho, ele vence o time-out.
- **Falha:** qualquer erro reverte o lote inteiro (nada fica pela metade) e é
  logado; o próximo tick tenta de novo. Ticks não se sobrepõem na mesma réplica.

---

## Testes BDD (compensação da Saga)

Os cenários de `features/` (Cucumber, em português) testam a saga de ponta a
ponta contra um stack isolado, definido em `docker-compose.bdd.yml`: a API
real, Postgres e LocalStack (SNS/SQS).

### O que o cenário prova

Em `features/saga-ordem-de-servico.feature`, a OS é levada até
`AGUARDANDO_APROVACAO` e o orçamento é reprovado. O teste verifica que:

- a OS fica `REPROVADA`;
- o passo `APROVAR_ORCAMENTO` da saga fica `COMPENSADO`.

O Billing é simulado: o step publica `orcamento.gerado` e, em seguida,
`orcamento.reprovado` direto no tópico `oficina-billing-events` do LocalStack,
com o `osId` no corpo. Nenhum serviço do Billing real participa do teste.

### Como rodar localmente

Com Docker ativo e `yarn install` feito:

```bash
docker compose -f docker-compose.bdd.yml up -d --build --wait
set -a; . ./.env.bdd; set +a
yarn test:bdd
docker compose -f docker-compose.bdd.yml down -v
```

O cucumber não lê o `.env.bdd` sozinho: por isso o `set -a` exporta as
variáveis antes do `yarn test:bdd`. O `down -v` apaga o volume do Postgres.

Portas no host:

| Serviço    | Porta no host | Variável para mudar            |
|------------|---------------|--------------------------------|
| API        | `3100`        | `BDD_APP_PORT`                 |
| LocalStack | `4567`        | `BDD_LOCALSTACK_PORT`          |
| Postgres   | `55432`       | `BDD_PG_PORT`                  |

Os steps esperam o estado final por polling. Dois ajustes opcionais:

- `BDD_POLL_TIMEOUT_MS` (padrão `90000`): tempo máximo de espera por cada
  `Então`. O timeout do step é esse valor mais 15 s.
- `BDD_POLL_INTERVAL_MS` (padrão `500`): intervalo entre as consultas.

### CI

O job `bdd` de `.github/workflows/ci-cd.yml` sobe o mesmo stack e roda
`yarn test:bdd`. Ele roda em todo pull request, sem filtro de paths. Se falhar,
imprime os logs do stack e, ao final, derruba o stack.

As features ficam fora da cobertura: o Jest só lê `src/` (`rootDir` e
`collectCoverageFrom`) e o Sonar analisa só `src`. O BDD valida o
comportamento de ponta a ponta, mas não entra no threshold de cobertura nem
nas métricas do Sonar.

### Qualidade de código (lint e SonarQube Cloud)

O job `build-and-test` de `.github/workflows/ci-cd.yml` executa, nesta ordem:

1. `yarn lint:ci` — ESLint com `--max-warnings=0` e sem `--fix`: qualquer erro
   ou warning falha o job. O `yarn lint` continua sendo o fixer local, que
   aplica as correções automáticas.
2. `yarn build`
3. `yarn test:cov` — testes com cobertura e thresholds globais de 90% em
   statements, 79% em branches, 90% em functions e 90% em lines.
4. Scan do **SonarQube Cloud** (`SonarSource/sonarqube-scan-action`), que lê o
   relatório `coverage/lcov.info` gerado no passo anterior.

**Configuração.** A análise é definida em `sonar-project.properties`
(`sonar.projectKey=guimullerdev_oficina-os-service`). Ele exclui `src/generated/**` da
análise, e as exclusões de cobertura são as mesmas do `collectCoverageFrom`
do Jest. A organização vem da variável de repositório `SONAR_ORGANIZATION` e
o token de autenticação vem do secret `SONAR_TOKEN`. Sem o secret (por
exemplo, em PR de fork), o step do Sonar é pulado.

**Quality Gate.** O gate é bloqueante: o scan roda com
`sonar.qualitygate.wait=true`, então o job `build-and-test` falha se o gate
reprovar. O projeto usa o gate padrão *Sonar way*, que reprova o PR se a
cobertura em código novo for menor que 80%, se a duplicação em código novo
passar de 3%, se algum rating (segurança, confiabilidade, manutenibilidade) do
código novo cair abaixo de A — o que inclui qualquer issue *blocker* — ou se
houver security hotspot não revisado. As condições de cobertura e duplicação
só valem quando o PR tem 20 linhas novas ou mais.

**Setup (uma vez, manual):**

1. Criar uma organização no plano Free do SonarQube Cloud e importar o repositório.
2. **Desligar o Automatic Analysis** do projeto. Ele conflita com o scan do CI.
3. Gerar um token e salvá-lo como secret `SONAR_TOKEN` no GitHub.
4. Salvar a organization key como variável de repositório `SONAR_ORGANIZATION`.

**Scan local (opcional).** Depois de `yarn test:cov`:

```bash
SONAR_TOKEN=... npx sonarqube-scanner -Dsonar.organization=<org>
```

O serviço `sonarqube` foi removido do `docker-compose.yml`: a análise roda só
no SonarQube Cloud.

---

## Vídeo demonstrativo

**Fase 3**: _(a publicar)_ — autenticação por CPF, geração e uso do JWT,
execução da pipeline, deploy automatizado, consumo das APIs protegidas,
dashboard com análise ao vivo, logs estruturados, correlação entre
componentes e traces.

**Fase 2**: https://www.youtube.com/watch?v=FO_1gfI67RU — deploy da
aplicação, execução do CI/CD, consumo das APIs e escalabilidade automática.

---

## Participantes

1. Guilherme Müller Severo - Discord Guilherme M Severo - RM373321

---

## Scripts úteis

| Comando | Descrição |
|---|---|
| `yarn start:dev` | Sobe a API com hot-reload |
| `yarn build` | Compila para `dist/` |
| `yarn test` / `yarn test:cov` | Testes unitários / com cobertura |
| `yarn test:e2e` | Testes end-to-end |
| `yarn lint` / `yarn lint:ci` | ESLint com correções automáticas / modo CI (sem `--fix`, `--max-warnings=0`) |
