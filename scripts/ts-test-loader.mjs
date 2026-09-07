// Node ESM loader for running the repo's dependency-free TS assertion scripts WITHOUT
// tsx/esbuild (their Windows binaries cannot run from the Cowork Linux VM): resolves
// extensionless relative imports and transpiles .ts/.tsx with the project's own
// TypeScript (pure JS). Stubs utils/prisma (globalThis.__prismaStub or a throwing
// proxy) and utils/redis. Usage, from client/ or server/:
//   node --import ../scripts/ts-test-register.mjs src/.../x.test.ts
// (server tests also want RESEND_API_KEY / STRIPE_SECRET_KEY / JWT_SECRET dummies
// and TS_PATH=node_modules/typescript.) On Windows `npx tsx` remains the normal way.
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as presolve } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const ts = require(process.env.TS_PATH || new URL('../client/node_modules/typescript', import.meta.url).pathname)
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.(ts|tsx|js|mjs|cjs|json)$/.test(specifier) && context.parentURL) {
    const base = presolve(dirname(fileURLToPath(context.parentURL)), specifier)
    for (const c of [base + '.ts', base + '.tsx', base + '/index.ts']) if (existsSync(c)) return next(pathToFileURL(c).href, context)
  }
  return next(specifier, context)
}
export async function load(url, context, next) {
  // Test stubs: no DB engine here (Windows Prisma binary) and no Redis.
  if (/\/utils\/prisma\.ts$/.test(url)) return { format: 'module', source: 'export const prisma = globalThis.__prismaStub ?? new Proxy({}, { get: () => () => { throw new Error("prisma stubbed in tests") } })', shortCircuit: true }
  if (/\/utils\/redis\.ts$/.test(url)) return { format: 'module', source: 'export const getCache = async () => null; export const setCache = async () => {}; export default {}', shortCircuit: true }
  if (/\.tsx?$/.test(url)) {
    const src = readFileSync(fileURLToPath(url), 'utf8')
    const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: fileURLToPath(url) })
    return { format: 'module', source: out.outputText, shortCircuit: true }
  }
  return next(url, context)
}
