// Saved/reusable packing lists (FR-SAVED-PACKING) — USER-level template CRUD.
//
// A PackingTemplate.items blob mirrors Trip.packingList's category/item shape
// exactly, so a template can be fed straight through mergePackedState to seed a
// trip (see controllers/trips.ts → seedPackingListFromTemplate). Templates are
// a Pro feature; the router gates the whole CRUD with requireFeature.
import { Response, NextFunction } from 'express'
import { AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { prisma } from '../utils/prisma'
import { resetCheckedState } from '../utils/packingMerge'
import { PackingTemplateCreateInput } from '../schemas'

// Total items across all categories — the light count returned by the list view.
function countItems(items: unknown): number {
  if (!Array.isArray(items)) return 0
  return items.reduce((sum: number, cat: any) => sum + (Array.isArray(cat?.items) ? cat.items.length : 0), 0)
}

/** POST /packing-templates — create a template from { name, items }. Pro-gated. */
export async function createPackingTemplate(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { name, items } = req.body as PackingTemplateCreateInput
    const template = await prisma.packingTemplate.create({
      data: {
        userId: req.user!.id,
        name,
        items: resetCheckedState(items as any[]) as any,
      },
    })
    // Return the light shape (no full items) — same as the list view.
    res.status(201).json({
      id: template.id,
      name: template.name,
      createdAt: template.createdAt,
      itemCount: countItems(template.items),
    })
  } catch (err) { next(err) }
}

/** GET /packing-templates — list the user's templates (light: id, name, count). */
export async function listPackingTemplates(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const templates = await prisma.packingTemplate.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      // items is read only to compute the count; it is NOT returned in the list.
      select: { id: true, name: true, createdAt: true, items: true },
    })
    res.json(
      templates.map(t => ({
        id: t.id,
        name: t.name,
        createdAt: t.createdAt,
        itemCount: countItems(t.items),
      })),
    )
  } catch (err) { next(err) }
}

/** GET /packing-templates/:id — one template's full items (for client preview). */
export async function getPackingTemplate(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const template = await prisma.packingTemplate.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    })
    if (!template) throw new AppError('Template not found', 404)
    res.json({
      id: template.id,
      name: template.name,
      createdAt: template.createdAt,
      items: template.items,
    })
  } catch (err) { next(err) }
}

/** DELETE /packing-templates/:id — ownership-checked delete (404 if not owned). */
export async function deletePackingTemplate(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    // deleteMany with the userId guard makes ownership part of the WHERE — a
    // template owned by someone else simply matches nothing (count 0 → 404),
    // so we never delete another user's row or leak its existence.
    const result = await prisma.packingTemplate.deleteMany({
      where: { id: req.params.id, userId: req.user!.id },
    })
    if (result.count === 0) throw new AppError('Template not found', 404)
    res.status(204).send()
  } catch (err) { next(err) }
}
