import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { RegisterUseCase } from '../application/use-cases/register.usecase';
import { LoginUseCase } from '../application/use-cases/login.usecase';
import { RefreshTokenUseCase } from '../application/use-cases/refresh-token.usecase';
import { RegisterDto } from '../application/dto/register.dto';
import { LoginDto } from '../application/dto/login.dto';
import { RefreshTokenDto } from '../application/dto/refresh-token.dto';
import { AuthResponseDto } from '../application/dto/auth-response.dto';
import { Public } from '../decorators/public.decorator';
import { OptionalJwtAuthGuard } from '../guards/optional-jwt-auth.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly registerUseCase: RegisterUseCase,
    private readonly loginUseCase: LoginUseCase,
    private readonly refreshTokenUseCase: RefreshTokenUseCase,
  ) {}

  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Registrar novo usuário',
    description:
      'Rota pública. O campo `role` só é aceito com Bearer token de um ADMIN; sem `role`, o usuário é criado como ATENDENTE.',
  })
  @ApiResponse({
    status: 201,
    description: 'Usuário criado; retorna accessToken e refreshToken',
    type: AuthResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Dados inválidos' })
  @ApiResponse({
    status: 403,
    description: 'Somente ADMIN pode definir o perfil (role) do usuário',
  })
  @ApiResponse({ status: 409, description: 'Email já cadastrado' })
  register(
    @Body() dto: RegisterDto,
    @Req() req: Request & { user?: { role?: string } },
  ): Promise<AuthResponseDto> {
    return this.registerUseCase.execute(dto, req.user);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Autenticar usuário' })
  @ApiResponse({
    status: 200,
    description: 'Login bem-sucedido; retorna accessToken e refreshToken',
    type: AuthResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Credenciais inválidas' })
  login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
    return this.loginUseCase.execute(dto);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Renovar access token usando refresh token' })
  @ApiResponse({
    status: 200,
    description: 'Novo accessToken emitido',
    type: AuthResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Refresh token inválido ou expirado',
  })
  refresh(@Body() dto: RefreshTokenDto): Promise<AuthResponseDto> {
    return this.refreshTokenUseCase.execute(dto);
  }
}
