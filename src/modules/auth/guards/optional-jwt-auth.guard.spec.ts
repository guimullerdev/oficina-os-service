import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';

const makeRequest = (authHeader?: string) => ({
  headers: { authorization: authHeader },
  user: undefined as object | undefined,
});

const makeContext = (request: object) => ({
  switchToHttp: () => ({ getRequest: () => request }),
});

const makeGuard = (verify: jest.Mock) =>
  new OptionalJwtAuthGuard(
    { verifyAsync: verify } as any,
    { get: jest.fn().mockReturnValue('secret') } as any,
  );

describe('OptionalJwtAuthGuard', () => {
  it('allows and skips verification without authorization header', async () => {
    const verify = jest.fn();
    const req = makeRequest();
    await expect(
      makeGuard(verify).canActivate(makeContext(req) as any),
    ).resolves.toBe(true);
    expect(verify).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it('allows and skips verification for non-Bearer header', async () => {
    const verify = jest.fn();
    const req = makeRequest('Basic abc');
    await expect(
      makeGuard(verify).canActivate(makeContext(req) as any),
    ).resolves.toBe(true);
    expect(verify).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it('attaches payload for a valid token', async () => {
    const payload = { sub: 'u-1', role: 'ADMIN' };
    const verify = jest.fn().mockResolvedValue(payload);
    const req = makeRequest('Bearer good');
    await expect(
      makeGuard(verify).canActivate(makeContext(req) as any),
    ).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith('good', { secret: 'secret' });
    expect(req.user).toBe(payload);
  });

  it('allows without user for an invalid token', async () => {
    const verify = jest.fn().mockRejectedValue(new Error('expired'));
    const req = makeRequest('Bearer bad');
    await expect(
      makeGuard(verify).canActivate(makeContext(req) as any),
    ).resolves.toBe(true);
    expect(req.user).toBeUndefined();
  });
});
