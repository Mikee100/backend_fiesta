import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import prisma from '../config/prisma';
import { requireUser, AuthenticatedUser } from '../middleware/auth';
import { createAccessToken } from '../services/auth/auth.service';

const router = Router();
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

function publicUser(user: AuthenticatedUser) {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

router.post('/login', loginLimiter, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.isActive || !(await bcrypt.compare(password, user.password))) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  const profile = { id: user.id, email: user.email, name: user.name, role: user.role };
  res.json({ access_token: createAccessToken(user.id), user: profile });
});

router.post('/logout', requireUser, (_req, res) => {
  res.status(204).end();
});

router.post('/refresh', requireUser, (_req, res) => {
  const user = res.locals.authUser as AuthenticatedUser;
  res.json({ token: createAccessToken(user.id) });
});

router.get('/me', requireUser, (_req, res) => {
  res.json(publicUser(res.locals.authUser as AuthenticatedUser));
});

export default router;