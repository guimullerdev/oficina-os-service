/**
 * Máquina de passos da Saga da Ordem de Serviço. Funções puras: recebem um
 * snapshot e devolvem uma decisão, sem mutar a entrada nem fazer I/O.
 */
import {
  COMPENSACAO_POR_FALHA,
  DEFINICAO_POR_NOME,
  EVENTOS_SAGA,
  SAGA_PASSOS,
  timeoutPadraoMs,
} from './saga-definicao';
import type {
  Compensacao,
  DefinicaoPasso,
  EnvSaga,
  NomePassoSaga,
  StatusPassoSaga,
  StatusSaga,
} from './saga-definicao';

export interface PassoSnapshot {
  ordem: number;
  nome: NomePassoSaga;
  status: StatusPassoSaga;
  tentativas: number;
  expiraEm: Date | null;
}

export interface SagaSnapshot {
  status: StatusSaga;
  passos: PassoSnapshot[];
}

export type PassoAlterado = PassoSnapshot;

export interface ComandoSaga {
  evento: string;
  payload: { ordem: number; nome: NomePassoSaga };
}

export type TipoDecisao = 'AVANCAR' | 'PROGRESSO' | 'COMPENSAR' | 'IGNORAR';

export interface DecisaoSaga {
  tipo: TipoDecisao;
  passosAlterados: PassoAlterado[];
  novoStatusSaga: StatusSaga;
  comandos: ComandoSaga[];
  compensacao?: Compensacao;
  motivo?: string;
}

export interface DecisaoInicio {
  status: StatusSaga;
  passos: PassoAlterado[];
  comandos: ComandoSaga[];
}

interface Encadeamento {
  passos: PassoAlterado[];
  comandos: ComandoSaga[];
  sagaConcluida: boolean;
}

function comando(def: DefinicaoPasso, evento: string): ComandoSaga {
  return { evento, payload: { ordem: def.ordem, nome: def.nome } };
}

function tentativasDe(passos: readonly PassoSnapshot[], ordem: number): number {
  return passos.find((p) => p.ordem === ordem)?.tentativas ?? 0;
}

/**
 * Inicia `primeiro` e encadeia os passos seguintes enquanto não tiverem
 * evento esperado (concluídos imediatamente). Para no primeiro passo que
 * precisa aguardar um evento; se acabarem os passos, a saga está concluída.
 */
function iniciarEncadeando(
  primeiro: DefinicaoPasso | undefined,
  passosAtuais: readonly PassoSnapshot[],
  agora: Date,
  env: EnvSaga,
): Encadeamento {
  const passos: PassoAlterado[] = [];
  const comandos: ComandoSaga[] = [];
  let def = primeiro;

  while (def) {
    const tentativas = tentativasDe(passosAtuais, def.ordem) + 1;
    if (def.comando !== null) comandos.push(comando(def, def.comando));

    if (def.eventoEsperado !== null) {
      passos.push({
        ordem: def.ordem,
        nome: def.nome,
        status: 'EM_ANDAMENTO',
        tentativas,
        expiraEm: new Date(agora.getTime() + timeoutPadraoMs(def.nome, env)),
      });
      return { passos, comandos, sagaConcluida: false };
    }

    passos.push({
      ordem: def.ordem,
      nome: def.nome,
      status: 'CONCLUIDO',
      tentativas,
      expiraEm: null,
    });
    const ordemAtual = def.ordem;
    def = SAGA_PASSOS.find((p) => p.ordem === ordemAtual + 1);
  }

  return { passos, comandos, sagaConcluida: true };
}

function ignorar(snapshot: SagaSnapshot, motivo: string): DecisaoSaga {
  return {
    tipo: 'IGNORAR',
    passosAlterados: [],
    novoStatusSaga: snapshot.status,
    comandos: [],
    motivo,
  };
}

