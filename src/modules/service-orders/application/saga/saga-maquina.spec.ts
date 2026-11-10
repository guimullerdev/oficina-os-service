import {
  COMPENSACAO_POR_FALHA,
  EVENTOS_SAGA,
  SAGA_PASSOS,
  timeoutPadraoMs,
} from './saga-definicao';
import type { NomePassoSaga, StatusPassoSaga } from './saga-definicao';
import { aplicarEvento, expirar, iniciar } from './saga-maquina';
import type { PassoSnapshot, SagaSnapshot } from './saga-maquina';

const HORA = 60 * 60 * 1000;
const agora = new Date('2026-01-01T10:00:00.000Z');
const depois = (ms: number) => new Date(agora.getTime() + ms);

function congelar<T>(valor: T): T {
  if (valor instanceof Date) return valor;
  if (valor !== null && typeof valor === 'object') {
    (Object.values(valor) as unknown[]).forEach((v) => {
      congelar(v);
    });
    Object.freeze(valor);
  }
  return valor;
}

/** Monta um snapshot com o passo `ordemAtual` em andamento. */
function snapshotNoPasso(
  ordemAtual: number,
  statusSaga: SagaSnapshot['status'] = 'EM_ANDAMENTO',
  expiraEm: Date | null = depois(HORA),
): SagaSnapshot {
  const passos: PassoSnapshot[] = SAGA_PASSOS.map((def) => {
    let status: StatusPassoSaga = 'PENDENTE';
    if (def.ordem < ordemAtual) status = 'CONCLUIDO';
    if (def.ordem === ordemAtual) status = 'EM_ANDAMENTO';
    return {
      ordem: def.ordem,
      nome: def.nome,
      status,
      tentativas: def.ordem <= ordemAtual ? 1 : 0,
      expiraEm: def.ordem === ordemAtual ? expiraEm : null,
    };
  });
  return congelar({ status: statusSaga, passos });
}

describe('saga-definicao', () => {
  it('define os 6 passos em ordem com comandos e eventos esperados', () => {
    expect(
      SAGA_PASSOS.map((p) => [
        p.ordem,
        p.nome,
        p.comando,
        p.eventoEsperado,
        [...p.eventosDeFalha],
      ]),
    ).toEqual([
      [1, 'ABRIR_OS', 'os.criada', null, []],
      [2, 'GERAR_ORCAMENTO', 'diagnostico.concluido', 'orcamento.gerado', []],
      [
        3,
        'APROVAR_ORCAMENTO',
        null,
        'orcamento.aprovado',
        ['orcamento.reprovado'],
      ],
      [
        4,
        'EXECUTAR',
        'os.execucao.solicitada',
        'execucao.concluida',
        ['execucao.falhou'],
      ],
      [
        5,
        'COBRAR',
        'os.cobranca.solicitada',
        'pagamento.confirmado',
        ['pagamento.recusado'],
      ],
      [6, 'CONFIRMAR', 'os.finalizada', null, []],
    ]);
  });

  it('aceita execucao.iniciada como progresso apenas no passo EXECUTAR', () => {
    const progresso = SAGA_PASSOS.map((p) => [p.nome, [...p.eventosProgresso]]);
    expect(progresso).toEqual([
      ['ABRIR_OS', []],
      ['GERAR_ORCAMENTO', []],
      ['APROVAR_ORCAMENTO', []],
      ['EXECUTAR', ['execucao.iniciada']],
      ['COBRAR', []],
      ['CONFIRMAR', []],
    ]);
  });

  it('expõe as constantes de nomes de evento', () => {
    expect(EVENTOS_SAGA.SAGA_PASSO_EXPIRADO).toBe('saga.passo.expirado');
    expect(EVENTOS_SAGA.ORCAMENTO_REPROVADO).toBe('orcamento.reprovado');
  });

  it('mapeia cada evento de falha para o resultado da compensação', () => {
    expect(COMPENSACAO_POR_FALHA['orcamento.reprovado']).toEqual({
      statusPasso: 'COMPENSADO',
      statusSaga: 'COMPENSADA',
      compensacao: 'OS_REPROVADA',
    });
    expect(COMPENSACAO_POR_FALHA['execucao.falhou']).toEqual({
      statusPasso: 'COMPENSADO',
      statusSaga: 'COMPENSADA',
      compensacao: 'OS_VOLTA_APROVADA',
    });
    expect(COMPENSACAO_POR_FALHA['pagamento.recusado']).toEqual({
      statusPasso: 'FALHOU',
      statusSaga: 'PENDENTE',
      compensacao: 'PAGAMENTO_PENDENTE',
    });
  });

  describe('timeoutPadraoMs', () => {
    it('usa 24h para APROVAR_ORCAMENTO e 1h para os demais', () => {
      expect(timeoutPadraoMs('APROVAR_ORCAMENTO')).toBe(24 * HORA);
      (
        [
          'ABRIR_OS',
          'GERAR_ORCAMENTO',
          'EXECUTAR',
          'COBRAR',
          'CONFIRMAR',
        ] as NomePassoSaga[]
      ).forEach((nome) => expect(timeoutPadraoMs(nome, {})).toBe(HORA));
    });

    it('o timeoutMs da definição é o padrão sem env', () => {
      SAGA_PASSOS.forEach((p) =>
        expect(p.timeoutMs).toBe(timeoutPadraoMs(p.nome)),
      );
    });

    it('lê SAGA_TIMEOUT_<NOME>_MS do env informado', () => {
      expect(
        timeoutPadraoMs('COBRAR', { SAGA_TIMEOUT_COBRAR_MS: '5000' }),
      ).toBe(5000);
    });

    it.each(['abc', '0', '-5', '1.5', ''])(
      'ignora valor inválido %p e usa o padrão',
      (valor) => {
        expect(
          timeoutPadraoMs('EXECUTAR', { SAGA_TIMEOUT_EXECUTAR_MS: valor }),
        ).toBe(HORA);
      },
    );

    it('ignora variável de outro passo', () => {
      expect(
        timeoutPadraoMs('EXECUTAR', { SAGA_TIMEOUT_COBRAR_MS: '5000' }),
      ).toBe(HORA);
    });
  });
});

