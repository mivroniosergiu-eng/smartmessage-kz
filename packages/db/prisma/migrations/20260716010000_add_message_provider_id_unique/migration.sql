CREATE UNIQUE INDEX "MessageLog_instanceId_providerMessageId_key"
ON "MessageLog"("instanceId", "providerMessageId");
