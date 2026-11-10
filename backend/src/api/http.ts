import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthContext } from '../repositories/apiKeys';

export const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

/** Auth context lives in res.locals so no global type augmentation is needed. */
export function getAuth(res: Response): AuthContext {
  return res.locals.auth as AuthContext;
}
