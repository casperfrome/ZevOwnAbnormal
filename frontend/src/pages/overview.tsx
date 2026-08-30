import { useQuery } from "@tanstack/react-query"
import { Activity, Database, ListChecks, ShieldAlert } from "lucide-react"
import { useApp } from "@/app/context"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ErrorState, LoadingState, MetricCard, PageHeader } from "@/components/shared"

export function OverviewPage() {
  const { resources } = useApp()
  const query = useQuery({ queryKey: ["overview", 30], queryFn: ({ signal }) => resources.overview(30, signal) })
  if (query.isLoading) return <LoadingState label="正在汇总监控数据" />
  if (query.error) return <ErrorState error={query.error} retry={() => query.refetch()} />
  const stats = query.data?.stats ?? {}
  return <div className="page-grid"><PageHeader title="总览" description="近 30 天异常态势与平台运行概况" /><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><MetricCard title="待处理异常" value={stats.pending_records ?? 0} description="需要团队关注" /><MetricCard title="处理中" value={stats.processing_records ?? 0} /><MetricCard title="启用规则" value={stats.active_rules ?? 0} /><MetricCard title="在线数据源" value={stats.online_datasources ?? 0} /></div><div className="grid gap-4 lg:grid-cols-2"><Card><CardHeader><CardTitle className="flex items-center gap-2"><Activity data-icon="inline-start" />异常态势</CardTitle></CardHeader><CardContent className="grid grid-cols-2 gap-4"><MetricCard title="高危异常" value={stats.high_anomalies ?? 0} /><MetricCard title="今日已解决" value={stats.resolved_records ?? 0} /></CardContent></Card><Card><CardHeader><CardTitle className="flex items-center gap-2"><Database data-icon="inline-start" />资源健康</CardTitle></CardHeader><CardContent className="grid grid-cols-2 gap-4 text-sm"><div className="flex items-center gap-2"><ListChecks data-icon="inline-start" />规则总数 {stats.total_rules ?? 0}</div><div className="flex items-center gap-2"><ShieldAlert data-icon="inline-start" />推送中 {stats.push_in_transit_anomalies ?? 0}</div></CardContent></Card></div></div>
}
