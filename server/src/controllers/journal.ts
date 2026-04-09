import { Response, NextFunction } from 'express'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import multer from 'multer'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

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

export async function getAllJournals(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const entries = await prisma.journalEntry.findMany({
      where: { stop: { trip: { userId: req.user!.id } } },
      include: { stop: { include: { trip: true } } },
      orderBy: { createdAt: 'desc' },
    })
    res.json(entries)
  } catch (err) { next(err) }
}

export async function getTripJournal(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({ where: { id: req.params.tripId, userId: req.user!.id } })
    if (!trip) throw new AppError('Trip not found', 404)

    const entries = await prisma.journalEntry.findMany({
      where: { stop: { tripId: req.params.tripId } },
      include: { stop: true },
      orderBy: { stop: { order: 'asc' } },
    })
    res.json(entries)
  } catch (err) { next(err) }
}

export async function upsertEntry(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const stop = await verifyStopOwnership(req.params.stopId, req.user!.id)
    const { title, body, rating, actualCost } = req.body

    const entry = await prisma.journalEntry.upsert({
      where: { stopId: stop.id },
      update: { title, body, rating, actualCost },
      create: { stopId: stop.id, title, body, rating, actualCost },
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

    const existing = await prisma.journalEntry.findUnique({ where: { stopId: stop.id } })
    const currentPhotos = (existing?.photos as string[]) || []

    const entry = await prisma.journalEntry.upsert({
      where: { stopId: stop.id },
      update: { photos: [...currentPhotos, ...uploadedUrls] },
      create: { stopId: stop.id, photos: uploadedUrls },
    })

    res.json(entry)
  } catch (err) { next(err) }
}