describe('saga-maquina', () => {
  describe('iniciar', () => {
    it('conclui o passo 1, inicia o passo 2 e emite os comandos', () => {
      const decisao = iniciar(agora);

      expect(decisao.status).toBe('EM_ANDAMENTO');
      expect(decisao.passos).toEqual([
        {
          ordem: 1,
          nome: 'ABRIR_OS',
          status: 'CONCLUIDO',
          tentativas: 1,
          expiraEm: null,
        },
        {
          ordem: 2,
          nome: 'GERAR_ORCAMENTO',
          status: 'EM_ANDAMENTO',
          tentativas: 1,
          expiraEm: depois(HORA),
        },
        ...[3, 4, 5, 6].map((ordem) => ({
          ordem,
          nome: SAGA_PASSOS[ordem - 1].nome,
          status: 'PENDENTE',
          tentativas: 0,
          expiraEm: null,
        })),
      ]);
      expect(decisao.comandos).toEqual([
        { evento: 'os.criada', payload: { ordem: 1, nome: 'ABRIR_OS' } },
        {
          evento: 'diagnostico.concluido',
          payload: { ordem: 2, nome: 'GERAR_ORCAMENTO' },
        },
      ]);
    });

    it('respeita o timeout configurado via env', () => {
      const decisao = iniciar(agora, {
        SAGA_TIMEOUT_GERAR_ORCAMENTO_MS: '2000',
      });
      expect(decisao.passos[1].expiraEm).toEqual(depois(2000));
    });
  });

  describe('aplicarEvento - AVANCAR', () => {
    it('orcamento.gerado conclui o passo 2 e inicia APROVAR_ORCAMENTO (24h, sem comando)', () => {
      const snapshot = snapshotNoPasso(2);
      const decisao = aplicarEvento(snapshot, 'orcamento.gerado', agora);

      expect(decisao.tipo).toBe('AVANCAR');
      expect(decisao.novoStatusSaga).toBe('EM_ANDAMENTO');
      expect(decisao.comandos).toEqual([]);
      expect(decisao.compensacao).toBeUndefined();
      expect(decisao.passosAlterados).toEqual([
        {
          ordem: 2,
          nome: 'GERAR_ORCAMENTO',
          status: 'CONCLUIDO',
          tentativas: 1,
          expiraEm: null,
        },
        {
          ordem: 3,
          nome: 'APROVAR_ORCAMENTO',
          status: 'EM_ANDAMENTO',
          tentativas: 1,
          expiraEm: depois(24 * HORA),
        },
      ]);
    });

    it('orcamento.aprovado inicia EXECUTAR e emite os.execucao.solicitada', () => {
      const decisao = aplicarEvento(
        snapshotNoPasso(3),
        'orcamento.aprovado',
        agora,
      );

      expect(decisao.tipo).toBe('AVANCAR');
      expect(decisao.passosAlterados.map((p) => [p.ordem, p.status])).toEqual([
        [3, 'CONCLUIDO'],
        [4, 'EM_ANDAMENTO'],
      ]);
      expect(decisao.comandos).toEqual([
        {
          evento: 'os.execucao.solicitada',
          payload: { ordem: 4, nome: 'EXECUTAR' },
        },
      ]);
    });

    it('execucao.concluida inicia COBRAR e emite os.cobranca.solicitada', () => {
      const decisao = aplicarEvento(
        snapshotNoPasso(4),
        'execucao.concluida',
        agora,
      );

      expect(decisao.tipo).toBe('AVANCAR');
      expect(decisao.novoStatusSaga).toBe('EM_ANDAMENTO');
      expect(decisao.passosAlterados.map((p) => [p.ordem, p.status])).toEqual([
        [4, 'CONCLUIDO'],
        [5, 'EM_ANDAMENTO'],
      ]);
      expect(decisao.comandos).toEqual([
        {
          evento: 'os.cobranca.solicitada',
          payload: { ordem: 5, nome: 'COBRAR' },
        },
      ]);
    });

    it('pagamento.confirmado encadeia CONFIRMAR e conclui a saga', () => {
      const decisao = aplicarEvento(
        snapshotNoPasso(5),
        'pagamento.confirmado',
        agora,
      );

      expect(decisao.tipo).toBe('AVANCAR');
      expect(decisao.novoStatusSaga).toBe('CONCLUIDA');
      expect(decisao.passosAlterados).toEqual([
        {
          ordem: 5,
          nome: 'COBRAR',
          status: 'CONCLUIDO',
          tentativas: 1,
          expiraEm: null,
        },
        {
          ordem: 6,
          nome: 'CONFIRMAR',
          status: 'CONCLUIDO',
          tentativas: 1,
          expiraEm: null,
        },
      ]);
      expect(decisao.comandos).toEqual([
        { evento: 'os.finalizada', payload: { ordem: 6, nome: 'CONFIRMAR' } },
      ]);
    });

    it('usa o timeout do env ao iniciar o próximo passo', () => {
      const decisao = aplicarEvento(
        snapshotNoPasso(4),
        'execucao.concluida',
        agora,
        { SAGA_TIMEOUT_COBRAR_MS: '3000' },
      );
      expect(decisao.passosAlterados[1].expiraEm).toEqual(depois(3000));
    });

    it('incrementa tentativas do próximo passo a partir do snapshot', () => {
      const snapshot = snapshotNoPasso(3);
      const comTentativas: SagaSnapshot = {
        ...snapshot,
        passos: snapshot.passos.map((p) =>
          p.ordem === 4 ? { ...p, tentativas: 2 } : p,
        ),
      };
      const decisao = aplicarEvento(comTentativas, 'orcamento.aprovado', agora);
      expect(decisao.passosAlterados[1].tentativas).toBe(3);
    });

    it('assume 0 tentativas quando o próximo passo não está no snapshot', () => {
      const snapshot: SagaSnapshot = {
        status: 'EM_ANDAMENTO',
        passos: [snapshotNoPasso(3).passos[2]],
      };
      const decisao = aplicarEvento(snapshot, 'orcamento.aprovado', agora);
      expect(decisao.passosAlterados[1]).toMatchObject({
        ordem: 4,
        tentativas: 1,
      });
    });

    it('percorre a saga inteira do início até CONCLUIDA aplicando a decisão', () => {
      const inicio = iniciar(agora);
      let snapshot: SagaSnapshot = {
        status: inicio.status,
        passos: inicio.passos,
      };
      const eventos = [
        'orcamento.gerado',
        'orcamento.aprovado',
        'execucao.iniciada',
        'execucao.concluida',
        'pagamento.confirmado',
      ];
      for (const evento of eventos) {
        const decisao = aplicarEvento(snapshot, evento, agora);
        expect(decisao.tipo).not.toBe('IGNORAR');
        snapshot = {
          status: decisao.novoStatusSaga,
          passos: snapshot.passos.map(
            (p) =>
              decisao.passosAlterados.find((a) => a.ordem === p.ordem) ?? p,
          ),
        };
      }
      expect(snapshot.status).toBe('CONCLUIDA');
      expect(snapshot.passos.every((p) => p.status === 'CONCLUIDO')).toBe(true);
    });
  });

  describe('aplicarEvento - PROGRESSO', () => {
    it('execucao.iniciada registra progresso sem concluir o passo', () => {
      const decisao = aplicarEvento(
        snapshotNoPasso(4),
        'execucao.iniciada',
        agora,
      );

      expect(decisao).toEqual({
        tipo: 'PROGRESSO',
        passosAlterados: [],
        novoStatusSaga: 'EM_ANDAMENTO',
        comandos: [],
      });
    });
  });

  describe('aplicarEvento - COMPENSAR', () => {
    it('orcamento.reprovado compensa o passo e a saga com OS_REPROVADA', () => {
      const decisao = aplicarEvento(
        snapshotNoPasso(3),
        'orcamento.reprovado',
        agora,
      );

      expect(decisao.tipo).toBe('COMPENSAR');
      expect(decisao.novoStatusSaga).toBe('COMPENSADA');
      expect(decisao.compensacao).toBe('OS_REPROVADA');
      expect(decisao.comandos).toEqual([]);
      expect(decisao.motivo).toContain('orcamento.reprovado');
      expect(decisao.passosAlterados).toEqual([
        {
          ordem: 3,
          nome: 'APROVAR_ORCAMENTO',
          status: 'COMPENSADO',
          tentativas: 1,
          expiraEm: null,
        },
      ]);
    });

    it('execucao.falhou compensa com OS_VOLTA_APROVADA', () => {
      const decisao = aplicarEvento(
        snapshotNoPasso(4),
        'execucao.falhou',
        agora,
      );

      expect(decisao.tipo).toBe('COMPENSAR');
      expect(decisao.novoStatusSaga).toBe('COMPENSADA');
      expect(decisao.compensacao).toBe('OS_VOLTA_APROVADA');
      expect(decisao.passosAlterados).toEqual([
        {
          ordem: 4,
          nome: 'EXECUTAR',
          status: 'COMPENSADO',
          tentativas: 1,
          expiraEm: null,
        },
      ]);
    });

    it('pagamento.recusado marca o passo FALHOU e a saga PENDENTE', () => {
      const decisao = aplicarEvento(
        snapshotNoPasso(5),
        'pagamento.recusado',
        agora,
      );

      expect(decisao.tipo).toBe('COMPENSAR');
      expect(decisao.novoStatusSaga).toBe('PENDENTE');
      expect(decisao.compensacao).toBe('PAGAMENTO_PENDENTE');
      expect(decisao.passosAlterados).toEqual([
        {
          ordem: 5,
          nome: 'COBRAR',
          status: 'FALHOU',
          tentativas: 1,
          expiraEm: null,
        },
      ]);
    });
  });

  describe('aplicarEvento - IGNORAR', () => {
    const ignorado = (snapshot: SagaSnapshot, evento: string) => {
      const decisao = aplicarEvento(snapshot, evento, agora);
      expect(decisao.tipo).toBe('IGNORAR');
      expect(decisao.passosAlterados).toEqual([]);
      expect(decisao.comandos).toEqual([]);
      expect(decisao.compensacao).toBeUndefined();
      expect(decisao.novoStatusSaga).toBe(snapshot.status);
      expect(decisao.motivo).toEqual(expect.any(String));
      return decisao;
    };

    it('evento de passo futuro (fora de ordem)', () => {
      const decisao = ignorado(snapshotNoPasso(2), 'pagamento.confirmado');
      expect(decisao.motivo).toContain('GERAR_ORCAMENTO');
      expect(decisao.motivo).toContain('pagamento.confirmado');
    });

    it('evento de passo já concluído (duplicado/atrasado)', () => {
      ignorado(snapshotNoPasso(3), 'orcamento.gerado');
    });

    it('evento de falha de outro passo', () => {
      ignorado(snapshotNoPasso(3), 'execucao.falhou');
      ignorado(snapshotNoPasso(4), 'orcamento.reprovado');
    });

    it('evento de progresso fora do passo EXECUTAR', () => {
      ignorado(snapshotNoPasso(3), 'execucao.iniciada');
    });

    it('evento desconhecido', () => {
      ignorado(snapshotNoPasso(4), 'evento.inexistente');
    });

    it.each(['CONCLUIDA', 'COMPENSADA', 'FALHOU', 'PENDENTE'] as const)(
      'saga em status %s não aceita eventos',
      (status) => {
        const decisao = ignorado(
          snapshotNoPasso(4, status),
          'execucao.concluida',
        );
        expect(decisao.motivo).toContain(status);
      },
    );

    it('saga EM_ANDAMENTO sem nenhum passo EM_ANDAMENTO', () => {
      const snapshot: SagaSnapshot = {
        status: 'EM_ANDAMENTO',
        passos: snapshotNoPasso(4).passos.map((p) => ({
          ...p,
          status: 'PENDENTE',
        })),
      };
      const decisao = ignorado(snapshot, 'execucao.concluida');
      expect(decisao.motivo).toContain('nenhum passo');
    });
  });

  describe('imutabilidade', () => {
    it('não muta o snapshot recebido (objeto congelado)', () => {
      const snapshot = snapshotNoPasso(4);
      expect(() => {
        aplicarEvento(snapshot, 'execucao.concluida', agora);
        aplicarEvento(snapshot, 'execucao.falhou', agora);
        aplicarEvento(snapshot, 'execucao.iniciada', agora);
        aplicarEvento(snapshot, 'x', agora);
        expirar(snapshot, depois(2 * HORA));
      }).not.toThrow();
      expect(snapshot).toEqual(snapshotNoPasso(4));
    });
  });

  describe('expirar', () => {
    it('compensa o passo vencido e emite saga.passo.expirado', () => {
      const decisao = expirar(
        snapshotNoPasso(3, 'EM_ANDAMENTO', depois(-1000)),
        agora,
      );

      expect(decisao.tipo).toBe('COMPENSAR');
      expect(decisao.novoStatusSaga).toBe('COMPENSADA');
      expect(decisao.compensacao).toBeUndefined();
      expect(decisao.motivo).toContain('EXPIRADO');
      expect(decisao.motivo).toContain('APROVAR_ORCAMENTO');
      expect(decisao.passosAlterados).toEqual([
        {
          ordem: 3,
          nome: 'APROVAR_ORCAMENTO',
          status: 'COMPENSADO',
          tentativas: 1,
          expiraEm: null,
        },
      ]);
      expect(decisao.comandos).toEqual([
        {
          evento: 'saga.passo.expirado',
          payload: { ordem: 3, nome: 'APROVAR_ORCAMENTO' },
        },
      ]);
    });

    it('expira exatamente em expiraEm (<=)', () => {
      const decisao = expirar(snapshotNoPasso(2, 'EM_ANDAMENTO', agora), agora);
      expect(decisao.tipo).toBe('COMPENSAR');
    });

    it('ignora quando o passo ainda não venceu', () => {
      const snapshot = snapshotNoPasso(2, 'EM_ANDAMENTO', depois(1));
      const decisao = expirar(snapshot, agora);
      expect(decisao).toEqual({
        tipo: 'IGNORAR',
        passosAlterados: [],
        novoStatusSaga: 'EM_ANDAMENTO',
        comandos: [],
        motivo: decisao.motivo,
      });
      expect(decisao.motivo).toContain('expirado');
    });

    it('ignora passo EM_ANDAMENTO sem expiraEm', () => {
      const decisao = expirar(snapshotNoPasso(2, 'EM_ANDAMENTO', null), agora);
      expect(decisao.tipo).toBe('IGNORAR');
    });

    it('ignora saga sem passo EM_ANDAMENTO (já terminal)', () => {
      const snapshot: SagaSnapshot = {
        status: 'CONCLUIDA',
        passos: snapshotNoPasso(6).passos.map((p) => ({
          ...p,
          status: 'CONCLUIDO',
        })),
      };
      const decisao = expirar(snapshot, depois(100 * HORA));
      expect(decisao.tipo).toBe('IGNORAR');
      expect(decisao.novoStatusSaga).toBe('CONCLUIDA');
    });
  });
});
