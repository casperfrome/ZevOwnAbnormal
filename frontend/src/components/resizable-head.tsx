import { useState, type ReactNode } from "react"
import { TableHead } from "@/components/ui/table"
import { clampColumnWidth, readColumnWidths } from "@/lib/column-widths"

export function useColumnWidths(storageKey: string) {
  const [widths, setWidths] = useState<Record<string, number>>(() => readColumnWidths(localStorage.getItem(storageKey)))
  const resize = (key: string, width: number) => setWidths((current) => { const next = { ...current, [key]: clampColumnWidth(width) }; localStorage.setItem(storageKey, JSON.stringify(next)); return next })
  return { widths, resize }
}

export function ResizableHead({ column, width, onResize, children }: { column: string; width?: number; onResize: (column: string, width: number) => void; children: ReactNode }) {
  return <TableHead style={width ? { width, minWidth: width } : undefined} className="relative select-none"><span>{children}</span><button type="button" aria-label={`调整${children}列宽`} className="absolute inset-y-1 right-0 w-2 cursor-col-resize border-r border-transparent hover:border-primary" onPointerDown={(event) => { event.preventDefault(); const startX = event.clientX; const startWidth = event.currentTarget.parentElement?.getBoundingClientRect().width ?? width ?? 160; const move = (moveEvent: PointerEvent) => onResize(column, startWidth + moveEvent.clientX - startX); const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop) }; window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop, { once: true }) }} /></TableHead>
}
