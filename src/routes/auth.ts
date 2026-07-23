import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";
import { signToken } from "../middleware/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { BadRequestError, ConflictError, UnauthorizedError } from "../lib/errors";

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().optional(),
  // INC-006 fix (Step 3): bcryptjs silently truncates input at 72 bytes. A password
  // longer than 72 chars was previously accepted and hashed, but only the first 72
  // bytes were used — the caller received no indication of the truncation. .max(72)
  // makes the boundary explicit and rejects the payload with a clear validation error.
  password: z.string().min(8).max(72),
  // INC-006 fix (Step 3): reasonable upper bound — previously no max was set, allowing
  // arbitrarily large strings to reach the database.
  displayName: z.string().min(1).max(100),
  accountType: z.enum(["CONSUMER", "VENDOR", "CREATOR"]).default("CONSUMER"),
}).refine((data) => data.email || data.phone, {
  message: "email or phone is required",
});

authRouter.post("/register", asyncHandler(async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new BadRequestError("Invalid registration data", parsed.error.flatten());
  }

  const { email, phone, password, displayName, accountType } = parsed.data;

  const existing = await prisma.user.findFirst({
    where: { OR: [{ email: email ?? undefined }, { phone: phone ?? undefined }] },
  });
  if (existing) throw new ConflictError("Account already exists");

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { email, phone, passwordHash, displayName, accountType },
  });

  const token = signToken({ id: user.id, accountType: user.accountType });
  res.status(201).json({ token, user: { id: user.id, displayName: user.displayName, accountType: user.accountType } });
}));

const loginSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().optional(),
  password: z.string(),
}).refine((data) => data.email || data.phone, {
  message: "email or phone is required",
});

authRouter.post("/login", asyncHandler(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new BadRequestError("Invalid login data", parsed.error.flatten());
  }

  const { email, phone, password } = parsed.data;
  const user = await prisma.user.findFirst({
    where: { OR: [{ email: email ?? undefined }, { phone: phone ?? undefined }] },
  });

  if (!user || !user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new UnauthorizedError("Invalid credentials");
  }

  const token = signToken({ id: user.id, accountType: user.accountType });
  res.json({ token, user: { id: user.id, displayName: user.displayName, accountType: user.accountType } });
}));
