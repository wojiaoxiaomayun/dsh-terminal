// Regression test: buildSessionEnv() must strip Volta's injected tool-image
// directories from PATH and clear Volta's internal env vars, so PTY children
// get a "fresh terminal" environment and per-project version switching works.
// Run: node tests/env-volta-path.mjs
import { delimiter } from 'node:path'
import { buildSessionEnv } from '../lib/index.js'

const winImage = 'C:\\Users\\u\\AppData\\Local\\Volta\\tools\\image\\node\\24.13.0'
const winShim = 'C:\\Program Files\\Volta'
const winPkgShim = 'C:\\Users\\u\\AppData\\Local\\Volta\\bin'
const winSystem = 'C:\\Windows\\system32'

// Build a PATH using the platform delimiter (':' on Unix, ';' on Windows).
const pathValue = [winImage, winShim, winPkgShim, winSystem].join(delimiter)

function assertClean(env, label) {
  const got = env.PATH ?? env.Path
  if (typeof got !== 'string') {
    console.error('FAIL', label, ': PATH key missing')
    return false
  }
  const segs = got.split(delimiter)
  const stillHasImage = segs.some((s) => /volta[\\/]tools[\\/]image/i.test(s))
  const keptShim = segs.includes(winShim)
  const keptPkgShim = segs.includes(winPkgShim)
  const keptSystem = segs.includes(winSystem)
  const cleared = ['_VOLTA_TOOL_RECURSION', 'VOLTA_TOOL_RECURSION', 'NODE_PATH']
    .every((k) => !(k in env))
  console.log(label, 'PATH:', got)
  const ok = !stillHasImage && keptShim && keptPkgShim && keptSystem && cleared
  if (!ok) {
    console.error('FAIL', label, { stillHasImage, keptShim, keptPkgShim, keptSystem, cleared })
  }
  return ok
}

const voltaInjected = {
  _VOLTA_TOOL_RECURSION: '1',
  VOLTA_TOOL_RECURSION: '1',
  NODE_PATH: 'C:\\Users\\u\\AppData\\Local\\Volta\\tools\\shared',
}

// Windows stores the var as "Path", Unix as "PATH" — cover both spellings.
const okUpper = assertClean(buildSessionEnv({ ...voltaInjected, PATH: pathValue }), '[PATH]')
const okMixed = assertClean(buildSessionEnv({ ...voltaInjected, Path: pathValue }), '[Path]')

console.log(okUpper && okMixed ? 'PASS: Volta image dirs + internal vars cleaned' : 'FAILED')
process.exit(okUpper && okMixed ? 0 : 1)
