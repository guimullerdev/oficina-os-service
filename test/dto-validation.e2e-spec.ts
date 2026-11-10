/**
 * E2E — Validação de DTOs
 *
 * Cobre endpoints POST/PUT dos módulos com:
 *   (a) body vazio {}          → 400
 *   (b) tipo errado nos campos → 400
 *   (c) campos extras          → 400 (forbidNonWhitelisted)
 */

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from 'src/app.module';
import { HttpExceptionFilter } from 'src/common/filters/http-exception.filter';
import { PrismaService } from 'src/prisma/prisma.service';

describe('DTO Validation (e2e)', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let token: string;
    let clienteId: string;
    let veiculoId: string;
    let servicoId: string;
    let pecaId: string;
    let osId: string;

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        app = moduleFixture.createNestApplication();
        app.useGlobalFilters(new HttpExceptionFilter());
        app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
        await app.init();

        prisma = moduleFixture.get<PrismaService>(PrismaService);

        // Cleanup
        await prisma.osItemServico.deleteMany();
        await prisma.osItemPeca.deleteMany();
        await prisma.ordemDeServico.deleteMany();
        await prisma.veiculo.deleteMany();
        await prisma.cliente.deleteMany();
        await prisma.user.deleteMany({ where: { email: 'validation@test.com' } });

        const authRes = await request(app.getHttpServer())
            .post('/auth/register')
            .send({ email: 'validation@test.com', password: 'senha123' });
        token = authRes.body.accessToken;

        // Base data for PATCH tests
        const cliente = await request(app.getHttpServer())
            .post('/clientes')
            .set('Authorization', `Bearer ${token}`)
            .send({ nome: 'Cliente Validação', documento: '11144477735', email: 'val@test.com', telefone: '11900000001' });
        clienteId = cliente.body.id;

        const veiculo = await request(app.getHttpServer())
            .post('/veiculos')
            .set('Authorization', `Bearer ${token}`)
            .send({ placa: 'VAL0001', marca: 'Honda', modelo: 'Civic', ano: 2019, clienteId });
        veiculoId = veiculo.body.id;

        // remover após migration da Fase 2 (T4): os_itens_* ainda têm FK para servicos/pecas
        await prisma.servico.deleteMany();
        await prisma.peca.deleteMany();
        const servico = await prisma.servico.create({ data: { nome: 'Revisão', precoBase: 200 } });
        servicoId = servico.id;
        const peca = await prisma.peca.create({ data: { nome: 'Vela de ignição', precoUnitario: 30 } });
        pecaId = peca.id;

        const os = await request(app.getHttpServer())
            .post('/os')
            .set('Authorization', `Bearer ${token}`)
            .send({ clienteId, veiculoId, descricaoProblema: 'OS para testes de validação' });
        osId = os.body.id;
    });

    afterAll(async () => {
        await app.close();
    });

    function auth() {
        return { Authorization: `Bearer ${token}` };
    }

    function expectValidationError(res: request.Response) {
        expect(res.status).toBe(400);
    }

    // ── /clientes ─────────────────────────────────────────────────────────────

    describe('POST /clientes', () => {
        it('(a) body vazio → 400', async () => {
            expectValidationError(await request(app.getHttpServer()).post('/clientes').set(auth()).send({}));
        });

        it('(b) email inválido → 400', async () => {
            expectValidationError(await request(app.getHttpServer()).post('/clientes').set(auth())
                .send({ nome: 'João', documento: '52998224725', email: 'nao-e-email' }));
        });

        it('(c) campo extra → 400', async () => {
            expectValidationError(await request(app.getHttpServer()).post('/clientes').set(auth())
                .send({ nome: 'João', documento: '52998224725', extraField: 'hack' }));
        });
    });

    describe('PUT /clientes/:id', () => {
        it('(b) nome como número → 400', async () => {
            expectValidationError(await request(app.getHttpServer()).put(`/clientes/${clienteId}`).set(auth())
                .send({ nome: 12345 }));
        });

        it('(c) campo extra → 400', async () => {
            expectValidationError(await request(app.getHttpServer()).put(`/clientes/${clienteId}`).set(auth())
                .send({ unknownField: 'x' }));
        });
    });

    // ── /veiculos ─────────────────────────────────────────────────────────────

    describe('POST /veiculos', () => {
        it('(a) body vazio → 400', async () => {
            expectValidationError(await request(app.getHttpServer()).post('/veiculos').set(auth()).send({}));
        });

        it('(b) ano como string → 400', async () => {
            expectValidationError(await request(app.getHttpServer()).post('/veiculos').set(auth())
                .send({ placa: 'XXX0000', marca: 'Ford', modelo: 'Ka', ano: 'dois mil', clienteId }));
        });

        it('(c) campo extra → 400', async () => {
            expectValidationError(await request(app.getHttpServer()).post('/veiculos').set(auth())
                .send({ placa: 'XXX0001', marca: 'Ford', modelo: 'Ka', clienteId, extraField: true }));
        });
    });

    describe('PUT /veiculos/:id', () => {
        it('(b) ano como string → 400', async () => {
            expectValidationError(await request(app.getHttpServer()).put(`/veiculos/${veiculoId}`).set(auth())
                .send({ ano: 'dois mil' }));
        });

        it('(c) campo extra → 400', async () => {
            expectValidationError(await request(app.getHttpServer()).put(`/veiculos/${veiculoId}`).set(auth())
                .send({ combustivel: 'flex' }));
        });
    });

    // ── /os ───────────────────────────────────────────────────────────────────

    describe('POST /os', () => {
        it('(a) body vazio → 400', async () => {
            expectValidationError(await request(app.getHttpServer()).post('/os').set(auth()).send({}));
        });

        it('(b) clienteId não é UUID → 400', async () => {
            expectValidationError(await request(app.getHttpServer()).post('/os').set(auth())
                .send({ clienteId: 'nao-uuid', veiculoId }));
        });

        it('(c) campo extra → 400', async () => {
            expectValidationError(await request(app.getHttpServer()).post('/os').set(auth())
                .send({ clienteId, veiculoId, prioridade: 'alta' }));
        });

        it('(a2) item inline de serviço sem precoUnitario → 400', async () => {
            expectValidationError(await request(app.getHttpServer()).post('/os').set(auth())
                .send({ clienteId, veiculoId, servicos: [{ servicoId }] }));
        });

        it('(a3) item inline de peça sem precoUnitario → 400', async () => {
            expectValidationError(await request(app.getHttpServer()).post('/os').set(auth())
                .send({ clienteId, veiculoId, pecas: [{ pecaId, quantidade: 1 }] }));
        });
    });

    describe('POST /os/:id/servicos', () => {
        it('(a) body vazio → 400', async () => {
            expectValidationError(await request(app.getHttpServer()).post(`/os/${osId}/servicos`).set(auth()).send({}));
        });

        it('(b) servicoId não é UUID → 400', async () => {
            expectValidationError(await request(app.getHttpServer()).post(`/os/${osId}/servicos`).set(auth())
                .send({ servicoId: 'nao-uuid', precoUnitario: 10 }));
        });

        it('(a2) sem precoUnitario → 400', async () => {
            expectValidationError(await request(app.getHttpServer()).post(`/os/${osId}/servicos`).set(auth())
                .send({ servicoId }));
        });

        it('(b2) precoUnitario negativo, string ou com 3 casas → 400', async () => {
            for (const precoUnitario of [-1, 'caro', 10.123]) {
                expectValidationError(await request(app.getHttpServer()).post(`/os/${osId}/servicos`).set(auth())
                    .send({ servicoId, precoUnitario }));
            }
        });

        it('(c) campo extra → 400', async () => {
            expectValidationError(await request(app.getHttpServer()).post(`/os/${osId}/servicos`).set(auth())
                .send({ servicoId, precoUnitario: 10, desconto: 10 }));
        });
    });

    describe('POST /os/:id/pecas', () => {
        it('(a) body vazio → 400', async () => {
            expectValidationError(await request(app.getHttpServer()).post(`/os/${osId}/pecas`).set(auth()).send({}));
        });

        it('(b) quantidade como string → 400', async () => {
            expectValidationError(await request(app.getHttpServer()).post(`/os/${osId}/pecas`).set(auth())
                .send({ pecaId, quantidade: 'dois', precoUnitario: 10 }));
        });

        it('(a2) sem precoUnitario → 400', async () => {
            expectValidationError(await request(app.getHttpServer()).post(`/os/${osId}/pecas`).set(auth())
                .send({ pecaId, quantidade: 1 }));
        });

        it('(b2) precoUnitario negativo, string ou com 3 casas → 400', async () => {
            for (const precoUnitario of [-1, 'caro', 10.123]) {
                expectValidationError(await request(app.getHttpServer()).post(`/os/${osId}/pecas`).set(auth())
                    .send({ pecaId, quantidade: 1, precoUnitario }));
            }
        });

        it('(c) campo extra → 400', async () => {
            expectValidationError(await request(app.getHttpServer()).post(`/os/${osId}/pecas`).set(auth())
                .send({ pecaId, quantidade: 1, precoUnitario: 10, desconto: 5 }));
        });
    });
});
