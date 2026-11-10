/**
* E2E — Ciclo de vida completo da Ordem de Serviço
*
* Fluxo: criar cliente/veículo → abrir OS → itens (precoUnitario informado)
*        → diagnóstico → aprovação via webhook → executar → entregar
*/

import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from 'src/app.module';
import { HttpExceptionFilter } from 'src/common/filters/http-exception.filter';
import { PrismaService } from 'src/prisma/prisma.service';

const WEBHOOK_SECRET = 'e2e-webhook-secret';

describe('Ordem de Serviço — ciclo de vida completo (e2e)', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let token: string;
    const originalWebhookSecret = process.env.WEBHOOK_SECRET;

    let clienteId: string;
    let veiculoId: string;
    let servicoId: string;
    let pecaId: string;
    let osId: string;

    beforeAll(async () => {
        process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;

        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        app = moduleFixture.createNestApplication();
        app.useGlobalFilters(new HttpExceptionFilter());
        app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
        await app.init();

        prisma = moduleFixture.get<PrismaService>(PrismaService);

        // Cleanup
        await prisma.osItemServico.deleteMany();
        await prisma.osItemPeca.deleteMany();
        await prisma.sagaInstancia.deleteMany();
        await prisma.ordemDeServico.deleteMany();
        await prisma.veiculo.deleteMany();
        await prisma.cliente.deleteMany();
        await prisma.user.deleteMany({ where: { email: 'e2e-os@test.com' } });

        // serviço/peça vivem em outros serviços: aqui são só referências fracas (UUIDs arbitrários)
        servicoId = randomUUID();
        pecaId = randomUUID();

        const authRes = await request(app.getHttpServer())
            .post('/auth/register')
            .send({ email: 'e2e-os@test.com', password: 'senha123', role: 'ADMIN' });
        token = authRes.body.accessToken;
    });

    afterAll(async () => {
        process.env.WEBHOOK_SECRET = originalWebhookSecret;
        await app.close();
    });

    function auth() {
        return { Authorization: `Bearer ${token}` };
    }

    function webhookAuth() {
        return { Authorization: `Bearer ${WEBHOOK_SECRET}` };
    }

    // ── 1. Cadastros base ─────────────────────────────────────────────────────

    it('1a. POST /clientes → 201', async () => {
        const res = await request(app.getHttpServer())
            .post('/clientes')
            .set(auth())
            .send({ nome: 'Carlos E2E', documento: '52998224725', email: 'carlos@e2e.com', telefone: '11900000000' })
            .expect(201);

        clienteId = res.body.id;
        expect(clienteId).toBeDefined();
        expect(res.body.nome).toBe('Carlos E2E');
        expect(res.body.ativo).toBe(true);
    });

    it('1b. POST /veiculos → 201', async () => {
        const res = await request(app.getHttpServer())
            .post('/veiculos')
            .set(auth())
            .send({ placa: 'EEE0001', marca: 'Fiat', modelo: 'Uno', ano: 2015, clienteId })
            .expect(201);

        veiculoId = res.body.id;
        expect(veiculoId).toBeDefined();
    });

    // ── 2. Abrir OS ───────────────────────────────────────────────────────────

    it('2. POST /os → abre OS com status RECEBIDA', async () => {
        const res = await request(app.getHttpServer())
            .post('/os')
            .set(auth())
            .send({ clienteId, veiculoId, descricaoProblema: 'Barulho ao frear' })
            .expect(201);

        osId = res.body.id;
        expect(osId).toBeDefined();
        expect(res.body.status).toBe('RECEBIDA');
        expect(res.body.numero).toBeDefined();
    });

    // ── 3. Adicionar itens à OS ───────────────────────────────────────────────

    it('3a. POST /os/:id/servicos → adiciona serviço com precoUnitario informado', async () => {
        const res = await request(app.getHttpServer())
            .post(`/os/${osId}/servicos`)
            .set(auth())
            .send({ servicoId, precoUnitario: 150.5 })
            .expect(201);

        expect(res.body.servicos).toHaveLength(1);
        expect(res.body.servicos[0].precoUnitario).toBe(150.5);
    });

    it('3b. POST /os/:id/pecas → adiciona peça com precoUnitario informado (sem mexer em estoque)', async () => {
        const res = await request(app.getHttpServer())
            .post(`/os/${osId}/pecas`)
            .set(auth())
            .send({ pecaId, quantidade: 2, precoUnitario: 99.9 })
            .expect(201);

        expect(res.body.pecas).toHaveLength(1);
        expect(res.body.pecas[0].quantidade).toBe(2);
        expect(res.body.pecas[0].valorUnitario).toBe(99.9);
    });

    it('3c. POST /os/:id/servicos sem precoUnitario → 400', async () => {
        await request(app.getHttpServer())
            .post(`/os/${osId}/servicos`)
            .set(auth())
            .send({ servicoId })
            .expect(400);
    });

    it('3d. POST /os/:id/pecas sem precoUnitario → 400', async () => {
        await request(app.getHttpServer())
            .post(`/os/${osId}/pecas`)
            .set(auth())
            .send({ pecaId, quantidade: 1 })
            .expect(400);
    });

    it('3e. GET /os/:id → retorna OS com itens', async () => {
        const res = await request(app.getHttpServer())
            .get(`/os/${osId}`)
            .set(auth())
            .expect(200);

        expect(res.body.servicos).toHaveLength(1);
        expect(res.body.pecas).toHaveLength(1);
    });

    // ── 4. Diagnóstico ────────────────────────────────────────────────────────

    it('4a. PATCH /os/:id/iniciar-diagnostico → RECEBIDA → EM_DIAGNOSTICO', async () => {
        const res = await request(app.getHttpServer())
            .patch(`/os/${osId}/iniciar-diagnostico`)
            .set(auth())
            .expect(200);

        expect(res.body.status).toBe('EM_DIAGNOSTICO');
    });

    it('4b. PATCH /os/:id/iniciar-diagnostico novamente → 422', async () => {
        await request(app.getHttpServer())
            .patch(`/os/${osId}/iniciar-diagnostico`)
            .set(auth())
            .expect(422);
    });

    it('4c. PATCH /os/:id/concluir-diagnostico → EM_DIAGNOSTICO → AGUARDANDO_APROVACAO', async () => {
        const res = await request(app.getHttpServer())
            .patch(`/os/${osId}/concluir-diagnostico`)
            .set(auth())
            .expect(200);

        expect(res.body.status).toBe('AGUARDANDO_APROVACAO');
    });

    // ── 5. Aprovação via webhook ──────────────────────────────────────────────

    it('5a. POST /os/webhook/notificacao sem token → 401', async () => {
        await request(app.getHttpServer())
            .post('/os/webhook/notificacao')
            .send({ osId, acao: 'APROVAR' })
            .expect(401);
    });

    it('5b. POST /os/webhook/notificacao APROVAR → OS APROVADA', async () => {
        const res = await request(app.getHttpServer())
            .post('/os/webhook/notificacao')
            .set(webhookAuth())
            .send({ osId, acao: 'APROVAR', observacoes: 'Cliente aprovou' })
            .expect(200);

        expect(res.body.resultado).toBe('APLICADA');
        expect(res.body.statusAtual).toBe('APROVADA');

        const os = await prisma.ordemDeServico.findUnique({ where: { id: osId } });
        expect(os!.status).toBe('APROVADA');
    });

    it('5c. POST /os/webhook/notificacao APROVAR repetido → idempotente', async () => {
        const res = await request(app.getHttpServer())
            .post('/os/webhook/notificacao')
            .set(webhookAuth())
            .send({ osId, acao: 'APROVAR' })
            .expect(200);

        expect(res.body.resultado).toBe('IGNORADA_IDEMPOTENTE');
        expect(res.body.statusAtual).toBe('APROVADA');
    });

    // ── 6. Execução ───────────────────────────────────────────────────────────

    it('6a. PATCH /os/:id/iniciar-execucao → APROVADA → EM_EXECUCAO', async () => {
        const res = await request(app.getHttpServer())
            .patch(`/os/${osId}/iniciar-execucao`)
            .set(auth())
            .expect(200);

        expect(res.body.status).toBe('EM_EXECUCAO');
    });

    it('6b. PATCH /os/:id/pecas/:itemId/utilizar → marca peça como utilizada', async () => {
        const os = await prisma.ordemDeServico.findUnique({
            where: { id: osId },
            include: { osItensPeca: true },
        });
        const itemId = os!.osItensPeca[0].id;

        await request(app.getHttpServer())
            .patch(`/os/${osId}/pecas/${itemId}/utilizar`)
            .set(auth())
            .expect(200);

        const item = await prisma.osItemPeca.findUnique({ where: { id: itemId } });
        expect(item!.utilizada).toBe(true);
    });

    it('6c. PATCH /os/:id/finalizar-execucao → EM_EXECUCAO → FINALIZADA', async () => {
        const res = await request(app.getHttpServer())
            .patch(`/os/${osId}/finalizar-execucao`)
            .set(auth())
            .expect(200);

        expect(res.body.status).toBe('FINALIZADA');
        expect(res.body.dataFechamento).toBeDefined();
    });

    it('6d. PATCH /os/:id/entregar → FINALIZADA → ENTREGUE', async () => {
        const res = await request(app.getHttpServer())
            .patch(`/os/${osId}/entregar`)
            .set(auth())
            .expect(200);

        expect(res.body.status).toBe('ENTREGUE');
    });

    // ── 7. Filtros e 404 ──────────────────────────────────────────────────────

    it('7a. GET /os?status=ENTREGUE → retorna a OS', async () => {
        const res = await request(app.getHttpServer())
            .get('/os?status=ENTREGUE&incluirArquivadas=true')
            .set(auth())
            .expect(200);

        expect(res.body.some((o: any) => o.id === osId)).toBe(true);
    });

    it('7b. GET /os/:id com ID inexistente → 404', async () => {
        await request(app.getHttpServer())
            .get('/os/00000000-0000-0000-0000-000000000000')
            .set(auth())
            .expect(404);
    });

    // ── 8. Fluxo de reprovação via webhook ────────────────────────────────────

    it('8. webhook REPROVAR → OS → REPROVADA', async () => {
        const osRes = await request(app.getHttpServer())
            .post('/os')
            .set(auth())
            .send({
                clienteId,
                veiculoId,
                servicos: [{ servicoId, precoUnitario: 100 }],
                pecas: [{ pecaId, quantidade: 1, precoUnitario: 50 }],
            })
            .expect(201);
        const novaOsId = osRes.body.id;

        await request(app.getHttpServer()).patch(`/os/${novaOsId}/iniciar-diagnostico`).set(auth()).expect(200);
        await request(app.getHttpServer()).patch(`/os/${novaOsId}/concluir-diagnostico`).set(auth()).expect(200);

        const res = await request(app.getHttpServer())
            .post('/os/webhook/notificacao')
            .set(webhookAuth())
            .send({ osId: novaOsId, acao: 'REPROVAR', observacoes: 'Muito caro' })
            .expect(200);

        expect(res.body.resultado).toBe('APLICADA');
        expect(res.body.statusAtual).toBe('REPROVADA');

        const os = await prisma.ordemDeServico.findUnique({ where: { id: novaOsId } });
        expect(os!.status).toBe('REPROVADA');
    });
});
