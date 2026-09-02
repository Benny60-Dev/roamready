-- FEAT-NAV-HANDOFF: generic client usage-event log (which maps app a leg was
-- handed to, etc.). Additive: new table only, no existing rows touched.
CREATE TABLE "ClientEvent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "userId" TEXT,
    "tripId" TEXT,
    "props" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClientEvent_name_createdAt_idx" ON "ClientEvent"("name", "createdAt");
CREATE INDEX "ClientEvent_userId_idx" ON "ClientEvent"("userId");
