import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register(new URL('./ts-test-loader.mjs', import.meta.url).href)
