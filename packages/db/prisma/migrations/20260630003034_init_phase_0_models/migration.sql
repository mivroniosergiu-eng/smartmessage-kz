-- CreateEnum
CREATE TYPE "WaLoginType" AS ENUM ('BAILEYS', 'CLOUD_API', 'EVOLUTION');

-- CreateEnum
CREATE TYPE "WaAccountStatus" AS ENUM ('CONNECTING', 'CONNECTED', 'DISCONNECTED', 'LOGGED_OUT', 'RESTRICTED', 'BANNED');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "MessageLogStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateEnum
CREATE TYPE "MessageErrorType" AS ENUM ('MEDIA_ERROR', 'SESSION_ERROR', 'SEND_ERROR');

-- CreateTable
CREATE TABLE "WaAccount" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "loginType" "WaLoginType" NOT NULL DEFAULT 'BAILEYS',
    "status" "WaAccountStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "pid" INTEGER,
    "restrictedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaSession" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "timePost" TIMESTAMP(3),
    "run" TEXT,
    "accounts" JSONB NOT NULL,
    "nextAccount" TEXT,
    "scheduleTime" JSONB NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "minDelay" INTEGER NOT NULL DEFAULT 2000,
    "maxDelay" INTEGER NOT NULL DEFAULT 5000,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "technicalFailed" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageLog" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" "MessageLogStatus" NOT NULL DEFAULT 'QUEUED',
    "errorType" "MessageErrorType",
    "timePost" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stats" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "waTotalSent" INTEGER NOT NULL DEFAULT 0,
    "waTotalSentByMonth" INTEGER NOT NULL DEFAULT 0,
    "waTimeReset" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bulkTotal" INTEGER NOT NULL DEFAULT 0,
    "bulkSent" INTEGER NOT NULL DEFAULT 0,
    "bulkFailed" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permissions" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "tier" "Tier" NOT NULL DEFAULT 'STARTER',
    "monthlyBroadcastMessages" INTEGER NOT NULL DEFAULT 10000,
    "monthlyAiGenerations" INTEGER NOT NULL DEFAULT 500,
    "maxWhatsappAccounts" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "details" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WaAccount_instanceId_key" ON "WaAccount"("instanceId");

-- CreateIndex
CREATE INDEX "WaAccount_teamId_idx" ON "WaAccount"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "WaSession_instanceId_key" ON "WaSession"("instanceId");

-- CreateIndex
CREATE INDEX "WaSession_teamId_idx" ON "WaSession"("teamId");

-- CreateIndex
CREATE INDEX "Campaign_teamId_idx" ON "Campaign"("teamId");

-- CreateIndex
CREATE INDEX "MessageLog_teamId_idx" ON "MessageLog"("teamId");

-- CreateIndex
CREATE INDEX "MessageLog_instanceId_idx" ON "MessageLog"("instanceId");

-- CreateIndex
CREATE UNIQUE INDEX "Stats_teamId_key" ON "Stats"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "Permissions_teamId_key" ON "Permissions"("teamId");

-- CreateIndex
CREATE INDEX "AuditLog_teamId_idx" ON "AuditLog"("teamId");

-- AddForeignKey
ALTER TABLE "WaAccount" ADD CONSTRAINT "WaAccount_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stats" ADD CONSTRAINT "Stats_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Permissions" ADD CONSTRAINT "Permissions_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
