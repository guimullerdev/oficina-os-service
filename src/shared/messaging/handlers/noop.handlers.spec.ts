import { Logger } from '@nestjs/common';

import {
  EVENTO_EXECUCAO_CONCLUIDA,
  EVENTO_EXECUCAO_FALHOU,
  EVENTO_EXECUCAO_INICIADA,
  EVENTO_ORCAMENTO_APROVADO,
  EVENTO_ORCAMENTO_GERADO,
  EVENTO_ORCAMENTO_REPROVADO,
  NOOP_HANDLERS,
} from './noop.handlers';

describe('NOOP_HANDLERS', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('cobre os seis eventos esperados, com os nomes das constantes', () => {
    expect(NOOP_HANDLERS.map((h) => h.evento)).toEqual([
      EVENTO_ORCAMENTO_GERADO,
      EVENTO_ORCAMENTO_APROVADO,
      EVENTO_ORCAMENTO_REPROVADO,
      EVENTO_EXECUCAO_INICIADA,
      EVENTO_EXECUCAO_CONCLUIDA,
      EVENTO_EXECUCAO_FALHOU,
    ]);
  });

  it('expõe os nomes de evento literais', () => {
    expect(EVENTO_ORCAMENTO_GERADO).toBe('orcamento.gerado');
    expect(EVENTO_ORCAMENTO_APROVADO).toBe('orcamento.aprovado');
    expect(EVENTO_ORCAMENTO_REPROVADO).toBe('orcamento.reprovado');
    expect(EVENTO_EXECUCAO_INICIADA).toBe('execucao.iniciada');
    expect(EVENTO_EXECUCAO_CONCLUIDA).toBe('execucao.concluida');
    expect(EVENTO_EXECUCAO_FALHOU).toBe('execucao.falhou');
  });

  it.each(NOOP_HANDLERS.map((h) => [h.evento]))(
    'handle() de %s resolve e registra log com evento e messageId',
    async (evento) => {
      const handler = NOOP_HANDLERS.find((h) => h.evento === evento);
      if (!handler) {
        throw new Error(`handler ausente: ${evento}`);
      }

      await expect(
        handler.handle({ messageId: 'm-1', evento, payload: {} }),
      ).resolves.toBeUndefined();

      expect(logSpy).toHaveBeenCalledWith(
        `Evento ${evento} recebido (no-op) messageId=m-1`,
      );
    },
  );
});
