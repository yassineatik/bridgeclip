import { normalizeVideoSource, twitchSourceError } from '../../shared/video-source'
import { useEffect, useMemo, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Clock3, ListVideo, Minus, Plus, RotateCcw, Sparkles } from 'lucide-react'
import { cn, MOD_KEY, parseTimecode, sourceLabel } from '../lib/utils'
import { useDraftStore, type ClipDraft, type RerenderSource, type WizardStep } from '../store/use-draft-store'
import { useActiveJobs } from '../store/use-job-store'
import type { ClipJobRequest } from '../../shared/jobs'
import { MAX_PARALLEL_JOBS } from '../../shared/jobs'
import { CaptionPresetPicker, CAPTION_PRESET_NAMES } from './CaptionPresetPicker'
import { SourcePicker } from './SourcePicker'
import { Panel } from './ui/Panel'
import { Switch } from './ui/Switch'
import { Checkbox } from './ui/Checkbox'
import { Button } from './ui/Button'
import { TextArea, TextInput } from './ui/Field'
import { IconTile } from './ui/IconTile'
import { SettingRow } from './ui/SettingRow'
import { onRadioKeyDown } from './ui/Segmented'
import { BANNER_GRID_POSITION_IDS, BANNER_HANDLE_MAX_CHARS, BANNER_PLATFORMS, CLIP_REQUEST_MAX_CHARS, DURATION_OPTIONS, VIDEO_SPEED_OPTIONS, bannerPositionLabel, canonicalBannerPlatforms, isBannerHandle, normalizeBannerHandle, type BannerPosition } from '../../shared/job-contract'
import { isModelId } from '../../shared/openrouter-models'
import { useModelStore } from '../store/use-model-store'
import { useSettingsStore } from '../store/use-settings-store'
import { ModelPicker } from './ModelPicker'
import { WorkflowPicker } from './WorkflowPicker'

const DURATIONS = DURATION_OPTIONS

const FORMATS = [
  { id: '9:16', label: 'Vertical', hint: 'Shorts, Reels, TikTok', w: 12, h: 21 },
  { id: '16:9', label: 'Horizontal', hint: 'YouTube, X, LinkedIn', w: 24, h: 14 }
] as const

const LAYOUT_STYLES = [
  { id: 'auto', label: 'Smart', hint: 'Auto frames each shot' },
  { id: 'fill', label: 'Full frame', hint: 'Follows the speaker' },
  { id: 'fit', label: 'Classic', hint: 'Whole frame, blurred' }
] as const

const MAX_CLIPS = 100

export const WIZARD_STEPS: { id: WizardStep; label: string; title: string; description: string }[] = [
  { id: 'video', label: 'Video', title: 'Choose a video', description: 'A local file, YouTube link or Twitch VOD link. Optionally suggest where to find clips.' },
  { id: 'format', label: 'Format', title: 'Format, framing and speed', description: 'Choose the look and pace of every clip in this job.' },
  { id: 'clips', label: 'Clips', title: 'What to clip, length and count', description: 'Optionally describe the moments you want. Pick one or more lengths, or none for any length.' },
  { id: 'captions', label: 'Captions', title: 'Captions', description: 'Word-by-word captions burned into each clip. Silent videos are clipped without them.' },
  { id: 'review', label: 'Review', title: 'Review and generate', description: 'Check the run, then generate. You can queue another video right after.' }
]

export function parseTrimRange(enabled: boolean, startText: string, endText: string): {
  start: number | null
  end: number | null
  error: string | null
} {
  const start = enabled ? parseTimecode(startText) : null
  const end = enabled ? parseTimecode(endText) : null
  let error: string | null = null
  if (Number.isNaN(start) || Number.isNaN(end)) error = 'Use seconds (90) or a timecode (1:30).'
  else if (end != null && end <= (start ?? 0)) error = 'End must be after the start.'
  return { start, end, error }
}

/** Why the channel handle can't be used, or null when blank or valid. */
export function bannerHandleError(handle: string): string | null {
  return handle.trim() && !isBannerHandle(handle) ? 'Use letters, numbers, dots, underscores or dashes.' : null
}

/** The run request for the current draft. */
export function buildJobRequest(draft: ClipDraft, trim: { start: number | null; end: number | null }): ClipJobRequest {
  if (!draft.workflow) throw new Error('Choose a workflow before creating clips.')
  const bannerHandle = normalizeBannerHandle(draft.bannerHandle ?? '')
  const rerender = draft.rerenderFrom ?? null
  if (rerender) {
    // A re-render keeps the run's saved plan: no planning options, no paid vision checks.
    return {
      videoUrl: normalizeVideoSource(draft.source),
      workflow: 'automatic',
      clippingMode: draft.clippingMode,
      ...(draft.clippingMode === 'advanced' ? { plannerModel: draft.plannerModel, transcriptionModel: draft.transcriptionModel } : {}),
      maxClips: draft.autoClipCount ? null : Math.min(draft.maxClips, rerender.clipCount),
      autoClipCount: draft.autoClipCount,
      durationRanges: null,
      aspectRatio: draft.aspectRatio,
      layoutStyle: draft.layoutStyle,
      layoutVision: false,
      pacing: draft.pacing,
      videoSpeed: draft.videoSpeed ?? 1,
      includeCaptions: draft.includeCaptions,
      captionPreset: draft.captionPreset,
      includeTitle: draft.includeTitle,
      startTimeSeconds: null,
      endTimeSeconds: null,
      bannerHandle,
      bannerPlatforms: bannerHandle ? canonicalBannerPlatforms(draft.bannerPlatforms ?? []) : [],
      ...(bannerHandle ? { bannerPosition: draft.bannerPosition ?? 'auto' } : {}),
      rerenderFrom: rerender.jobId
    }
  }
  return {
    videoUrl: normalizeVideoSource(draft.source),
    workflow: draft.workflow,
    clippingMode: draft.clippingMode,
    ...(draft.clippingMode === 'advanced' ? { plannerModel: draft.plannerModel, transcriptionModel: draft.transcriptionModel } : {}),
    ...(draft.clipRequest?.trim() ? { clipRequest: draft.clipRequest.trim() } : {}),
    maxClips: draft.autoClipCount ? null : draft.maxClips,
    autoClipCount: draft.autoClipCount,
    durationRanges: draft.durations.length > 0 ? draft.durations : null,
    aspectRatio: draft.aspectRatio,
    layoutStyle: draft.layoutStyle,
    layoutVision: draft.clippingMode !== 'economy' && draft.aspectRatio === '9:16' && draft.layoutStyle === 'auto' && draft.layoutVision,
    pacing: draft.pacing,
    videoSpeed: draft.videoSpeed ?? 1,
    includeCaptions: draft.includeCaptions,
    captionPreset: draft.captionPreset,
    includeTitle: draft.includeTitle,
    startTimeSeconds: trim.start,
    endTimeSeconds: trim.end,
    bannerHandle,
    bannerPlatforms: bannerHandle ? canonicalBannerPlatforms(draft.bannerPlatforms ?? []) : [],
    ...(bannerHandle ? { bannerPosition: draft.bannerPosition ?? 'auto' } : {})
  }
}

