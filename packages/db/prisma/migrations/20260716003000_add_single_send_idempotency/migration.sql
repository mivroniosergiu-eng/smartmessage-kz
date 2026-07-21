ALTER TABLE "MessageLog"
ADD COLUMN "idempotencyKey" TEXT,
ADD COLUMN "providerMessageId" TEXT;

UPDATE "MessageLog"
SET "idempotencyKey" = "id"
WHERE "idempotencyKey" IS NULL;

ALTER TABLE "MessageLog"
ALTER COLUMN "idempotencyKey" SET NOT NULL;

CREATE UNIQUE INDEX "MessageLog_teamId_idempotencyKey_key"
ON "MessageLog"("teamId", "idempotencyKey");
