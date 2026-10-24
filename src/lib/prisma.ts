import { PrismaClient } from '@prisma/client';

// Raw client. Tenant-scoped access goes through the scoping extension (TASK-4), never this directly in tenant routes.
export const prisma = new PrismaClient();
