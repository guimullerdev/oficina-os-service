import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StatusPassoSaga, StatusSaga } from '@prisma/client';

export class SagaPassoResponseDto {
  @ApiProperty() ordem: number;
  @ApiProperty() nome: string;
  @ApiProperty({ enum: StatusPassoSaga }) status: StatusPassoSaga;
  @ApiPropertyOptional({ nullable: true, type: String }) comando: string | null;
  @ApiPropertyOptional({ nullable: true, type: String }) eventoEsperado:
    | string
    | null;
  @ApiPropertyOptional({ nullable: true, type: Date }) expiraEm: Date | null;
  @ApiProperty() tentativas: number;
  @ApiPropertyOptional({ nullable: true, type: String }) erro: string | null;
}

export class SagaResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() osId: string;
  @ApiProperty() tipo: string;
  @ApiProperty({ enum: StatusSaga }) status: StatusSaga;
  @ApiProperty() correlationId: string;
  @ApiProperty() iniciadaEm: Date;
  @ApiPropertyOptional({ nullable: true, type: Date })
  finalizadaEm: Date | null;
  @ApiProperty({ type: [SagaPassoResponseDto] }) passos: SagaPassoResponseDto[];
}
