-- Persistent WA auth-state payload for future connector implementations.
-- This is a provider-neutral database JSON payload, not filesystem WA session storage.
CREATE TABLE "WaAuthState" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaAuthState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WaAuthState_instanceId_key" ON "WaAuthState"("instanceId");

ALTER TABLE "WaAuthState"
ADD CONSTRAINT "WaAuthState_instanceId_fkey"
FOREIGN KEY ("instanceId") REFERENCES "WaAccount"("instanceId")
ON DELETE CASCADE ON UPDATE CASCADE;
