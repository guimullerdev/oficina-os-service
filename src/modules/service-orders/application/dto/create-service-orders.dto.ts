import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsString,
  IsOptional,
  IsUUID,
  IsNotEmpty,
  IsArray,
  ValidateNested,
  IsInt,
  IsNumber,
  Max,
  Min,
} from 'class-validator';

export class CreateOsServicoDto {
  @ApiProperty({
    example: 'uuid-do-servico',
    description: 'UUID do serviço (referência fraca, não validada)',
  })
  @IsNotEmpty()
  @IsUUID()
  servicoId: string;

  @ApiProperty({
    example: 80,
    description:
      'Preço unitário em reais (denormalizado; não validado contra catálogo)',
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99999999.99)
  precoUnitario: number;
}

export class CreateOsPecaDto {
  @ApiProperty({
    example: 'uuid-da-peca',
    description: 'UUID da peça (referência fraca, não validada)',
  })
  @IsNotEmpty()
  @IsUUID()
  pecaId: string;

  @ApiProperty({ example: 2, description: 'Quantidade (mínimo 1)' })
  @IsInt()
  @Min(1)
  quantidade: number;

  @ApiProperty({
    example: 80,
    description:
      'Preço unitário em reais (denormalizado; não validado contra catálogo)',
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99999999.99)
  precoUnitario: number;
}

export class CreateOsDto {
  @ApiProperty({
    example: 'a3e4f5b6-1234-5678-9abc-def012345678',
    description: 'UUID do cliente',
  })
  @IsNotEmpty()
  @IsUUID()
  clienteId: string;

  @ApiProperty({
    example: 'b4f5a6c7-2345-6789-abcd-ef0123456789',
    description: 'UUID do veículo',
  })
  @IsNotEmpty()
  @IsUUID()
  veiculoId: string;

  @ApiPropertyOptional({
    example: 'Veículo apresenta barulho ao frear e luz do motor acesa',
  })
  @IsOptional()
  @IsString()
  descricaoProblema?: string;

  @ApiPropertyOptional({
    type: [CreateOsServicoDto],
    description: 'Serviços a adicionar na abertura (opcional)',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateOsServicoDto)
  servicos?: CreateOsServicoDto[];

  @ApiPropertyOptional({
    type: [CreateOsPecaDto],
    description: 'Peças a adicionar na abertura (opcional)',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateOsPecaDto)
  pecas?: CreateOsPecaDto[];
}
