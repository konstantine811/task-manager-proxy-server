import type { NextFunction, Request, Response } from "express";
import { admin } from "./firebase.js";
import { httpError } from "./errors.js";
import { isAdminEmail } from "./config.js";
import type { AuthenticatedRequest } from "./types.js";

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    if (!token) throw httpError(401, "Missing Firebase ID token.");

    (req as AuthenticatedRequest).user = await admin.auth().verifyIdToken(token);
    next();
  } catch (error) {
    next(error);
  }
}

export function authUser(req: Request) {
  const user = (req as AuthenticatedRequest).user;
  if (!user) throw httpError(401, "Missing authenticated user.");
  return user;
}

export async function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  try {
    const user = authUser(req);
    if (!isAdminEmail(user.email)) {
      throw httpError(403, "Admin access is required.");
    }
    next();
  } catch (error) {
    next(error);
  }
}
