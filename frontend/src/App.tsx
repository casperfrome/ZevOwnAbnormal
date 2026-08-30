import { Component, Suspense, lazy, type CSSProperties, type ErrorInfo, type ReactNode, useCallback, useEffect, useMemo, useState } from "react"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"
import { HashRouter } from "react-router-dom"
import { AlertTriangle, BarChart3, BellRing, Blocks, ChevronsUpDown, CircleUserRound, Database, FlaskConical, LogOut, Search, Server, ShieldCheck, TableProperties, Users } from "lucide-react"
import { ApiClient, ApiError } from "@/api/client"
import { createResources } from "@/api/resources"
import type { User } from "@/api/types"
import { AppContext } from "@/app/context"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger } from "@/components/ui/sidebar"
import { Spinner } from "@/components/ui/spinner"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ErrorState, LoadingState } from "@/components/shared"
import { parseHashRoute } from "@/lib/route"

const RecordsPage = lazy(() => import("@/pages/records").then((module) => ({ default: module.RecordsPage })))
const GroupsPage = lazy(() => import("@/pages/groups").then((module) => ({ default: module.GroupsPage })))
const RulesPage = lazy(() => import("@/pages/rules").then((module) => ({ default: module.RulesPage })))
const RuleEditorPage = lazy(() => import("@/pages/rules").then((module) => ({ default: module.RuleEditorPage })))
const DatasetsPage = lazy(() => import("@/pages/datasets").then((module) => ({ default: module.DatasetsPage })))
const DatasetEditorPage = lazy(() => import("@/pages/datasets").then((module) => ({ default: module.DatasetEditorPage })))
const DatasourcesPage = lazy(() => import("@/pages/datasources").then((module) => ({ default: module.DatasourcesPage })))
const OverviewPage = lazy(() => import("@/pages/overview").then((module) => ({ default: module.OverviewPage })))
const TestsPage = lazy(() => import("@/pages/system").then((module) => ({ default: module.TestsPage })))
const AccountPage = lazy(() => import("@/pages/system").then((module) => ({ default: module.AccountPage })))
const AccountsPage = lazy(() => import("@/pages/system").then((module) => ({ default: module.AccountsPage })))

class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("Unhandled UI error", error, info) }
  render() { return this.state.error ? <main className="mx-auto max-w-2xl p-8"><ErrorState error={this.state.error} retry={() => this.setState({ error: undefined })} /></main> : this.props.children }
}

function initials(name: string) { return name.trim().slice(0, 2).toUpperCase() || "ZA" }

function LoginPage({ resources, onLogin }: { resources: ReturnType<typeof createResources>; onLogin: (user: User) => void }) {
  const [loginName, setLoginName] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [pending, setPending] = useState(false)
  const submit = async (event: React.FormEvent) => { event.preventDefault(); setError(""); setPending(true); try { onLogin(await resources.auth.login(loginName, password)) } catch (caught) { setError(caught instanceof Error ? caught.message : "登录失败") } finally { setPending(false) } }
  return <main className="grid min-h-screen place-items-center bg-[radial-gradient(circle_at_top,var(--color-secondary),transparent_55%)] p-4"><Card className="w-full max-w-sm"><CardHeader><div className="mb-4 grid size-12 place-items-center rounded-xl bg-primary text-primary-foreground"><AlertTriangle /></div><CardTitle className="text-2xl"><h1>登录 ZevOwnAbnormal</h1></CardTitle><CardDescription>异常监控、校验和通知的一体化工作台</CardDescription></CardHeader><CardContent><form onSubmit={submit}><FieldGroup><Field data-invalid={Boolean(error)}><FieldLabel htmlFor="login-name">登录名</FieldLabel><Input id="login-name" autoFocus autoComplete="username" value={loginName} onChange={(event) => setLoginName(event.target.value)} aria-invalid={Boolean(error)} /></Field><Field data-invalid={Boolean(error)}><FieldLabel htmlFor="login-password">密码</FieldLabel><Input id="login-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} aria-invalid={Boolean(error)} /><FieldError>{error}</FieldError></Field><Button type="submit" disabled={!loginName || !password || pending}>{pending && <Spinner data-icon="inline-start" />}登录</Button></FieldGroup></form></CardContent></Card></main>
}

