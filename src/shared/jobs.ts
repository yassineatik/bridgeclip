import type { RunDiagnostics } from './run-diagnostics'
import type { PipelineStage } from './job-progress'
import type { JobOutput } from './job-output'
import type { BannerPosition } from './job-contract'

/** Options for one clipping run, as the Create wizard submits them. */
export interface ClipJobRequest {
  workflow?: 'automatic' | 'review'
  videoUrl: string
  /** Missing on older queued requests; those retain the original quality mode. */
  clippingMode?: 'quality' | 'economy' | 'advanced'
  /** Required in Advanced mode; presets choose their own models. */
  plannerModel?: string
  transcriptionModel?: string
  /** What the user wants clipped, in their words. Omitted: the best moments. */
  clipRequest?: string
  maxClips: number | null
  autoClipCount: boolean
  durationRanges: string[] | null
  aspectRatio: string
  layoutStyle: string
  layoutVision: boolean
  pacing: string
  /** Export speed for every clip. Older requests default to normal speed. */
  videoSpeed?: number
  includeCaptions: boolean
  captionPreset: string
  /** Title card at the top of Automatic clips. Older requests default to shown. */
  includeTitle?: boolean
  startTimeSeconds: number | null
  endTimeSeconds: number | null
  /** One handle shown on every clip, e.g. @YassInPublic; null hides the banner. */
  bannerHandle: string | null
  /** Platforms whose icons precede the handle, canonical order. */
  bannerPlatforms: string[]
  /** Where the banner sits (see BANNER_POSITIONS). Older requests omit it: auto. */
  bannerPosition?: BannerPosition
  /**
   * Render again: the id (output folder name) of a finished run whose saved
   * transcript and clip plan are reused. Download-side research,
   * transcription, planning, Jev and vision are skipped, so nothing is
   * billed; `maxClips` keeps the first N planned clips (null: all). The
   * result is a new run.
   */
  rerenderFrom?: string
}

/** How many clipping runs the main process lets run at once; the rest wait in a queue. */
export const MAX_PARALLEL_JOBS = 2
/** Finished runs retained in the live session; older runs remain on disk. */
export const MAX_FINISHED_JOBS = 50

export type ActiveJobStatus = 'queued' | 'pending' | 'downloading' | 'contextualizing' | 'transcribing' | 'planning' | 'rendering' | 'uploading'
export type TerminalJobStatus = 'completed' | 'failed' | 'cancelled'
export type JobStatus = ActiveJobStatus | TerminalJobStatus

export const ACTIVE_JOB_STATUSES: readonly ActiveJobStatus[] = ['queued', 'pending', 'downloading', 'contextualizing', 'transcribing', 'planning', 'rendering', 'uploading']

export function isActiveJobStatus(status: string): status is ActiveJobStatus {
  return (ACTIVE_JOB_STATUSES as readonly string[]).includes(status)
}

/**
 * A job as the main process tracks it. The main process owns the list and
 * pushes a fresh snapshot on every change (`jobs:update`); `revision` only goes
 * up, so the renderer can drop a snapshot that arrives after a newer one.
 */
export interface JobSnapshot {
  id: string
  revision: number
  request: ClipJobRequest
  status: JobStatus
  percent: number
  stages?: PipelineStage[]
  diagnostics?: RunDiagnostics
  progressAt?: number
  step: string
  clipsDone: number
  clipsTotal: number
  error: string | null
  /** Suggested fix, when the main process can tell what went wrong. */
  errorHint: string | null
  failureCode?: string | null
  failureStage?: string | null
  httpStatus?: number | null
  output: JobOutput | null
  /** The run folder inside the output directory. */
  outputDir: string
  queuedAt: string
  startedAt: string | null
  finishedAt: string | null
}
