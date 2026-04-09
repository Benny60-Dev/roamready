import { Response, NextFunction } from 'express'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

function computeStatus(item: any, currentMiles?: number): 'OK' | 'DUE_SOON' | 'OVERDUE' {
  const now = new Date()

  if (item.intervalMiles && currentMiles && item.lastServiceMiles) {
    const nextDue = item.lastServiceMiles + item.intervalMiles
    if (currentMiles >= nextDue) return 'OVERDUE'
    if (currentMiles >= nextDue - 500) return 'DUE_SOON'
  }

  if (item.intervalMonths && item.lastServiceDate) {
    const nextDue = new Date(item.lastServiceDate)
    nextDue.setMonth(nextDue.getMonth() + item.intervalMonths)
    const daysUntil = (nextDue.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    if (daysUntil <= 0) return 'OVERDUE'
    if (daysUntil <= 30) return 'DUE_SOON'
  }

  return 'OK'
}

async function verifyRigOwnership(rigId: string, userId: string) {
  const rig = await prisma.rig.findFirst({ where: { id: rigId, userId } })
  if (!rig) throw new AppError('Rig not found', 404)
  return rig
}

export async function getItems(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const rig = await verifyRigOwnership(req.params.rigId, req.user!.id)
    const items = await prisma.maintenanceItem.findMany({
      where: { rigId: rig.id },
      orderBy: { name: 'asc' },
    })

    const itemsWithStatus = items.map(item => ({
      ...item,
      status: computeStatus(item, rig.currentMiles ?? undefined),
    }))

    res.json(itemsWithStatus)
  } catch (err) { next(err) }
}

export async function createItem(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const rig = await verifyRigOwnership(req.params.rigId, req.user!.id)
    const item = await prisma.maintenanceItem.create({
      data: { ...req.body, rigId: rig.id },
    })
    res.status(201).json(item)
  } catch (err) { next(err) }
}

export async function updateItem(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const rig = await verifyRigOwnership(req.params.rigId, req.user!.id)
    const item = await prisma.maintenanceItem.findFirst({ where: { id: req.params.itemId, rigId: rig.id } })
    if (!item) throw new AppError('Item not found', 404)

    const updated = await prisma.maintenanceItem.update({
      where: { id: req.params.itemId },
      data: req.body,
    })
    res.json(updated)
  } catch (err) { next(err) }
}

export async function logService(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const rig = await verifyRigOwnership(req.params.rigId, req.user!.id)
    const item = await prisma.maintenanceItem.findFirst({ where: { id: req.params.itemId, rigId: rig.id } })
    if (!item) throw new AppError('Item not found', 404)

    const { serviceDate, mileage, notes, cost } = req.body

    await prisma.maintenanceLog.create({
      data: { itemId: item.id, serviceDate: new Date(serviceDate), mileage, notes, cost },
    })

    const updated = await prisma.maintenanceItem.update({
      where: { id: item.id },
      data: {
        lastServiceDate: new Date(serviceDate),
        lastServiceMiles: mileage,
        status: 'OK',
      },
    })

    res.json(updated)
  } catch (err) { next(err) }
}

export async function getHistory(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const rig = await verifyRigOwnership(req.params.rigId, req.user!.id)
    const logs = await prisma.maintenanceLog.findMany({
      where: { item: { rigId: rig.id } },
      include: { item: true },
      orderBy: { serviceDate: 'desc' },
    })
    res.json(logs)
  } catch (err) { next(err) }
}