interface JobFormProps {
  onSubmit: (config: ClipJobRequest) => void
  /** Opens a queued job on the Jobs page. */
  onViewJob?: (jobId: string) => void
  /** Why the job can't start yet (missing keys, tools); disables submit. */
  blockedReason?: ReactNode
  submitting?: boolean
  className?: string
}

type Update = (patch: Partial<ClipDraft>) => void

/**
 * The Create wizard: Video → Format → Clips → Captions → Review. Each step is
 * one compact panel with Back/Next pinned below it. After Generate the job is
 * queued and the wizard offers the next video, so several runs can go at once.
 */
export function JobForm({ onSubmit, onViewJob, blockedReason, submitting, className }: JobFormProps): React.JSX.Element {
  const draft = useDraftStore()
  const { update, step, setStep } = draft

  const trim = useMemo(
    () => parseTrimRange(draft.trimOpen, draft.trimStart, draft.trimEnd),
    [draft.trimOpen, draft.trimStart, draft.trimEnd]
  )

  const index = WIZARD_STEPS.findIndex((s) => s.id === step)
  const meta = WIZARD_STEPS[index]
  const rerender = draft.rerenderFrom
  const sourceError = rerender ? null : twitchSourceError(draft.source)
  const hasSource = Boolean(draft.source.trim()) && !sourceError
  const videoValid = rerender ? hasSource : hasSource && draft.workflow !== null && !trim.error
  const modelsValid = draft.clippingMode !== 'advanced' || (isModelId(draft.plannerModel) && isModelId(draft.transcriptionModel))
  const bannerValid = bannerHandleError(draft.bannerHandle) === null
  const stepValid = videoValid && (step !== 'clips' || modelsValid) && (step !== 'captions' || bannerValid)
  const canSubmit = videoValid && modelsValid && bannerValid && !blockedReason && !submitting && !draft.started

  const submit = (): void => {
    if (canSubmit) onSubmit(buildJobRequest(draft, trim))
  }

  // ⌘↵ / Ctrl+↵ generates only once a video and workflow are chosen.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        submit()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  if (draft.started) {
    return <StartedPanel className={className} onViewJob={onViewJob} />
  }

  const goTo = (target: WizardStep): void => {
    setStep(target)
    document.getElementById('page-scroll')?.scrollTo({ top: 0 })
  }
  const next = WIZARD_STEPS[index + 1]
  const back = WIZARD_STEPS[index - 1]

  return (
    <div className={cn('space-y-3', className)}>
      <Stepper current={step} reachable={videoValid ? WIZARD_STEPS.length - 1 : 0} onSelect={goTo} />

      {step === 'captions' && draft.workflow === 'review' && (
        <aside aria-labelledby="caption-editor-note" className="rounded-2xl border border-accent/20 bg-accent/5 p-4 xl:p-5">
          <span className="eyebrow text-accent">Review &amp; edit</span>
          <h2 id="caption-editor-note" className="mt-1.5 text-sm font-semibold text-ink">Adjust captions in the editor</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            Choose a starting style below. Before exporting, you can change how captions look, reposition them, or hide them from selected parts of each clip.
          </p>
        </aside>
      )}

      <Panel className="p-4 xl:p-5">
        {step !== 'video' && <div className="mb-3">
          <h2 className="text-sm font-semibold text-ink">{step === 'review' && draft.workflow === 'review' ? 'Ready to find candidates' : meta.title}</h2>
          <p className="mt-0.5 text-xs text-ink-muted">{step === 'review' && draft.workflow === 'review' ? 'Jev reviews each candidate before the editor opens for your final cut.' : meta.description}</p>
        </div>}
        {sourceError && <p role="alert" className="text-sm text-danger">{sourceError}</p>}
        {step === 'video' && (rerender
          ? <RerenderNotice run={rerender} onStartOver={draft.startAnother} />
          : <VideoStep draft={draft} update={update} trimError={trim.error} disabled={submitting} />)}
        {step === 'format' && <FormatStep draft={draft} update={update} />}
        {step === 'clips' && <ClipsStep draft={draft} update={update} />}
        {step === 'captions' && <CaptionsStep draft={draft} update={update} />}
        {step === 'review' && <ReviewStep draft={draft} trim={trim} onEdit={goTo} />}
      </Panel>

      {/* Actions stay pinned to the bottom edge on a solid strip. */}
      <div className="sticky bottom-0 z-10 -mb-3 flex items-center gap-3 bg-canvas pb-3 pt-2">
        {back ? (
          <Button variant="ghost" icon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={() => goTo(back.id)}>
            Back
          </Button>
        ) : <span />}
        <p className="min-w-0 flex-1 truncate text-center text-2xs text-ink-subtle">
          {blockedReason ?? (!draft.workflow ? 'Choose a workflow to continue.' : !modelsValid ? 'Choose both models in Advanced mode.' : !bannerValid ? 'Fix the channel handle to continue.' : step === 'video' && !hasSource ? 'Add a video to continue.' : `${MOD_KEY}↵ generates from any step`)}
        </p>
        {next && step !== 'review' ? (
          <div className="flex items-center gap-2">
            {step !== 'video' && (
              <Button variant="ghost" onClick={submit} disabled={!canSubmit} loading={submitting} className="max-sm:hidden">
                {rerender ? rerenderLabel(draft) : draft.workflow === 'review' ? 'Find candidates' : 'Generate now'}
              </Button>
            )}
            <Button variant="primary" trailingIcon={<ArrowRight className="h-3.5 w-3.5" />} onClick={() => goTo(next.id)} disabled={!stepValid}>
              Next: {next.label}
            </Button>
          </div>
        ) : (
          <Button variant="primary" size="lg" icon={rerender ? <RotateCcw className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />} onClick={submit} disabled={!canSubmit} loading={submitting}>
            {rerender ? rerenderLabel(draft) : draft.workflow === 'review' ? 'Find candidates' : 'Generate clips'}
          </Button>
        )}
      </div>
    </div>
  )
}

