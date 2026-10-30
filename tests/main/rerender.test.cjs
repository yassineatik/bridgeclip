'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function loadShared(file) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/shared', file), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(js, { module, exports: module.exports, require: (id) => id.startsWith('./') ? loadShared(id.slice(2) + '.ts') : require(id), URL })
  return module.exports
}
function loadSource(file, mocks = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/main', file), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  // One Error class across contexts, so `instanceof Error` in job-start sees errors thrown by security.ts.
  vm.runInNewContext(js, { module, exports: module.exports, require: (id) => mocks[id] ?? (id.startsWith('../shared/') ? loadShared(id.slice('../shared/'.length) + '.ts') : require(id)), URL, Set, Map, Error, process, Buffer, console, setTimeout, clearTimeout, __dirname: path.join(__dirname, '../../src/main') })
  return module.exports
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-rerender-'))
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }))
const outputDirectory = path.join(home, 'library')
const run = path.join(outputDirectory, 'earlier')
fs.mkdirSync(run, { recursive: true })
const source = path.join(home, 'Movies', 'episode.mp4')
fs.mkdirSync(path.dirname(source))
fs.writeFileSync(source, 'mp4')
fs.writeFileSync(path.join(run, 'transcript.json'), '{"segments":[]}')
fs.writeFileSync(path.join(run, 'plan.json'), '{"segments":[]}')
fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({ source_video_url: source }))

const security = loadSource('security.ts', { electron: {}, '../shared/brand': loadShared('brand.ts') })
const validation = loadSource('validation.ts', { './security': security })
const jobStart = loadSource('job-start.ts', {
  './settings-store': { loadSettings: () => ({ outputDirectory, openrouterApiKey: '' }) },
  './file-manager': {}, './pipeline-runner': {}, './run-history': {}, './job-manager': {},
  './logger': { logger: { info() {}, warn() {}, error() {} } },
  './security': security, './network-policy': {}, './validation': validation, './openrouter-models': {}, './tools': {}
})

const request = (overrides) => ({
  videoUrl: source, workflow: 'automatic', maxClips: 3, autoClipCount: false, includeCaptions: true, aspectRatio: '9:16',
  layoutStyle: 'auto', layoutVision: true, pacing: 'tight', captionPreset: 'pop', durationRanges: null,
  startTimeSeconds: null, endTimeSeconds: null, bannerHandle: null, bannerPlatforms: [], rerenderFrom: 'earlier', ...overrides
})

test('a re-render may clip the local file its run recorded, even outside the library', async () => {
  // Past the media check, the next stop is the missing-key check: that is as far as this harness goes.
  const result = await jobStart.startClipJobRequest(request({}))
  assert.match(result.error, /OpenRouter API key/)
  assert.equal(jobStart.recordedRerenderSource(outputDirectory, 'earlier'), source)
  assert.equal(jobStart.hasRerenderSources(outputDirectory, 'earlier'), true)
})

test('a re-render refuses any other source and a run without saved files', async () => {
  const other = path.join(home, 'Movies', 'other.mp4')
  fs.writeFileSync(other, 'mp4')
  assert.equal((await jobStart.startClipJobRequest(request({ videoUrl: other }))).error, 'Render again uses the source video this run was clipped from.')
  // Without a re-render, an outside-library file is refused as before (a fresh file: the first test authorized the recorded one).
  const unpicked = path.join(home, 'Movies', 'unpicked.mp4')
  fs.writeFileSync(unpicked, 'mp4')
  assert.equal((await jobStart.startClipJobRequest(request({ rerenderFrom: undefined, videoUrl: unpicked }))).error, 'Media file is outside the library')
  fs.mkdirSync(path.join(outputDirectory, 'bare'))
  fs.writeFileSync(path.join(outputDirectory, 'bare', 'job_output.json'), JSON.stringify({ source_video_url: source }))
  assert.equal((await jobStart.startClipJobRequest(request({ rerenderFrom: 'bare' }))).error, 'This run has no saved transcript and plan to render again.')
  assert.equal(jobStart.recordedRerenderSource(outputDirectory, 'missing'), null)
})
