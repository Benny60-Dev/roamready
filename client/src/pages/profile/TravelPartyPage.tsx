import { useEffect, useState } from 'react'
import { Plus, Trash2, Pencil, User as UserIcon, PawPrint, AlertTriangle } from 'lucide-react'
import { usersApi } from '../../services/api'
import { Person, Pet, PersonRole, PetType, TravelParty } from '../../types'

// Display labels for the enum values stored on Person/Pet rows.
const ROLE_LABELS: Record<PersonRole, string> = {
  ADULT: 'Adult',
  TEEN: 'Teen',
  CHILD: 'Child',
  INFANT: 'Infant',
}

const PET_TYPE_LABELS: Record<PetType, string> = {
  DOG: 'Dog',
  CAT: 'Cat',
  OTHER: 'Other',
}

// v1 form state. Mirrors the schema's v1-exposed fields only — name + role
// for Person, type + name for Pet. The Zod schemas accept more (dormant AI
// fields), but the UI doesn't surface them this round.
interface PersonDraft {
  id?: string
  name: string
  role: PersonRole
}

interface PetDraft {
  id?: string
  type: PetType
  name: string
}

const EMPTY_PERSON: PersonDraft = { name: '', role: 'ADULT' }
const EMPTY_PET: PetDraft = { type: 'DOG', name: '' }