const navGroups = [
  { label: "监控", items: [{ page: "records", label: "异常记录", icon: BellRing }, { page: "anomaly-groups", label: "异常记录组", icon: Blocks }, { page: "rules", label: "异常规则", icon: ShieldCheck }] },
  { label: "数据", items: [{ page: "datasets", label: "数据集", icon: TableProperties }, { page: "datasources", label: "数据源", icon: Database }] },
  { label: "系统", items: [{ page: "overview", label: "总览", icon: BarChart3 }, { page: "tests", label: "系统测试", icon: FlaskConical }, { page: "accounts", label: "账号管理", icon: Users, admin: true }] },
]
const titles: Record<string, string> = { records: "异常记录", "anomaly-groups": "异常记录组", rules: "异常规则", "rule-editor": "规则配置", datasets: "数据集", "dataset-editor": "数据集配置", datasources: "数据源", overview: "总览", tests: "系统测试", account: "个人账号", accounts: "账号管理" }

function useHash() {
  const [hash, setHash] = useState(() => window.location.hash || "#records")
  useEffect(() => { const listener = () => setHash(window.location.hash || "#records"); window.addEventListener("hashchange", listener); return () => window.removeEventListener("hashchange", listener) }, [])
  const navigate = useCallback((next: string) => { if (window.location.hash === next) setHash(next); else window.location.hash = next }, [])
  return { hash, navigate }
}

