import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

/**
 * Lê o Bearer token se existir e válido, anexando o payload em `request.user`.
 * Nunca rejeita a requisição: token ausente ou inválido apenas deixa `user` indefinido.
 */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: object }>();
    const token = this.extractToken(request);

    if (token) {
      try {
        request.user = await this.jwtService.verifyAsync<object>(token, {
          secret: this.configService.get<string>('JWT_SECRET'),
        });
      } catch {
        request.user = undefined;
      }
    }

    return true;
  }

  private extractToken(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
