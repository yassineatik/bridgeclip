export const DURATION_OPTIONS = [
  { id: 'xshort', label: 'Extra short', range: '10–30s' },
  { id: 'short', label: 'Short', range: '30–60s' },
  { id: 'medium', label: 'Medium', range: '1–2m' },
  { id: 'long', label: 'Long', range: '2–5m' },
  { id: 'xlong', label: 'Extra long', range: '5–10m' },
  { id: 'extended', label: 'Extended', range: '10–15m' },
  { id: 'feature', label: 'Feature', range: '15–30m' }
] as const

/** Increment when the desktop bridge and bundled BridgeClip engine job contract change. */
/** Version 3 adds review projects that must never auto-render. */
export const BRIDGE_CONTRACT_VERSION = 3

/** Longest "What to clip" description sent to the planner. */
export const CLIP_REQUEST_MAX_CHARS = 1000

export const VIDEO_SPEED_OPTIONS = [1, 1.1, 1.25, 1.5, 1.75, 2] as const

export function isVideoSpeed(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 2
}

export type DurationId = (typeof DURATION_OPTIONS)[number]['id']
export const DURATION_IDS: readonly string[] = DURATION_OPTIONS.map((option) => option.id)

/** Platforms the channel banner can show an icon for, in the order they are drawn. */
export const BANNER_PLATFORMS = [
  { id: 'youtube', label: 'YouTube' },
  { id: 'x', label: 'X' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'instagram', label: 'Instagram' }
] as const

export type BannerPlatform = (typeof BANNER_PLATFORMS)[number]['id']
export const BANNER_PLATFORM_IDS: readonly string[] = BANNER_PLATFORMS.map((platform) => platform.id)

/** Longest channel handle drawn on the banner, including the @. */
export const BANNER_HANDLE_MAX_CHARS = 64

const BANNER_HANDLE = /^@?[A-Za-z0-9._-]{1,63}$/

/** True for a handle like @YassInPublic (the @ is optional); blank is not a handle. */
export function isBannerHandle(value: string): boolean {
  return BANNER_HANDLE.test(value.trim())
}

/** The handle as drawn: trimmed and with exactly one leading @. Null when blank. */
export function normalizeBannerHandle(text: string): string | null {
  const name = text.trim().replace(/^@/, '')
  return name ? `@${name}` : null
}

/** The chosen platforms in drawing order, without duplicates or unknown ids. */
export function canonicalBannerPlatforms(platforms: readonly string[]): string[] {
  return BANNER_PLATFORM_IDS.filter((id) => platforms.includes(id))
}

/**
 * Where the banner sits on a 9:16 clip: Auto (the lowest clear spot, moving
 * off faces), one of nine grid spots "<vertical>-<horizontal>" that stay
 * where you put them (still off the captions), or Mixed, a different grid
 * spot on each clip.
 */
export const BANNER_VERTICAL = ['top', 'middle', 'bottom'] as const
export const BANNER_HORIZONTAL = ['left', 'center', 'right'] as const
export type BannerVertical = (typeof BANNER_VERTICAL)[number]
export type BannerHorizontal = (typeof BANNER_HORIZONTAL)[number]
export type BannerGridPosition = `${BannerVertical}-${BannerHorizontal}`
export type BannerPosition = 'auto' | 'mixed' | BannerGridPosition

export const BANNER_GRID_POSITION_IDS: readonly BannerGridPosition[] = BANNER_VERTICAL.flatMap((v) =>
  BANNER_HORIZONTAL.map((h) => `${v}-${h}` as BannerGridPosition)
)
export const BANNER_POSITION_IDS: readonly BannerPosition[] = ['auto', 'mixed', ...BANNER_GRID_POSITION_IDS]
/** Requests saved before the grid used a vertical word alone; it meant the center column. */
const LEGACY_BANNER_POSITIONS: readonly string[] = BANNER_VERTICAL

export function isBannerPosition(value: unknown): value is BannerPosition | BannerVertical {
  return typeof value === 'string' && ((BANNER_POSITION_IDS as readonly string[]).includes(value) || LEGACY_BANNER_POSITIONS.includes(value))
}

/** The id as stored and sent: a legacy vertical word becomes its center spot. */
export function normalizeBannerPosition(value: BannerPosition | BannerVertical): BannerPosition {
  return LEGACY_BANNER_POSITIONS.includes(value) ? (`${value}-center` as BannerPosition) : (value as BannerPosition)
}

/** 'Auto', 'Mixed', 'Bottom left', 'Middle center', ... */
export function bannerPositionLabel(id: BannerPosition | BannerVertical): string {
  const [vertical, horizontal] = normalizeBannerPosition(id).split('-')
  const words = horizontal ? [vertical, horizontal] : [vertical]
  return words.map((word, i) => (i === 0 ? word[0].toUpperCase() + word.slice(1) : word)).join(' ')
}
