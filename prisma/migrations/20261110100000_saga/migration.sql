-- CreateEnum
CREATE TYPE "StatusSaga" AS ENUM ('EM_ANDAMENTO', 'CONCLUIDA', 'COMPENSADA', 'PENDENTE', 'FALHOU');

-- CreateEnum
CREATE TYPE "StatusPassoSaga" AS ENUM ('PENDENTE', 'EM_ANDAMENTO', 'CONCLUIDO', 'FALHOU', 'COMPENSADO', 'EXPIRADO');

-- CreateTable
CREATE TABLE "saga_instancias" (
    "id" TEXT NOT NULL,
    "os_id" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "status" "StatusSaga" NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "iniciada_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizada_em" TIMESTAMP(3),

    CONSTRAINT "saga_instancias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saga_passos" (
    "id" TEXT NOT NULL,
    "saga_id" TEXT NOT NULL,
    "ordem" INTEGER NOT NULL,
    "nome" TEXT NOT NULL,
    "status" "StatusPassoSaga" NOT NULL DEFAULT 'PENDENTE',
    "comando" TEXT,
    "evento_esperado" TEXT,
    "expira_em" TIMESTAMP(3),
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "erro" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saga_passos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "saga_instancias_correlation_id_idx" ON "saga_instancias"("correlation_id");

-- CreateIndex
CREATE UNIQUE INDEX "saga_instancias_os_id_tipo_key" ON "saga_instancias"("os_id", "tipo");

-- CreateIndex
CREATE INDEX "saga_passos_status_expira_em_idx" ON "saga_passos"("status", "expira_em");

-- CreateIndex
CREATE UNIQUE INDEX "saga_passos_saga_id_ordem_key" ON "saga_passos"("saga_id", "ordem");

-- AddForeignKey
ALTER TABLE "saga_instancias" ADD CONSTRAINT "saga_instancias_os_id_fkey" FOREIGN KEY ("os_id") REFERENCES "ordens_de_servico"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saga_passos" ADD CONSTRAINT "saga_passos_saga_id_fkey" FOREIGN KEY ("saga_id") REFERENCES "saga_instancias"("id") ON DELETE CASCADE ON UPDATE CASCADE;

