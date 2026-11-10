import { MessageHandler } from './message-handler.interface';
import {
  MessageHandlerRegistry,
  UnknownEventError,
} from './message-handler.registry';

function makeHandler(evento: string): MessageHandler {
  return {
    evento,
    handle: jest.fn().mockResolvedValue(undefined),
  };
}

describe('MessageHandlerRegistry', () => {
  let registry: MessageHandlerRegistry;

  beforeEach(() => {
    registry = new MessageHandlerRegistry();
  });

  describe('register()', () => {
    it('registra o handler pelo evento', () => {
      const handler = makeHandler('orcamento.gerado');

      registry.register(handler);

      expect(registry.resolve('orcamento.gerado')).toBe(handler);
    });

    it('rejeita evento duplicado com erro', () => {
      registry.register(makeHandler('orcamento.gerado'));

      expect(() => registry.register(makeHandler('orcamento.gerado'))).toThrow(
        'Handler duplicado para o evento orcamento.gerado',
      );
    });

    it('aceita eventos distintos', () => {
      registry.register(makeHandler('orcamento.gerado'));

      expect(() =>
        registry.register(makeHandler('orcamento.aprovado')),
      ).not.toThrow();
      expect(registry.has('orcamento.aprovado')).toBe(true);
    });
  });

  describe('resolve()', () => {
    it('retorna o handler registrado', () => {
      const handler = makeHandler('execucao.falhou');
      registry.register(handler);

      expect(registry.resolve('execucao.falhou')).toBe(handler);
    });

    it('lança UnknownEventError quando o evento não está registrado', () => {
      expect(() => registry.resolve('evento.desconhecido')).toThrow(
        UnknownEventError,
      );
    });
  });

  describe('has()', () => {
    it('retorna true para evento registrado', () => {
      registry.register(makeHandler('execucao.concluida'));

      expect(registry.has('execucao.concluida')).toBe(true);
    });

    it('retorna false para evento não registrado', () => {
      expect(registry.has('execucao.concluida')).toBe(false);
    });
  });
});

describe('UnknownEventError', () => {
  it('expõe o nome da classe, o evento e a mensagem', () => {
    const error = new UnknownEventError('evento.x');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('UnknownEventError');
    expect(error.evento).toBe('evento.x');
    expect(error.message).toBe(
      'Nenhum handler registrado para o evento evento.x',
    );
  });
});
