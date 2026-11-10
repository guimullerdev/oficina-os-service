-- CreateTable
CREATE TABLE "mensagens_processadas" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "evento" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mensagens_processadas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mensagens_processadas_event_id_key" ON "mensagens_processadas"("event_id");
