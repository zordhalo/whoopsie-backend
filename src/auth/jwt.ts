import jwt from "@tsndr/cloudflare-worker-jwt";
import type { AuthClaims, Env, User } from "../types";

const ALG = "HS256";

export async function signToken(env: Env, user: User): Promise<string> {
  const ttlDays = parseInt(env.JWT_TTL_DAYS, 10) || 30;
  const now = Math.floor(Date.now() / 1000);
  const claims: AuthClaims = {
    sub: user.id,
    email: user.email,
    iat: now,
    exp: now + ttlDays * 86400,
    iss: env.JWT_ISSUER,
  };
  return jwt.sign(claims, env.JWT_SECRET, { algorithm: ALG });
}

export async function verifyToken(env: Env, token: string): Promise<AuthClaims | null> {
  try {
    const ok = await jwt.verify(token, env.JWT_SECRET, { algorithm: ALG });
    if (!ok) return null;
    const { payload } = jwt.decode<AuthClaims>(token);
    if (payload.iss !== env.JWT_ISSUER) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
