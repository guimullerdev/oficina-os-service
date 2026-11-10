import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsUUID, Max, Min } from 'class-validator';

export class AddServicoDto {
  @ApiProperty({
    example: 'd6e7f8a9-4567-8901-cdef-012345678901',
    description: 'UUID do serviço a adicionar (referência fraca, não validada)',
  })
  @IsUUID()
  @IsNotEmpty()
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
