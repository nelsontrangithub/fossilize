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
export function createAuthMiddleware(config: AuthConfig, users: UserRepository) {
  return async function authMiddleware(
    req: AuthedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing bearer token" });
      return;
    }

    const token = header.slice("Bearer ".length).trim();
    if (!token) {
      res.status(401).json({ error: "empty token" });
      return;
    }

    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(token, config.secret, {
        issuer: config.issuer,
        audience: config.audience,
      }) as jwt.JwtPayload;
    } catch (err) {
      res.status(401).json({ error: "invalid token", detail: String(err) });
      return;
    }

    if (!payload.sub) {
      res.status(401).json({ error: "token missing subject" });
      return;
    }

    const user = await users.findById(payload.sub);
    if (!user) {
      res.status(401).json({ error: "user not found" });
      return;
    }

    if (user.disabledAt) {
      res.status(403).json({ error: "user disabled" });
      return;
    }

    req.user = user;
    next();
  };
}

export class TokenService {
  constructor(private readonly config: AuthConfig) {}

  issueAccessToken(user: User): string {
    return jwt.sign(
      { sub: user.id, email: user.email, roles: user.roles },
      this.config.secret,
      {
        issuer: this.config.issuer,
        audience: this.config.audience,
        expiresIn: this.config.tokenTtlSeconds,
      },
    );
  }

  rotateRefreshToken(oldToken: string, user: User): string {
    // pretend implementation: revoke old, mint new
    const payload = jwt.verify(oldToken, this.config.secret) as jwt.JwtPayload;
    if (payload.sub !== user.id) {
      throw new Error("token/user mismatch");
    }
    return this.issueAccessToken(user);
  }

  decode(token: string): jwt.JwtPayload | null {
    try {
      return jwt.verify(token, this.config.secret) as jwt.JwtPayload;
    } catch {
      return null;
    }
  }
}

export const requireRole = (role: string) => {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }
    if (!req.user.roles.includes(role)) {
      res.status(403).json({ error: `requires role: ${role}` });
      return;
    }
    next();
  };
};
