-- CreateTable
CREATE TABLE "CachedReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reportId" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CachedParticipant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subId" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Reminder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subId" TEXT NOT NULL,
    "visitType" TEXT NOT NULL,
    "scheduledDate" DATETIME NOT NULL,
    "reminderNumber" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'would-send',
    "recipientEmail" TEXT,
    "recipientPhone" TEXT,
    "surveyLinks" TEXT,
    "surveyNames" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "CachedReport_reportId_key" ON "CachedReport"("reportId");

-- CreateIndex
CREATE UNIQUE INDEX "CachedParticipant_subId_key" ON "CachedParticipant"("subId");

-- CreateIndex
CREATE INDEX "Reminder_subId_idx" ON "Reminder"("subId");

-- CreateIndex
CREATE INDEX "Reminder_scheduledDate_idx" ON "Reminder"("scheduledDate");

-- CreateIndex
CREATE INDEX "Reminder_status_idx" ON "Reminder"("status");

-- CreateIndex
CREATE INDEX "Reminder_visitType_idx" ON "Reminder"("visitType");
