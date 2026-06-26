/**
 * BUG-MILEAGE-OPENING-TURN — proof that the always-on mileage rule renders in the
 * high-salience uncached suffix on a NORMAL (non-surprise) planning turn, where the
 * critical-rules block used to be empty.
 *
 * Run: npx tsx src/services/__tests__/criticalRulesBlock.proof.ts
 *
 * Imports the REAL exported MILEAGE_HONESTY_RULE and reproduces the exact assembly
 * expression from chatWithAI for the opening "KC to Bangor" turn:
 *   recentSurpriseDestinations = []  (no surprise context)
 *   surpriseVibe                = undefined
 *   → criticalRulesParts = []  → surpriseRulesBlock = ''
 *   → criticalRulesBlock = surpriseRulesBlock + MILEAGE_HONESTY_RULE
 */
import { MILEAGE_HONESTY_RULE } from '../ai'

// --- exact assembly logic from chatWithAI, for the non-surprise opening turn ---
const recentSurpriseDestinations: string[] = []
const surpriseVibe: string | undefined = undefined

const criticalRulesParts: string[] = []
if (recentSurpriseDestinations.length > 0) criticalRulesParts.push('«surprise exclusion»')
if (surpriseVibe) criticalRulesParts.push('«surprise vibe»')

const surpriseRulesBlock = criticalRulesParts.length > 0
  ? `## CRITICAL RULES FOR THIS REQUEST\n\n${criticalRulesParts.join('\n\n')}\n\n---\n\n`
  : ''
const criticalRulesBlock = surpriseRulesBlock + MILEAGE_HONESTY_RULE

// stand-in for the always-present dynamicContext that follows it in the suffix
const dynamicContext = '=== CURRENT REQUEST CONTEXT ===\n\nToday is 2026-06-26.\nUser profile: {…}'
const assembledSuffix = criticalRulesBlock + dynamicContext

console.log('surpriseRulesBlock empty? ', surpriseRulesBlock === '')
console.log('criticalRulesBlock empty? ', criticalRulesBlock === '')
console.log('criticalRulesBlock length:', criticalRulesBlock.length)
console.log('contains mileage sub-header? ', criticalRulesBlock.includes('### Distances and times'))
console.log('contains forbidden-mileage example? ', criticalRulesBlock.includes('1,600 miles one-way'))
console.log('contains geography carve-out? ', criticalRulesBlock.includes('ENCOURAGED'))
console.log('\n================ ASSEMBLED UNCACHED SUFFIX (non-surprise opening turn) ================\n')
console.log(assembledSuffix)

const ok = surpriseRulesBlock === '' && criticalRulesBlock.length > 0 &&
  criticalRulesBlock.includes('### Distances and times')
console.log('\nRESULT:', ok ? 'PASS — rule present where the block was previously empty' : 'FAIL')
if (!ok) process.exit(1)
