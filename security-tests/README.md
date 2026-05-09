## Payload index

### createMembership tests (May 9, 2026 — Phase 2.5)

| File | Payload | Expected | Tests |
|---|---|---|---|
| `test-create-1.json` | `{"type":"Good Sam"}` | 201 | Happy path — legit creation |
| `test-create-2.json` | `{"type":"KOA","isAdmin":true}` | 400 | Unknown field rejection |
| `test-create-3.json` | `{"type":"KOA","userId":"attacker-id-12345"}` | 400 | userId injection / mass-assignment |
| `test-create-4.json` | `{"memberNumber":"12345"}` | 400 | Required field (`type`) missing |

Endpoint: `POST /api/v1/users/me/memberships`

### updateTrip tests (May 1, 2026 — Phase 2.4)

| File | Payload | Expected | Tests |
|---|---|---|---|
| `legit-trip.json` | `{"name":"Phase 2.4 verification rename"}` | 200 | Happy path — legit rename |
| `malicious-trip.json` | userId + sharedToken + packingList + maliciousField | 400 | Mass-assignment + .strict() rejection |
| `restore-trip-name.json` | `{"name":"Big Bend Desert Discovery"}` | 200 | Restore after verification rename |

Endpoint: `PUT /api/v1/trips/:id`

### updateMembership tests (May 1, 2026 — Phase 2.3)

| File | Payload | Expected | Tests |
|---|---|---|---|
| `malicious-membership.json` | userId + planTier + expiresAt + maliciousField | 400 | Self-grant Premier / userId injection |

Endpoint: `PUT /api/v1/users/me/memberships/:id`

### updateStop tests (April 30, 2026 — Phase 2.2)

| File | Payload | Expected | Tests |
|---|---|---|---|
| `malicious.json` | `{"userId":"attacker","tripId":"attacker","maliciousField":"rejected"}` | 400 | Original Tier-1 verification — TOCTOU defense |

Endpoint: `PUT /api/v1/trips/:id/stops/:stopId` (and `PUT /api/v1/bookings/:id`)

## Notes

- These payloads contain NO real secrets. The strings like "attacker-id-12345" are placeholder values designed to trigger schema rejection.
- If you add new payloads, update this README with the file, payload, expected response, and what it tests.
- See server/src/schemas/ for the actual Zod schemas these payloads validate against.
