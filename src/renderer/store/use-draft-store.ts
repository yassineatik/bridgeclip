import { create } from 'zustand'
import { BANNER_HANDLE_MAX_CHARS, canonicalBannerPlatforms, isBannerPosition, normalizeBannerPosition, type BannerPosition } from '../../shared/job-contract'

const BANNER_STORAGE_KEY = 'bridgeclip.banner'

/** The last channel banner, remembered across launches. */
function readBanner(): { bannerHandle: string; bannerPlatforms: string[]; bannerPosition: BannerPosition } {
  try {
    const saved = JSON.parse(localStorage.getItem(BANNER_STORAGE_KEY) ?? 'null') as { handle?: unknown; platforms?: unknown; position?: unknown } | null
    return {
      bannerHandle: typeof saved?.handle === 'string' ? saved.handle.slice(0, BANNER_HANDLE_MAX_CHARS) : '',
      bannerPlatforms: Array.isArray(saved?.platforms) ? canonicalBannerPlatforms(saved.platforms.filter((p): p is string => typeof p === 'string')) : [],
      bannerPosition: isBannerPosition(saved?.position) ? normalizeBannerPosition(saved.position) : 'auto'
    }
  } catch {
    return { bannerHandle: '', bannerPlatforms: [], bannerPosition: 'auto' }
  }
}

function saveBanner(handle: string, platforms: string[], position: BannerPosition): void {
  try {
    localStorage.setItem(BANNER_STORAGE_KEY, JSON.stringify({ handle, platforms, position }))
  } catch {
    // Only a convenience; the banner starts blank next time.
  }
}

/** The Create wizard's steps, in order. */
export type WizardStep = 'video' | 'format' | 'clips' | 'captions' | 'review'

/** The run the wizard just queued, shown as a confirmation until the next video. */
export interface StartedJob {
  jobId: string
  source: string
  /** True when every slot was busy and the job is waiting its turn. */
  queued: boolean
}

/**
 * The Create form, kept outside the component so the chosen video and options
 * survive navigating away (e.g. to Settings to add a key) and a failed run.
 */
export interface ClipDraft {
  workflow: 'automatic' | 'review' | null
  source: string
  clippingMode: 'quality' | 'economy' | 'advanced'
  plannerModel: string
  transcriptionModel: string
  aspectRatio: '9:16' | '16:9'
  /** 9:16 framing: smart per-shot layouts, always full frame, or letterbox. */
  layoutStyle: 'auto' | 'fill' | 'fit'
  /** Paid vision verification for ambiguous shots in Smart framing. */
  layoutVision: boolean
  /** tight: cut dead air and filler words; natural: original timing. */
  pacing: 'tight' | 'natural'
  videoSpeed: number
  /** Optional description of the moments to clip; blank finds the best ones. */
  clipRequest: string
  durations: string[]
  autoClipCount: boolean
  maxClips: number
  includeCaptions: boolean
  captionPreset: string
  /** Automatic clips: the title card at the top of each clip. */
  includeTitle: boolean
  trimOpen: boolean
  trimStart: string
  trimEnd: string
  /** Channel banner on every clip: one handle (e.g. @YassInPublic) and the platforms whose icons precede it. Blank hides it. */
  bannerHandle: string
  bannerPlatforms: string[]
  /** Where the banner sits; Mixed varies it per clip. */
  bannerPosition: BannerPosition
  /** Render again: the finished run whose saved transcript and plan this draft reuses (first `maxClips` of `clipCount`). */
  rerenderFrom: RerenderSource | null
}

/** A finished run the wizard re-renders for free. */
export interface RerenderSource {
  /** The run's output folder name. */
  jobId: string
  title: string
  /** Planned clips the run has; the draft renders the first `maxClips` of them. */
  clipCount: number
}

/** How many planned clips a re-render keeps unless the user changes it: enough to judge a change. */
export const RERENDER_DEFAULT_CLIPS = 3

interface DraftState extends ClipDraft {
  step: WizardStep
  started: StartedJob | null
  update: (patch: Partial<ClipDraft>) => void
  setStep: (step: WizardStep) => void
  clearSource: () => void
  /** The job was queued: show the confirmation. */
  markStarted: (started: StartedJob) => void
  /** Start a new video with no workflow selected, keeping output preferences (not the video-specific clip request). */
  startAnother: () => void
  /** Re-render a finished run: its source, automatic workflow, a few clips, starting on the Format step. */
  startRerender: (run: RerenderSource & { source: string }) => void
}

export const useDraftStore = create<DraftState>((set, get) => ({
  ...readBanner(),
  workflow: null,
  source: '',
  clippingMode: 'quality',
  plannerModel: '',
  transcriptionModel: '',
  aspectRatio: '9:16',
  layoutStyle: 'auto',
  layoutVision: true,
  pacing: 'tight',
  videoSpeed: 1,
  clipRequest: '',
  durations: ['short'],
  autoClipCount: true,
  maxClips: 5,
  includeCaptions: true,
  captionPreset: 'pop',
  includeTitle: true,
  trimOpen: false,
  trimStart: '',
  trimEnd: '',
  rerenderFrom: null,
  step: 'video',
  started: null,
  update: (patch) => {
    set(patch)
    if ('bannerHandle' in patch || 'bannerPlatforms' in patch || 'bannerPosition' in patch) {
      const { bannerHandle, bannerPlatforms, bannerPosition } = get()
      saveBanner(bannerHandle, bannerPlatforms, bannerPosition)
    }
  },
  setStep: (step) => set({ step }),
  clearSource: () => set({ source: '', trimStart: '', trimEnd: '', rerenderFrom: null }),
  markStarted: (started) => set({ started }),
  startAnother: () => set({ workflow: null, source: '', clipRequest: '', trimOpen: false, trimStart: '', trimEnd: '', rerenderFrom: null, step: 'video', started: null }),
  startRerender: ({ source, ...run }) => set({
    workflow: 'automatic', source, clipRequest: '', trimOpen: false, trimStart: '', trimEnd: '', started: null,
    rerenderFrom: run, autoClipCount: false, maxClips: Math.max(1, Math.min(RERENDER_DEFAULT_CLIPS, run.clipCount)), step: 'format'
  })
}))