export default function TravelPartyPage() {
  const [party, setParty] = useState<TravelParty | null>(null)
  const [loading, setLoading] = useState(true)

  const [personDraft, setPersonDraft] = useState<PersonDraft | null>(null)
  const [petDraft, setPetDraft] = useState<PetDraft | null>(null)
  const [saving, setSaving] = useState(false)
  // Surfaces save/delete failures inline instead of the old try/finally-with-no-
  // catch that swallowed them (part of BUG-PARTY-DUP-ON-EMPTY-STATE: a failed add
  // looked like it did nothing).
  const [error, setError] = useState<string | null>(null)

  // Default-party fetch. Returns null for users who don't have one yet
  // (the backfill only created parties for users with a TravelProfile).
  // First save on this page lazily creates the default party — see
  // ensureParty() below.
  useEffect(() => {
    usersApi.getDefaultParty()
      .then(res => setParty(res.data))
      .catch(() => setParty(null))
      .finally(() => setLoading(false))
  }, [])

  // Lazy-create the default party on first write. Avoids forcing the user
  // through an "Initialize your travel party" empty state and matches the
  // backfill semantics: a default party comes into existence when there's
  // data to put in it.
  //
  // BUG-PARTY-DUP-ON-EMPTY-STATE: local `party` state being null does NOT mean
  // the server has no default — it can be null from a slow/transient initial
  // fetch or a click that raced the load. Re-check the server for an existing
  // default BEFORE creating one, so we reuse the real party and createParty only
  // fires when the server truly has none. Otherwise we'd silently mint a
  // duplicate, non-default party and orphan the new person/pet into it.
  async function ensureParty(): Promise<TravelParty> {
    if (party) return party
    const existing = await usersApi.getDefaultParty()
    if (existing?.data) {
      const found = existing.data as TravelParty
      setParty(found)
      return found
    }
    const res = await usersApi.createParty({})
    const next = res.data as TravelParty
    setParty(next)
    return next
  }

  // ─── People ──────────────────────────────────────────────────────────────

  function startAddPerson() {
    setPersonDraft({ ...EMPTY_PERSON })
  }

  function startEditPerson(p: Person) {
    setPersonDraft({
      id: p.id,
      name: p.name ?? '',
      role: p.role,
    })
  }

  function cancelPersonDraft() {
    setPersonDraft(null)
  }

  async function savePerson() {
    if (!personDraft) return
    setSaving(true)
    setError(null)
    try {
      const target = await ensureParty()
      const payload = {
        name: personDraft.name.trim() || null,
        role: personDraft.role,
      }
      if (personDraft.id) {
        const res = await usersApi.updatePerson(target.id, personDraft.id, payload)
        setParty({
          ...target,
          people: target.people.map(p => p.id === personDraft.id ? res.data : p),
        })
      } else {
        const res = await usersApi.createPerson(target.id, payload)
        setParty({ ...target, people: [...target.people, res.data] })
      }
      setPersonDraft(null)
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not save this person. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  async function deletePerson(personId: string) {
    if (!party) return
    if (!confirm('Remove this person from your travel party?')) return
    setError(null)
    try {
      await usersApi.deletePerson(party.id, personId)
      setParty({ ...party, people: party.people.filter(p => p.id !== personId) })
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not remove this person. Please try again.')
    }
  }

  // ─── Pets ────────────────────────────────────────────────────────────────

  function startAddPet() {
    setPetDraft({ ...EMPTY_PET })
  }

  function startEditPet(p: Pet) {
    setPetDraft({
      id: p.id,
      type: p.type,
      name: p.name ?? '',
    })
  }

  function cancelPetDraft() {
    setPetDraft(null)
  }

  async function savePet() {
    if (!petDraft) return
    setSaving(true)
    setError(null)
    try {
      const target = await ensureParty()
      const payload = {
        type: petDraft.type,
        name: petDraft.name.trim() || null,
      }
      if (petDraft.id) {
        const res = await usersApi.updatePet(target.id, petDraft.id, payload)
        setParty({
          ...target,
          pets: target.pets.map(p => p.id === petDraft.id ? res.data : p),
        })
      } else {
        const res = await usersApi.createPet(target.id, payload)
        setParty({ ...target, pets: [...target.pets, res.data] })
      }
      setPetDraft(null)
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not save this pet. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  async function deletePet(petId: string) {
    if (!party) return
    if (!confirm('Remove this pet from your travel party?')) return
    setError(null)
    try {
      await usersApi.deletePet(party.id, petId)
      setParty({ ...party, pets: party.pets.filter(p => p.id !== petId) })
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not remove this pet. Please try again.')
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-4 max-w-2xl">
        <h1 className="text-xl font-medium text-gray-900">Travel Party</h1>
        <div className="card text-center py-10 text-sm text-gray-500">Loading…</div>
      </div>
    )
  }

  const people = party?.people ?? []
  const pets = party?.pets ?? []

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-xl font-medium text-gray-900">Travel Party</h1>
        <p className="mt-1 text-sm text-gray-500">
          Tell us who's coming along so we can tailor campgrounds, activities, and packing lists.
        </p>
      </div>

      {/* Save/delete failures surface here instead of being swallowed. Matches
          the red-bordered error card used on AdminDiagnosticsPage. */}
      {error && (
        <div className="card border border-red-200 bg-red-50/40 flex items-start gap-2">
          <AlertTriangle size={16} className="text-red-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* People ───────────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-gray-900 flex items-center gap-2">
            <UserIcon size={16} className="text-gray-500" />
            People
          </h2>
          <button
            onClick={startAddPerson}
            disabled={loading || !!personDraft}
            className="btn-primary flex items-center gap-1.5 text-sm disabled:opacity-50"
          >
            <Plus size={15} /> Add person
          </button>
        </div>

        <div className="space-y-2">
          {people.map(p => (
            <div key={p.id} className="card">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-medium text-gray-900 flex items-center gap-2">
                    {p.name?.trim() || <span className="text-gray-400">Unnamed</span>}
                    {p.isSelf && (
                      <span className="text-[11px] font-medium text-gray-500 bg-gray-100 rounded px-1.5 py-0.5">You</span>
                    )}
                  </p>
                  <p className="text-xs text-gray-500">{ROLE_LABELS[p.role]}</p>
                </div>
                <div className="flex items-center gap-1 ml-2">
                  <button
                    onClick={() => startEditPerson(p)}
                    disabled={!!personDraft}
                    title="Edit"
                    className="p-1.5 rounded-lg hover:bg-gray-100 disabled:opacity-50"
                  >
                    <Pencil size={14} className="text-gray-400" />
                  </button>
                  {/* The self-person can't be removed — it represents the account
                      holder and is the planner's source of truth (server also
                      rejects deleting it). Edit stays so "Me" can be renamed. */}
                  {!p.isSelf && (
                    <button
                      onClick={() => deletePerson(p.id)}
                      title="Remove"
                      className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
          {people.length === 0 && !personDraft && (
            <div className="card text-center py-8 text-sm text-gray-500">
              No people added yet. Add yourself and anyone traveling with you.
            </div>
          )}
        </div>

        {personDraft && (
          <div className="card-lg space-y-4">
            <h3 className="font-medium text-gray-900">
              {personDraft.id ? 'Edit person' : 'Add a person'}
            </h3>
            <div>
              <label className="label">Name</label>
              <input
                className="input"
                placeholder="First name"
                value={personDraft.name}
                onChange={e => setPersonDraft({ ...personDraft, name: e.target.value })}
              />
            </div>
            <div>
              <label className="label">Role</label>
              <select
                className="input"
                value={personDraft.role}
                onChange={e => setPersonDraft({ ...personDraft, role: e.target.value as PersonRole })}
              >
                {(Object.keys(ROLE_LABELS) as PersonRole[]).map(r => (
                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <button onClick={cancelPersonDraft} className="btn-ghost flex-1">Cancel</button>
              <button onClick={savePerson} disabled={saving || loading} className="btn-primary flex-1">
                {saving ? 'Saving…' : personDraft.id ? 'Save' : 'Add person'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Pets ─────────────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-gray-900 flex items-center gap-2">
            <PawPrint size={16} className="text-gray-500" />
            Pets
          </h2>
          <button
            onClick={startAddPet}
            disabled={loading || !!petDraft}
            className="btn-primary flex items-center gap-1.5 text-sm disabled:opacity-50"
          >
            <Plus size={15} /> Add pet
          </button>
        </div>

        <div className="space-y-2">
          {pets.map(p => (
            <div key={p.id} className="card">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-medium text-gray-900">
                    {p.name?.trim() || <span className="text-gray-400">Unnamed</span>}
                  </p>
                  <p className="text-xs text-gray-500">{PET_TYPE_LABELS[p.type]}</p>
                </div>
                <div className="flex items-center gap-1 ml-2">
                  <button
                    onClick={() => startEditPet(p)}
                    disabled={!!petDraft}
                    title="Edit"
                    className="p-1.5 rounded-lg hover:bg-gray-100 disabled:opacity-50"
                  >
                    <Pencil size={14} className="text-gray-400" />
                  </button>
                  <button
                    onClick={() => deletePet(p.id)}
                    title="Remove"
                    className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}
          {pets.length === 0 && !petDraft && (
            <div className="card text-center py-8 text-sm text-gray-500">
              No pets added yet.
            </div>
          )}
        </div>

        {petDraft && (
          <div className="card-lg space-y-4">
            <h3 className="font-medium text-gray-900">
              {petDraft.id ? 'Edit pet' : 'Add a pet'}
            </h3>
            {/* Type first per spec — required, no schema default. */}
            <div>
              <label className="label">Type</label>
              <select
                className="input"
                value={petDraft.type}
                onChange={e => setPetDraft({ ...petDraft, type: e.target.value as PetType })}
              >
                {(Object.keys(PET_TYPE_LABELS) as PetType[]).map(t => (
                  <option key={t} value={t}>{PET_TYPE_LABELS[t]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Name</label>
              <input
                className="input"
                placeholder="Pet's name"
                value={petDraft.name}
                onChange={e => setPetDraft({ ...petDraft, name: e.target.value })}
              />
            </div>
            <div className="flex gap-2">
              <button onClick={cancelPetDraft} className="btn-ghost flex-1">Cancel</button>
              <button onClick={savePet} disabled={saving || loading} className="btn-primary flex-1">
                {saving ? 'Saving…' : petDraft.id ? 'Save' : 'Add pet'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
