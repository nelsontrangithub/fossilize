import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";
import { User, UserRepository } from "./users";

export interface AuthConfig {
  secret: string;
  issuer: string;
  audience: string;
  tokenTtlSeconds: number;
}

export interface AuthedRequest extends Request {
  user?: User;
}

/**
 * Express middleware that verifies the bearer token on the incoming request,
 * attaches the resolved user to req.user, and rejects with 401 otherwise.
 */
export function createAuthMiddleware(config: AuthConfig, users: UserRepository) { /* fossil:examples/auth.ts#createAuthMiddleware 48L */ }

export class TokenService {
  constructor(private readonly config: AuthConfig) {}

  issueAccessToken(user: User): string { /* fossil:examples/auth.ts#TokenService.issueAccessToken 10L */ }

  rotateRefreshToken(oldToken: string, user: User): string { /* fossil:examples/auth.ts#TokenService.rotateRefreshToken 7L */ }

  decode(token: string): jwt.JwtPayload | null { /* fossil:examples/auth.ts#TokenService.decode 6L */ }
}

export const requireRole = (role: string) => { /* fossil:examples/auth.ts#requireRole 12L */ };


