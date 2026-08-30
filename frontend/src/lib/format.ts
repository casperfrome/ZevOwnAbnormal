export function formatDateTime(value?: string | number | Date) {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date)
}

export function csvText(rows: Array<Record<string, unknown>>) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  const escape = (value: unknown) => {
    const text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value)
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }
  return `\uFEFF${[columns.join(","), ...rows.map((row) => columns.map((column) => escape(row[column])).join(","))].join("\r\n")}`
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export function valueText(value: unknown) {
  if (value == null || value === "") return "—"
  if (typeof value === "object") return jsonText(value)
  return String(value)
}

export function jsonText(value: unknown) {
  const seen = new WeakSet<object>()
  try {
    const text = JSON.stringify(value, (_key, current) => {
      if (typeof current === "object" && current !== null) {
        if (seen.has(current)) return "[循环引用]"
        seen.add(current)
      }
      return current
    })
    return text ?? "—"
  } catch { return "[不可序列化数据]" }
}

export function businessKeyText(value: unknown) {
  if (value == null || value === "") return "—"
  if (typeof value !== "object" || Array.isArray(value)) return valueText(value)
  return Object.keys(value as Record<string, unknown>).sort().map((key) => `${key}: ${valueText((value as Record<string, unknown>)[key])}`).join(" · ") || "—"
}
