/**
 * Definição estática da Saga da Ordem de Serviço (domínio puro: sem Prisma,
 * sem Nest, sem I/O). Os tipos abaixo espelham os enums do schema Prisma, mas
 * são declarados localmente para manter o domínio independente do client.
 */

export type StatusSaga =
  | 'EM_ANDAMENTO'
  | 'CONCLUIDA'
  | 'COMPENSADA'
  | 'PENDENTE'
  | 'FALHOU';

export type StatusPassoSaga =
  | 'PENDENTE'
  | 'EM_ANDAMENTO'
  | 'CONCLUIDO'
  | 'FALHOU'
  | 'COMPENSADO'
  | 'EXPIRADO';

export type NomePassoSaga =
  | 'ABRIR_OS'
  | 'GERAR_ORCAMENTO'
  | 'APROVAR_ORCAMENTO'
  | 'EXECUTAR'
  | 'COBRAR'
  | 'CONFIRMAR';

export type Compensacao =
  | 'OS_REPROVADA'
  | 'OS_VOLTA_APROVADA'
  | 'PAGAMENTO_PENDENTE';

export const EVENTOS_SAGA = {
  OS_CRIADA: 'os.criada',
  DIAGNOSTICO_CONCLUIDO: 'diagnostico.concluido',
  ORCAMENTO_GERADO: 'orcamento.gerado',
  ORCAMENTO_APROVADO: 'orcamento.aprovado',
  ORCAMENTO_REPROVADO: 'orcamento.reprovado',
  OS_EXECUCAO_SOLICITADA: 'os.execucao.solicitada',
  EXECUCAO_INICIADA: 'execucao.iniciada',
  EXECUCAO_CONCLUIDA: 'execucao.concluida',
  EXECUCAO_FALHOU: 'execucao.falhou',
  OS_COBRANCA_SOLICITADA: 'os.cobranca.solicitada',
  PAGAMENTO_CONFIRMADO: 'pagamento.confirmado',
  PAGAMENTO_RECUSADO: 'pagamento.recusado',
  OS_FINALIZADA: 'os.finalizada',
  SAGA_PASSO_EXPIRADO: 'saga.passo.expirado',
} as const;

export interface DefinicaoPasso {
  readonly ordem: number;
  readonly nome: NomePassoSaga;
  /** Evento que a OS publica no outbox ao iniciar o passo (ou null). */
  readonly comando: string | null;
  /** Evento que conclui o passo; null = concluído imediatamente. */
  readonly eventoEsperado: string | null;
  /** Eventos aceitos como progresso, sem concluir o passo. */
  readonly eventosProgresso: readonly string[];
  readonly eventosDeFalha: readonly string[];
  readonly timeoutMs: number;
}

export interface ResultadoFalha {
  readonly statusPasso: StatusPassoSaga;
  readonly statusSaga: StatusSaga;
  readonly compensacao: Compensacao;
}

export type EnvSaga = Readonly<Record<string, string | undefined>>;

const HORA_MS = 60 * 60 * 1000;

const TIMEOUT_DEFAULT_MS: Readonly<Record<NomePassoSaga, number>> = {
  ABRIR_OS: HORA_MS,
  GERAR_ORCAMENTO: HORA_MS,
  APROVAR_ORCAMENTO: 24 * HORA_MS,
  EXECUTAR: HORA_MS,
  COBRAR: HORA_MS,
  CONFIRMAR: HORA_MS,
};

/**
 * Timeout do passo em ms. Lê `SAGA_TIMEOUT_<NOME>_MS` do `env` informado;
 * valores ausentes ou inválidos (não inteiros positivos) usam o padrão.
 */
export function timeoutPadraoMs(
  nome: NomePassoSaga,
  env: EnvSaga = {},
): number {
  const configurado = Number(env[`SAGA_TIMEOUT_${nome}_MS`]);
  return Number.isInteger(configurado) && configurado > 0
    ? configurado
    : TIMEOUT_DEFAULT_MS[nome];
}

export const SAGA_PASSOS: readonly DefinicaoPasso[] = [
  {
    ordem: 1,
    nome: 'ABRIR_OS',
    comando: EVENTOS_SAGA.OS_CRIADA,
    eventoEsperado: null,
    eventosProgresso: [],
    eventosDeFalha: [],
    timeoutMs: timeoutPadraoMs('ABRIR_OS'),
  },
  {
    ordem: 2,
    nome: 'GERAR_ORCAMENTO',
    comando: EVENTOS_SAGA.DIAGNOSTICO_CONCLUIDO,
    eventoEsperado: EVENTOS_SAGA.ORCAMENTO_GERADO,
    eventosProgresso: [],
    eventosDeFalha: [],
    timeoutMs: timeoutPadraoMs('GERAR_ORCAMENTO'),
  },
  {
    ordem: 3,
    nome: 'APROVAR_ORCAMENTO',
    comando: null,
    eventoEsperado: EVENTOS_SAGA.ORCAMENTO_APROVADO,
    eventosProgresso: [],
    eventosDeFalha: [EVENTOS_SAGA.ORCAMENTO_REPROVADO],
    timeoutMs: timeoutPadraoMs('APROVAR_ORCAMENTO'),
  },
  {
    ordem: 4,
    nome: 'EXECUTAR',
    comando: EVENTOS_SAGA.OS_EXECUCAO_SOLICITADA,
    eventoEsperado: EVENTOS_SAGA.EXECUCAO_CONCLUIDA,
    eventosProgresso: [EVENTOS_SAGA.EXECUCAO_INICIADA],
    eventosDeFalha: [EVENTOS_SAGA.EXECUCAO_FALHOU],
    timeoutMs: timeoutPadraoMs('EXECUTAR'),
  },
  {
    ordem: 5,
    nome: 'COBRAR',
    comando: EVENTOS_SAGA.OS_COBRANCA_SOLICITADA,
    eventoEsperado: EVENTOS_SAGA.PAGAMENTO_CONFIRMADO,
    eventosProgresso: [],
    eventosDeFalha: [EVENTOS_SAGA.PAGAMENTO_RECUSADO],
    timeoutMs: timeoutPadraoMs('COBRAR'),
  },
  {
    ordem: 6,
    nome: 'CONFIRMAR',
    comando: EVENTOS_SAGA.OS_FINALIZADA,
    eventoEsperado: null,
    eventosProgresso: [],
    eventosDeFalha: [],
    timeoutMs: timeoutPadraoMs('CONFIRMAR'),
  },
];

export const DEFINICAO_POR_NOME: Readonly<
  Record<NomePassoSaga, DefinicaoPasso>
> = Object.fromEntries(SAGA_PASSOS.map((p) => [p.nome, p])) as Record<
  NomePassoSaga,
  DefinicaoPasso
>;

/** Efeito de cada evento de falha no passo, na saga e na OS. */
export const COMPENSACAO_POR_FALHA: Readonly<Record<string, ResultadoFalha>> = {
  [EVENTOS_SAGA.ORCAMENTO_REPROVADO]: {
    statusPasso: 'COMPENSADO',
    statusSaga: 'COMPENSADA',
    compensacao: 'OS_REPROVADA',
  },
  [EVENTOS_SAGA.EXECUCAO_FALHOU]: {
    statusPasso: 'COMPENSADO',
    statusSaga: 'COMPENSADA',
    compensacao: 'OS_VOLTA_APROVADA',
  },
  [EVENTOS_SAGA.PAGAMENTO_RECUSADO]: {
    statusPasso: 'FALHOU',
    statusSaga: 'PENDENTE',
    compensacao: 'PAGAMENTO_PENDENTE',
  },
};