/** Passo 1 concluído, passo 2 em andamento e os demais pendentes. */
export function iniciar(agora: Date, env: EnvSaga = {}): DecisaoInicio {
  const { passos, comandos } = iniciarEncadeando(
    SAGA_PASSOS[0],
    [],
    agora,
    env,
  );
  const pendentes: PassoAlterado[] = SAGA_PASSOS.filter(
    (def) => !passos.some((p) => p.ordem === def.ordem),
  ).map((def) => ({
    ordem: def.ordem,
    nome: def.nome,
    status: 'PENDENTE',
    tentativas: 0,
    expiraEm: null,
  }));

  return {
    status: 'EM_ANDAMENTO',
    passos: [...passos, ...pendentes],
    comandos,
  };
}

export function aplicarEvento(
  snapshot: SagaSnapshot,
  evento: string,
  agora: Date,
  env: EnvSaga = {},
): DecisaoSaga {
  if (snapshot.status !== 'EM_ANDAMENTO') {
    return ignorar(
      snapshot,
      `saga em status ${snapshot.status} não aceita o evento ${evento}`,
    );
  }

  const atual = snapshot.passos.find((p) => p.status === 'EM_ANDAMENTO');
  if (!atual) {
    return ignorar(
      snapshot,
      `nenhum passo em andamento para o evento ${evento}`,
    );
  }

  const def = DEFINICAO_POR_NOME[atual.nome];

  if (evento === def.eventoEsperado) {
    const proximo = SAGA_PASSOS.find((p) => p.ordem === def.ordem + 1);
    const { passos, comandos, sagaConcluida } = iniciarEncadeando(
      proximo,
      snapshot.passos,
      agora,
      env,
    );
    return {
      tipo: 'AVANCAR',
      passosAlterados: [
        { ...atual, status: 'CONCLUIDO', expiraEm: null },
        ...passos,
      ],
      novoStatusSaga: sagaConcluida ? 'CONCLUIDA' : 'EM_ANDAMENTO',
      comandos,
    };
  }

  if (def.eventosProgresso.includes(evento)) {
    return {
      tipo: 'PROGRESSO',
      passosAlterados: [],
      novoStatusSaga: snapshot.status,
      comandos: [],
    };
  }

  if (def.eventosDeFalha.includes(evento)) {
    const resultado = COMPENSACAO_POR_FALHA[evento];
    return {
      tipo: 'COMPENSAR',
      passosAlterados: [
        { ...atual, status: resultado.statusPasso, expiraEm: null },
      ],
      novoStatusSaga: resultado.statusSaga,
      comandos: [],
      compensacao: resultado.compensacao,
      motivo: `passo ${atual.nome} recebeu ${evento}`,
    };
  }

  return ignorar(
    snapshot,
    `evento ${evento} fora de ordem: passo ${atual.nome} espera ${def.eventoEsperado}`,
  );
}

/**
 * Time-out de passo: o passo vencido passa por EXPIRADO e é COMPENSADO, a saga
 * é COMPENSADA e `saga.passo.expirado` é emitido. Não altera o status da OS.
 */
export function expirar(snapshot: SagaSnapshot, agora: Date): DecisaoSaga {
  const vencido = snapshot.passos.find(
    (p) =>
      p.status === 'EM_ANDAMENTO' &&
      p.expiraEm !== null &&
      p.expiraEm.getTime() <= agora.getTime(),
  );
  if (!vencido) return ignorar(snapshot, 'nenhum passo expirado');

  return {
    tipo: 'COMPENSAR',
    passosAlterados: [{ ...vencido, status: 'COMPENSADO', expiraEm: null }],
    novoStatusSaga: 'COMPENSADA',
    comandos: [
      {
        evento: EVENTOS_SAGA.SAGA_PASSO_EXPIRADO,
        payload: { ordem: vencido.ordem, nome: vencido.nome },
      },
    ],
    motivo: `passo ${vencido.nome} passou por EXPIRADO e foi COMPENSADO`,
  };
}
