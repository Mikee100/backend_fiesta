import jwt from 'jsonwebtoken';

const TOKEN_ISSUER = 'fiesta-house-admin';

function getJwtSecret(): string {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('AUTH_JWT_SECRET must be configured with at least 32 characters');
  }
  return secret;
}

export function createAccessToken(userId: string): string {
  return jwt.sign({}, getJwtSecret(), {
    subject: userId,
    issuer: TOKEN_ISSUER,
    expiresIn: '8h',
  });
}

export function readAccessToken(token: string): string | null {
  try {
    const payload = jwt.verify(token, getJwtSecret(), { issuer: TOKEN_ISSUER });
    return typeof payload === 'object' && typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}