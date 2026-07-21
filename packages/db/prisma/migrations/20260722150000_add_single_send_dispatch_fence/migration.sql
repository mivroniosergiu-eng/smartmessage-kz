ALTER TYPE "MessageLogStatus" ADD VALUE 'DISPATCHING';

ALTER TABLE "MessageLog"
ADD COLUMN "dispatchAttemptedAt" TIMESTAMP(3);
