-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('AD', 'CHAT', 'MANUAL', 'IMPORT');

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN "source" "LeadSource" NOT NULL DEFAULT 'MANUAL';

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'MEMBER';

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_providerCustomerId_key" ON "Subscription"("providerCustomerId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- Backfill/Cleanup
DELETE FROM "WaSession"
WHERE NOT EXISTS (SELECT 1 FROM "Team" WHERE "Team"."id" = "WaSession"."teamId")
   OR NOT EXISTS (SELECT 1 FROM "WaAccount" WHERE "WaAccount"."instanceId" = "WaSession"."instanceId");

DELETE FROM "MessageLog"
WHERE NOT EXISTS (SELECT 1 FROM "Team" WHERE "Team"."id" = "MessageLog"."teamId")
   OR NOT EXISTS (SELECT 1 FROM "WaAccount" WHERE "WaAccount"."instanceId" = "MessageLog"."instanceId");

DELETE FROM "AuditLog"
WHERE NOT EXISTS (SELECT 1 FROM "Team" WHERE "Team"."id" = "AuditLog"."teamId");

UPDATE "AuditLog"
SET "userId" = NULL
WHERE "userId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "User" WHERE "User"."id" = "AuditLog"."userId");

-- AddForeignKey
ALTER TABLE "WaSession" ADD CONSTRAINT "WaSession_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "WaAccount"("instanceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaSession" ADD CONSTRAINT "WaSession_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageLog" ADD CONSTRAINT "MessageLog_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "WaAccount"("instanceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageLog" ADD CONSTRAINT "MessageLog_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
