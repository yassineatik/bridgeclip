import { normalizeVideoSource, twitchSourceError } from '../shared/video-source'
import { isAbsolute } from 'path'
import type { ClipJobConfig } from './pipeline-runner'
import { isWebUrl } from './security'
import { BANNER_PLATFORM_IDS, CLIP_REQUEST_MAX_CHARS, DURATION_IDS, canonicalBannerPlatforms, isBannerHandle, isBannerPosition, isVideoSpeed, normalizeBannerHandle, normalizeBannerPosition } from '../shared/job-contract'
import { isModelId } from '../shared/openrouter-models'
import type { ClipJobRequest } from '../shared/jobs'

// Trims what Python's str.strip() also treats as whitespace (\x1c-\x1f, \x85),
// so the bridge never receives a request it considers blank.
// eslint-disable-next-line no-control-regex
const CLIP_REQUEST_EDGES = /^[\s\u001c-\u001f\u0085]+|[\s\u001c-\u001f\u0085]+$/g
const trimClipRequest = (text: string): string => text.replace(CLIP_REQUEST_EDGES, '')

export function validateJobConfig(value: unknown): ClipJobConfig {
  if (!value || typeof value !== 'object') throw new Error('Invalid job options')
  const v = value as ClipJobConfig
  if (typeof v.videoUrl !== 'string' || v.videoUrl.length > 8192 || !(isWebUrl(v.videoUrl) || isAbsolute(v.videoUrl))) throw new Error('Choose a video file or an HTTP(S) URL')
  const sourceError = twitchSourceError(v.videoUrl)
  if (sourceError) throw new Error(sourceError)
  if (typeof v.autoClipCount !== 'boolean' || typeof v.includeCaptions !== 'boolean') throw new Error('Invalid job options')
  if (typeof v.layoutVision !== 'boolean') throw new Error('Invalid vision option')
  if (v.includeTitle !== undefined && typeof v.includeTitle !== 'boolean') throw new Error('Invalid title option')
  if (v.clipRequest !== undefined && (typeof v.clipRequest !== 'string' || v.clipRequest.includes('\0') || trimClipRequest(v.clipRequest).length > CLIP_REQUEST_MAX_CHARS)) throw new Error(`Describe what to clip in ${CLIP_REQUEST_MAX_CHARS} characters or fewer`)
  if (v.videoSpeed !== undefined && !isVideoSpeed(v.videoSpeed)) throw new Error('Video speed must be between 1× and 2×')
  if (v.workflow !== undefined && !['automatic', 'review'].includes(v.workflow)) throw new Error('Invalid workflow')
  if (v.clippingMode !== undefined && !['quality', 'economy', 'advanced'].includes(v.clippingMode)) throw new Error('Invalid clipping mode')
  if (v.clippingMode === 'advanced' && (!isModelId(v.plannerModel) || !isModelId(v.transcriptionModel))) throw new Error('Choose both models in Advanced mode')
  if (v.clippingMode !== 'advanced' && (v.plannerModel !== undefined || v.transcriptionModel !== undefined)) throw new Error('Custom models require Advanced mode')
  if (v.maxClips !== null && (!Number.isInteger(v.maxClips) || v.maxClips < 1 || v.maxClips > 100)) throw new Error('Clip count must be between 1 and 100')
  for (const [key, allowed] of Object.entries({ aspectRatio: ['9:16', '16:9'], layoutStyle: ['auto', 'fill', 'fit'], pacing: ['tight', 'natural'] })) {
    if (!allowed.includes(v[key as keyof ClipJobConfig] as string)) throw new Error(`Invalid ${key}`)
  }
  if (typeof v.captionPreset !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(v.captionPreset)) throw new Error('Invalid caption preset')
  if (v.durationRanges !== null && (!Array.isArray(v.durationRanges) || v.durationRanges.length > DURATION_IDS.length || v.durationRanges.some((item) => !DURATION_IDS.includes(item)))) throw new Error('Invalid clip duration')
  for (const time of [v.startTimeSeconds, v.endTimeSeconds]) {
    if (time !== null && (typeof time !== 'number' || !Number.isFinite(time) || time < 0)) throw new Error('Invalid trim time')
  }
  if (v.endTimeSeconds !== null && v.endTimeSeconds <= (v.startTimeSeconds ?? 0)) throw new Error('Trim end must follow trim start')
  // Requests stored before the banner had a handle carry neither field.
  const rawHandle = v.bannerHandle ?? null
  const rawPlatforms = v.bannerPlatforms === undefined ? [] : v.bannerPlatforms
  if (rawHandle !== null && (typeof rawHandle !== 'string' || !isBannerHandle(rawHandle))) throw new Error('Use letters, numbers, dots, underscores or dashes in the handle')
  if (!Array.isArray(rawPlatforms) || rawPlatforms.some((platform) => !BANNER_PLATFORM_IDS.includes(platform)) || new Set(rawPlatforms).size !== rawPlatforms.length) throw new Error('Invalid banner platforms')
  const bannerHandle = rawHandle === null ? null : normalizeBannerHandle(rawHandle)
  const bannerPlatforms = bannerHandle ? canonicalBannerPlatforms(rawPlatforms) : []
  if (v.bannerPosition !== undefined && !isBannerPosition(v.bannerPosition)) throw new Error('Invalid banner position')
  const bannerPosition = bannerHandle ? normalizeBannerPosition(v.bannerPosition ?? 'auto') : v.bannerPosition === undefined ? undefined : normalizeBannerPosition(v.bannerPosition)
  if (v.rerenderFrom !== undefined && (typeof v.rerenderFrom !== 'string' || !RUN_ID.test(v.rerenderFrom))) throw new Error('Invalid run to render again')
  if (v.rerenderFrom !== undefined && v.workflow !== undefined && v.workflow !== 'automatic') throw new Error('Render again only works with the Automatic workflow')
  // A re-render reuses the run's saved plan: nothing that steers planning or vision applies.
  const rerender: Partial<ClipJobConfig> = v.rerenderFrom === undefined ? {} : {
    workflow: 'automatic', clipRequest: undefined, durationRanges: null, startTimeSeconds: null, endTimeSeconds: null, layoutVision: false
  }
  // Capabilities are looked up in main after validation, never accepted from the renderer.
  const clipRequest = v.clipRequest === undefined ? undefined : trimClipRequest(v.clipRequest) || undefined
  // Only known fields continue: a misspelled option must not ride along in the job record.
  const known = Object.fromEntries(JOB_REQUEST_FIELDS.filter((key) => v[key] !== undefined).map((key) => [key, v[key]])) as unknown as ClipJobConfig
  return { ...known, videoUrl: normalizeVideoSource(v.videoUrl), videoSpeed: v.videoSpeed ?? 1, includeTitle: v.includeTitle ?? true, clipRequest, bannerHandle, bannerPlatforms, bannerPosition, ...rerender, plannerCapabilities: undefined }
}

/** A run's output folder name; no separators, so it can never leave the output directory. */
const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/

const JOB_REQUEST_FIELDS: readonly (keyof ClipJobRequest)[] = [
  'workflow', 'videoUrl', 'clippingMode', 'plannerModel', 'transcriptionModel', 'clipRequest', 'maxClips', 'autoClipCount',
  'durationRanges', 'aspectRatio', 'layoutStyle', 'layoutVision', 'pacing', 'videoSpeed', 'includeCaptions', 'captionPreset',
  'includeTitle', 'startTimeSeconds', 'endTimeSeconds', 'bannerHandle', 'bannerPlatforms', 'bannerPosition', 'rerenderFrom'
]
