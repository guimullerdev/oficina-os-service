/*
  Warnings:

  - You are about to drop the `movimentacoes_estoque` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `orcamentos` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `pecas` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `servicos` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "movimentacoes_estoque" DROP CONSTRAINT "movimentacoes_estoque_os_id_fkey";

-- DropForeignKey
ALTER TABLE "movimentacoes_estoque" DROP CONSTRAINT "movimentacoes_estoque_peca_id_fkey";

-- DropForeignKey
ALTER TABLE "orcamentos" DROP CONSTRAINT "orcamentos_os_id_fkey";

-- DropForeignKey
ALTER TABLE "os_itens_peca" DROP CONSTRAINT "os_itens_peca_peca_id_fkey";

-- DropForeignKey
ALTER TABLE "os_itens_servico" DROP CONSTRAINT "os_itens_servico_servico_id_fkey";

-- DropTable
DROP TABLE "movimentacoes_estoque";

-- DropTable
DROP TABLE "orcamentos";

-- DropTable
DROP TABLE "pecas";

-- DropTable
DROP TABLE "servicos";

-- DropEnum
DROP TYPE "StatusOrcamento";

-- DropEnum
DROP TYPE "TipoMovimentacao";
