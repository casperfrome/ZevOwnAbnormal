import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useApp } from "@/app/context"
import { EmptyState, ErrorState, LoadingState, PageHeader, SearchInput, StatusBadge } from "@/components/shared"
import { formatDateTime, valueText } from "@/lib/format"

export function GroupsPage({ detailId, navigate }: { detailId?: string; navigate: (hash: string) => void }) {
  const { resources } = useApp(); const [search, setSearch] = useState("")
  const query = useQuery({ queryKey: ["groups", search], queryFn: ({ signal }) => resources.groups.list({ page: 1, pageSize: 50, search }, signal) })
  const detail = useQuery({ queryKey: ["group", detailId], queryFn: ({ signal }) => resources.groups.detail(detailId!, signal), enabled: Boolean(detailId) })
  return <div className="page-grid"><PageHeader title="异常记录组" description="按规则与异常键聚合连续异常" /><SearchInput value={search} onChange={setSearch} placeholder="搜索记录组…" />{query.isLoading ? <LoadingState /> : query.error ? <ErrorState error={query.error} /> : !query.data?.items.length ? <EmptyState /> : <Card className="overflow-x-auto"><Table className="dense-table"><TableHeader><TableRow><TableHead>异常键</TableHead><TableHead>规则</TableHead><TableHead>级别</TableHead><TableHead>记录数</TableHead><TableHead>最近发现</TableHead><TableHead /></TableRow></TableHeader><TableBody>{query.data.items.map((item) => <TableRow key={item.id}><TableCell className="font-medium">{item.anomaly_key || item.id}</TableCell><TableCell>{item.rule_name || "—"}</TableCell><TableCell><StatusBadge value={item.severity} /></TableCell><TableCell>{item.record_count ?? 0}</TableCell><TableCell>{formatDateTime(item.last_detected_at)}</TableCell><TableCell className="text-right"><Button size="sm" variant="ghost" onClick={() => navigate(`#anomaly-groups/${encodeURIComponent(item.id)}`)}>查看</Button></TableCell></TableRow>)}</TableBody></Table></Card>}<Sheet open={Boolean(detailId)} onOpenChange={(open) => { if (!open) navigate("#anomaly-groups") }}><SheetContent className="w-full overflow-y-auto sm:max-w-xl"><SheetHeader><SheetTitle>异常记录组详情</SheetTitle><SheetDescription>{detailId}</SheetDescription></SheetHeader><div className="space-y-2 px-4 pb-6">{detail.isLoading ? <LoadingState /> : detail.error ? <ErrorState error={detail.error} /> : detail.data && Object.entries(detail.data).map(([key, value]) => <div key={key} className="grid grid-cols-[9rem_1fr] gap-3 border-b py-2 text-sm"><span className="text-muted-foreground">{key}</span><span className="break-all">{valueText(value)}</span></div>)}</div></SheetContent></Sheet></div>
}
