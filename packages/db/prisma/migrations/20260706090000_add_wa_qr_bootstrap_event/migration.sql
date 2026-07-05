-- Persistent transient QR bootstrap payload only.
-- This table intentionally stores no WA auth-state, credentials, or session files.
CREATE TABLE "WaQrBootstrapEvent" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "qrCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaQrBootstrapEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WaQrBootstrapEvent_instanceId_key" ON "WaQrBootstrapEvent"("instanceId");

ALTER TABLE "WaQrBootstrapEvent"
ADD CONSTRAINT "WaQrBootstrapEvent_instanceId_fkey"
FOREIGN KEY ("instanceId") REFERENCES "WaAccount"("instanceId")
ON DELETE CASCADE ON UPDATE CASCADE;
