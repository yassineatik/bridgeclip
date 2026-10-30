import { randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { loadSettings } from './settings-store'
import { ensureOutputDir } from './file-manager'
import { getBridgeRunnerPath, getEnginePath, preflightCheck, resolvePythonPath, validatePython, type ClipJobConfig } from './pipeline-runner'
import { createRunRecord, finishRunRecord } from './run-history'
import { enqueueJob } from './job-manager'
import { logger } from './logger'
import { assertMediaPath, authorizeMedia, isWebUrl } from './security'
import { assertPublicWebUrl } from './network-policy'
import { validateJobConfig } from './validation'
import { resolveAdvancedModels } from './openrouter-models'
import { supportsCaptionFilter } from './tools'
import type { JobSnapshot } from '../shared/jobs'

/** A passing engine check is reused briefly, so queuing several videos stays quick. */
const ENGINE_CHECK_TTL_MS = 5 * 60 * 1000
let lastEngineCheck: { key: string; at: number } | null = null

export type StartJobResult = { jobId: string; queued: boolean; job: JobSnapshot } | { error: string }

/** The run folder keeps what a re-render reuses (validation already bounds the id to one folder name). */
export function hasRerenderSources(outputDirectory: string, runId: string): boolean {
  const run = join(outputDirectory, runId)
  return existsSync(join(run, 'transcript.json')) && existsSync(join(run, 'plan.json'))
}

/** The source video a finished run was clipped from, as its job_output.json records it; null when unreadable. */
export function recordedRerenderSource(outputDirectory: string, runId: string): string | null {
  try {
    const output = JSON.parse(readFileSync(join(outputDirectory, runId, 'job_output.json'), 'utf8')) as { source_video_url?: unknown }
    return typeof output.source_video_url === 'string' && output.source_video_url ? output.source_video_url : null
  } catch {
    return null
  }
}

/**
 * Validate a clipping request, check the engine and keys, create its run
 * folder and queue it. Used by the Create page and the assistant alike; it
 * needs no window, so jobs can start while every window is closed.
 */
export async function startClipJobRequest(request: unknown): Promise<StartJobResult> {
  let config: ClipJobConfig
  try {
    config = validateJobConfig(request)
    if (config.clippingMode === 'advanced') {
      config.plannerCapabilities = await resolveAdvancedModels(config.plannerModel!, config.transcriptionModel!)
    }
    if (config.rerenderFrom !== undefined) {
      // A re-render clips the run's own source again. A local file outside
      // the library is allowed only when it is the file that run recorded.
      if (config.videoUrl !== recordedRerenderSource(loadSettings().outputDirectory, config.rerenderFrom)) {
        return { error: 'Render again uses the source video this run was clipped from.' }
      }
      if (!isWebUrl(config.videoUrl)) authorizeMedia(config.videoUrl)
    }
    if (isWebUrl(config.videoUrl)) await assertPublicWebUrl(config.videoUrl)
    else assertMediaPath(config.videoUrl, loadSettings().outputDirectory)
  } catch (error) { return { error: error instanceof Error ? error.message : 'Invalid job options' } }
  const settings = loadSettings()

  if (config.rerenderFrom !== undefined && !hasRerenderSources(settings.outputDirectory, config.rerenderFrom)) {
    return { error: 'This run has no saved transcript and plan to render again.' }
  }
  // A re-render reuses the saved transcript and plan, so it spends no credit,
  // but the engine still builds its provider services from the key.
  if (!settings.openrouterApiKey) {
    logger.warn('job.start.missingKey', { key: 'OPENROUTER_API_KEY' })
    return { error: 'OpenRouter API key is required for AI clip planning. Go to Settings to add it.' }
  }

  const enginePath = getEnginePath()
  const bridgePath = getBridgeRunnerPath()
  const pythonPath = resolvePythonPath(enginePath, settings.pythonPath)

  const preflight = preflightCheck({ pythonPath, bridgePath, enginePath })
  if (!preflight.ok) {
    const message = preflight.hint
      ? `${preflight.error}\n\n${preflight.hint}`
      : preflight.error!
    logger.error('job.start.preflight.failed', {
      error: preflight.error,
      hint: preflight.hint,
      pythonPath,
      bridgePath,
      enginePath
    })
    return { error: message }
  }
  const engineKey = `${pythonPath}\0${enginePath}`
  if (!lastEngineCheck || lastEngineCheck.key !== engineKey || Date.now() - lastEngineCheck.at > ENGINE_CHECK_TTL_MS) {
    const pythonValidation = await validatePython(pythonPath, enginePath)
    if (!pythonValidation.ok) {
      lastEngineCheck = null
      return { error: 'The clipping engine is incomplete or incompatible. Open Settings → System check, then repair the BridgeClip installation before starting.' }
    }
    lastEngineCheck = { key: engineKey, at: Date.now() }
  }
  if (config.includeCaptions && !(await supportsCaptionFilter())) {
    return { error: 'FFmpeg cannot render captions because its ass filter is missing. Install an FFmpeg build with libass, or turn captions off.' }
  }

  ensureOutputDir(settings.outputDirectory)

  const jobId = randomUUID()
  logger.info('job.start.request', { jobId, sourceType: isWebUrl(config.videoUrl) ? 'remote' : 'local', aspectRatio: config.aspectRatio })
  try {
    createRunRecord(settings.outputDirectory, jobId, config.videoUrl)
  } catch {
    try { finishRunRecord(settings.outputDirectory, jobId, 'failed', 'Could not start this run.') } catch { /* Output folder may be unavailable. */ }
    return { error: 'Could not create the clipping run. Check the output folder and retry.' }
  }
  // Starts now when a slot is free; otherwise waits its turn in the queue.
  const job = enqueueJob(jobId, config, settings.outputDirectory)
  return { jobId, queued: job.status === 'queued', job }
}
