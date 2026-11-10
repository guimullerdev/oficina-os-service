import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsNumber, IsUUID, Max, Min } from 'class-validator';

export class AddPecaDto {
  @ApiProperty({
    example: 'c5d6e7f8-3456-7890-bcde-f01234567890',
    description: 'UUID da peça a adicionar (referência fraca, não validada)',
  })
  @IsUUID()
  @IsNotEmpty()
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