function AppShell({ resources, user, setUser }: { resources: ReturnType<typeof createResources>; user: User; setUser: (user: User | null) => void }) {
  const { hash, navigate } = useHash(); const route = parseHashRoute(hash); const [searchOpen, setSearchOpen] = useState(false)
  const rules = useQuery({ queryKey: ["rules"], queryFn: ({ signal }) => resources.rules.list(signal), staleTime: 60_000 }); const datasets = useQuery({ queryKey: ["datasets"], queryFn: ({ signal }) => resources.datasets.list(signal), staleTime: 60_000 })
  const pendingRecords = useQuery({ queryKey: ["records", "pending-count"], queryFn: ({ signal }) => resources.records.pendingCount(signal), staleTime: 30_000 })
  useEffect(() => { const listener = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSearchOpen((value) => !value) } }; window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener) }, [])
  const selectSearch = (target: string) => { setSearchOpen(false); navigate(target) }
  const content = <Suspense fallback={<LoadingState label="正在加载页面" />}>{(() => { switch (route.page) { case "records": return <RecordsPage detailId={route.detailId} navigate={navigate} />; case "anomaly-groups": return <GroupsPage detailId={route.detailId} navigate={navigate} />; case "rules": return <RulesPage navigate={navigate} />; case "rule-editor": return <RuleEditorPage id={route.entityId} navigate={navigate} />; case "datasets": return <DatasetsPage navigate={navigate} />; case "dataset-editor": return <DatasetEditorPage id={route.entityId} navigate={navigate} />; case "datasources": return <DatasourcesPage />; case "overview": return <OverviewPage />; case "tests": return <TestsPage />; case "account": return <AccountPage />; case "accounts": return user.is_superuser ? <AccountsPage /> : <RecordsPage navigate={navigate} /> } })()}</Suspense>
  return <AppContext.Provider value={{ resources, user, setUser }}><SidebarProvider style={{ "--sidebar-width": "248px" } as CSSProperties}><Sidebar className="app-sidebar" collapsible="offcanvas"><SidebarHeader><SidebarMenu><SidebarMenuItem><SidebarMenuButton size="lg" onClick={() => navigate("#records")} tooltip="ZevOwnAbnormal"><span className="grid size-9 place-items-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground"><AlertTriangle /></span><span className="grid flex-1 text-left text-sm leading-tight"><span className="truncate font-semibold">ZevOwnAbnormal</span><span className="truncate text-xs">异常运营平台</span></span></SidebarMenuButton></SidebarMenuItem></SidebarMenu></SidebarHeader><SidebarContent>{navGroups.map((group) => <SidebarGroup key={group.label}><SidebarGroupLabel>{group.label}</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{group.items.filter((item) => !item.admin || user.is_superuser).map((item) => <SidebarMenuItem key={item.page}><SidebarMenuButton className="app-nav-item" asChild isActive={route.page === item.page || (item.page === "rules" && route.page === "rule-editor") || (item.page === "datasets" && route.page === "dataset-editor")} tooltip={item.label}><a href={`#${item.page}`}><item.icon /><span>{item.label}</span></a></SidebarMenuButton>{item.page === "records" && pendingRecords.data && pendingRecords.data > 0 ? <SidebarMenuBadge aria-label={`${pendingRecords.data} 条待处理异常`}>{pendingRecords.data}</SidebarMenuBadge> : null}</SidebarMenuItem>)}</SidebarMenu></SidebarGroupContent></SidebarGroup>)}</SidebarContent><SidebarFooter><SidebarMenu><SidebarMenuItem><DropdownMenu><DropdownMenuTrigger asChild><SidebarMenuButton size="lg"><Avatar className="size-8"><AvatarFallback>{initials(user.display_name)}</AvatarFallback></Avatar><span className="grid flex-1 text-left text-sm leading-tight"><span className="truncate font-medium">{user.display_name}</span><span className="truncate text-xs">{user.is_superuser ? "超级管理员" : user.job_title || "普通账号"}</span></span><ChevronsUpDown /></SidebarMenuButton></DropdownMenuTrigger><DropdownMenuContent side="top" align="end" className="w-56"><DropdownMenuLabel>{user.login_name}</DropdownMenuLabel><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => navigate("#account")}><CircleUserRound data-icon="inline-start" />个人账号</DropdownMenuItem><DropdownMenuItem onSelect={async () => { await resources.auth.logout(); setUser(null) }}><LogOut data-icon="inline-start" />退出登录</DropdownMenuItem></DropdownMenuContent></DropdownMenu></SidebarMenuItem></SidebarMenu></SidebarFooter><SidebarRail /></Sidebar><SidebarInset><header className="app-topbar sticky top-0 z-20 flex h-[72px] items-center gap-4 border-b bg-background/95 px-4 backdrop-blur md:px-8"><SidebarTrigger aria-label="打开导航" /><Breadcrumb className="min-w-0"><BreadcrumbList><BreadcrumbItem>ZevOwnAbnormal</BreadcrumbItem><BreadcrumbSeparator /><BreadcrumbItem><BreadcrumbPage>{titles[route.page]}</BreadcrumbPage></BreadcrumbItem></BreadcrumbList></Breadcrumb><div className="ml-auto"><Button variant="outline" className="hidden w-70 justify-start text-muted-foreground sm:flex" onClick={() => setSearchOpen(true)}><Search data-icon="inline-start" />搜索规则、数据集…<kbd className="ml-auto text-xs">Ctrl K</kbd></Button><Button variant="ghost" size="icon" className="sm:hidden" aria-label="打开全局搜索" onClick={() => setSearchOpen(true)}><Search /></Button></div></header><main className="app-content mx-auto w-full max-w-[1440px] flex-1 p-4 md:p-8">{content}</main></SidebarInset></SidebarProvider><CommandDialog open={searchOpen} onOpenChange={setSearchOpen}><Command><CommandInput placeholder="搜索规则、数据集或页面…" /><CommandList><CommandEmpty>没有匹配结果</CommandEmpty><CommandGroup heading="页面">{navGroups.flatMap((group) => group.items).filter((item) => !item.admin || user.is_superuser).map((item) => <CommandItem key={item.page} onSelect={() => selectSearch(`#${item.page}`)}><item.icon />{item.label}</CommandItem>)}</CommandGroup><CommandGroup heading="规则">{Array.isArray(rules.data) && rules.data.map((rule) => <CommandItem key={rule.id} onSelect={() => selectSearch(`#rules/${rule.id}/edit`)}><ShieldCheck />{rule.name}<CommandShortcut>规则</CommandShortcut></CommandItem>)}</CommandGroup><CommandGroup heading="数据集">{Array.isArray(datasets.data) && datasets.data.map((dataset) => <CommandItem key={dataset.id} onSelect={() => selectSearch(`#datasets/${dataset.id}/edit`)}><Server />{dataset.name}<CommandShortcut>数据集</CommandShortcut></CommandItem>)}</CommandGroup></CommandList></Command></CommandDialog></AppContext.Provider>
}

function AppRoot() {
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const client = useMemo(() => new ApiClient({ onUnauthorized: () => setUser(null) }), [])
  const resources = useMemo(() => createResources(client), [client])
  useEffect(() => { const controller = new AbortController(); resources.auth.me(controller.signal).then((next) => { client.markAuthenticated(); setUser(next) }).catch((error) => { if (!(error instanceof ApiError && error.status === 401) && error.name !== "AbortError") console.error(error); setUser(null) }); return () => controller.abort() }, [client, resources])
  if (user === undefined) return <LoadingState label="正在验证登录状态" />
  if (!user) return <LoginPage resources={resources} onLogin={(next) => { client.markAuthenticated(); setUser(next) }} />
  return <AppShell resources={resources} user={user} setUser={setUser} />
}

export default function App() { const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false }, mutations: { retry: 0 } } })); return <ErrorBoundary><HashRouter><QueryClientProvider client={queryClient}><TooltipProvider><AppRoot /><Toaster richColors position="top-right" /></TooltipProvider></QueryClientProvider></HashRouter></ErrorBoundary> }
