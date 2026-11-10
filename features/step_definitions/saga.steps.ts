import { Given, Then, When } from '@cucumber/cucumber';
import { pollUntil } from '../support/polling';
import { SagaWorld } from '../support/world';

Given(
  'que existe uma ordem de serviço aguardando aprovação do orçamento',
  async function (this: SagaWorld) {
    await this.criarOsAguardandoAprovacao();
  },
);

When(
  'o billing publica o evento {string} para a ordem de serviço',
  async function (this: SagaWorld, evento: string) {
    // Como no gate-1r: orcamento.gerado antes do desfecho.
    await this.publicarEvento('orcamento.gerado');
    await this.publicarEvento(evento);
  },
);

Then(
  'a ordem de serviço fica com status {string}',
  async function (this: SagaWorld, esperado: string) {
    await pollUntil(
      () => this.statusOs(),
      (status) => status === esperado,
      { description: `OS ${this.osId} com status ${esperado}` },
    );
  },
);

Then(
  'o passo {string} da saga fica {string}',
  async function (this: SagaWorld, passo: string, esperado: string) {
    await pollUntil(
      async () => (await this.saga()).passos ?? [],
      (passos) => passos.some((p) => p.nome === passo && p.status === esperado),
      { description: `passo ${passo}=${esperado} da OS ${this.osId}` },
    );
  },
);
