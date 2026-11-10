import { ApiProperty } from '@nestjs/swagger';

class VeiculoPublicoDto {
  @ApiProperty() placa: string;
  @ApiProperty() marca: string;
  @ApiProperty() modelo: string;
}

export class ConsultaOsPublicaResponseDto {
  @ApiProperty() numero: string;
  @ApiProperty() status: string;
  @ApiProperty() dataAbertura: Date;
  @ApiProperty() veiculo: VeiculoPublicoDto;
}