function Stepper({ current, reachable, onSelect }: { current: WizardStep; reachable: number; onSelect: (step: WizardStep) => void }): React.JSX.Element {
  const currentIndex = WIZARD_STEPS.findIndex((s) => s.id === current)
  return (
    <nav aria-label="Create steps">
      <ol className="flex items-center gap-1.5">
        {WIZARD_STEPS.map((s, i) => {
          const active = i === currentIndex
          const done = i < currentIndex
          const enabled = i <= reachable
          return (
            <li key={s.id} className="flex min-w-0 flex-1 items-center gap-1.5 last:flex-none">
              <button
                type="button"
                onClick={() => onSelect(s.id)}
                disabled={!enabled}
                aria-current={active ? 'step' : undefined}
                className={cn(
                  'group flex min-w-0 items-center gap-2 rounded-full py-1 pl-1 pr-2.5 text-xs transition-colors duration-200',
                  active ? 'bg-white/[0.08] font-medium text-ink' : enabled ? 'text-ink-muted hover:bg-white/[0.05] hover:text-ink' : 'text-ink-faint'
                )}
              >
                <span
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-mono text-2xs tabular',
                    active ? 'bg-accent text-accent-ink' : done ? 'bg-ink text-canvas' : 'bg-white/[0.06] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]'
                  )}
                >
                  {done ? <Check className="h-3 w-3" strokeWidth={3} /> : i + 1}
                </span>
                <span className={cn('truncate', !active && 'max-md:hidden')}>{s.label}</span>
              </button>
              {i < WIZARD_STEPS.length - 1 && (
                <span aria-hidden className={cn('h-px min-w-3 flex-1', done ? 'bg-ink/40' : 'bg-white/[0.08]')} />
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/** The Generate button for a re-render: how many of the saved plan's clips it renders. */
export function rerenderLabel(draft: ClipDraft): string {
  const run = draft.rerenderFrom
  if (!run) return 'Generate clips'
  const count = draft.autoClipCount ? run.clipCount : Math.min(draft.maxClips, run.clipCount)
  return `Render ${count} clip${count === 1 ? '' : 's'}`
}

/** Stands in for the Video step while a finished run is re-rendered. */
export function RerenderNotice({ run, onStartOver }: { run: RerenderSource; onStartOver: () => void }): React.JSX.Element {
  return (
    <section aria-labelledby="rerender-heading" className="space-y-3">
      <div className="glass-tile flex items-start gap-3 rounded-xl px-3 py-3">
        <IconTile tone="accent" size="sm"><RotateCcw /></IconTile>
        <div className="min-w-0">
          <h2 id="rerender-heading" className="text-sm font-semibold text-ink">Render again</h2>
          <p className="mt-0.5 truncate text-sm text-ink-muted" title={run.title}>{run.title}</p>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-subtle">
            Reuses this run's saved transcript and its {run.clipCount} planned clip{run.clipCount === 1 ? '' : 's'}, so it costs no OpenRouter credit.
            Change the format, captions or banner, then render a few clips to see them. The result is a new run; this one stays as it is.
          </p>
        </div>
      </div>
      <Button variant="ghost" icon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={onStartOver}>Start over with a new video</Button>
    </section>
  )
}

function VideoStep({ draft, update, trimError, disabled }: { draft: ClipDraft; update: Update; trimError: string | null; disabled?: boolean }): React.JSX.Element {
  return (
    <div className="space-y-3">
      <WorkflowPicker value={draft.workflow} onChange={(workflow) => update({ workflow })} disabled={disabled} />
      <section aria-labelledby="video-source-heading" className="space-y-3 border-t border-white/[0.06] pt-4">
        <div>
          <h2 id="video-source-heading" className="text-sm font-semibold text-ink">{WIZARD_STEPS[0].title}</h2>
          <p className="mt-0.5 text-xs text-ink-muted">{WIZARD_STEPS[0].description}</p>
        </div>
        <SourcePicker value={draft.source} onChange={(source) => update({ source })} disabled={disabled} />
      </section>
      <SettingRow
        title="Preferred part of the video"
        description="Suggest where to find clips. The full source is transcribed; boundaries may expand to preserve complete ideas."
        control={<Switch label="Prefer a source range" checked={draft.trimOpen} onChange={(trimOpen) => update({ trimOpen })} />}
      />
      {draft.trimOpen && (
        <div className="animate-fade-in">
          <div className="grid grid-cols-2 gap-2">
            <TextInput
              mono
              placeholder="Start 0:00"
              value={draft.trimStart}
              onChange={(e) => update({ trimStart: e.target.value })}
              aria-label="Start time"
              aria-invalid={Boolean(trimError)}
              aria-describedby="trim-help"
            />
            <TextInput
              mono
              placeholder="End"
              value={draft.trimEnd}
              onChange={(e) => update({ trimEnd: e.target.value })}
              aria-label="End time"
              aria-invalid={Boolean(trimError)}
              aria-describedby="trim-help"
            />
          </div>
          <p id="trim-help" role={trimError ? 'alert' : undefined} className={cn('mt-1.5 text-2xs', trimError ? 'text-danger' : 'text-ink-subtle')}>
            {trimError ?? 'Use seconds (90) or mm:ss (1:30).'}
          </p>
        </div>
      )}
    </div>
  )
}

/** Format, framing and pacing. Exported for the keyboard-navigation test. */
export function FormatStep({ draft, update }: { draft: ClipDraft; update: Update }): React.JSX.Element {
  return (
    <div className="space-y-4">
      <Group label="Format">
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Format">
          {FORMATS.map((f) => {
            const selected = draft.aspectRatio === f.id
            return (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                onKeyDown={onRadioKeyDown}
                onClick={() => update({ aspectRatio: f.id })}
                className={cn('glass-tile glass-tile-hover flex items-center gap-3 rounded-xl px-3 py-2.5 text-left', selected && 'glass-selected')}
              >
                <span className="flex h-6 w-7 shrink-0 items-center justify-center">
                  <span
                    className={cn(
                      'rounded-[4px] border-[1.5px] transition-colors duration-200',
                      selected ? 'border-accent bg-accent/25' : 'border-ink-subtle bg-white/[0.04]'
                    )}
                    style={{ width: f.w, height: f.h }}
                  />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-ink">
                    {f.label} <span className="font-mono text-2xs font-normal text-ink-subtle">{f.id}</span>
                  </span>
                  <span className="block truncate text-2xs text-ink-subtle">{f.hint}</span>
                </span>
              </button>
            )
          })}
        </div>
      </Group>

      {draft.aspectRatio === '9:16' && (
        <Group label="Framing">
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Framing">
            {LAYOUT_STYLES.map((style) => {
              const selected = draft.layoutStyle === style.id
              return (
                <button
                  key={style.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  onKeyDown={onRadioKeyDown}
                  onClick={() => update({ layoutStyle: style.id })}
                  className={cn(
                    'glass-tile glass-tile-hover flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-left',
                    selected ? 'glass-selected text-ink' : 'text-ink-muted hover:text-ink'
                  )}
                >
                  <FramingGlyph style={style.id} selected={selected} />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium">{style.label}</span>
                    <span className={cn('block truncate text-2xs', selected ? 'text-ink-muted' : 'text-ink-subtle')}>{style.hint}</span>
                  </span>
                </button>
              )
            })}
          </div>
          {draft.layoutStyle === 'auto' && draft.rerenderFrom && (
            <p className="mt-2 text-2xs text-ink-subtle">AI vision checks are off when rendering a run again, so it costs nothing.</p>
          )}
          {draft.layoutStyle === 'auto' && !draft.rerenderFrom && draft.clippingMode === 'economy' && (
            <p className="mt-2 text-2xs text-ink-subtle">AI vision checks are off in Economy mode.</p>
          )}
          {draft.layoutStyle === 'auto' && !draft.rerenderFrom && draft.clippingMode !== 'economy' && (
            <SettingRow
              className="mt-2"
              title="Check tricky shots with AI vision"
              description="Checks uncertain shots. May add OpenRouter charges."
              control={<Switch label="AI vision for smart framing" checked={draft.layoutVision} onChange={(layoutVision) => update({ layoutVision })} />}
            />
          )}
        </Group>
      )}

      <Group label="Pacing">
        <SettingRow
          title="Cut dead air"
          description="Proposes pause and filler cuts. When enabled, Jev checks each removal."
          control={
            <Switch label="Cut dead air and filler words" checked={draft.pacing === 'tight'} onChange={(on) => update({ pacing: on ? 'tight' : 'natural' })} />
          }
        />
      </Group>

      <Group label="Video speed" aside="All clips in this job">
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6" role="radiogroup" aria-label="Video speed" aria-describedby="video-speed-help">
          {VIDEO_SPEED_OPTIONS.map((speed) => {
            const selected = (draft.videoSpeed ?? 1) === speed
            return (
              <button key={speed} type="button" role="radio" aria-checked={selected}
                aria-label={`${speed}×${speed === 1 ? ' (Normal)' : ''}`}
                tabIndex={selected ? 0 : -1} onKeyDown={onRadioKeyDown}
                onClick={() => update({ videoSpeed: speed })}
                className={cn('glass-tile glass-tile-hover rounded-xl px-2 py-2 text-center', selected ? 'glass-selected text-ink' : 'text-ink-muted hover:text-ink')}>
                <span className="block font-mono text-sm tabular">{speed}×</span>
                <span className="block text-2xs text-ink-subtle">{speed === 1 ? 'Normal' : `${Math.round(60 / speed)}s per minute`}</span>
              </button>
            )
          })}
        </div>
        <p id="video-speed-help" className="mt-2 text-2xs text-ink-subtle">Speeds up every exported clip, keeping voice pitch natural and captions in sync. Faster clips are shorter.</p>
      </Group>
    </div>
  )
}

export function ClipsStep({ draft, update }: { draft: ClipDraft; update: Update }): React.JSX.Element {
  const jevEnabled = useSettingsStore((s) => s.jevEnabled === 'on')
  const toggleDuration = (id: string): void => {
    update({ durations: draft.durations.includes(id) ? draft.durations.filter((d) => d !== id) : [...draft.durations, id] })
  }
  if (draft.rerenderFrom) {
    const planned = draft.rerenderFrom.clipCount
    return (
      <div className="space-y-4">
        <ClipCount
          draft={draft}
          update={update}
          max={planned}
          autoTitle="Render every planned clip"
          autoDescription={`All ${planned} clip${planned === 1 ? '' : 's'} of the saved plan.`}
          autoLabel="Render every planned clip"
          help={`Renders the first ${draft.autoClipCount ? planned : Math.min(draft.maxClips, planned)} clip${(draft.autoClipCount ? planned : Math.min(draft.maxClips, planned)) === 1 ? '' : 's'} of the saved plan.`}
        />
      </div>
    )
  }
  return (
    <div className="space-y-4">
      <Group label="What to clip" aside="Optional">
        <TextArea
          rows={3}
          maxLength={CLIP_REQUEST_MAX_CHARS}
          value={draft.clipRequest ?? ''}
          onChange={(e) => update({ clipRequest: e.target.value })}
          aria-label="What to clip"
          aria-describedby="clip-request-help"
          placeholder="e.g. every time they talk about pricing, or the funniest reactions"
        />
        <p id="clip-request-help" className="mt-2 text-2xs text-ink-subtle">Only matching moments are clipped, so you may get fewer clips, or none. Leave blank for the best moments.</p>
      </Group>
      <Group label="Clipping mode">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Clipping mode">
          {([
            { id: 'quality', label: 'Quality', hint: `GPT-6 Sol planning · ${draft.workflow === 'review' ? 'Jev review required' : `Jev review & repairs ${jevEnabled ? 'enabled' : 'off'}`} · MAI Transcribe 2` },
            { id: 'economy', label: 'Economy', hint: 'GLM 5.3 Flash planning · Whisper Turbo' },
            { id: 'advanced', label: 'Advanced', hint: 'Choose your OpenRouter models' }
          ] as const).map((mode) => {
            const selected = draft.clippingMode === mode.id
            return <button key={mode.id} type="button" role="radio" aria-checked={selected} tabIndex={selected ? 0 : -1}
              onKeyDown={onRadioKeyDown} onClick={() => update({ clippingMode: mode.id })}
              className={cn('glass-tile glass-tile-hover rounded-xl px-3 py-2.5 text-left', selected && 'glass-selected')}>
              <span className="block text-sm font-medium text-ink">{mode.label}</span>
              <span className="block text-2xs text-ink-subtle">{mode.hint}</span>
            </button>
          })}
        </div>
        {draft.clippingMode === 'advanced' ? <AdvancedModels draft={draft} update={update} /> :
          <p className="mt-2 text-2xs text-ink-subtle">Economy uses lower-cost models and skips paid vision checks. Transcription retries temporary errors and can fall back to Whisper Large V3, then MAI Transcribe 2. Clip choices and captions may be less accurate.</p>}
      </Group>
      <Group label="Clip length" aside={draft.durations.length === 0 ? 'Any length' : `${draft.durations.length} selected`}>
        <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-7" role="group" aria-label="Clip length options">
          {DURATIONS.map((d) => {
            const selected = draft.durations.includes(d.id)
            return (
              <button
                key={d.id}
                type="button"
                aria-pressed={selected}
                onClick={() => toggleDuration(d.id)}
                className={cn(
                  'glass-tile glass-tile-hover rounded-xl px-1 py-1.5 text-center',
                  selected ? 'glass-selected text-ink' : 'text-ink-muted hover:text-ink'
                )}
              >
                <span className="block font-mono text-xs tabular">{d.range}</span>
                <span className={cn('block truncate text-2xs', selected ? 'text-ink-muted' : 'text-ink-subtle')}>{d.label}</span>
              </button>
            )
          })}
        </div>
        {(draft.videoSpeed ?? 1) > 1 && <p className="mt-2 text-2xs text-ink-subtle">Lengths refer to the original footage. At {draft.videoSpeed}×, 60 seconds becomes about {Math.round(60 / draft.videoSpeed)} seconds before dead-air cuts.</p>}
      </Group>

      <ClipCount draft={draft} update={update} max={MAX_CLIPS} autoTitle="Let AI decide" autoDescription="Every moment worth posting." autoLabel="Let AI decide how many clips" />
    </div>
  )
}

/** The "Number of clips" group: a switch for all of them, else a bounded counter. */
function ClipCount({ draft, update, max, autoTitle, autoDescription, autoLabel, help }: {
  draft: ClipDraft
  update: Update
  max: number
  autoTitle: string
  autoDescription: string
  autoLabel: string
  help?: string
}): React.JSX.Element {
  const count = Math.min(draft.maxClips, max)
  return (
    <Group label="Number of clips">
      <SettingRow
        title={autoTitle}
        description={autoDescription}
        control={<Switch label={autoLabel} checked={draft.autoClipCount} onChange={(autoClipCount) => update({ autoClipCount })} />}
      />
      {!draft.autoClipCount && (
        <div className="mt-2 flex max-w-xs items-center gap-2 animate-fade-in">
          <Button
            iconOnly
            aria-label="Fewer clips"
            onClick={() => update({ maxClips: Math.max(1, count - 1) })}
            disabled={count <= 1}
            icon={<Minus className="h-3.5 w-3.5" />}
          />
          <TextInput
            className="flex-1 rounded-full [&_input]:text-center"
            inputMode="numeric"
            value={String(count)}
            onChange={(e) => {
              const n = parseInt(e.target.value.replace(/\D/g, ''), 10)
              update({ maxClips: Number.isFinite(n) ? Math.min(max, Math.max(1, n)) : 1 })
            }}
            aria-label="Maximum clips"
            mono
          />
          <Button
            iconOnly
            aria-label="More clips"
            onClick={() => update({ maxClips: Math.min(max, count + 1) })}
            disabled={count >= max}
            icon={<Plus className="h-3.5 w-3.5" />}
          />
        </div>
      )}
      {help && <p className="mt-2 text-2xs text-ink-subtle">{help}</p>}
    </Group>
  )
}

export function CaptionsStep({ draft, update }: { draft: ClipDraft; update: Update }): React.JSX.Element {
  return (
    <div className="space-y-3">
      {draft.workflow !== 'review' && (
        <SettingRow
          title="Show title at the top"
          description="Each clip's title over the video. Turn off to leave it out."
          control={<Switch label="Title at the top" checked={draft.includeTitle} onChange={(includeTitle) => update({ includeTitle })} />}
        />
      )}
      <SettingRow
        title="Burn in captions"
        description="Turn off for clips without word-by-word captions."
        control={<Switch label="Captions" checked={draft.includeCaptions} onChange={(includeCaptions) => update({ includeCaptions })} />}
      />
      <div
        className={cn('transition-[opacity,filter] duration-300 ease-out', !draft.includeCaptions && 'pointer-events-none opacity-35 saturate-50')}
        aria-disabled={!draft.includeCaptions}
      >
        <CaptionPresetPicker
          showPreview
          value={draft.captionPreset}
          onChange={(captionPreset) => update({ captionPreset })}
          disabled={!draft.includeCaptions}
        />
      </div>
      <ChannelBanner draft={draft} update={update} />
    </div>
  )
}

/** One handle for every platform, shown after the icons of the platforms ticked here. Remembered for the next run. */
function ChannelBanner({ draft, update }: { draft: ClipDraft; update: Update }): React.JSX.Element {
  const error = bannerHandleError(draft.bannerHandle)
  const blank = !draft.bannerHandle.trim()
  const toggle = (id: string): void => {
    update({ bannerPlatforms: canonicalBannerPlatforms(draft.bannerPlatforms.includes(id) ? draft.bannerPlatforms.filter((p) => p !== id) : [...draft.bannerPlatforms, id]) })
  }
  return (
    <Group label="Channel banner" aside={blank ? 'Off' : 'On every clip'}>
      <TextInput
        value={draft.bannerHandle}
        onChange={(e) => update({ bannerHandle: e.target.value })}
        placeholder="@YassInPublic"
        maxLength={BANNER_HANDLE_MAX_CHARS}
        aria-label="Channel handle"
        aria-invalid={Boolean(error)}
        aria-describedby="banner-help"
      />
      <p id="banner-help" role={error ? 'alert' : undefined} className={cn('mt-1.5 text-2xs', error ? 'text-danger' : 'text-ink-subtle')}>
        {error ?? 'Shown on every clip above the platform buttons, with the icons of the platforms you tick. Leave blank for no banner.'}
      </p>
      <div className={cn('mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4', blank && 'opacity-50')} role="group" aria-label="Banner platforms">
        {BANNER_PLATFORMS.map((platform) => {
          const checked = draft.bannerPlatforms.includes(platform.id)
          return (
            <div key={platform.id} className={cn('glass-tile flex items-center gap-2.5 rounded-xl px-3 py-2', !blank && 'glass-tile-hover', checked && !blank && 'glass-selected')}>
              <Checkbox checked={checked} onChange={() => toggle(platform.id)} disabled={blank} label={platform.label} />
              <span
                aria-hidden
                onClick={() => { if (!blank) toggle(platform.id) }}
                className={cn('select-none text-sm', blank ? 'cursor-not-allowed text-ink-subtle' : 'cursor-pointer text-ink')}
              >
                {platform.label}
              </span>
            </div>
          )
        })}
      </div>
      <div className={cn('mt-3', blank && 'opacity-50')}>
        <p className="mb-1.5 text-2xs text-ink-subtle">Position</p>
        <BannerPositionPicker value={draft.bannerPosition ?? 'auto'} onChange={(bannerPosition) => update({ bannerPosition })} disabled={blank} />
        <p id="banner-position-help" className="mt-1.5 text-2xs text-ink-subtle">
          {bannerPositionLabel(draft.bannerPosition ?? 'auto')}. Auto takes the lowest clear spot and moves off faces; a grid spot stays where you put it, off the captions. Mixed gives each clip a different spot.
        </p>
      </div>
    </Group>
  )
}

const POSITION_CHOICES = [
  { id: 'auto', label: 'Auto', hint: 'Lowest clear spot' },
  { id: 'mixed', label: 'Mixed', hint: 'Different per clip' }
] as const
/** The mini frame's size (a 9:16 clip) and where its nine dots sit inside it, px. */
const FRAME_W = 54
const FRAME_H = 96
const DOT = 14
const DOT_X = [6, (FRAME_W - DOT) / 2, FRAME_W - DOT - 6]
const DOT_Y = [8, (FRAME_H - DOT) / 2, FRAME_H - DOT - 8]

/**
 * Auto and Mixed tiles beside a 9:16 mini frame with nine dots, one radio
 * group. All eleven radios are direct children of the group, which the
 * shared arrow-key handler relies on; the frame outline is only decoration.
 */
function BannerPositionPicker({ value, onChange, disabled }: { value: BannerPosition; onChange: (position: BannerPosition) => void; disabled: boolean }): React.JSX.Element {
  const radio = (id: BannerPosition): { role: 'radio'; 'aria-checked': boolean; tabIndex: number; disabled: boolean; onKeyDown: typeof onRadioKeyDown; onClick: () => void } => ({
    role: 'radio',
    'aria-checked': value === id,
    tabIndex: value === id ? 0 : -1,
    disabled,
    onKeyDown: onRadioKeyDown,
    onClick: () => onChange(id)
  })
  return (
    <div
      role="radiogroup"
      aria-label="Banner position"
      aria-describedby="banner-position-help"
      className="relative flex items-stretch gap-2"
      style={{ paddingRight: FRAME_W + 8, minHeight: FRAME_H }}
    >
      {POSITION_CHOICES.map((choice) => {
        const selected = value === choice.id
        return (
          <button
            key={choice.id}
            type="button"
            {...radio(choice.id)}
            className={cn('glass-tile flex-1 rounded-xl px-2 py-1.5 text-center', !disabled && 'glass-tile-hover', selected && !disabled ? 'glass-selected text-ink' : 'text-ink-muted', !disabled && 'hover:text-ink', disabled && 'cursor-not-allowed')}
          >
            <span className="block text-xs font-medium">{choice.label}</span>
            <span className={cn('block truncate text-2xs', selected ? 'text-ink-muted' : 'text-ink-subtle')}>{choice.hint}</span>
          </button>
        )
      })}
      <span
        aria-hidden
        className="glass-well pointer-events-none absolute right-0 top-0 rounded-[6px]"
        style={{ width: FRAME_W, height: FRAME_H }}
      />
      {BANNER_GRID_POSITION_IDS.map((id) => {
        const [vertical, horizontal] = id.split('-')
        const row = ['top', 'middle', 'bottom'].indexOf(vertical)
        const col = ['left', 'center', 'right'].indexOf(horizontal)
        const selected = value === id
        return (
          <button
            key={id}
            type="button"
            aria-label={bannerPositionLabel(id)}
            title={bannerPositionLabel(id)}
            {...radio(id)}
            className={cn(
              'absolute flex items-center justify-center rounded-full transition-[background,box-shadow] duration-150',
              selected ? 'bg-accent shadow-[0_0_0_1px_rgb(var(--accent)/0.7)]' : 'bg-white/[0.12] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.18)]',
              !disabled && !selected && 'hover:bg-white/[0.3]',
              disabled && 'cursor-not-allowed'
            )}
            style={{ width: DOT, height: DOT, right: FRAME_W - DOT_X[col] - DOT, top: DOT_Y[row] }}
          />
        )
      })}
    </div>
  )
}

function ReviewStep({ draft, trim, onEdit }: {
  draft: ClipDraft
  trim: { start: number | null; end: number | null }
  onEdit: (step: WizardStep) => void
}): React.JSX.Element {
  const active = useActiveJobs()
  const runningCount = active.filter((job) => job.status !== 'queued').length
  const lengths = draft.durations.length === 0
    ? 'Any length'
    : DURATIONS.filter((d) => draft.durations.includes(d.id)).map((d) => d.range).join(', ')
  const framing = draft.aspectRatio === '9:16'
    ? `${LAYOUT_STYLES.find((s) => s.id === draft.layoutStyle)?.label ?? 'Smart'} framing${!draft.rerenderFrom && draft.clippingMode !== 'economy' && draft.layoutStyle === 'auto' && draft.layoutVision ? ' · AI vision' : ''}`
    : 'Whole frame'
  const trimLabel = draft.trimOpen && (trim.start != null || trim.end != null)
    ? ` · ${trim.start != null ? formatSeconds(trim.start) : 'start'} to ${trim.end != null ? formatSeconds(trim.end) : 'end'}`
    : ''

  const rerender = draft.rerenderFrom
  const planned = rerender?.clipCount ?? 0
  const rows: { step: WizardStep; label: string; value: string }[] = rerender ? [
    { step: 'video', label: 'Render again', value: rerender.title },
    { step: 'format', label: 'Format', value: `${FORMATS.find((f) => f.id === draft.aspectRatio)?.label ?? draft.aspectRatio} ${draft.aspectRatio} · ${framing}` },
    { step: 'format', label: 'Pacing', value: draft.pacing === 'tight' ? 'Cut dead air' : 'Keep pauses' },
    { step: 'format', label: 'Speed', value: `${draft.videoSpeed ?? 1}×${(draft.videoSpeed ?? 1) === 1 ? ' · Normal' : ' · All exported clips'}` },
    { step: 'clips', label: 'Clips', value: draft.autoClipCount ? `All ${planned} planned clip${planned === 1 ? '' : 's'}` : `First ${Math.min(draft.maxClips, planned)} of ${planned} planned clip${planned === 1 ? '' : 's'}` },
    { step: 'captions', label: 'Captions', value: draft.includeCaptions ? CAPTION_PRESET_NAMES[draft.captionPreset] ?? draft.captionPreset : 'Off' }
  ] : [
    { step: 'video', label: 'Workflow', value: draft.workflow === 'review' ? 'Review & edit · export when ready' : 'Automatic' },
    { step: 'video', label: 'Video', value: `${sourceLabel(draft.source)}${trimLabel}` },
    { step: 'format', label: 'Format', value: `${FORMATS.find((f) => f.id === draft.aspectRatio)?.label ?? draft.aspectRatio} ${draft.aspectRatio} · ${framing}` },
    { step: 'format', label: 'Pacing', value: draft.workflow === 'review' ? 'Manual · choose your own cuts in the editor' : draft.pacing === 'tight' ? 'Cut dead air' : 'Keep pauses' },
    { step: 'format', label: 'Speed', value: `${draft.videoSpeed ?? 1}×${(draft.videoSpeed ?? 1) === 1 ? ' · Normal' : ' · All exported clips'}` },
    { step: 'clips', label: 'Mode', value: draft.clippingMode === 'advanced' ? 'Advanced · custom models' : draft.clippingMode === 'economy' ? 'Economy · lower cost' : 'Quality · higher accuracy' },
    { step: 'clips', label: 'Clips', value: `${lengths}${(draft.videoSpeed ?? 1) > 1 && draft.durations.length > 0 ? ' of source footage' : ''} · ${draft.autoClipCount ? 'AI decides how many' : `Up to ${draft.maxClips}`}` },
    { step: 'clips', label: 'What to clip', value: draft.clipRequest?.trim() || 'The best moments' },
    { step: 'captions', label: 'Captions', value: draft.includeCaptions ? CAPTION_PRESET_NAMES[draft.captionPreset] ?? draft.captionPreset : 'Off' }
  ]
  if (draft.workflow !== 'review') rows.push({ step: 'captions', label: 'Title', value: draft.includeTitle ? 'Shown at the top' : 'Off' })
  const bannerHandle = normalizeBannerHandle(draft.bannerHandle)
  const bannerLabels = BANNER_PLATFORMS.filter((p) => draft.bannerPlatforms.includes(p.id)).map((p) => p.label)
  const position = draft.bannerPosition ?? 'auto'
  const positionSuffix = position !== 'auto' ? ` · ${bannerPositionLabel(position)}` : ''
  rows.push({ step: 'captions', label: 'Banner', value: bannerHandle ? `${bannerLabels.length ? `${bannerHandle} · ${bannerLabels.join(', ')}` : bannerHandle}${positionSuffix}` : 'Off' })
  if (draft.clippingMode === 'advanced' && !rerender) rows.splice(5, 0,
    { step: 'clips', label: 'Transcribe', value: draft.transcriptionModel || 'Choose a model' },
    { step: 'clips', label: 'Plan', value: draft.plannerModel || 'Choose a model' })

  return (
    <div className="space-y-3">
      <dl className="glass-well divide-y divide-white/[0.05] overflow-hidden rounded-xl">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-3 px-3 py-2">
            <dt className="w-20 shrink-0 text-xs text-ink-subtle">{row.label}</dt>
            <dd className="min-w-0 flex-1 truncate text-sm text-ink" title={row.value}>{row.value}</dd>
            <Button size="sm" variant="ghost" onClick={() => onEdit(row.step)} aria-label={`Edit ${row.label.toLowerCase()}`}>
              Edit
            </Button>
          </div>
        ))}
      </dl>
      <p className="flex items-start gap-2 text-2xs text-ink-subtle">
        <Clock3 className="mt-px h-3.5 w-3.5 shrink-0" />
        {runningCount >= MAX_PARALLEL_JOBS
          ? `${runningCount} jobs are running. This one waits in the queue and starts automatically.`
          : active.length > 0
            ? `Runs alongside ${active.length} other job${active.length === 1 ? '' : 's'}. Up to ${MAX_PARALLEL_JOBS} run at once.`
            : 'Runs on this computer. Transcription and clip planning bill your OpenRouter account.'}
      </p>
    </div>
  )
}

function StartedPanel({ className, onViewJob }: { className?: string; onViewJob?: (jobId: string) => void }): React.JSX.Element | null {
  const started = useDraftStore((s) => s.started)
  const startAnother = useDraftStore((s) => s.startAnother)
  if (!started) return null
  return (
    <Panel className={cn('flex flex-col items-center px-5 py-8 text-center animate-fade-in', className)}>
      <IconTile tone="success" size="lg">
        <CheckCircle2 />
      </IconTile>
      <h2 className="mt-3 text-base font-semibold text-ink">{started.queued ? 'Queued' : 'Clipping started'}</h2>
      <p className="mt-1 max-w-md truncate text-sm text-ink-muted" title={started.source}>{sourceLabel(started.source)}</p>
      <p className="mt-1 max-w-md text-xs text-ink-subtle">
        {started.queued
          ? `Up to ${MAX_PARALLEL_JOBS} jobs run at once. This one starts as soon as a slot frees up.`
          : 'It keeps running while you queue more videos or use the rest of BridgeClip.'}
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={startAnother}>
          Clip another video
        </Button>
        {onViewJob && (
          <Button icon={<ListVideo className="h-3.5 w-3.5" />} onClick={() => onViewJob(started.jobId)}>
            View job
          </Button>
        )}
      </div>
    </Panel>
  )
}

function AdvancedModels({ draft, update }: { draft: ClipDraft; update: Update }): React.JSX.Element {
  const { catalog, loading, error, load } = useModelStore()
  useEffect(() => { void load() }, [load])
  return <div className="mt-3 space-y-4 rounded-xl border border-white/10 p-3">
    <div className="flex items-center justify-between gap-3">
      <p className="text-xs text-ink-muted">Search OpenRouter’s live model catalog.</p>
      <Button size="sm" variant="ghost" loading={loading} disabled={loading} onClick={() => void load(true)}>Refresh models</Button>
    </div>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    <ModelPicker task="transcription" models={catalog?.transcription ?? []} value={draft.transcriptionModel} loading={loading}
      onChange={(transcriptionModel) => update({ transcriptionModel })} />
    <ModelPicker task="planning" models={catalog?.planning ?? []} value={draft.plannerModel} loading={loading}
      onChange={(plannerModel) => update({ plannerModel })} />
    <p className="text-2xs text-ink-subtle">Temporary errors are retried with your selected models. No automatic model switching. Usage bills your OpenRouter account. Optional AI framing checks use Gemini and can be changed in Format.</p>
  </div>
}

function formatSeconds(total: number): string {
  const m = Math.floor(total / 60)
  const s = Math.floor(total % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Tiny 9:16 diagram of a framing style: split panels, full bleed, or letterbox. */
function FramingGlyph({ style, selected }: { style: 'auto' | 'fill' | 'fit'; selected: boolean }): React.JSX.Element {
  const fill = selected ? 'bg-accent' : 'bg-ink-subtle/60'
  return (
    <span
      aria-hidden
      className={cn(
        'flex h-[24px] w-[14px] shrink-0 flex-col gap-px overflow-hidden rounded-[4px] border-[1.5px] p-px transition-colors duration-200',
        selected ? 'border-accent' : 'border-ink-subtle'
      )}
    >
      {style === 'auto' && (
        <>
          <span className={cn('flex-1 rounded-[1px]', fill)} />
          <span className={cn('flex-1 rounded-[1px] opacity-60', fill)} />
        </>
      )}
      {style === 'fill' && <span className={cn('flex-1 rounded-[1px]', fill)} />}
      {style === 'fit' && <span className={cn('my-auto h-[6px] rounded-[1px]', fill)} />}
    </span>
  )
}

function Group({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }): React.JSX.Element {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="eyebrow">{label}</span>
        {aside && <span className="text-2xs text-ink-subtle">{aside}</span>}
      </div>
      {children}
    </div>
  )
}
