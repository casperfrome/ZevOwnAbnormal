export type AppRoute =
  | { page: "records"; detailId?: string }
  | { page: "anomaly-groups"; detailId?: string }
  | { page: "rules" }
  | { page: "rule-editor"; mode: "new" | "edit"; entityId?: string }
  | { page: "datasets" }
  | { page: "dataset-editor"; mode: "new" | "edit"; entityId?: string }
  | { page: "datasources" }
  | { page: "overview" }
  | { page: "tests" }
  | { page: "account" }
  | { page: "accounts" }

function decodePart(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function parseHashRoute(hash: string): AppRoute {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean)
  const [page, first, second] = parts

  if (page === "records") return { page, detailId: decodePart(parts.slice(1).join("/")) }
  if (page === "anomaly-groups") return { page, detailId: decodePart(parts.slice(1).join("/")) }
  if (page === "rules") {
    if (first === "new") return { page: "rule-editor", mode: "new" }
    if (first && second === "edit") return { page: "rule-editor", mode: "edit", entityId: decodePart(first) }
    return { page }
  }
  if (page === "datasets") {
    if (first === "new") return { page: "dataset-editor", mode: "new" }
    if (first && second === "edit") return { page: "dataset-editor", mode: "edit", entityId: decodePart(first) }
    return { page }
  }
  if (page === "datasources" || page === "overview" || page === "tests" || page === "account" || page === "accounts") {
    return { page }
  }
  return { page: "records" }
}
