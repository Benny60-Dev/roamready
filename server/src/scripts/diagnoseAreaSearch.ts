/**
 * Diagnose searchCampgroundsByArea filter behavior.
 *
 * One-off — hits the live Google Places searchText endpoint with the same
 * query and FieldMask searchCampgroundsByArea uses, then locally re-applies
 * the keep/reject filter and reports which results would PASS vs FAIL and
 * why. Used to figure out why genuine KOAs / RV parks are getting dropped.
 *
 * Run with:  npm run diagnose:area-search
 */
import axios from 'axios'

const FIELD_MASK =
  'places.id,places.displayName,places.formattedAddress,places.internationalPhoneNumber,places.websiteUri,places.googleMapsUri,places.rating,places.userRatingCount,places.location,places.types'

// Mirror the production filter exactly so this diagnostic reflects what the
// orchestrator actually sees.
const KEEP_KEYWORDS = [
  'campground',
  'rv park',
  'rv resort',
  'koa',
  'campsite',
  'caravan park',
  'campgrounds',
]
const REJECT_TYPES = [
  'hotel',
  'motel',
  'resort_hotel',
  'bed_and_breakfast',
  'parking',
  'gas_station',
  'restaurant',
  'store',
  'supermarket',
]

interface FilterVerdict {
  pass: boolean
  reason: string
}

function applyFilter(place: any): FilterVerdict {
  const types: string[] = Array.isArray(place.types)
    ? place.types.map((t: string) => t.toLowerCase())
    : []
  const rejectHit = types.find(t => REJECT_TYPES.includes(t))
  if (rejectHit) {
    return { pass: false, reason: `REJECTED: types contains '${rejectHit}'` }
  }

  const displayName = String(place.displayName?.text ?? '').toLowerCase()
  const nameKeyword = KEEP_KEYWORDS.find(kw => displayName.includes(kw))
  const typeKeyword = KEEP_KEYWORDS.find(kw => {
    const underscore = kw.replace(/ /g, '_')
    return types.some(t => t === kw || t === underscore || t.includes(underscore))
  })

  if (nameKeyword) {
    return { pass: true, reason: `PASS: displayName contains '${nameKeyword}'` }
  }
  if (typeKeyword) {
    return { pass: true, reason: `PASS: types match keyword '${typeKeyword}'` }
  }
  return {
    pass: false,
    reason: `REJECTED: no keep-keyword match (types=[${types.join(', ')}])`,
  }
}

async function diagnoseLocation(locationName: string, locationState: string) {
  const textQuery = `campgrounds and RV parks near ${locationName}, ${locationState}`
  console.log('\n' + '='.repeat(80))
  console.log(`LOCATION: ${locationName}, ${locationState}`)
  console.log(`QUERY:    ${textQuery}`)
  console.log('='.repeat(80))

  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) {
    console.error('ERROR: GOOGLE_MAPS_API_KEY not set in env')
    return
  }

  let places: any[] = []
  try {
    const response = await axios.post(
      'https://places.googleapis.com/v1/places:searchText',
      { textQuery },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': FIELD_MASK,
        },
        timeout: 8000,
      },
    )
    places = response.data?.places ?? []
  } catch (err: any) {
    const status = err?.response?.status
    console.error(`ERROR: Places call failed (HTTP ${status ?? 'unknown'}):`, err?.response?.data ?? err?.message)
    return
  }

  console.log(`\nAPI returned ${places.length} place(s)\n`)

  if (places.length === 0) {
    console.log('(empty response)')
    return
  }

  let passCount = 0
  let failCount = 0
  places.forEach((place, idx) => {
    const verdict = applyFilter(place)
    const marker = verdict.pass ? '✅' : '❌'
    if (verdict.pass) passCount++
    else failCount++

    const name = place.displayName?.text ?? '(no name)'
    const types: string[] = Array.isArray(place.types) ? place.types : []
    const rating = typeof place.rating === 'number' ? place.rating.toFixed(1) : 'n/a'
    const reviewCount =
      typeof place.userRatingCount === 'number' ? `${place.userRatingCount} reviews` : 'no reviews'
    const address = place.formattedAddress ?? '(no address)'

    console.log(`${marker} [${idx + 1}] ${name}`)
    console.log(`     types:   [${types.join(', ')}]`)
    console.log(`     rating:  ${rating} (${reviewCount})`)
    console.log(`     address: ${address}`)
    console.log(`     verdict: ${verdict.reason}`)
    console.log('')
  })

  console.log(`Summary for ${locationName}, ${locationState}: ${passCount} pass, ${failCount} fail (of ${places.length} total)`)
}

async function main() {
  console.log('Diagnostic: searchCampgroundsByArea — filter behavior across 3 cities')
  console.log(`KEEP_KEYWORDS: [${KEEP_KEYWORDS.join(', ')}]`)
  console.log(`REJECT_TYPES:  [${REJECT_TYPES.join(', ')}]`)

  await diagnoseLocation('Lordsburg', 'NM')
  await diagnoseLocation('Tucson', 'AZ')
  await diagnoseLocation('Sedona', 'AZ')

  console.log('\n' + '='.repeat(80))
  console.log('DONE')
  console.log('='.repeat(80))
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
