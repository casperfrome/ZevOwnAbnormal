export const clampColumnWidth = (width: number) => Math.max(96, Math.min(720, Math.round(width)))
export function readColumnWidths(value: string | null) {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])).map(([key, width]) => [key, clampColumnWidth(width)]))
  } catch { return {} }
}
