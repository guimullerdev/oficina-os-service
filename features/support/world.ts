import { randomInt, randomUUID } from 'node:crypto';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { setWorldConstructor, World } from '@cucumber/cucumber';

export interface SagaPasso {
  nome?: string;
  status?: string;
}

export interface SagaResponse {
  passos?: SagaPasso[];
}

interface IdResponse {
  id?: string;
}

interface TokenResponse {
  accessToken?: string;
}

interface OsResponse {
  status?: string;
}

const config = {
  baseUrl: process.env.BASE_URL ?? 'http://localhost:3100',
  endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4567',
  region: process.env.AWS_REGION ?? 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
  topicArn:
    process.env.BILLING_TOPIC_ARN ??
    'arn:aws:sns:us-east-1:000000000000:oficina-billing-events',
};

const STAFF_EMAIL = 'mecanico@oficina.com';
const STAFF_PASSWORD = 'senha123';

function cpfValido(): string {
  const d: number[] = Array.from({ length: 9 }, () => randomInt(0, 10));
  if (new Set(d).size === 1) d[0] = (d[0] + 1) % 10;
  for (const n of [9, 10]) {
    const sum = d.reduce((acc, v, i) => acc + v * (n + 1 - i), 0);
    d.push(((sum * 10) % 11) % 10);
  }
  return d.join('');
}

function placa(): string {
  const letras = Array.from({ length: 3 }, () =>
    String.fromCharCode(65 + randomInt(0, 26)),
  ).join('');
  return `${letras}${randomInt(1000, 10000)}`;
}

function requireId(resp: IdResponse, what: string): string {
  if (!resp.id) {
    throw new Error(`falha ao criar ${what}: ${JSON.stringify(resp)}`);
  }
  return resp.id;
}

export class SagaWorld extends World {
  osId?: string;
  private token?: string;
  private readonly sns = new SNSClient({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  private async api<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async authenticate(): Promise<void> {
    const cred = { email: STAFF_EMAIL, password: STAFF_PASSWORD };
    let token: string | undefined;
    try {
      token = (await this.api<TokenResponse>('POST', '/auth/register', cred))
        .accessToken;
    } catch {
      // usuário já existe: cai no login
    }
    if (!token) {
      token = (await this.api<TokenResponse>('POST', '/auth/login', cred))
        .accessToken;
    }
    if (!token) throw new Error(`sem accessToken em ${config.baseUrl}`);
    this.token = token;
  }

  async criarOsAguardandoAprovacao(): Promise<void> {
    await this.authenticate();
    const cpf = cpfValido();
    const clienteId = requireId(
      await this.api<IdResponse>('POST', '/clientes', {
        nome: 'BDD Saga',
        documento: cpf,
        email: `bdd-${cpf}-${randomUUID().slice(0, 8)}@example.com`,
        telefone: '11999990000',
      }),
      'cliente',
    );
    const veiculoId = requireId(
      await this.api<IdResponse>('POST', '/veiculos', {
        placa: placa(),
        marca: 'Fiat',
        modelo: 'Uno',
        ano: 2018,
        cor: 'Branco',
        kmAtual: 75000,
        clienteId,
      }),
      'veiculo',
    );
    const osId = requireId(
      await this.api<IdResponse>('POST', '/os', {
        clienteId,
        veiculoId,
        descricaoProblema: 'BDD - orcamento reprovado',
      }),
      'OS',
    );
    this.osId = osId;
    await this.api('PATCH', `/os/${osId}/iniciar-diagnostico`);
    await this.api('PATCH', `/os/${osId}/concluir-diagnostico`);
    const status = await this.statusOs();
    if (status !== 'AGUARDANDO_APROVACAO') {
      throw new Error(
        `OS deveria estar AGUARDANDO_APROVACAO, esta '${status}'`,
      );
    }
  }

  async publicarEvento(evento: string): Promise<void> {
    const attr = (value: string) => ({
      DataType: 'String',
      StringValue: value,
    });
    const traceId = randomUUID().replace(/-/g, '');
    await this.sns.send(
      new PublishCommand({
        TopicArn: config.topicArn,
        Message: JSON.stringify({ osId: this.osId }),
        MessageAttributes: {
          evento: attr(evento),
          eventId: attr(randomUUID()),
          correlationId: attr(randomUUID()),
          traceparent: attr(`00-${traceId}-${traceId.slice(0, 16)}-01`),
        },
      }),
    );
  }

  async statusOs(): Promise<string | undefined> {
    return (await this.api<OsResponse>('GET', `/os/${this.osId}`)).status;
  }

  async saga(): Promise<SagaResponse> {
    return this.api<SagaResponse>('GET', `/os/${this.osId}/saga`);
  }
}

setWorldConstructor(SagaWorld);
