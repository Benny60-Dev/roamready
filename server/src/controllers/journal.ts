import { Response, NextFunction } from 'express'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import multer from 'multer'
import { Prisma } from '@prisma/client'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import type { JournalCreateInput, JournalUpdateInput } from '../schemas'

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
})

export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

async function verifyStopOwnership(stopId: string, userId: string) {
  const stop = await prisma.stop.findFirst({
    where: { id: stopId, trip: { userId } },
    include: { trip: true },
  })
  if (!stop) throw new AppError('Stop not found', 404)
  return stop
}

/** Verifies the trip exists AND belongs to req.user. Throws 404 otherwise.
 *  Used when an entry links to a trip, so a caller can't attach their entry
 *  to a trip they don't own. */
async function verifyTripOwnership(tripId: string, userId: string) {
  const trip = await prisma.trip.findFirst({
    where: { id: tripId, userId },
    select: { id: true },
  })
  if (!trip) throw new AppError('Trip not found', 404)
}

// ─── Freeform diary CRUD ────────────────────────────────────────────────────
// JournalEntry is a per-user diary: userId required, tripId/stopId optional
// links. Ownership is by userId (never the Stop->Trip chain the legacy per-stop
// path below uses). state auto-resolves from a linked Stop when not supplied.

export async function listEntries(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id
    const { tripId, state, tag, rating, q } = req.query

    // ── Full-text search path (raw tsvector). When q is present, search the
    //    generated `search` tsvector with websearch_to_tsquery (handles natural
    //    input like "that RV park in Texas"), ranked by ts_rank. Structured
    //    filters are applied in the same SQL. EVERYTHING is parameterized via
    //    Prisma.sql — q and every filter are bind params, never interpolated.
    if (typeof q === 'string' && q.trim()) {
      const term = q.trim()
      const conditions: Prisma.Sql[] = [
        Prisma.sql`"userId" = ${userId}`,
        Prisma.sql`"search" @@ websearch_to_tsquery('english', ${term})`,
      ]
      if (typeof tripId === 'string' && tripId) conditions.push(Prisma.sql`"tripId" = ${tripId}`)
      if (typeof state === 'string' && state) conditions.push(Prisma.sql`"state" = ${state}`)
      if (typeof tag === 'string' && tag) conditions.push(Prisma.sql`${tag} = ANY("tags")`)
      if (typeof rating === 'string' && rating.trim()) {
        const r = parseInt(rating, 10)
        if (!Number.isNaN(r)) conditions.push(Prisma.sql`"rating" = ${r}`)
      }

      // Explicit column list (NOT SELECT *) so the `search` tsvector column is
      // excluded — keeping the row shape identical to what findMany returns
      // (findMany omits the Unsupported `search` field).
      const entries = await prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT "id", "userId", "tripId", "stopId", "entryDate", "title", "body",
               "rating", "photos", "actualCost", "state", "lat", "lng",
               "placeName", "tags", "createdAt", "updatedAt"
        FROM "JournalEntry"
        WHERE ${Prisma.join(conditions, ' AND ')}
        ORDER BY ts_rank("search", websearch_to_tsquery('english', ${term})) DESC,
                 "entryDate" DESC
      `)
      res.json(entries)
      return
    }

    // ── No q: structured-filter path (unchanged Prisma findMany). ──
    const where: any = { userId }
    if (typeof tripId === 'string' && tripId) where.tripId = tripId
    if (typeof state === 'string' && state) where.state = state
    if (typeof tag === 'string' && tag) where.tags = { has: tag }
    if (typeof rating === 'string' && rating.trim()) {
      const r = parseInt(rating, 10)
      if (!Number.isNaN(r)) where.rating = r
    }

    const entries = await prisma.journalEntry.findMany({
      where,
      orderBy: { entryDate: 'desc' },
    })
    res.json(entries)
  } catch (err) { next(err) }
}

export async function getEntry(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const entry = await prisma.journalEntry.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    })
    if (!entry) throw new AppError('Journal entry not found', 404)
    res.json(entry)
  } catch (err) { next(err) }
}

export async function createEntry(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id
    const input: JournalCreateInput = req.body

    // Verify any linked trip/stop belong to the caller before persisting.
    if (input.tripId) await verifyTripOwnership(input.tripId, userId)

    // Auto-resolve state + coords from a linked stop: when stopId is present and
    // a field was OMITTED by the caller (key absent), inherit it from the stop.
    // An explicitly-sent value (including null) is preserved — we only fill gaps.
    // This is what gives per-stop diary entries map pins (step 7); freeform
    // entries (no stopId) keep null coords and get no pin.
    let resolvedState = input.state ?? null
    let resolvedLat = input.lat ?? null
    let resolvedLng = input.lng ?? null
    let resolvedPlaceName = input.placeName ?? null
    if (input.stopId) {
      const stop = await verifyStopOwnership(input.stopId, userId)
      if (input.state === undefined) resolvedState = stop.locationState ?? null
      if (input.lat === undefined) resolvedLat = stop.latitude ?? null
      if (input.lng === undefined) resolvedLng = stop.longitude ?? null
      if (input.placeName === undefined) resolvedPlaceName = stop.locationName ?? null
    }

    const entry = await prisma.journalEntry.create({
      data: {
        userId,
        tripId: input.tripId ?? null,
        stopId: input.stopId ?? null,
        title: input.title ?? null,
        body: input.body,
        rating: input.rating ?? null,
        tags: input.tags ?? [],
        placeName: resolvedPlaceName,
        lat: resolvedLat,
        lng: resolvedLng,
        state: resolvedState,
        // entryDate omitted -> Prisma applies @default(now())
        ...(input.entryDate ? { entryDate: input.entryDate } : {}),
      },
    })
    res.status(201).json(entry)
  } catch (err) { next(err) }
}

export async function updateEntry(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id
    const id = req.params.id
    const input: JournalUpdateInput = req.body

    const existing = await prisma.journalEntry.findFirst({ where: { id, userId } })
    if (!existing) throw new AppError('Journal entry not found', 404)

    if (input.tripId) await verifyTripOwnership(input.tripId, userId)

    // .strict() guarantees only schema keys are present, so spreading is safe.
    const data: any = { ...input }

    // state auto-resolve only when this update (re)links a stop and doesn't
    // explicitly set state. Updates that leave stopId untouched keep state as-is.
    if (input.stopId) {
      const stop = await verifyStopOwnership(input.stopId, userId)
      if (input.state === undefined) data.state = stop.locationState ?? null
    }

    const updated = await prisma.journalEntry.update({ where: { id }, data })
    res.json(updated)
  } catch (err) { next(err) }
}

export async function deleteEntry(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const existing = await prisma.journalEntry.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    })
    if (!existing) throw new AppError('Journal entry not found', 404)

    await prisma.journalEntry.delete({ where: { id: req.params.id } })
    res.json({ message: 'Journal entry deleted' })
  } catch (err) { next(err) }
}

// ─── Legacy per-stop journal (still live) ───────────────────────────────────

export async function upsertEntry(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const stop = await verifyStopOwnership(req.params.stopId, req.user!.id)
    const { title, body, rating, actualCost } = req.body

    // stopId is no longer unique (a stop can now hold multiple diary entries),
    // so we can't use prisma.upsert({ where: { stopId } }). Preserve the existing
    // one-entry-per-stop behavior by updating the first existing entry for this
    // stop, or creating a new one with the owning userId (and denormalized tripId).
    const existing = await prisma.journalEntry.findFirst({ where: { stopId: stop.id } })
    const entry = existing
      ? await prisma.journalEntry.update({
          where: { id: existing.id },
          data: {
            title,
            body,
            rating,
            actualCost,
            // Backfill coords/placeName from the stop only where the entry is
            // still missing them — never overwrite a value that's already set.
            ...(existing.lat == null ? { lat: stop.latitude ?? null } : {}),
            ...(existing.lng == null ? { lng: stop.longitude ?? null } : {}),
            ...(existing.placeName == null ? { placeName: stop.locationName ?? null } : {}),
          },
        })
      : await prisma.journalEntry.create({
          data: {
            userId: req.user!.id,
            stopId: stop.id,
            tripId: stop.tripId,
            title,
            body,
            rating,
            actualCost,
            // New per-stop entry inherits the stop's coords + name for the map pin.
            lat: stop.latitude ?? null,
            lng: stop.longitude ?? null,
            placeName: stop.locationName ?? null,
          },
        })
    res.json(entry)
  } catch (err) { next(err) }
}

export async function uploadPhotos(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const stop = await verifyStopOwnership(req.params.stopId, req.user!.id)

    if (!process.env.AWS_S3_BUCKET) {
      return res.status(503).json({ error: 'S3 not configured' })
    }

    const files = req.files as Express.Multer.File[]
    if (!files?.length) throw new AppError('No files uploaded', 400)

    const uploadedUrls: string[] = []

    for (const file of files) {
      const key = `journals/${req.user!.id}/${stop.id}/${Date.now()}-${file.originalname}`
      await s3.send(new PutObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      }))
      uploadedUrls.push(`https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`)
    }

    const existing = await prisma.journalEntry.findFirst({ where: { stopId: stop.id } })
    const currentPhotos = (existing?.photos as string[]) || []

    const entry = existing
      ? await prisma.journalEntry.update({
          where: { id: existing.id },
          data: { photos: [...currentPhotos, ...uploadedUrls] },
        })
      : await prisma.journalEntry.create({
          data: { userId: req.user!.id, stopId: stop.id, tripId: stop.tripId, photos: uploadedUrls },
        })

    res.json(entry)
  } catch (err) { next(err) }
}
