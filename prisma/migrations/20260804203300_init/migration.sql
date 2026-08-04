-- CreateEnum
CREATE TYPE "ItemStatus" AS ENUM ('pending_review', 'ready', 'exported');

-- CreateEnum
CREATE TYPE "ItemCondition" AS ENUM ('new', 'new_other', 'used', 'for_parts');

-- CreateTable
CREATE TABLE "ScanSession" (
    "id" TEXT NOT NULL,
    "label" TEXT,
    "startedBy" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "ScanSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Item" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "status" "ItemStatus" NOT NULL DEFAULT 'pending_review',
    "upc" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "isMultipack" BOOLEAN NOT NULL DEFAULT false,
    "packSize" INTEGER,
    "expirationDate" TIMESTAMP(3),
    "shelfLocation" TEXT NOT NULL,
    "photoUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scannedBy" TEXT,
    "scanSessionId" TEXT,
    "upcLookupData" JSONB,
    "aiTitle" TEXT,
    "aiDescription" TEXT,
    "finalTitle" TEXT,
    "finalDescription" TEXT,
    "price" DECIMAL(10,2),
    "categoryId" TEXT,
    "condition" "ItemCondition",
    "compNotes" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "exportBatchId" TEXT,
    "exportedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExportBatch" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exportedBy" TEXT,

    CONSTRAINT "ExportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Item_sku_key" ON "Item"("sku");

-- CreateIndex
CREATE INDEX "Item_status_idx" ON "Item"("status");

-- CreateIndex
CREATE INDEX "Item_scanSessionId_idx" ON "Item"("scanSessionId");

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_scanSessionId_fkey" FOREIGN KEY ("scanSessionId") REFERENCES "ScanSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_exportBatchId_fkey" FOREIGN KEY ("exportBatchId") REFERENCES "ExportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
