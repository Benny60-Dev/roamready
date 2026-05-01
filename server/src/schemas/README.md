# Request schemas

Each file in this directory exports Zod schemas for one Prisma model.

Schemas MUST omit server-managed fields:
  - `id`, `createdAt`, `updatedAt` (always)
  - `userId` / `ownerId` / `tripId` / `rigId` (any FK pointing at an owner)

Schemas MUST use `.strict()` so unknown keys are REJECTED, not stripped silently.

Provide separate schemas for create vs. update (update fields are typically optional).

Enums should reference Prisma's generated enum imports where possible.
