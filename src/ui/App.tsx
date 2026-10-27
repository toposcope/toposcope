import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Undo2 } from "lucide-react";
import { accessLit, HeaderField, HeaderTabs, settingsLit } from "@/components/operator-header";
import { AccessView, type AccessFilter } from "@/components/access-view";
import { SharePage } from "@/components/share-page";
import { LinkPage } from "@/components/link-page";
import { HomeView } from "@/components/home-view";
import { toast } from "sonner";
import { AlertRuleDialog, type AlertDraft, type MonitorInput } from "@/components/alert-rule-dialog";
import { NewMonitorDialog } from "@/components/new-monitor-dialog";
import { PushMonitorDialog, type PushDraft, type PushInput } from "@/components/push-monitor-dialog";
import { HttpMonitorDialog, type HttpDraft, type HttpMonitorInput } from "@/components/http-monitor-dialog";
import { NetMonitorDialog, type NetDraft, type NetMonitorInput } from "@/components/net-monitor-dialog";
import { WatchView } from "@/components/watch-view";
import { MonitorRail } from "@/components/monitor-rail";
import type { MonitorBand } from "@/components/monitor-band";
import { FIELDS_RANGE, FieldsView } from "@/components/fields-view";
import { SpanDetail } from "@/components/span-detail";
import { ContextTabs } from "@/components/context-tabs";
import { ContextView, type ContextMode } from "@/components/context-view";
import { EventDetail } from "@/components/event-detail";
import { FingerprintCutPanel } from "@/components/fingerprint-cut-panel";
import { TraceWaterfall } from "@/components/trace-waterfall";
import { SpanFlamegraph } from "@/components/span-flamegraph";
import { EventTable } from "@/components/event-table";
import { WorkspaceStrip } from "@/components/workspace-strip";
import { FacetChips } from "@/components/facet-chips";
import { HuntCrumb } from "@/components/hunt-crumb";
import { MarksPanel } from "@/components/marks-panel";
import { WatchThisSheet, type WatchThisInput } from "@/components/watch-this-sheet";
import { BoardInputs } from "@/components/board-inputs";
import { SaveSearchDialog } from "@/components/save-search-dialog";
import { InstanceMenu, instanceTitle, type InstanceInfo } from "@/components/instance-menu";
import { marksHuntWindow, monitorHuntRange, pushHuntRange, sourceOf, watchCounts, type WatchFilter, type WatchRange } from "./watch";
import { monitorQuery } from "../shared/push";
import { SettingsPage } from "@/components/settings-page";
import { MeMenu, type Me } from "@/components/me-menu";
import { StatusFooter } from "@/components/status-footer";
import { SystemMeters } from "@/components/system-meters";
import { VersionFooter } from "@/components/version-footer";
import { TimeRangePicker } from "@/components/time-range-picker";
import { SharesDialog } from "@/components/shares-dialog";
import { ThroughputMeter } from "@/components/throughput-meter";
import { WidgetCanvas, type SeriesData } from "@/components/widget-canvas";
import { BoardEmpty } from "@/components/board-inputs";
import type { HbarCommand } from "@/components/hbar-widget";
import { Button } from "@/components/ui/button";
import { CountText } from "@/components/count-text";
import { cn } from "@/lib/utils";
import type {
  AlertRule,
  MonitorStretch,
  MonitorView,
  MonitorsResponse,
  FacetValue,
  Facets,
  HistogramBucket,
  LogEvent,
  SavedSearch,
  SearchAggResult,
  SearchResult,
  SearchScan,
} from "@/types";
import { BrandMark } from "./brand-mark";
import { eventKey, indexOfEventKey } from "./event-key";
import { isTypingTarget } from "./keyboard";
import { isEmptyIngest, nextIngested } from "./empty-ingest";
import { joinTraceRef } from "../shared/ids";
import {
  formatChangeMarkLabel,
  type ChangeMark,
  type ChangeMarkKind,
} from "../shared/change-mark";
import type { FingerprintCutResult } from "../shared/fingerprint-cut";
import type { ProfileResponse } from "../shared/profile";
import type { Span, TraceResponse } from "../shared/span";
import {
  inspectTabKey,
  upsertInspectTab,
  type InspectTab,
} from "./inspect-tabs";
import {
  blankSearchSnap,
  closeWorkspace,
  decideFocusMarkInLogs,
  decideOpenSurroundings,
  duplicateSnap,
  followChildSnap,
  insertWorkspace,
  isReaderKind,
  parkedCutLine,
  selectionAfterReplace,
  shouldRestorePaint,
  shouldRestoreParkedCut,
  snapPinnedEvent,
  stampWorkspace,
  surroundingsEventSnap,
  surroundingsMarkSnap,
  urlSearchSnap,
  workspaceHuntKey,
  workspaceLiveLabel,
  ordinalLabels,
  type HistogramExploreOrigin,
  type Workspace,
  type WorkspaceFollow,
  type WorkspaceKind,
  type WorkspacePaint,
  type WorkspaceSnap,
} from "./workspaces";
import {
  cutCrumbLabel,
  cutRailSurface,
  fingerprintCutViewWindows,
  type FingerprintCutSnap,
} from "./fingerprint-cut";
import { compareFoldWindows, type CompareFoldSnap } from "./compare-fold";
import { fillHistogram, rangeDurationMs } from "./fill-histogram";
import {
  bindForBoard,
  boardSlotCount,
  boundQuery,
  isBoardUnbound,
  storedBoardQuery,
  type BoardSlots,
} from "./boards";
import { compileQuery, isCoreField } from "../query/compile";
import {
  logsScanBudgetRefuseReason,
  mergeAggBuckets,
  mergeAggSplits,
  parseSearchAgg,
  refusedAgg,
  rateFromHistogram,
  windowSeconds,
} from "../query/agg";
import { formatCompactCount } from "@/count-format";
import { QueryErrorChip } from "@/components/query-error-chip";
import {
  SearchQueryField,
  type MenuSuggestion,
} from "@/components/search-query-field";
import { isAttrIdent, maxAttrFacets, parseAttrFacets, parsePromotedCols } from "../shared/attrs";
import {
  applySeriesSearchParams,
  defaultLayout,
  isDefaultLayout,
  isSingleHistogram,
  patchWidget,
  primaryTimeseries,
  seriesQueryKey,
  widgetHbarFetch,
  hbarFetchNeedsNetwork,
  widgetSeriesQueries,
  attrSeriesKey,
  facetSeriesKey,
  type HbarFetch,
  type SeriesQuery,
  type WidgetDef,
} from "../shared/widgets";
import {
  applyFieldValues,
  cheapSuggestKeys,
  emptyFieldsCatalog,
  graphMetricLabels,
  isChartSummaryKey,
  suggestRolesFromKeys,
  type FieldRole,
  type FieldsResponse,
  type FieldsSuggestPayload,
  type FieldsValuesPayload,
  type FieldsWave,
} from "../shared/fields";
import { formatMetricLabels, parseMetricRef } from "../shared/metric";
import {
  histogramIntervalMs,
  type HistogramChartKind,
  type HistogramIntervalId,
  type HistogramSplit,
} from "../query/histogram";
import {
  clampHistogramWindow,
  autoChipInterval,
  displayedHistogramInterval,
  histogramExploreResetLabel,
  histogramChartNeedsRefetch,
  resolveQueryHistogramStep,
} from "./histogram-zoom";
import { parseRangeMs, retentionRangeMs } from "../query/relative";
import {
  surroundingDefaultN,
  surroundingMaxN,
  surroundingStepN,
} from "../query/surrounding";
import { excludeFieldToken, setFieldToken, toggleFieldToken, addFieldToken, activeFacetValues, queryFieldKeys, toggleFingerprintCutFilter } from "./query-tokens";
import {
  histogramTotal,
  livePageSize,
  mergeHistogramBuckets,
  mergeLiveEvents,
} from "./merge-live";
import {
  isoFromLocal,
  parseSearchUrl,
  serializeSearchUrl,
  toLocalInput,
  type OperatorView,
  type RangeMode,
} from "./search-url";
import { SEARCH_SLOW_AFTER_MS, formatSearchElapsed, rangeTriggerLabel } from "./time-range";
import { SeriesCatalogContext, type SeriesCatalog } from "./series-catalog";
import type { MetricEntry } from "./series-list";
import {
  bandWindowKey,
  searchWindowMs,
  windowHead,
  windowMeta,
  type SearchWindow,
} from "./window-identity";
import { flattenTrace } from "./waterfall";
import { followOnOpened, followQuery } from "./follow";
import { eventCursor } from "../shared/event-cursor";
import {
  followOpened,
  followSpanSearchParams,
  type FollowOpened,
  type FollowSpan,
} from "../shared/follow-span";
import { FollowOpenedChip } from "@/components/follow-opened-chip";
import { HeldContext } from "./held-context";
import { heldView } from "./held-view";
import { HeldPill, ScopeChipView } from "@/components/held-tells";
import { useHeld } from "./use-held";
import {
  deriveLiveSeries,
  extraQueryLiveFetch,
  extraQueryNeedsSearch,
  mergeIncrementalExtraSeries,
  skipKeysFromFieldRoles,
} from "./live-widget-clock";

const emptyFacets: Facets = { level: [], service: [], host: [] };

type MetricNameRow = {
  k: string;
  n: number;
  kind?: MetricEntry["kind"];
  of?: string;
  reading?: MetricEntry["reading"];
  unit?: string;
  description?: string;
};

type MetricNamesReply = {
  keys: MetricNameRow[];
  total?: number;
  picked?: MetricNameRow[];
};

function metricEntry(item: MetricNameRow): MetricEntry {
  return {
    name: item.k,
    kind: item.kind ?? "gauge",
    points: item.n,
    of: item.of,
    reading: item.reading,
    ...(item.unit ? { unit: item.unit } : {}),
    ...(item.description ? { description: item.description } : {}),
  };
}

/** A metric list is asked for by window alone: the log query does not filter metrics. */
function metricWindowParams(query: string): URLSearchParams {
  const params = new URLSearchParams(query);
  for (const key of ["q", "agg", "metric", "ml", "msplit"]) {
    params.delete(key);
  }
  return params;
}

function facetOnlyParams(facetQuery: string): URLSearchParams {
  const params = new URLSearchParams(facetQuery);
  params.delete("split");
  params.delete("agg");
  params.delete("events");
  params.delete("since");
  params.delete("cursor");
  params.delete("step");
  params.delete("limit");
  return params;
}

function stampSeries(data: Omit<SeriesData, "fetchedAt">): SeriesData {
  return { ...data, fetchedAt: Date.now() };
}

async function fetchHbarSeries(
  hbar: HbarFetch,
  facetQuery: string,
  windowTotal: number,
  signal: AbortSignal,
): Promise<Record<string, SeriesData>> {
  const map: Record<string, SeriesData> = {};
  const jobs: Promise<void>[] = [];
  if (hbar.coreLimit !== null) {
    jobs.push(
      (async () => {
        const params = facetOnlyParams(facetQuery);
        params.set("limit", String(hbar.coreLimit));
        params.set("omit", "0");
        const res = await fetch(`/api/facets?${params.toString()}`, { signal });
        if (!res.ok) {
          return;
        }
        const json = (await res.json()) as Facets;
        for (const field of ["level", "service", "host"] as const) {
          map[facetSeriesKey(field)] = stampSeries({
            histogram: [],
            agg: null,
            total: windowTotal,
            values: json[field] ?? [],
          });
        }
      })(),
    );
  }
  if (hbar.none) {
    map[facetSeriesKey("none")] = stampSeries({
      histogram: [],
      agg: null,
      total: windowTotal,
      values: [{ v: "events", n: windowTotal }],
    });
  }
  if (hbar.attrKeys.length > 0) {
    jobs.push(
      (async () => {
        const params = facetOnlyParams(facetQuery);
        params.set("attrs", hbar.attrKeys.join(","));
        params.set("limit", String(hbar.attrLimit));
        params.set("omit", "0");
        const res = await fetch(`/api/attr-facets?${params.toString()}`, {
          signal,
        });
        if (!res.ok) {
          return;
        }
        const json = (await res.json()) as Record<string, FacetValue[]>;
        for (const key of hbar.attrKeys) {
          map[attrSeriesKey(key)] = stampSeries({
            histogram: [],
            agg: null,
            total: windowTotal,
            values: json[key] ?? [],
          });
        }
      })(),
    );
  }
  await Promise.all(jobs);
  return map;
}

async function fetchIncrementalExtras(
  queries: SeriesQuery[],
  facetQuery: string,
  since: string | null,
  prev: Record<string, SeriesData>,
  histFrom: string | undefined,
  histTo: string | undefined,
  intervalMs: number,
  signal: AbortSignal,
): Promise<Record<string, SeriesData>> {
  const extraEntries = await Promise.all(
    queries.map(async (item) => {
      const extraParams = new URLSearchParams(facetQuery);
      extraParams.set("events", "0");
      applySeriesSearchParams(extraParams, item);
      extraParams.delete("cursor");
      if (since) {
        extraParams.set("since", since);
      } else {
        extraParams.delete("since");
      }
      const extraRes = await fetch(`/api/search?${extraParams.toString()}`, {
        signal,
      });
      if (!extraRes.ok) {
        return null;
      }
      const extraJson = (await extraRes.json()) as SearchResult;
      const key = seriesQueryKey(item);
      return [
        key,
        stampSeries(
          mergeIncrementalExtraSeries(
            prev[key],
            {
              histogram: extraJson.histogram,
              agg: extraJson.agg ?? null,
            },
            item,
            histFrom,
            histTo,
            intervalMs,
          ),
        ),
      ] as const;
    }),
  );
  const map: Record<string, SeriesData> = {};
  for (const entry of extraEntries) {
    if (entry) {
      map[entry[0]] = entry[1];
    }
  }
  return map;
}

function searchSpanMs(
  range: RangeMode,
  from: string,
  to: string,
  live: boolean,
  liveWindow: number,
): number {
  if (live && range === "custom") {
    return liveWindow;
  }
  if (range !== "custom") {
    return parseRangeMs(range) ?? 60 * 60 * 1000;
  }
  return rangeDurationMs(from, to);
}

export function App() {
  const boot = useMemo(
    () => parseSearchUrl(typeof window === "undefined" ? "" : window.location.search),
    [],
  );
  const plotRef = useRef<HTMLDivElement>(null);
  const [from, setFrom] = useState(boot.from);
  const [to, setTo] = useState(boot.to);
  const [range, setRange] = useState<RangeMode>(boot.range);
  const [q, setQ] = useState(boot.q);
  const [live, setLive] = useState(boot.live);
  const [savedId, setSavedId] = useState<string | null>(boot.saved);
  const [bind, setBind] = useState<Record<string, string>>(boot.bind);
  const [boardBindValues, setBoardBindValues] = useState<Record<string, FacetValue[]>>(
    {},
  );
  const [view, setView] = useState<OperatorView>(boot.view);
  const [split, setSplit] = useState<HistogramSplit>(boot.split);
  const [chart, setChart] = useState<HistogramChartKind>(boot.chart);
  const [logScale, setLogScale] = useState(boot.logScale);
  const [step, setStep] = useState<HistogramIntervalId | null>(boot.step);
  const [agg, setAgg] = useState<string | null>(boot.agg);
  const [replaceY, setReplaceY] = useState(boot.replaceY);
  const [logsOn, setLogsOn] = useState(boot.logs);
  const [widgets, setWidgets] = useState<WidgetDef[]>(boot.widgets);
  const [seriesByKey, setSeriesByKey] = useState<Record<string, SeriesData>>({});
  const [explore, setExplore] = useState<HistogramExploreOrigin | null>(null);
  const [wsKind, setWsKind] = useState<WorkspaceKind>("search");
  const [wsId, setWsId] = useState(1);
  const [wsSeq, setWsSeq] = useState(1);
  const [wsList, setWsList] = useState<Workspace[]>(() => [
    {
      id: 1,
      kind: "search",
      label: workspaceLiveLabel({
        kind: "search",
        q: boot.q,
        savedName: null,
        savedDirty: false,
        follow: null,
        surrAnchor: null,
        focusMark: null,
      }),
      snap: urlSearchSnap(boot),
    },
  ]);
  const [follow, setFollow] = useState<WorkspaceFollow | null>(null);
  const followOpenRef = useRef<
    ((field: string, value: string, opened: FollowOpened) => void) | null
  >(null);
  const [surrAnchor, setSurrAnchor] = useState<LogEvent | null>(null);
  const [surrSel, setSurrSel] = useState<LogEvent | null>(null);
  const [focusMark, setFocusMark] = useState<ChangeMark | null>(null);
  const [inspectTabs, setInspectTabs] = useState<InspectTab[]>([]);
  const [activeInspect, setActiveInspect] = useState<InspectTab | null>(null);
  const [traceLoad, setTraceLoad] = useState<{
    value: string;
    result: TraceResponse | null;
    loading: boolean;
    failed: boolean;
  }>({ value: "", result: null, loading: false, failed: false });
  const [profileLoad, setProfileLoad] = useState<{
    key: string;
    result: ProfileResponse | null;
    loading: boolean;
    failed: boolean;
  }>({ key: "", result: null, loading: false, failed: false });
  const isSurr = wsKind === "surroundings";
  const isMarkFocus = isSurr && focusMark !== null;
  const traceView = activeInspect?.kind === "trace" ? activeInspect : null;
  /** The span picked in a trace's waterfall, read in the rail; `spanRail` is which of it or the event the rail shows. */
  const [spanSel, setSpanSel] = useState<{ trace: string; spanId: string } | null>(null);
  const [spanRail, setSpanRail] = useState<"span" | "event">("span");
  const profileView = activeInspect?.kind === "profile" ? activeInspect : null;
  const [aroundN, setAroundN] = useState(surroundingDefaultN);
  const [aroundMode, setAroundMode] = useState<ContextMode>("all");
  const [attrFacets, setAttrFacets] = useState<string[]>(boot.attrFacets);
  const [cols, setCols] = useState<string[]>(boot.cols);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [ingested, setIngested] = useState(false);
  const [histogram, setHistogram] = useState<HistogramBucket[]>([]);
  const [searchWindow, setSearchWindow] = useState<SearchWindow | null>(null);
  const [windowMarks, setWindowMarks] = useState<ChangeMark[]>([]);
  // A first-seen alert's link (`cut=<mark id>`) opens that mark's Fingerprints once, on arrival.
  const pendingCutRef = useRef<string | null>(
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("cut"),
  );
  // `mark=<id>` (#260): the hunt lands with the Compare fold open under that mark.
  const pendingMarkRef = useRef<string | null>(
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("mark"),
  );
  const [markBefore, setMarkBefore] = useState<ChangeMark | null>(null);
  const [markAfter, setMarkAfter] = useState<ChangeMark | null>(null);
  const [marksOff, setMarksOff] = useState<ChangeMarkKind[]>([]);
  const [marksMuted, setMarksMuted] = useState<string[]>([]);
  const [cut, setCut] = useState<FingerprintCutSnap | null>(null);
  const [compare, setCompare] = useState<CompareFoldSnap | null>(null);
  const [focusMarkId, setFocusMarkId] = useState<string | null>(null);
  const [aggSeries, setAggSeries] = useState<SearchAggResult | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<Facets>(emptyFacets);
  const [facetsLoading, setFacetsLoading] = useState(true);
  // What this instance holds (#139): where each source it pulls from stands.
  const held = useHeld(view === "search", live);
  const linked = held.sources.length > 0;
  const linkedRef = useRef(linked);
  linkedRef.current = linked;
  const lastFacetQueryRef = useRef<string | null>(null);
  const [attrFacetValues, setAttrFacetValues] = useState<Record<string, FacetValue[]>>(
    {},
  );
  const [attrFacetsLoading, setAttrFacetsLoading] = useState(false);
  const [attrPrefixes, setAttrPrefixes] = useState<Record<string, string>>({});
  const [attrPrefixValues, setAttrPrefixValues] = useState<Record<string, FacetValue[]>>(
    {},
  );
  const [attrKeyOptions, setAttrKeyOptions] = useState<Array<{ k: string; n: number }>>(
    [],
  );
  const [attrKeysLoading, setAttrKeysLoading] = useState(false);
  const [numericKeys, setNumericKeys] = useState<string[]>([]);
  const [metricNames, setMetricNames] = useState<string[]>([]);
  /** The same names with their kinds, how many there are in all, and the ones cards already hold. */
  const [metricCatalog, setMetricCatalog] = useState<{
    entries: MetricEntry[];
    total: number;
    picked: Record<string, MetricEntry>;
  }>({ entries: [], total: 0, picked: {} });
  /** The window the names were last asked for, to ask it for more by name. */
  const metricWindowRef = useRef("");
  const pickedMetricsRef = useRef<string[]>([]);
  const [saved, setSaved] = useState<SavedSearch[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailOpen, setDetailOpen] = useState(false);
  // The marks panel (#262) takes the event panel's slot: one at a time.
  const [marksPanelOpen, setMarksPanelOpen] = useState(false);
  // Watch this (#264): the sheet over the rows.
  const [watchThisOpen, setWatchThisOpen] = useState(false);
  const [pinnedEvent, setPinnedEvent] = useState<LogEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanRefuse, setScanRefuse] = useState<SearchScan | null>(null);
  const [retentionDays, setRetentionDays] = useState(30);
  const [unauthorized, setUnauthorized] = useState(false);
  const [instance, setInstance] = useState<InstanceInfo | null>(null);
  const [homeId, setHomeId] = useState<string | null>(null);

  const loadHome = useCallback(async () => {
    const res = await fetch("/api/home");
    if (res.ok) {
      setHomeId(((await res.json()) as { saved_id: string | null }).saved_id);
    }
  }, []);

  useEffect(() => {
    void loadHome().catch(() => undefined);
  }, [loadHome]);


  const loadInstance = useCallback(async () => {
    const res = await fetch("/api/instance");
    if (res.ok) {
      setInstance((await res.json()) as InstanceInfo);
    }
  }, []);
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    void fetch("/api/me")
      .then(async (res) => (res.ok ? setMe((await res.json()) as Me) : undefined))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void loadInstance().catch(() => undefined);
  }, [loadInstance]);

  useEffect(() => {
    document.title = instanceTitle(instance);
  }, [instance]);

  // A sign-in that ran out (or a password change) answers 401: the page itself then shows the
  // sign-in page. Once a minute at most, so a 401 the page cannot fix does not loop.
  useEffect(() => {
    if (!unauthorized) {
      return;
    }
    try {
      const last = Number(sessionStorage.getItem("toposcope:signin-reload") ?? 0);
      if (Date.now() - last < 60_000) {
        return;
      }
      sessionStorage.setItem("toposcope:signin-reload", String(Date.now()));
    } catch {
      return;
    }
    window.location.reload();
  }, [unauthorized]);

  async function signOut() {
    await fetch("/api/sign-out", { method: "POST" }).catch(() => undefined);
    window.location.assign("/?signed_out=1");
  }
  const [alerts, setAlerts] = useState<MonitorView[]>([]);
  /** Watch (#175): every monitor, and its stretches on Watch's clock. */
  const [monitors, setMonitors] = useState<MonitorsResponse | null>(null);
  const [watchRange, setWatchRange] = useState<WatchRange>("24h");
  const watchRangeRef = useRef<WatchRange>("24h");
  const [watchFilter, setWatchFilter] = useState<WatchFilter>("all");
  const [watchMarkList, setWatchMarkList] = useState<ChangeMark[]>([]);
  /** 18p: a new monitor chooses its source first. */
  const [newMonitor, setNewMonitor] = useState<{ savedSearchId: string | null; lockSearch: boolean } | null>(null);
  /** 18s: a push monitor's editor (#177). */
  const [pushDraft, setPushDraft] = useState<PushDraft | null>(null);
  /** 18r: an HTTP(S) monitor's editor. */
  const [httpDraft, setHttpDraft] = useState<HttpDraft | null>(null);
  /** 18r's TCP · certificate editor (#180). */
  const [netDraft, setNetDraft] = useState<NetDraft | null>(null);
  /** The monitor read beside a Search tab (18i), by tab. */
  const [monitorRail, setMonitorRail] = useState<Record<number, string>>({});
  /** Stretches of the monitors on this tab's saved search, on its clock (18o). */
  const [huntStretches, setHuntStretches] = useState<MonitorStretch[]>([]);
  const [alertsCanLink, setAlertsCanLink] = useState(false);
  const [fields, setFields] = useState<FieldsResponse | null>(null);
  const [fieldLinks, setFieldLinks] = useState<Record<string, string>>({});
  const [fieldRoles, setFieldRoles] = useState<Record<string, FieldRole>>({});
  const [fieldsWave, setFieldsWave] = useState<FieldsWave | null>(null);
  const [fieldsWarm, setFieldsWarm] = useState(false);
  const [fieldsElapsedMs, setFieldsElapsedMs] = useState(0);
  const [fieldsFailed, setFieldsFailed] = useState(false);
  const [searching, setSearching] = useState(true);
  const [searchElapsedMs, setSearchElapsedMs] = useState(0);
  const [lastMs, setLastMs] = useState<number | null>(null);
  const [showFaults, setShowFaults] = useState(false);
  const [chipInField, setChipInField] = useState(true);
  const [queryHistory, setQueryHistory] = useState<string[]>([]);
  // Access (#265): its filter; the Links tab is Access filtered to links.
  const [accessFilter, setAccessFilter] = useState<AccessFilter>("all");
  // A link's own page (#267), from its Access row.
  const [linkPageId, setLinkPageId] = useState<string | null>(null);
  // A share's own page (#266), from its Access row.
  const [sharePage, setSharePage] = useState<string | null>(null);
  const [sharesOpen, setSharesOpen] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveUpdate, setSaveUpdate] = useState(false);
  const [alertDraft, setAlertDraft] = useState<AlertDraft | null>(null);
  const liveWindowMs = useRef(60 * 60 * 1000);
  const searchRef = useRef<HTMLInputElement>(null);
  const clockRef = useRef<HTMLButtonElement>(null);
  const skipUrl = useRef(true);
  const histogramRef = useRef(histogram);
  const aggSeriesRef = useRef(aggSeries);
  const widgetsRef = useRef(widgets);
  const logsOnRef = useRef(logsOn);
  const lastToRef = useRef<string | null>(null);
  const livePollsRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const fullPollAcRef = useRef<AbortController | null>(null);
  const extraAbortRef = useRef<AbortController | null>(null);
  const extraInflightRef = useRef(false);
  const hbarAbortRef = useRef<AbortController | null>(null);
  const fieldsAbortRef = useRef<AbortController | null>(null);
  const fieldsRef = useRef<FieldsResponse | null>(null);
  const fieldsStartedRef = useRef(0);
  const blockingSearchRef = useRef(false);
  const viewGenRef = useRef(0);
  const lastPaintHuntRef = useRef<string | null>(null);
  const skipAttrFacetGen = useRef<number | null>(null);
  const seriesByKeyRef = useRef(seriesByKey);
  const fieldRolesRef = useRef(fieldRoles);
  const attrFacetsRef = useRef(attrFacets);
  histogramRef.current = histogram;
  aggSeriesRef.current = aggSeries;
  widgetsRef.current = widgets;
  logsOnRef.current = logsOn;
  fieldsRef.current = fields;
  seriesByKeyRef.current = seriesByKey;
  fieldRolesRef.current = fieldRoles;
  attrFacetsRef.current = attrFacets;

  const loadAlerts = useCallback(async () => {
    const res = await fetch(`/api/monitors?range=${watchRangeRef.current}`);
    if (res.status === 401) {
      setUnauthorized(true);
      throw new Error("Unauthorized. Sign in again.");
    }
    if (!res.ok) {
      throw new Error(`Monitors failed (${res.status})`);
    }
    const json = (await res.json()) as MonitorsResponse;
    setMonitors(json);
    setAlerts(json.monitors);
    setAlertsCanLink(Boolean(json.link));
  }, []);

  const loadWatchMarks = useCallback(async () => {
    const res = await fetch(`/api/marks?range=${watchRangeRef.current}`);
    if (!res.ok) {
      return;
    }
    const body = (await res.json()) as { marks?: ChangeMark[] };
    setWatchMarkList(Array.isArray(body.marks) ? body.marks : []);
  }, []);

  // Fields reads a fixed last 24 h under Settings, not the hunt's clock (28b, #292).
  const fieldsQuery = useCallback(() => `range=${FIELDS_RANGE}`, []);

  const loadFieldConfig = useCallback(async () => {
    const res = await fetch("/api/fields");
    if (res.status === 401) {
      setUnauthorized(true);
      throw new Error("Unauthorized. Sign in again.");
    }
    if (!res.ok) {
      throw new Error(`Fields failed (${res.status})`);
    }
    const json = (await res.json()) as FieldsResponse;
    setFieldLinks(json.links ?? {});
    setFieldRoles(json.roles ?? {});
  }, []);

  const loadFields = useCallback(async () => {
    const query = fieldsQuery();
    if (!query) {
      return;
    }
    fieldsAbortRef.current?.abort();
    const ac = new AbortController();
    fieldsAbortRef.current = ac;
    const first = (fieldsRef.current?.keys.length ?? 0) === 0;
    fieldsStartedRef.current = Date.now();
    setFieldsFailed(false);
    setFieldsWarm(!first);
    setFieldsElapsedMs(0);
    setFieldsWave("keys");
    const get = async (path: string) => {
      const res = await fetch(path, { signal: ac.signal });
      if (res.status === 401) {
        setUnauthorized(true);
        throw new Error("Unauthorized. Sign in again.");
      }
      if (!res.ok) {
        throw new Error(`Fields failed (${res.status})`);
      }
      return res.json();
    };
    try {
      const keysJson = (await get(`/api/fields?${query}&wave=keys`)) as FieldsResponse;
      if (ac.signal.aborted) {
        return;
      }
      setFields({
        ...emptyFieldsCatalog(),
        ...keysJson,
        metricLabels: [],
        suggestRoles: {},
        suggestLinks: {},
      });
      setFieldLinks(keysJson.links ?? {});
      setFieldRoles(keysJson.roles ?? {});
      if (keysJson.events <= 0) {
        setFieldsWave(null);
        setFieldsWarm(false);
        return;
      }
      setFieldsWave("values");
      const valuesJson = (await get(
        `/api/fields?${query}&wave=values`,
      )) as FieldsValuesPayload;
      if (ac.signal.aborted) {
        return;
      }
      const withValues = applyFieldValues(keysJson.keys, valuesJson.values ?? {});
      setFields((prev) =>
        prev
          ? { ...prev, keys: withValues }
          : { ...emptyFieldsCatalog(), ...keysJson, keys: withValues },
      );
      setFieldsWave("suggest");
      const cheap = cheapSuggestKeys(withValues);
      const cheapQ = cheap.length ? `&cheap=${encodeURIComponent(cheap.join(","))}` : "";
      const suggestJson = (await get(
        `/api/fields?${query}&wave=suggest${cheapQ}`,
      )) as FieldsSuggestPayload;
      if (ac.signal.aborted) {
        return;
      }
      setFields((prev) =>
        prev
          ? {
              ...prev,
              metricLabels: suggestJson.metricLabels ?? [],
              suggestRoles: suggestRolesFromKeys(withValues),
              suggestLinks: suggestJson.suggestLinks ?? {},
            }
          : null,
      );
      setFieldsWave(null);
      setFieldsWarm(false);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      setFieldsFailed(true);
      if (first) {
        setFields(null);
      }
      if (fieldsAbortRef.current === ac) {
        setFieldsWave(null);
        setFieldsWarm(false);
      }
      throw err;
    }
  }, [fieldsQuery]);

  const saveFields = useCallback(
    async (roles: Record<string, FieldRole>, links: Record<string, string>) => {
      const res = await fetch("/api/fields", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roles, links }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(json?.error ?? `Fields save failed (${res.status})`);
      }
      const json = (await res.json()) as {
        roles: Record<string, FieldRole>;
        links: Record<string, string>;
      };
      setFieldLinks(json.links ?? {});
      setFieldRoles(json.roles ?? {});
      setFields((prev) =>
        prev ? { ...prev, roles: json.roles, links: json.links } : prev,
      );
    },
    [],
  );

  function cancelFields() {
    fieldsAbortRef.current?.abort();
    setFieldsWave(null);
    setFieldsWarm(false);
  }

  const loadSaved = useCallback(async () => {
    const res = await fetch("/api/saved-searches");
    if (res.status === 401) {
      setUnauthorized(true);
      throw new Error("Unauthorized. Sign in again.");
    }
    if (!res.ok) {
      throw new Error(`Saved searches failed (${res.status})`);
    }
    const json = (await res.json()) as { searches: SavedSearch[] };
    setSaved(json.searches);
  }, []);

  const loadFacets = useCallback(async (query: string) => {
    const gen = viewGenRef.current;
    lastFacetQueryRef.current = query;
    setFacetsLoading(true);
    try {
      // Linked, the toposcope group counts each source in this hunt (#139).
      const res = await fetch(`/api/facets?${query}${linkedRef.current ? "&fields=toposcope" : ""}`);
      if (viewGenRef.current !== gen) {
        return;
      }
      if (!res.ok) {
        setFacets(emptyFacets);
        return;
      }
      const json = (await res.json()) as Facets;
      if (viewGenRef.current !== gen) {
        return;
      }
      setFacets(json);
    } catch {
      if (viewGenRef.current !== gen) {
        return;
      }
      setFacets(emptyFacets);
    } finally {
      if (viewGenRef.current === gen) {
        setFacetsLoading(false);
      }
    }
  }, []);
  // The first answer that something is linked: count the sources in the hunt already open.
  useEffect(() => {
    if (linked && lastFacetQueryRef.current !== null) {
      void loadFacets(lastFacetQueryRef.current);
    }
  }, [linked, loadFacets]);

  const loadMetricNames = useCallback(async (query: string) => {
    const gen = viewGenRef.current;
    try {
      const params = metricWindowParams(query);
      metricWindowRef.current = params.toString();
      if (pickedMetricsRef.current.length > 0) {
        params.set("picked", pickedMetricsRef.current.join(","));
      }
      const res = await fetch(`/api/metric-names?${params.toString()}`);
      if (viewGenRef.current !== gen) {
        return;
      }
      if (!res.ok) {
        setMetricNames([]);
        setMetricCatalog({ entries: [], total: 0, picked: {} });
        return;
      }
      const json = (await res.json()) as MetricNamesReply;
      setMetricNames(json.keys.map((item) => item.k));
      setMetricCatalog({
        entries: json.keys.map(metricEntry),
        total: json.total ?? json.keys.length,
        picked: Object.fromEntries((json.picked ?? []).map((item) => [item.k, metricEntry(item)])),
      });
    } catch {
      if (viewGenRef.current !== gen) {
        return;
      }
      setMetricNames([]);
      setMetricCatalog({ entries: [], total: 0, picked: {} });
    }
  }, []);

  /** Names past the ones loaded, asked for by any part of the name. */
  const findMetrics = useCallback(async (find: string): Promise<MetricEntry[]> => {
    try {
      const params = new URLSearchParams(metricWindowRef.current);
      params.set("find", find);
      const res = await fetch(`/api/metric-names?${params.toString()}`);
      if (!res.ok) {
        return [];
      }
      return ((await res.json()) as MetricNamesReply).keys.map(metricEntry);
    } catch {
      return [];
    }
  }, []);

  /** A metric's label keys in this window, for a panel's split picker. */
  const metricLabelKeys = useCallback(async (name: string) => {
    try {
      const params = new URLSearchParams(metricWindowRef.current);
      params.set("name", name);
      const res = await fetch(`/api/metric-labels?${params.toString()}`);
      if (!res.ok) {
        return [];
      }
      return ((await res.json()) as { labels: Array<{ key: string; values: number }> }).labels;
    } catch {
      return [];
    }
  }, []);

  const loadNumericKeys = useCallback(async (query: string) => {
    const gen = viewGenRef.current;
    try {
      const res = await fetch(`/api/numeric-keys?${query}`);
      if (viewGenRef.current !== gen) {
        return;
      }
      if (!res.ok) {
        setNumericKeys([]);
        return;
      }
      const json = (await res.json()) as { keys: Array<{ k: string; n: number }> };
      setNumericKeys(json.keys.map((item) => item.k));
    } catch {
      if (viewGenRef.current !== gen) {
        return;
      }
      setNumericKeys([]);
    }
  }, []);

  const loadAttrKeys = useCallback(async (query: string) => {
    const gen = viewGenRef.current;
    try {
      const res = await fetch(`/api/attr-keys?${query}`);
      if (viewGenRef.current !== gen) {
        return;
      }
      if (!res.ok) {
        return;
      }
      const json = (await res.json()) as { keys: Array<{ k: string; n: number }> };
      setAttrKeyOptions(json.keys);
    } catch {
      // keep last list
    }
  }, []);

  const windowParams = useCallback(() => {
    const params = new URLSearchParams();
    if (range !== "custom") {
      params.set("range", range);
    } else {
      const fromIso = isoFromLocal(from);
      const toIso = isoFromLocal(to);
      if (fromIso) {
        params.set("from", fromIso);
      }
      if (toIso) {
        params.set("to", toIso);
      }
    }
    const qVal = q.trim();
    if (qVal) {
      params.set("q", qVal);
    }
    return params;
  }, [from, to, range, q]);

  const refreshHbarSeries = useCallback(
    async (nextWidgets: WidgetDef[]) => {
      const hbar = widgetHbarFetch(nextWidgets);
      hbarAbortRef.current?.abort();
      const ac = new AbortController();
      hbarAbortRef.current = ac;
      const total = histogramTotal(histogramRef.current);
      try {
        const patch = await fetchHbarSeries(
          hbar,
          windowParams().toString(),
          total,
          ac.signal,
        );
        if (ac.signal.aborted) {
          return;
        }
        setSeriesByKey((prev) => ({ ...prev, ...patch }));
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return;
        }
      }
    },
    [windowParams],
  );

  const loadAttrFacets = useCallback(
    async (pins: string[], query: string) => {
      const gen = viewGenRef.current;
      if (pins.length === 0) {
        if (viewGenRef.current === gen) {
          setAttrFacetValues({});
          setAttrFacetsLoading(false);
        }
        return;
      }
      setAttrFacetsLoading(true);
      try {
        const params = new URLSearchParams(query);
        params.set("attrs", pins.join(","));
        const res = await fetch(`/api/attr-facets?${params.toString()}`);
        if (viewGenRef.current !== gen) {
          return;
        }
        if (!res.ok) {
          setAttrFacetValues({});
          return;
        }
        const json = (await res.json()) as Record<string, FacetValue[]>;
        if (viewGenRef.current !== gen) {
          return;
        }
        setAttrFacetValues(json);
      } catch {
        if (viewGenRef.current !== gen) {
          return;
        }
        setAttrFacetValues({});
      } finally {
        if (viewGenRef.current === gen) {
          setAttrFacetsLoading(false);
        }
      }
    },
    [],
  );

  const selectionRef = useRef({
    index: 0,
    detailOpen: false,
    events: [] as LogEvent[],
  });
  selectionRef.current = {
    index: selectedIndex,
    detailOpen,
    events,
  };
  const loadTowardTsRef = useRef<number | null>(null);

  const runSearch = useCallback(
    async (
      mode: "replace" | "append" | "poll",
      overrides?: {
        q?: string;
        from?: string;
        to?: string;
        range?: RangeMode;
        live?: boolean;
        split?: HistogramSplit;
        step?: HistogramIntervalId | null;
        chart?: HistogramChartKind;
        agg?: string | null;
        metric?: string | null;
        metricLabels?: Record<string, string>;
        logs?: boolean;
        widgets?: WidgetDef[];
        park?: ReturnType<typeof parkedCutLine>;
      },
    ) => {
      setError(null);
      setUnauthorized(false);
      if (mode !== "poll") {
        setScanRefuse(null);
      }
      if (mode === "poll" && blockingSearchRef.current) {
        return;
      }
      const wouldIncremental =
        mode === "poll" && (livePollsRef.current + 1) % 15 !== 0;
      if (
        wouldIncremental &&
        fullPollAcRef.current &&
        !fullPollAcRef.current.signal.aborted
      ) {
        return;
      }
      if (mode !== "poll") {
        setSearching(true);
        livePollsRef.current = 0;
        blockingSearchRef.current = true;
      }
      if (mode === "replace") {
        loadTowardTsRef.current = null;
      }
      if (mode !== "poll" || !wouldIncremental) {
        extraAbortRef.current?.abort();
      }
      abortRef.current?.abort();
      if (mode !== "poll") {
        hbarAbortRef.current?.abort();
      }
      const ac = new AbortController();
      abortRef.current = ac;
      const params = new URLSearchParams();
      const isLive = overrides?.live ?? live;
      const activeRange = overrides?.range ?? range;
      let fromIso = isoFromLocal(overrides?.from ?? from);
      let toIso = isoFromLocal(overrides?.to ?? to);
      if (activeRange !== "custom") {
        params.set("range", activeRange);
      } else if (isLive) {
        const now = Date.now();
        fromIso = new Date(now - liveWindowMs.current).toISOString();
        toIso = new Date(now).toISOString();
        params.set("from", fromIso);
        params.set("to", toIso);
      } else {
        if (fromIso) params.set("from", fromIso);
        if (toIso) params.set("to", toIso);
      }
      const qVal = (overrides?.q ?? q).trim();
      if (compileQuery(qVal).faults.length > 0) {
        if (mode === "poll") {
          return;
        }
        if (mode === "replace") {
          setShowFaults(true);
          blockingSearchRef.current = false;
          setSearching(false);
          return;
        }
      }
      if (qVal) params.set("q", qVal);
      const activeSplit = overrides?.split ?? split;
      const activeStep = overrides?.step !== undefined ? overrides.step : step;
      const activeChart = overrides?.chart ?? chart;
      const querySpan = searchSpanMs(
        activeRange,
        overrides?.from ?? from,
        overrides?.to ?? to,
        isLive,
        liveWindowMs.current,
      );
      const sentStep = resolveQueryHistogramStep(querySpan, activeStep, activeChart);
      const activeWidgets = overrides?.widgets ?? widgetsRef.current;
      const primaryWidget = primaryTimeseries(activeWidgets);
      const activeMetric =
        overrides?.metric !== undefined
          ? overrides.metric
          : (primaryWidget?.metric ?? null);
      const activeMetricLabels =
        overrides?.metricLabels ?? primaryWidget?.metricLabels ?? {};
      // The pinned plot's split (13a) goes with its own metric only.
      const activeMetricSplit =
        activeMetric && primaryWidget?.metric === activeMetric
          ? (primaryWidget.metricSplit ?? null)
          : null;
      const activeAgg = activeMetric
        ? null
        : overrides?.agg !== undefined
          ? overrides.agg
          : agg;
      const activeLogs = overrides?.logs ?? logsOn;
      const hunt = workspaceHuntKey({
        q: qVal,
        range: activeRange,
        from: overrides?.from ?? from,
        to: overrides?.to ?? to,
        live: isLive,
        step: activeStep,
        agg: activeAgg,
        logsOn: activeLogs,
        split: activeSplit,
        attrFacets: attrFacetsRef.current,
        widgets: activeWidgets,
      });
      const gen = viewGenRef.current;
      if (mode !== "poll") {
        skipAttrFacetGen.current = null;
      }
      if (mode === "append" && !activeLogs) {
        blockingSearchRef.current = false;
        setSearching(false);
        return;
      }
      if (mode !== "append") {
        if (activeSplit !== "level") {
          params.set("split", activeSplit);
        }
        if (sentStep) {
          params.set("step", sentStep);
        }
        if (activeMetric) {
          params.set("metric", activeMetric);
          const ml = formatMetricLabels(activeMetricLabels);
          if (ml) {
            params.set("ml", ml);
          }
          if (activeMetricSplit) {
            params.set("msplit", activeMetricSplit);
          }
        } else if (activeAgg) {
          params.set("agg", activeAgg);
        }
        if (!activeLogs) {
          params.set("events", "0");
        }
      }
      const facetQuery = params.toString();
      if (mode === "append") {
        const oldest = selectionRef.current.events.at(-1);
        const cursor = oldest ? eventCursor(oldest) : nextCursor;
        if (cursor) {
          params.set("cursor", cursor);
        }
      }
      const incremental =
        mode === "poll" && ++livePollsRef.current % 15 !== 0;
      if (mode === "poll" && !incremental) {
        fullPollAcRef.current = ac;
      }
      if (incremental) {
        const since = activeLogs
          ? selectionRef.current.events[0]?.ts ?? lastToRef.current
          : lastToRef.current;
        if (since) {
          params.set("since", since);
        }
      }
      const started = Date.now();
      try {
        const res = await fetch(`/api/search?${params.toString()}`, {
          signal: ac.signal,
        });
        if (res.status === 401) {
          setUnauthorized(true);
          throw new Error("Unauthorized. Sign in again.");
        }
        if (!res.ok) {
          throw new Error(`Search failed (${res.status})`);
        }
        const json = (await res.json()) as SearchResult;
        if (viewGenRef.current !== gen || ac.signal.aborted) {
          return;
        }
        if (mode === "replace" || (mode === "poll" && !incremental)) {
          setScanRefuse(json.scan?.source === "refused" ? json.scan : null);
        } else if (mode === "append" && json.scan?.events) {
          setScanRefuse(json.scan);
        }
        const histFrom = json.from ?? fromIso ?? json.histogram[0]?.t;
        const histTo = json.to ?? toIso ?? json.histogram[json.histogram.length - 1]?.t;
        if (json.to) {
          lastToRef.current = json.to;
        }
        let windowTotal = 0;
        if (mode !== "append") {
          const histRefused = json.scan?.histogram === true;
          const mergedHist =
            mode === "poll" && !histRefused
              ? mergeHistogramBuckets(histogramRef.current, json.histogram)
              : json.histogram;
          const filled =
            histFrom && histTo
              ? fillHistogram(
                  histFrom,
                  histTo,
                  mergedHist,
                  histogramIntervalMs(
                    histFrom,
                    histTo,
                    sentStep ?? undefined,
                  ),
                )
              : mergedHist;
          windowTotal = histogramTotal(filled);
          setHistogram(filled);
          setSearchWindow({ from: json.from, to: json.to });
          setTotal(windowTotal);
          const intervalMs = histogramIntervalMs(
            histFrom,
            histTo,
            sentStep ?? undefined,
          );
          const intervalSec = intervalMs / 1000;
          const parsedAgg = parseSearchAgg(activeAgg ?? undefined);
          let nextAgg: SearchAggResult | null = null;
          if (activeMetric) {
            if (json.agg) {
              const buckets =
                mode === "poll"
                  ? mergeAggBuckets(
                      aggSeriesRef.current?.buckets ?? [],
                      json.agg.buckets,
                    )
                  : json.agg.buckets;
              nextAgg = { ...json.agg, buckets };
              if (json.agg.splits) {
                nextAgg.splits =
                  mode === "poll"
                    ? mergeAggSplits(aggSeriesRef.current?.splits, json.agg.splits)
                    : json.agg.splits;
              }
            }
          } else if (!parsedAgg) {
            nextAgg = null;
          } else if (parsedAgg.op === "rate") {
            nextAgg = histRefused
              ? refusedAgg(
                  "rate",
                  json.scan?.reason ?? logsScanBudgetRefuseReason,
                )
              : rateFromHistogram(
                  filled,
                  intervalSec,
                  windowSeconds(histFrom, histTo),
                );
          } else if (json.agg) {
            const buckets =
              mode === "poll" && json.agg.source !== "refused"
                ? mergeAggBuckets(aggSeriesRef.current?.buckets ?? [], json.agg.buckets)
                : json.agg.buckets;
            nextAgg = { ...json.agg, buckets };
          } else if (mode === "poll") {
            nextAgg = aggSeriesRef.current;
          }
          setAggSeries(nextAgg);
          const primaryKey = seriesQueryKey({
            split: activeSplit,
            agg: activeAgg,
            metric: activeMetric,
            metricLabels: activeMetricLabels,
            metricSplit: activeMetricSplit,
          });
          const primaryData: SeriesData = stampSeries({
            histogram: filled,
            agg: nextAgg,
            total: windowTotal,
          });
          const extraQueries = widgetSeriesQueries(activeWidgets).filter(
            (item) => seriesQueryKey(item) !== primaryKey,
          );
          const hbarFetch = widgetHbarFetch(activeWidgets);
          const skipKeys = skipKeysFromFieldRoles(fieldRolesRef.current);
          const extraNetwork = extraQueries.filter((item) =>
            extraQueryNeedsSearch(item, activeWidgets, activeSplit),
          );
          const extraLive = extraQueries.filter((item) =>
            extraQueryLiveFetch(
              item,
              activeWidgets,
              qVal,
              skipKeys,
              activeSplit,
              intervalMs,
            ),
          );
          const derived = deriveLiveSeries(
            activeWidgets,
            primaryData,
            activeSplit,
            histFrom,
            histTo,
            intervalMs,
            stampSeries,
          );
          const fetchFullExtras =
            (extraNetwork.length > 0 ||
              hbarFetch.attrKeys.length > 0 ||
              hbarFetch.coreLimit !== null ||
              hbarFetch.none) &&
            (mode === "replace" || (mode === "poll" && !incremental));
          if (fetchFullExtras) {
            const extraEntries = await Promise.all(
              extraNetwork.map(async (item) => {
                const extraParams = new URLSearchParams(facetQuery);
                extraParams.set("events", "0");
                applySeriesSearchParams(extraParams, item);
                extraParams.delete("since");
                extraParams.delete("cursor");
                const extraRes = await fetch(`/api/search?${extraParams.toString()}`, {
                  signal: ac.signal,
                });
                if (!extraRes.ok) {
                  return null;
                }
                const extraJson = (await extraRes.json()) as SearchResult;
                const extraFilled =
                  histFrom && histTo
                    ? fillHistogram(
                        histFrom,
                        histTo,
                        extraJson.histogram,
                        histogramIntervalMs(
                          histFrom,
                          histTo,
                          sentStep ?? undefined,
                        ),
                      )
                    : extraJson.histogram;
                const extraParsed = parseSearchAgg(item.agg ?? undefined);
                let extraAgg = extraJson.agg ?? null;
                if (item.metric) {
                  extraAgg = extraJson.agg ?? null;
                } else if (extraParsed?.op === "rate") {
                  extraAgg = extraJson.scan?.histogram
                    ? refusedAgg(
                        "rate",
                        extraJson.scan.reason,
                      )
                    : rateFromHistogram(
                        extraFilled,
                        intervalSec,
                        windowSeconds(histFrom, histTo),
                      );
                }
                return [
                  seriesQueryKey(item),
                  stampSeries({
                    histogram: extraFilled,
                    agg: extraAgg,
                    total: histogramTotal(extraFilled),
                  }),
                ] as const;
              }),
            );
            const map: Record<string, SeriesData> = { [primaryKey]: primaryData };
            for (const entry of extraEntries) {
              if (entry) {
                map[entry[0]] = entry[1];
              }
            }
            Object.assign(
              map,
              await fetchHbarSeries(hbarFetch, facetQuery, windowTotal, ac.signal),
            );
            Object.assign(map, derived);
            if (viewGenRef.current !== gen || ac.signal.aborted) {
              return;
            }
            setSeriesByKey(map);
          } else if (incremental) {
            let extraPatch: Record<string, SeriesData> = {};
            if (extraLive.length > 0 && !extraInflightRef.current) {
              extraInflightRef.current = true;
              const extraAc = new AbortController();
              extraAbortRef.current = extraAc;
              try {
                extraPatch = await fetchIncrementalExtras(
                  extraLive,
                  facetQuery,
                  params.get("since"),
                  seriesByKeyRef.current,
                  histFrom,
                  histTo,
                  intervalMs,
                  extraAc.signal,
                );
              } catch (err) {
                if (!(err instanceof Error && err.name === "AbortError")) {
                  extraPatch = {};
                }
              } finally {
                if (extraAbortRef.current === extraAc) {
                  extraInflightRef.current = false;
                }
              }
            }
            if (viewGenRef.current !== gen || ac.signal.aborted) {
              return;
            }
            setSeriesByKey((prev) => ({
              ...prev,
              [primaryKey]: primaryData,
              ...derived,
              ...extraPatch,
            }));
          } else {
            setSeriesByKey((prev) => ({
              ...prev,
              [primaryKey]: primaryData,
              ...derived,
            }));
          }
        }
        if (viewGenRef.current !== gen || ac.signal.aborted) {
          return;
        }
        if (mode !== "append" && histFrom && histTo) {
          try {
            const marksParams = new URLSearchParams();
            marksParams.set("from", histFrom);
            marksParams.set("to", histTo);
            const marksRes = await fetch(`/api/marks?${marksParams.toString()}`, {
              signal: ac.signal,
            });
            if (viewGenRef.current !== gen || ac.signal.aborted) {
              return;
            }
            if (marksRes.ok) {
              const body = (await marksRes.json()) as {
                marks?: ChangeMark[];
                before?: ChangeMark | null;
                after?: ChangeMark | null;
              };
              setWindowMarks(Array.isArray(body.marks) ? body.marks : []);
              setMarkBefore(body.before ?? null);
              setMarkAfter(body.after ?? null);
            } else if (mode === "replace") {
              setWindowMarks([]);
              setMarkBefore(null);
              setMarkAfter(null);
            }
          } catch (err) {
            if (err instanceof Error && err.name === "AbortError") {
              return;
            }
            if (mode === "replace") {
              setWindowMarks([]);
              setMarkBefore(null);
              setMarkAfter(null);
            }
          }
        }
        lastPaintHuntRef.current = hunt;
        setIngested((prev) =>
          nextIngested(prev, mode, {
            ingested: json.ingested,
            events: json.events,
            histogramTotal: windowTotal,
          }),
        );
        if (mode !== "poll") {
          setNextCursor(activeLogs ? json.nextCursor : null);
        }
        if (!activeLogs) {
          if (mode === "replace") {
            const next = selectionAfterReplace(overrides?.park ?? null, []);
            setEvents([]);
            setSelectedIndex(next.index);
            setDetailOpen(next.detailOpen);
            setPinnedEvent(next.pinned);
          }
        } else if (mode === "append") {
          setEvents((prev) => {
            const seen = new Set(prev.map(eventKey));
            return [
              ...prev,
              ...json.events.filter((row) => !seen.has(eventKey(row))),
            ];
          });
        } else if (mode === "poll") {
          const sel = selectionRef.current;
          const merged = histFrom
            ? mergeLiveEvents(sel.events, json.events, histFrom, livePageSize)
            : json.events;
          const current = sel.events[sel.index];
          const key = current ? eventKey(current) : null;
          const idx = indexOfEventKey(merged, key);
          setEvents(merged);
          if (idx >= 0) {
            setSelectedIndex(idx);
            setPinnedEvent(null);
          } else if (sel.detailOpen && current) {
            setPinnedEvent(current);
            setSelectedIndex(-1);
          }
        } else {
          const next = selectionAfterReplace(
            overrides?.park ?? null,
            json.events,
          );
          setEvents(json.events);
          setSelectedIndex(next.index);
          setDetailOpen(next.detailOpen);
          setPinnedEvent(next.pinned);
        }
        if (mode === "replace" || (mode === "poll" && !incremental)) {
          if (mode === "replace") {
            setLastMs(Date.now() - started);
            if (qVal) {
              setQueryHistory((prev) =>
                [qVal, ...prev.filter((item) => item !== qVal)].slice(0, 10),
              );
            }
          }
          void loadFacets(facetQuery);
          void loadNumericKeys(facetQuery);
          void loadMetricNames(facetQuery);
          void loadAttrKeys(facetQuery);
          if (mode === "poll") {
            void loadAttrFacets(attrFacetsRef.current, facetQuery);
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return;
        }
        if (viewGenRef.current !== gen) {
          return;
        }
        lastPaintHuntRef.current = hunt;
        const message = err instanceof Error ? err.message : "Search failed";
        setError(message);
      } finally {
        if (mode === "poll" && !incremental && fullPollAcRef.current === ac) {
          fullPollAcRef.current = null;
        }
        if (mode !== "poll" && abortRef.current === ac) {
          blockingSearchRef.current = false;
          setSearching(false);
        }
      }
    },
    [from, to, range, q, live, split, step, chart, agg, logsOn, nextCursor, loadFacets, loadNumericKeys, loadMetricNames, loadAttrKeys, loadAttrFacets],
  );

  useEffect(() => {
    const target = loadTowardTsRef.current;
    if (target == null || searching) {
      return;
    }
    const oldest = events.at(-1);
    if (!oldest || !nextCursor) {
      loadTowardTsRef.current = null;
      return;
    }
    if (Date.parse(oldest.ts) > target) {
      void runSearch("append");
      return;
    }
    loadTowardTsRef.current = null;
  }, [events, nextCursor, searching, runSearch]);

  useEffect(() => {
    void fetch("/api/settings").then(async (res) => {
      if (!res.ok) {
        return;
      }
      const json = (await res.json()) as { retention_days: number };
      if (Number.isInteger(json.retention_days)) {
        setRetentionDays(json.retention_days);
      }
    });
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/saved-searches");
        if (res.status === 401) {
          setUnauthorized(true);
          throw new Error("Unauthorized. Sign in again.");
        }
        if (!res.ok) {
          throw new Error(`Saved searches failed (${res.status})`);
        }
        const json = (await res.json()) as { searches: SavedSearch[] };
        setSaved(json.searches);
        const item = boot.saved
          ? json.searches.find((row) => row.id === boot.saved)
          : undefined;
        if (item?.board) {
          const nextBind = bindForBoard(boot.bind, item.board.keys);
          setBind(nextBind);
          const nextQ = boundQuery(item.query, nextBind);
          setQ(nextQ);
          if (isSingleHistogram(boot.widgets) && item.widgets) {
            setLogsOn(item.widgets.logs);
            setWidgets(item.widgets.widgets);
          }
          if (isBoardUnbound(item.board, nextBind)) {
            blockingSearchRef.current = false;
            setSearching(false);
            setEvents([]);
            setHistogram([]);
            setSearchWindow(null);
            setAggSeries(null);
            setTotal(0);
            setSeriesByKey({});
            return;
          }
          void runSearch("replace", { q: nextQ });
          return;
        }
        void runSearch("replace");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to load saved searches";
        setError(message);
        void runSearch("replace");
      }
    })();
    void loadAlerts().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : "Failed to load alerts";
      setError(message);
    });
    void loadFieldConfig().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : "Failed to load fields";
      toast.error(message);
    });
    // initial load only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!traceView) {
      return;
    }
    const value = traceView.value;
    let cancelled = false;
    setTraceLoad({ value, result: null, loading: true, failed: false });
    void fetch(`/api/traces/${encodeURIComponent(value)}`)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error("trace");
        }
        return (await res.json()) as TraceResponse;
      })
      .then((result) => {
        if (!cancelled) {
          setTraceLoad({ value, result, loading: false, failed: false });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTraceLoad({ value, result: null, loading: false, failed: true });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [traceView]);

  useEffect(() => {
    if (!profileView) {
      return;
    }
    const key = `${profileView.trace_id}:${profileView.span_id}`;
    const params = new URLSearchParams({
      trace_id: profileView.trace_id,
      span_id: profileView.span_id,
    });
    let cancelled = false;
    setProfileLoad({ key, result: null, loading: true, failed: false });
    void fetch(`/api/profiles?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error("profile");
        }
        return (await res.json()) as ProfileResponse;
      })
      .then((result) => {
        if (!cancelled) {
          setProfileLoad({ key, result, loading: false, failed: false });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProfileLoad({ key, result: null, loading: false, failed: true });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [profileView]);

  // Live pauses while reading (#261, 26e): no polls while an event is open; the next poll's since= catches up.
  const readingPaused = live && detailOpen && view === "search";
  useEffect(() => {
    if (!live || view !== "search" || isReaderKind(wsKind) || readingPaused) {
      return;
    }
    const id = setInterval(() => {
      void runSearch("poll");
    }, 2000);
    return () => clearInterval(id);
  }, [live, view, wsKind, runSearch, readingPaused]);

  useEffect(() => {
    if (!searching) {
      setSearchElapsedMs(0);
      return;
    }
    const started = Date.now();
    setSearchElapsedMs(0);
    const id = setInterval(() => {
      setSearchElapsedMs(Date.now() - started);
    }, 100);
    return () => clearInterval(id);
  }, [searching]);

  const fieldsBusy = fieldsWave !== null;
  useEffect(() => {
    if (!fieldsBusy) {
      setFieldsElapsedMs(0);
      return;
    }
    const started = fieldsStartedRef.current || Date.now();
    const id = setInterval(() => {
      setFieldsElapsedMs(Date.now() - started);
    }, 100);
    return () => clearInterval(id);
  }, [fieldsBusy]);

  // Watch reads every 15s; elsewhere the header's open count every 30s.
  useEffect(() => {
    const onWatch = view === "watch";
    if (onWatch) {
      void loadAlerts().catch(() => undefined);
      void loadWatchMarks().catch(() => undefined);
    }
    const id = setInterval(() => {
      void loadAlerts().catch(() => undefined);
      if (onWatch) {
        void loadWatchMarks().catch(() => undefined);
      }
    }, onWatch ? 15_000 : 30_000);
    return () => clearInterval(id);
  }, [view, watchRange, loadAlerts, loadWatchMarks]);

  useEffect(() => {
    if (view !== "fields") {
      return;
    }
    void loadFields().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : "Failed to load fields";
      setError(message);
    });
  }, [view, loadFields]);

  useEffect(() => {
    const snapshot = {
      q,
      range,
      from,
      to,
      live,
      saved: savedId,
      view,
      mark: compare?.mark.id ?? null,
      split,
      chart,
      logScale,
      step,
      attrFacets,
      cols,
      agg,
      replaceY,
      logs: logsOn,
      widgets,
      bind,
      boardKeys: saved.find((item) => item.id === savedId)?.board?.keys ?? null,
    };
    if (skipUrl.current) {
      skipUrl.current = false;
      const initial = serializeSearchUrl(snapshot);
      if (initial !== window.location.search) {
        history.replaceState(null, "", `${window.location.pathname}${initial}`);
      }
      return;
    }
    const timer = setTimeout(() => {
      const next = serializeSearchUrl(snapshot);
      if (next !== window.location.search) {
        history.replaceState(null, "", `${window.location.pathname}${next}`);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [q, range, from, to, live, savedId, view, compare, split, chart, logScale, step, attrFacets, cols, agg, replaceY, logsOn, widgets, bind, saved]);

  useEffect(() => {
    function onPop() {
      const state = parseSearchUrl(window.location.search);
      skipUrl.current = true;
      setQ(state.q);
      setRange(state.range);
      setFrom(state.from);
      setTo(state.to);
      setLive(state.live);
      setSavedId(state.saved);
      setBind(state.bind);
      setView(state.view);
      setSplit(state.split);
      setChart(state.chart);
      setLogScale(state.logScale);
      setStep(state.step);
      setAttrFacets(state.attrFacets);
      setCols(state.cols);
      setAgg(state.agg);
      setReplaceY(state.replaceY);
      setLogsOn(state.logs);
      setWidgets(state.widgets);
      setExplore(null);
      setFollow(null);
      setSurrAnchor(null);
      setSurrSel(null);
      setFocusMark(null);
      setFocusMarkId(null);
      setCut(null);
      setCompare(null);
      setInspectTabs([]);
      setActiveInspect(null);
      setWsKind("search");
      setWsId(1);
      setWsSeq(1);
      setWsList([
        {
          id: 1,
          kind: "search",
          label: workspaceLiveLabel({
            kind: "search",
            q: state.q,
            savedName: null,
            savedDirty: false,
            follow: null,
            surrAnchor: null,
            focusMark: null,
          }),
          snap: urlSearchSnap(state),
        },
      ]);
      if (state.view === "search") {
        void runSearch("replace", {
          q: state.q,
          range: state.range,
          from: state.from,
          to: state.to,
          live: state.live,
          split: state.split,
          step: state.step,
          agg: state.agg,
          logs: state.logs,
          widgets: state.widgets,
        });
      }
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [runSearch]);

  useEffect(() => {
    if (isReaderKind(wsKind)) {
      return;
    }
    if (skipAttrFacetGen.current === viewGenRef.current) {
      return;
    }
    void loadAttrFacets(attrFacets, windowParams().toString());
  }, [attrFacets, loadAttrFacets, windowParams, wsKind]);

  useEffect(() => {
    const item = saved.find((row) => row.id === savedId);
    if (!item?.board || isReaderKind(wsKind)) {
      return;
    }
    const keys = item.board.keys;
    if (keys.length === 0) {
      setBoardBindValues({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const next: Record<string, FacetValue[]> = {};
      await Promise.all(
        keys.map(async (key) => {
          const others = { ...bind };
          delete others[key];
          const qVal = boundQuery(item.query, others).trim();
          const params = new URLSearchParams();
          if (range !== "custom") {
            params.set("range", range);
          } else {
            const fromIso = isoFromLocal(from);
            const toIso = isoFromLocal(to);
            if (fromIso) params.set("from", fromIso);
            if (toIso) params.set("to", toIso);
          }
          if (qVal) {
            params.set("q", qVal);
          }
          params.set("omit", "0");
          if (isCoreField(key)) {
            if (key === "toposcope") {
              params.set("fields", "toposcope");
            }
            const res = await fetch(`/api/facets?${params.toString()}`);
            if (!res.ok) {
              return;
            }
            const json = (await res.json()) as Facets & { toposcope?: FacetValue[] };
            next[key] = json[key] ?? [];
            return;
          }
          params.set("attrs", key);
          const res = await fetch(`/api/attr-facets?${params.toString()}`);
          if (!res.ok) {
            return;
          }
          const json = (await res.json()) as Record<string, FacetValue[]>;
          next[key] = json[key] ?? [];
        }),
      );
      if (!cancelled) {
        setBoardBindValues(next);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [saved, savedId, bind, range, from, to, wsKind]);

  useEffect(() => {
    const entries = Object.entries(attrPrefixes).filter(
      ([, prefix]) => prefix.trim().length > 0,
    );
    if (isReaderKind(wsKind) || entries.length === 0) {
      if (!isReaderKind(wsKind)) {
        setAttrPrefixValues({});
      }
      return;
    }
    const query = windowParams().toString();
    const timer = setTimeout(() => {
      void (async () => {
        const next: Record<string, FacetValue[]> = {};
        await Promise.all(
          entries.map(async ([key, prefix]) => {
            const params = new URLSearchParams(query);
            params.set("key", key);
            params.set("prefix", prefix.trim());
            const res = await fetch(`/api/attr-values?${params.toString()}`);
            if (!res.ok) {
              return;
            }
            const json = (await res.json()) as { values: FacetValue[] };
            next[key] = json.values;
          }),
        );
        setAttrPrefixValues(next);
      })();
    }, 250);
    return () => clearTimeout(timer);
  }, [attrPrefixes, windowParams, wsKind]);

  const dialogOpen =
    sharesOpen || saveAsOpen || alertDraft !== null || newMonitor !== null || pushDraft !== null || httpDraft !== null || netDraft !== null;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (view !== "search" || dialogOpen) {
        return;
      }
      if (e.key === "/" && !isTypingTarget(e.target)) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (isTypingTarget(e.target)) {
        if (e.key === "Escape" && !e.defaultPrevented) {
          (e.target as HTMLElement).blur();
        }
        return;
      }
      if (activeInspect) {
        if (e.key === "Escape") {
          e.preventDefault();
          setActiveInspect(null);
        }
        return;
      }
      if (e.key === "Escape") {
        setDetailOpen(false);
        setPinnedEvent(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, dialogOpen, activeInspect]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (searching || saved.find((row) => row.id === savedId)?.board) {
      return;
    }
    if (compileQuery(q).faults.length > 0) {
      setShowFaults(true);
      return;
    }
    setShowFaults(false);
    void runSearch("replace");
  }

  function cancelSearch() {
    abortRef.current?.abort();
    blockingSearchRef.current = false;
    loadTowardTsRef.current = null;
    setSearching(false);
  }

  function bindFromQuery(query: string, keys: string[]): Record<string, string> {
    const active = activeFacetValues(query, keys);
    const out: Record<string, string> = {};
    for (const key of keys) {
      const value = active[key]?.[0];
      if (value) {
        out[key] = value;
      }
    }
    return out;
  }

  function applySavedBoard(item: SavedSearch) {
    if (!item.board) {
      return;
    }
    const nextBind = bindForBoard(
      { ...bindFromQuery(q, item.board.keys), ...bind },
      item.board.keys,
    );
    setBind(nextBind);
    setQ(boundQuery(item.query, nextBind));
  }

  function savedFields(board: BoardSlots | null) {
    const layout = { logs: logsOn, widgets };
    return {
      query: board ? storedBoardQuery(q, board.keys) : q,
      range: range === "custom" ? null : range,
      from_ts: range === "custom" ? isoFromLocal(from) ?? null : null,
      to_ts: range === "custom" && !live ? isoFromLocal(to) ?? null : null,
      agg,
      widgets: isDefaultLayout(layout) ? null : layout,
      board,
      cols,
    };
  }

  async function createSaved(name: string, board: BoardSlots | null = null) {
    const res = await fetch("/api/saved-searches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, ...savedFields(board) }),
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(json?.error ?? `Save failed (${res.status})`);
      throw new Error("save failed");
    }
    const created = (await res.json()) as SavedSearch;
    setSavedId(created.id);
    applySavedBoard(created);
    toast.success(created.board ? "Saved board" : "Saved search");
    await loadSaved();
  }

  async function updateActiveSaved(name: string, board: BoardSlots | null) {
    if (!savedId) {
      await createSaved(name, board);
      return;
    }
    const res = await fetch(`/api/saved-searches/${savedId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, ...savedFields(board) }),
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(json?.error ?? `Save failed (${res.status})`);
      throw new Error("save failed");
    }
    const updated = (await res.json()) as SavedSearch;
    applySavedBoard(updated);
    toast.success(updated.board ? "Board updated" : "Saved");
    await loadSaved();
  }

  function onSaveClick() {
    if (!savedId || saved.find((item) => item.id === savedId)?.board) {
      setSaveUpdate(Boolean(savedId));
      setSaveAsOpen(true);
      return;
    }
    void updateActiveSaved(
      saved.find((item) => item.id === savedId)?.name ?? "Untitled",
      null,
    );
  }

  /** Watch this (#264): the hunt becomes a saved hunt if it is not one, then a monitor on it. */
  async function saveWatchThis(input: WatchThisInput) {
    let id = activeSaved && !activeSaved.board ? activeSaved.id : null;
    if (!id) {
      const res = await fetch("/api/saved-searches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: input.name, query: q, range: input.window, agg: pinnedSeries?.metric ? null : (pinnedSeries?.agg ?? agg ?? null) }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(json?.error ?? `Saving the hunt failed (${res.status})`);
        throw new Error("save failed");
      }
      id = ((await res.json()) as SavedSearch).id;
      setSavedId(id);
      await loadSaved().catch(() => undefined);
    }
    await createAlert({
      name: input.name,
      kind: "threshold",
      saved_search_id: id,
      threshold: input.threshold,
      webhook_url: input.webhookUrls.find((u) => u !== "default") ?? "",
      webhook_urls: input.webhookUrls,
      measure: input.measure,
      body_kind: "default",
      body_template: "",
      resolved_body: null,
      remind_every: "window",
      opens_when: input.opensWhen,
    } as MonitorInput);
    setWatchThisOpen(false);
    setView("watch");
  }

  async function togglePinned(item: SavedSearch) {
    const res = await fetch(`/api/saved-searches/${item.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: !item.pinned }),
    });
    if (!res.ok) {
      toast.error(`Pin failed (${res.status})`);
      return;
    }
    toast.success(item.pinned ? `${item.name} unpinned from Home` : `${item.name} pinned to Home`);
    await loadSaved().catch(() => undefined);
  }

  async function onDelete(id: string) {
    const res = await fetch(`/api/saved-searches/${id}`, { method: "DELETE" });
    if (res.status === 409) {
      toast.error("Saved search is used by an alert rule");
      return;
    }
    if (!res.ok) {
      toast.error(`Delete failed (${res.status})`);
      return;
    }
    if (savedId === id) {
      setSavedId(null);
    }
    await loadSaved();
  }


  async function createAlert(input: MonitorInput | HttpMonitorInput | NetMonitorInput) {
    const res = await fetch("/api/alert-rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(json?.error ?? `Create monitor failed (${res.status})`);
      throw new Error("create monitor failed");
    }
    toast.success("Monitor created");
    await loadAlerts();
  }

  async function updateAlert(
    id: string,
    input:
      | MonitorInput
      | HttpMonitorInput
      | NetMonitorInput
      | { silence_for: "1h" | "4h" | "24h" }
      | { silenced_until: null }
      | { enabled: boolean },
  ) {
    const res = await fetch(`/api/alert-rules/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(json?.error ?? `Update monitor failed (${res.status})`);
      throw new Error("update monitor failed");
    }
    toast.success("silence_for" in input ? "Monitor silenced" : "enabled" in input ? (input.enabled ? "Monitor resumed" : "Monitor paused") : "Monitor updated");
    await loadAlerts();
  }

  async function deleteAlert(id: string) {
    const res = await fetch(`/api/alert-rules/${id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error(`Delete monitor failed (${res.status})`);
      throw new Error("delete monitor failed");
    }
    toast.success("Monitor deleted");
    await loadAlerts();
  }

  /** A push monitor from its editor (18s): declared by name, so a first result that made it is kept. */
  async function createPush(input: PushInput) {
    const res = await fetch(`/api/monitors/${encodeURIComponent(input.name)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "push", ...input }),
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(json?.error ?? `Create monitor failed (${res.status})`);
      throw new Error("create monitor failed");
    }
    toast.success(res.status === 201 ? "Monitor created" : "Monitor updated");
    await loadAlerts();
  }

  async function updatePush(id: string, input: PushInput) {
    const res = await fetch(`/api/alert-rules/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(json?.error ?? `Update monitor failed (${res.status})`);
      throw new Error("update monitor failed");
    }
    toast.success("Monitor updated");
    await loadAlerts();
  }

  async function silenceAlert(
    rule: AlertRule,
    forId: "1h" | "4h" | "24h" | null,
  ) {
    await updateAlert(rule.id, forId ? { silence_for: forId } : { silenced_until: null });
  }

  /** A monitor opened as a hunt (18i): its search in a new tab, with the monitor beside it. */
  function openMonitor(monitor: MonitorView, stretch?: Pick<MonitorStretch, "opened_at" | "resolved_at">) {
    if (sourceOf(monitor) === "push") {
      // 18i: its results are rows (`monitor:<name>`), with how each went and how long it ran.
      setView("search");
      const id = wsSeq + 1;
      const at = stretch ?? monitor.open;
      addWorkspace(
        {
          ...blankSearchSnap(),
          kind: "search",
          q: monitor.query ?? monitorQuery(monitor.name),
          range: pushHuntRange(monitor),
          live: false,
          attrFacets: ["status", "signal"],
          cols: ["status", "duration_ms"],
          ...(at ? monitorHuntWindow(at) : {}),
        },
        true,
      );
      setMonitorRail((prev) => ({ ...prev, [id]: monitor.id }));
      return;
    }
    if (sourceOf(monitor) === "http" || sourceOf(monitor) === "tcp" || sourceOf(monitor) === "cert") {
      // Its results are its rows (#178, #180).
      setView("search");
      const tab = wsSeq + 1;
      addWorkspace(
        { ...blankSearchSnap(), q: monitor.query || monitorQuery(monitor.name), range: "1h", live: false, ...monitorHuntWindow(stretch ?? monitor.open) },
        true,
      );
      setMonitorRail((prev) => ({ ...prev, [tab]: monitor.id }));
      return;
    }
    const item = monitor.saved_search_id ? saved.find((row) => row.id === monitor.saved_search_id) : undefined;
    if (!item) {
      toast.error("This monitor's saved search is gone");
      return;
    }
    setView("search");
    const id = wsSeq + 1;
    addWorkspace({ ...snapFromSaved(item, {}), ...monitorHuntWindow(stretch ?? monitor.open) }, true);
    setMonitorRail((prev) => ({ ...prev, [id]: monitor.id }));
  }

  /** #212, 20c: a chip's stretch of marks, every service, in a new Search tab. */
  function openMarksStretch(fromMs: number, toMs: number) {
    const pick = marksHuntWindow(Date.now(), fromMs, toMs);
    setView("search");
    addWorkspace(
      {
        ...blankSearchSnap(),
        range: "custom",
        from: toLocalInput(new Date(pick.fromMs)),
        to: toLocalInput(new Date(pick.toMs)),
        live: false,
      },
      true,
    );
  }

  function monitorHuntWindow(stretch?: Pick<MonitorStretch, "opened_at" | "resolved_at"> | null): Partial<WorkspaceSnap> {
    if (!stretch) {
      return {};
    }
    const pick = monitorHuntRange(Date.now(), stretch);
    return pick.range === "custom"
      ? { range: "custom", from: toLocalInput(new Date(pick.fromMs)), to: toLocalInput(new Date(pick.toMs)) }
      : { range: pick.range };
  }

  function snapFromSaved(
    item: SavedSearch,
    nextBind: Record<string, string>,
  ): WorkspaceSnap {
    const layout = item.widgets ?? defaultLayout({ agg: item.agg ?? null });
    const primary = primaryTimeseries(layout.widgets);
    const relative = Boolean(item.range && parseRangeMs(item.range) !== null);
    return {
      ...blankSearchSnap(),
      kind: "search",
      q: item.board ? boundQuery(item.query, nextBind) : item.query,
      savedId: item.id,
      bind: item.board ? nextBind : {},
      range: relative ? item.range! : "custom",
      from: item.from_ts ? toLocalInput(new Date(item.from_ts)) : from,
      to: item.to_ts ? toLocalInput(new Date(item.to_ts)) : to,
      live: false,
      widgets: layout.widgets,
      logsOn: layout.logs,
      agg: primary?.metric ? null : (item.agg ?? primary?.agg ?? null),
      split: primary?.split ?? "level",
      chart: primary?.chart ?? "stacked",
      logScale: primary?.logScale ?? false,
      replaceY: primary?.replaceY ?? false,
      cols: parsePromotedCols(item.cols),
    };
  }

  function openSavedTab(item: SavedSearch) {
    setView("search");
    addWorkspace(snapFromSaved(item, {}), true);
  }

  function onRangeChange(next: RangeMode) {
    const item = saved.find((row) => row.id === savedId);
    if (item?.board) {
      if (!item.board.win || next === "custom") {
        return;
      }
    }
    setExplore(null);
    setRange(next);
    void runSearch("replace", { range: next });
  }

  function onCustomRange(nextFrom: string, nextTo: string) {
    if (saved.find((row) => row.id === savedId)?.board) {
      return;
    }
    const span = Date.parse(nextTo) - Date.parse(nextFrom);
    if (!Number.isFinite(span) || span < 1) {
      return;
    }
    setExplore((prev) => prev ?? { range, from, to, live, step });
    liveWindowMs.current = span;
    setLive(false);
    setRange("custom");
    setFrom(nextFrom);
    setTo(nextTo);
    void runSearch("replace", {
      live: false,
      range: "custom",
      from: nextFrom,
      to: nextTo,
    });
  }

  function onGraphField(field: string, value: string, metric: string) {
    const labels = graphMetricLabels(fieldLinks, field, value);
    if (!labels) {
      return;
    }
    const primary = primaryTimeseries(widgets);
    if (!primary) {
      return;
    }
    const next = patchWidget(widgets, primary.id, {
      agg: null,
      metric,
      metricLabels: labels,
      metricSplit: null,
    });
    setWidgets(next);
    setAgg(null);
    void runSearch("replace", {
      agg: null,
      metric,
      metricLabels: labels,
      widgets: next,
    });
  }

  function onLiveChange(on: boolean) {
    if (saved.find((row) => row.id === savedId)?.board) {
      return;
    }
    if (on) {
      if (range === "custom") {
        liveWindowMs.current = rangeDurationMs(from, to);
      } else {
        liveWindowMs.current = parseRangeMs(range) ?? 60 * 60 * 1000;
      }
      setLive(true);
      void runSearch("replace", { live: true });
    } else {
      setLive(false);
      if (range === "custom") {
        const now = new Date();
        setTo(toLocalInput(now));
        setFrom(toLocalInput(new Date(now.getTime() - liveWindowMs.current)));
      }
    }
  }

  function onHistogramWindow(fromIso: string, toIso: string) {
    if (saved.find((row) => row.id === savedId)?.board) {
      return;
    }
    const clamped = clampHistogramWindow(
      Date.parse(fromIso),
      Date.parse(toIso),
      Date.now(),
      retentionRangeMs(retentionDays),
    );
    if (!clamped) {
      return;
    }
    const nextFrom = toLocalInput(new Date(clamped.fromMs));
    const nextTo = toLocalInput(new Date(clamped.toMs));
    const span = clamped.toMs - clamped.fromMs;
    const currentSpan = searchSpanMs(range, from, to, live, liveWindowMs.current);
    const spanChanged =
      Number.isFinite(span) &&
      Number.isFinite(currentSpan) &&
      Math.abs(span - currentSpan) > 1000;
    const nextStep = spanChanged ? (step ?? autoChipInterval(currentSpan, chart)) : step;
    setExplore((prev) => prev ?? { range, from, to, live, step });
    if (Number.isFinite(span) && span > 0) {
      liveWindowMs.current = span;
    }
    setStep(nextStep);
    setLive(false);
    setRange("custom");
    setFrom(nextFrom);
    setTo(nextTo);
    void runSearch("replace", {
      live: false,
      range: "custom",
      from: nextFrom,
      to: nextTo,
      step: nextStep,
    });
  }

  function onResetExplore() {
    const origin = explore;
    if (!origin) {
      return;
    }
    setExplore(null);
    setRange(origin.range);
    setFrom(origin.from);
    setTo(origin.to);
    setLive(origin.live);
    setStep(origin.step);
    if (origin.live) {
      liveWindowMs.current =
        origin.range === "custom"
          ? rangeDurationMs(origin.from, origin.to)
          : parseRangeMs(origin.range) ?? 60 * 60 * 1000;
    }
    void runSearch("replace", {
      range: origin.range,
      from: origin.from,
      to: origin.to,
      live: origin.live,
      step: origin.step,
    });
  }

  function focusEvent(event: LogEvent) {
    const i = indexOfEventKey(events, eventKey(event));
    if (i >= 0) {
      setPinnedEvent(null);
      setSelectedIndex(i);
    } else {
      setPinnedEvent(event);
      setSelectedIndex(-1);
    }
  }

  function liveLabelNow(): string {
    const item = saved.find((row) => row.id === savedId);
    const board = Boolean(item?.board);
    return workspaceLiveLabel({
      kind: wsKind,
      q,
      savedName: item?.name ?? null,
      savedDirty: board ? false : !item || item.query !== q,
      home: Boolean(item && item.id === homeId),
      follow,
      surrAnchor,
      focusMark,
      board,
      boardBinds: item?.board
        ? item.board.keys.map((key) => bind[key] ?? "").filter((value) => value.length > 0)
        : [],
    });
  }

  function labelForSnap(snap: WorkspaceSnap): { label: string; board: boolean } {
    const item = snap.savedId
      ? saved.find((row) => row.id === snap.savedId)
      : undefined;
    const board = Boolean(item?.board);
    return {
      board,
      label: workspaceLiveLabel({
        kind: snap.kind,
        q: snap.q,
        savedName: item?.name ?? null,
        savedDirty: board ? false : Boolean(item && item.query !== snap.q),
        home: Boolean(item && item.id === homeId),
        follow: snap.follow,
        surrAnchor: snap.surrAnchor,
        focusMark: snap.focusMark,
        board,
        boardBinds: item?.board
          ? item.board.keys
              .map((key) => snap.bind[key] ?? "")
              .filter((value) => value.length > 0)
          : [],
      }),
    };
  }

  function currentSnap(): WorkspaceSnap {
    const hunt = workspaceHuntKey({
      q,
      range,
      from,
      to,
      live,
      step,
      agg,
      logsOn,
      split,
      attrFacets,
      widgets,
    });
    const parkStack = Boolean(cut && detailOpen);
    const paint: WorkspacePaint | null =
      (lastMs != null || error != null) &&
      (lastPaintHuntRef.current === hunt || parkStack)
        ? {
            hunt,
            events,
            histogram,
            agg: aggSeries,
            seriesByKey,
            total,
            nextCursor,
            ingested,
            lastMs,
            error,
            facets,
            attrFacetValues,
            numericKeys,
            metricNames,
            attrKeyOptions,
            lastTo: lastToRef.current,
            window: searchWindow,
            marks: windowMarks,
            markBefore,
            markAfter,
          }
        : null;
    return {
      kind: wsKind,
      q,
      range,
      from,
      to,
      live,
      savedId,
      bind,
      split,
      chart,
      logScale,
      step,
      agg,
      replaceY,
      logsOn,
      widgets,
      attrFacets,
      cols,
      explore,
      follow,
      inspectTabs,
      activeInspect,
      aroundN,
      aroundMode,
      selectedIndex,
      detailOpen,
      pinnedEvent: snapPinnedEvent({
        cut,
        detailOpen,
        pinned: pinnedEvent,
        selected: events[selectedIndex],
      }),
      surrAnchor,
      surrSel,
      focusMark,
      frozenFacets: isReaderKind(wsKind) ? facets : null,
      frozenAttrFacetValues: isReaderKind(wsKind) ? attrFacetValues : null,
      paint,
      marksOff,
      marksMuted,
      cut,
      compare,
    };
  }

  function clearUnboundBoard() {
    abortRef.current?.abort();
    extraAbortRef.current?.abort();
    hbarAbortRef.current?.abort();
    blockingSearchRef.current = false;
    loadTowardTsRef.current = null;
    lastPaintHuntRef.current = null;
    setSearching(false);
    setEvents([]);
    setHistogram([]);
    setSearchWindow(null);
    setWindowMarks([]);
    setMarkBefore(null);
    setMarkAfter(null);
    setAggSeries(null);
    setTotal(0);
    setNextCursor(null);
    setSeriesByKey({});
    setLastMs(null);
  }

  function abortActiveSearch() {
    abortRef.current?.abort();
    extraAbortRef.current?.abort();
    hbarAbortRef.current?.abort();
    fullPollAcRef.current = null;
    extraInflightRef.current = false;
    blockingSearchRef.current = false;
    loadTowardTsRef.current = null;
    setSearching(false);
  }

  function focusMarkInLogs(mark: ChangeMark) {
    if (compileQuery(q).faults.length > 0) {
      setShowFaults(true);
      return;
    }
    const decision = decideFocusMarkInLogs(
      { kind: wsKind, focusMarkId: focusMark?.id ?? null },
      wsList,
      mark.id,
    );
    switch (decision.action) {
      case "stay":
        return;
      case "recenter":
        setSurrAnchor(null);
        setSurrSel(null);
        setFocusMark(mark);
        setFocusMarkId(mark.id);
        setAroundN(surroundingDefaultN);
        setAroundMode("all");
        setActiveInspect(null);
        setLive(false);
        return;
      case "switch":
        goWs(decision.id);
        return;
      case "open-beside":
        addWorkspace(
          surroundingsMarkSnap(currentSnap(), mark, {
            frozenFacets: facets,
            frozenAttrFacetValues: attrFacetValues,
          }),
          false,
        );
        return;
      default: {
        const _never: never = decision;
        return _never;
      }
    }
  }

  function openFingerprints(mark: ChangeMark) {
    const openedAt = live
      ? new Date().toISOString()
      : isoFromLocal(to) ?? new Date().toISOString();
    setCut({ mark, openedAt, result: null });
    setFocusMarkId(mark.id);
    setDetailOpen(false);
    setPinnedEvent(null);
  }

  useEffect(() => {
    const id = pendingCutRef.current;
    if (!id) {
      return;
    }
    const mark = windowMarks.find((m) => m.id === id);
    if (!mark) {
      return;
    }
    pendingCutRef.current = null;
    openFingerprints(mark);
    // openFingerprints reads the clock it is called with; the link's window is already set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowMarks]);

  // Esc closes the Compare fold when nothing nearer is open (#260; principle 08: Esc goes back one step).
  useEffect(() => {
    if (!compare) {
      return;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented || isTypingTarget(e.target) || detailOpen) {
        return;
      }
      if (document.querySelector('[role="dialog"], [role="menu"]')) {
        return;
      }
      setCompare(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [compare, detailOpen]);

  useEffect(() => {
    const id = pendingMarkRef.current;
    if (!id) {
      return;
    }
    const mark = windowMarks.find((m) => m.id === id);
    if (!mark) {
      return;
    }
    pendingMarkRef.current = null;
    openCompare(mark);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowMarks]);

  function openCompare(mark: ChangeMark) {
    const openedAt = live
      ? new Date().toISOString()
      : isoFromLocal(to) ?? new Date().toISOString();
    setCompare({ mark, openedAt });
    setFocusMarkId(mark.id);
  }

  function restorePaint(paint: WorkspacePaint) {
    skipAttrFacetGen.current = viewGenRef.current;
    lastPaintHuntRef.current = paint.hunt;
    setEvents(paint.events);
    setHistogram(paint.histogram);
    setSearchWindow(paint.window);
    histogramRef.current = paint.histogram;
    setWindowMarks(paint.marks);
    setMarkBefore(paint.markBefore);
    setMarkAfter(paint.markAfter);
    setAggSeries(paint.agg);
    aggSeriesRef.current = paint.agg;
    setSeriesByKey(paint.seriesByKey);
    seriesByKeyRef.current = paint.seriesByKey;
    setTotal(paint.total);
    setNextCursor(paint.nextCursor);
    setIngested(paint.ingested);
    setLastMs(paint.lastMs);
    setError(paint.error);
    setFacets(paint.facets);
    setFacetsLoading(false);
    setAttrFacetValues(paint.attrFacetValues);
    setAttrFacetsLoading(false);
    setNumericKeys(paint.numericKeys);
    setMetricNames(paint.metricNames);
    setAttrKeyOptions(paint.attrKeyOptions);
    lastToRef.current = paint.lastTo;
  }

  function applySnap(snap: WorkspaceSnap, search: boolean) {
    viewGenRef.current += 1;
    abortActiveSearch();
    const item = snap.savedId
      ? saved.find((row) => row.id === snap.savedId)
      : undefined;
    const board = item?.board ?? null;
    setWsKind(snap.kind);
    setQ(snap.q);
    setRange(snap.range);
    setFrom(snap.from);
    setTo(snap.to);
    setLive(board ? false : snap.live);
    setSavedId(snap.savedId);
    setBind(snap.bind);
    setSplit(snap.split);
    setChart(snap.chart);
    setLogScale(snap.logScale);
    setStep(snap.step);
    setAgg(snap.agg);
    setReplaceY(snap.replaceY);
    setLogsOn(snap.logsOn);
    setWidgets(snap.widgets);
    setAttrFacets(snap.attrFacets);
    setCols(snap.cols);
    setExplore(snap.explore);
    setFollow(snap.follow);
    setSpanSel(null);
    setMarksOff(snap.marksOff);
    setMarksMuted(snap.marksMuted);
    setCut(snap.cut);
    setCompare(snap.compare);
    setFocusMark(snap.focusMark);
    setFocusMarkId(snap.cut?.mark.id ?? snap.focusMark?.id ?? null);
    setInspectTabs(snap.inspectTabs);
    setActiveInspect(snap.activeInspect);
    setAroundN(snap.aroundN);
    setAroundMode(snap.aroundMode);
    setSelectedIndex(snap.selectedIndex);
    setDetailOpen(snap.detailOpen);
    setPinnedEvent(snap.pinnedEvent);
    setSurrAnchor(snap.surrAnchor);
    setSurrSel(snap.surrSel);
    if (snap.live && !board) {
      liveWindowMs.current =
        snap.range === "custom"
          ? rangeDurationMs(snap.from, snap.to)
          : parseRangeMs(snap.range) ?? 60 * 60 * 1000;
    }
    if (isReaderKind(snap.kind)) {
      lastPaintHuntRef.current = null;
      if (snap.frozenFacets) {
        setFacets(snap.frozenFacets);
      }
      if (snap.frozenAttrFacetValues) {
        setAttrFacetValues(snap.frozenAttrFacetValues);
      }
      setFacetsLoading(false);
      setAttrFacetsLoading(false);
      return;
    }
    if ((shouldRestorePaint(snap) || shouldRestoreParkedCut(snap)) && snap.paint) {
      restorePaint(snap.paint);
      return;
    }
    lastPaintHuntRef.current = null;
    skipAttrFacetGen.current = null;
    if (search) {
      if (board && isBoardUnbound(board, snap.bind)) {
        clearUnboundBoard();
        return;
      }
      setEvents([]);
      setHistogram([]);
      setSearchWindow(null);
      histogramRef.current = [];
      setWindowMarks([]);
      setMarkBefore(null);
      setMarkAfter(null);
      setAggSeries(null);
      aggSeriesRef.current = null;
      setSeriesByKey({});
      seriesByKeyRef.current = {};
      setTotal(0);
      setNextCursor(null);
      setLastMs(null);
      lastToRef.current = null;
      void runSearch("replace", {
        q: snap.q,
        range: snap.range,
        from: snap.from,
        to: snap.to,
        live: board ? false : snap.live,
        split: snap.split,
        step: snap.step,
        agg: snap.agg,
        logs: snap.logsOn,
        widgets: snap.widgets,
        park: parkedCutLine(snap),
      });
    }
  }

  function addWorkspace(snap: WorkspaceSnap, atEnd: boolean) {
    const id = wsSeq + 1;
    const meta = labelForSnap(snap);
    const next: Workspace = {
      id,
      kind: snap.kind,
      label: meta.label,
      board: meta.board,
      snap,
    };
    setWsSeq(id);
    setWsList((list) =>
      insertWorkspace(
        stampWorkspace(
          list,
          wsId,
          currentSnap(),
          liveLabelNow(),
          Boolean(saved.find((row) => row.id === savedId)?.board),
        ),
        wsId,
        next,
        atEnd,
      ),
    );
    applySnap(snap, true);
    setWsId(id);
  }

  function goWs(id: number) {
    if (id === wsId) {
      return;
    }
    const target = wsList.find((item) => item.id === id);
    if (!target) {
      return;
    }
    setWsList((list) => stampWorkspace(list, wsId, currentSnap(), liveLabelNow()));
    applySnap(target.snap, true);
    setWsId(id);
  }

  function onNewWorkspace() {
    addWorkspace(blankSearchSnap(), true);
  }

  function onDuplicateWorkspace() {
    addWorkspace(duplicateSnap(currentSnap()), false);
  }

  function onCloseWorkspace(id: number) {
    const stamped = stampWorkspace(wsList, wsId, currentSnap(), liveLabelNow());
    const closed = closeWorkspace(stamped, id);
    if (closed.nextId === null) {
      return;
    }
    setWsList(closed.list);
    if (id === wsId) {
      const target = closed.list.find((item) => item.id === closed.nextId);
      if (target) {
        applySnap(target.snap, true);
        setWsId(target.id);
      }
    }
  }

  function followSnap(
    key: string,
    value: string,
    opened: FollowOpened,
  ): WorkspaceSnap {
    return followChildSnap(currentSnap(), {
      q: followQuery(key, value),
      from: toLocalInput(new Date(opened.fromMs)),
      to: toLocalInput(new Date(opened.toMs)),
      key,
      value,
      opened,
    });
  }

  function ensureSearchWorkspace() {
    if (wsKind === "search") {
      return;
    }
    const searchTab = wsList.find((item) => item.kind === "search");
    if (searchTab) {
      setWsList((list) =>
        stampWorkspace(
          list,
          wsId,
          currentSnap(),
          liveLabelNow(),
          Boolean(saved.find((row) => row.id === savedId)?.board),
        ),
      );
      applySnap(searchTab.snap, false);
      setWsId(searchTab.id);
      return;
    }
    addWorkspace(blankSearchSnap(), true);
  }

  function openSurroundings(event: LogEvent) {
    const decision = decideOpenSurroundings(
      { kind: wsKind, surrAnchor },
      event,
    );
    switch (decision.action) {
      case "stay":
        return;
      case "recenter":
        setSurrAnchor(event);
        setFocusMark(null);
        setFocusMarkId(null);
        setSurrSel(null);
        setAroundN(surroundingDefaultN);
        setAroundMode("all");
        setActiveInspect(null);
        return;
      case "open-beside":
        addWorkspace(
          surroundingsEventSnap(currentSnap(), event, {
            frozenFacets: facets,
            frozenAttrFacetValues: attrFacetValues,
          }),
          false,
        );
        return;
      default: {
        const _never: never = decision;
        return _never;
      }
    }
  }

  function closeInspect(index: number) {
    const closed = inspectTabs[index];
    const next = inspectTabs.filter((_, j) => j !== index);
    setInspectTabs(next);
    if (
      activeInspect &&
      closed &&
      inspectTabKey(activeInspect) === inspectTabKey(closed)
    ) {
      setActiveInspect(next[Math.min(index, next.length - 1)] ?? null);
    }
  }

  function openTrace(event: LogEvent) {
    const ref = joinTraceRef(event.attrs);
    if (!ref) {
      return;
    }
    const tab: InspectTab = {
      kind: "trace",
      key: ref.key,
      value: ref.value,
      ts: event.ts,
      service: event.service,
    };
    setInspectTabs((tabs) => upsertInspectTab(tabs, tab));
    setActiveInspect(tab);
    if (!isReaderKind(wsKind)) {
      focusEvent(event);
    }
  }

  function onSelectSpan(spanId: string | null) {
    if (!traceView) {
      return;
    }
    setSpanSel(spanId ? { trace: traceView.value, spanId } : null);
    setSpanRail("span");
  }

  function openProfile(span: Span) {
    if (!traceView) {
      return;
    }
    const tab: InspectTab = {
      kind: "profile",
      trace_id: span.trace_id || traceView.value,
      span_id: span.span_id,
      service: span.service,
      name: span.name,
      ts: span.ts || traceView.ts,
    };
    setInspectTabs((tabs) => upsertInspectTab(tabs, tab));
    setActiveInspect(tab);
  }

  function backFromProfile() {
    if (!profileView) {
      setActiveInspect(null);
      return;
    }
    const trace = inspectTabs.find(
      (tab) => tab.kind === "trace" && tab.value === profileView.trace_id,
    );
    setActiveInspect(trace ?? null);
  }

  async function copyLink() {
    const next = serializeSearchUrl({
      q,
      range,
      from,
      to,
      live,
      saved: savedId,
      view,
      mark: compare?.mark.id ?? null,
      split,
      chart,
      logScale,
      step,
      attrFacets,
      cols,
      agg,
      replaceY,
      logs: logsOn,
      widgets,
      bind,
      boardKeys: saved.find((item) => item.id === savedId)?.board?.keys ?? null,
    });
    const path = `${window.location.pathname}${next}`;
    history.replaceState(null, "", path);
    await navigator.clipboard.writeText(`${window.location.origin}${path}`);
    toast.success("Link copied");
  }

  const onCutResult = useCallback((result: FingerprintCutResult) => {
    setCut((prev) => (prev ? { ...prev, result } : prev));
  }, []);

  function applyQuery(next: string) {
    if (isReaderKind(wsKind)) {
      return;
    }
    setQ(next);
    void runSearch("replace", { q: next });
  }

  function onPickBind(key: string, value: string) {
    const item = saved.find((row) => row.id === savedId);
    if (!item?.board) {
      return;
    }
    const nextBind = { ...bind, [key]: value };
    const nextQ = boundQuery(item.query, nextBind);
    setBind(nextBind);
    setQ(nextQ);
    if (isBoardUnbound(item.board, nextBind)) {
      return;
    }
    void runSearch("replace", { q: nextQ });
  }

  /** Latest render's opener: the read below awaits, and tabs may change meanwhile. */
  followOpenRef.current = (field: string, value: string, opened: FollowOpened) => {
    setView("search");
    addWorkspace(followSnap(field, value, opened), false);
  };

  /** Reads the value's first and last row within a day, then opens the tab on them. */
  async function onFollowField(field: string, value: string, ts: string) {
    const atMs = Date.parse(ts);
    if (Number.isNaN(atMs)) {
      return;
    }
    let span: FollowSpan | null = null;
    try {
      const params = followSpanSearchParams(
        followQuery(field, value),
        new Date(atMs).toISOString(),
      );
      const res = await fetch(`/api/search/follow-span?${params.toString()}`);
      if (res.ok) {
        span = (await res.json()) as FollowSpan;
      }
    } catch {
      span = null;
    }
    followOpenRef.current?.(field, value, followOpened(atMs, span));
  }

  function onResetFollow() {
    const opened = follow?.opened;
    if (!opened) {
      return;
    }
    const nextFrom = toLocalInput(new Date(opened.fromMs));
    const nextTo = toLocalInput(new Date(opened.toMs));
    setExplore(null);
    setRange("custom");
    setFrom(nextFrom);
    setTo(nextTo);
    setLive(false);
    setStep(null);
    void runSearch("replace", {
      range: "custom",
      from: nextFrom,
      to: nextTo,
      live: false,
      step: null,
    });
  }

  function onToggleFacet(field: string, value: string) {
    applyQuery(toggleFieldToken(q, field, value));
  }



  function onAddAttrFacet(key: string) {
    if (!isChartSummaryKey(key, fieldRoles)) {
      const role = fieldRoles[key];
      toast.error(`${key} is ${role} — skip chart summaries`);
      return;
    }
    if (attrFacets.length >= maxAttrFacets) {
      toast.error(`At most ${maxAttrFacets} attr facets`);
      return;
    }
    setAttrFacets(parseAttrFacets([...attrFacets, key].join(",")));
  }

  function onRemoveAttrFacet(key: string) {
    setAttrFacets(attrFacets.filter((item) => item !== key));
    setAttrPrefixes((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  async function onOpenAddFacet() {
    setAttrKeysLoading(true);
    const fromPage = new Map<string, number>();
    for (const event of events) {
      for (const raw of Object.keys(event.attrs ?? {})) {
        const key = raw.toLowerCase();
        if (!isAttrIdent(key)) {
          continue;
        }
        fromPage.set(key, (fromPage.get(key) ?? 0) + 1);
      }
    }
    try {
      const res = await fetch(`/api/attr-keys?${windowParams().toString()}`);
      const keys = res.ok
        ? ((await res.json()) as { keys: Array<{ k: string; n: number }> }).keys
        : [];
      for (const item of keys) {
        fromPage.set(item.k, Math.max(fromPage.get(item.k) ?? 0, item.n));
      }
    } catch {
      // page keys still usable
    } finally {
      const merged = [...fromPage.entries()]
        .map(([k, n]) => ({ k, n }))
        .sort((a, b) => b.n - a.n || a.k.localeCompare(b.k));
      setAttrKeyOptions(merged);
      setAttrKeysLoading(false);
    }
  }

  function onFilterField(field: string, value: string) {
    applyQuery(addFieldToken(q, field, value));
  }

  function onHbarCommand(command: HbarCommand, field: string, value: string) {
    switch (command) {
      case "filter":
        applyQuery(setFieldToken(q, field, value));
        return;
      case "exclude":
        applyQuery(excludeFieldToken(q, field, value));
        return;
      default: {
        const _exhaustive: never = command;
        return _exhaustive;
      }
    }
  }

  const loadMenuValues = useCallback(
    async (field: string, prefix: string): Promise<MenuSuggestion[]> => {
      const pre = prefix.toLowerCase();
      if (field === "level" || field === "service" || field === "host") {
        return facets[field]
          .filter((item) => item.v.toLowerCase().startsWith(pre))
          .map((item) => ({
            label: item.v,
            insert: `${item.v} `,
            meta: formatCompactCount(item.n),
          }));
      }
      const params = windowParams();
      try {
        if (prefix.length > 0) {
          params.set("key", field);
          params.set("prefix", prefix);
          const res = await fetch(`/api/attr-values?${params.toString()}`);
          if (!res.ok) {
            return [];
          }
          const json = (await res.json()) as { values: FacetValue[] };
          return json.values.map((item) => ({
            label: item.v,
            insert: `${item.v} `,
            meta: formatCompactCount(item.n),
          }));
        }
        params.set("attrs", field);
        const res = await fetch(`/api/attr-facets?${params.toString()}`);
        if (!res.ok) {
          return [];
        }
        const json = (await res.json()) as Record<string, FacetValue[]>;
        return (json[field] ?? []).map((item) => ({
          label: item.v,
          insert: `${item.v} `,
          meta: formatCompactCount(item.n),
        }));
      } catch {
        return [];
      }
    },
    [facets, windowParams],
  );

  const menuFields = useMemo(() => {
    const seen = new Set(["level", "service", "host"]);
    const list: Array<{ name: string; kind: "field" | "attr" }> = [
      { name: "level", kind: "field" },
      { name: "service", kind: "field" },
      { name: "host", kind: "field" },
    ];
    for (const item of attrKeyOptions) {
      if (seen.has(item.k)) {
        continue;
      }
      seen.add(item.k);
      list.push({ name: item.k, kind: "attr" });
    }
    return list;
  }, [attrKeyOptions]);

  function openNewAlert() {
    // A push, HTTP(S), TCP or certificate monitor needs no saved search (#177, #178, #180); the others pick one.
    const watchable = saved.filter((item) => !item.board);
    const current = saved.find((item) => item.id === savedId);
    const id =
      current && !current.board ? current.id : (watchable[0]?.id ?? null);
    setNewMonitor({ savedSearchId: id, lockSearch: false });
  }

  const emptyIngest = isEmptyIngest({
    searching,
    error,
    eventCount: events.length,
    q,
    ingested,
  });
  const inFlightDim = searching && (events.length > 0 || histogram.length > 0);
  const spanMs = searchSpanMs(range, from, to, live, liveWindowMs.current);
  // What the Series control can offer in this window. The pinned plot is a widget too.
  pickedMetricsRef.current = [
    ...new Set(
      widgets
        .map((widget) => parseMetricRef(widget.metric)?.name)
        .filter((name): name is string => Boolean(name)),
    ),
  ];
  const seriesCatalog = useMemo<SeriesCatalog>(
    () => ({
      numericKeys,
      metrics: metricCatalog.entries,
      metricTotal: metricCatalog.total,
      picked: metricCatalog.picked,
      window: range === "custom" ? "" : range,
      live,
      find: findMetrics,
      labels: metricLabelKeys,
    }),
    [numericKeys, metricCatalog, range, live, findMetrics, metricLabelKeys],
  );
  const clockFromMs = Date.parse(isoFromLocal(from) ?? "");
  const { fromMs: windowFromMs, toMs: windowToMs } = searchWindowMs(searchWindow, {
    fromMs: clockFromMs,
    toMs:
      Number.isFinite(clockFromMs) && spanMs > 0
        ? clockFromMs + spanMs
        : Date.parse(isoFromLocal(to) ?? ""),
  });
  // Monitors on this tab's saved search: their stretches on this clock (#175, 18o).
  // A push, HTTP(S), TCP or certificate monitor's stretches sit on a hunt of its own `monitor:<name>` (18i).
  const bandMonitors = alerts.filter(
    (m) =>
      (savedId && m.saved_search_id === savedId) ||
      (["push", "http", "tcp", "cert"].includes(sourceOf(m)) && Boolean(q.trim()) && m.query === q.trim()),
  );
  const bandKey = bandMonitors.map((m) => m.id).join(",");
  // Read again when the search's reply moves the window off the clock guessed before it.
  const bandWindow = bandWindowKey({ fromMs: windowFromMs, toMs: windowToMs });
  useEffect(() => {
    if (view !== "search" || !bandKey || !Number.isFinite(windowFromMs) || !Number.isFinite(windowToMs)) {
      setHuntStretches((prev) => (prev.length > 0 ? [] : prev));
      return;
    }
    const ac = new AbortController();
    const params = new URLSearchParams({
      from: new Date(windowFromMs).toISOString(),
      to: new Date(Math.max(windowToMs, Date.now())).toISOString(),
    });
    void fetch(`/api/monitors?${params.toString()}`, { signal: ac.signal })
      .then((res) => (res.ok ? (res.json() as Promise<MonitorsResponse>) : null))
      .then((json) => {
        if (json && !ac.signal.aborted) {
          setHuntStretches(json.stretches);
        }
      })
      .catch(() => undefined);
    return () => ac.abort();
    // The window moves every Live poll; the stretches follow it to the minute and the 30s monitor read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, bandKey, range, from, to, alerts, bandWindow]);
  const monitorBand: MonitorBand | null =
    bandMonitors.length > 0
      ? {
          items: huntStretches.flatMap((stretch) => {
            const monitor = bandMonitors.find((m) => m.id === stretch.monitor_id);
            return monitor ? [{ stretch, monitor }] : [];
          }),
          nowMs: Date.now(),
          onOpenMonitor: (monitor) => setMonitorRail((prev) => ({ ...prev, [wsId]: monitor.id })),
          onSilence: (monitor, forId) => void silenceAlert(monitor, forId),
        }
      : null;
  const railMonitor = monitorRail[wsId] ? alerts.find((m) => m.id === monitorRail[wsId]) : undefined;
  const barInterval = displayedHistogramInterval(spanMs, step, chart);
  const searchSlow = searching && searchElapsedMs >= SEARCH_SLOW_AFTER_MS;
  const compiled = compileQuery(q);
  const qFaults = compiled.faults;
  const qErrOn = showFaults && qFaults.length > 0;
  const activeFacets: Partial<Record<string, string | string[]>> = activeFacetValues(
    q,
    ["level", "service", "host", ...attrFacets],
  );
  const heldCounts = new Map((facets.toposcope ?? []).map((item) => [item.v, item.n] as const));
  const heldV = heldView({
    sources: held.sources,
    now: held.now,
    live,
    // A relative window runs to now: a source that went quiet since the last paint is short in it.
    window: { from: windowFromMs, to: range === "custom" ? windowToMs : Math.max(windowToMs, held.now) },
    q,
    counts: heldCounts,
    total,
  });
  const displayAttrFacets: Record<string, FacetValue[]> = { ...attrFacetValues };
  for (const [key, prefix] of Object.entries(attrPrefixes)) {
    if (prefix.trim().length > 0) {
      displayAttrFacets[key] = attrPrefixValues[key] ?? [];
    }
  }
  const skipFacetKeys = skipKeysFromFieldRoles(fieldRoles);
  const chartAttrKeyOptions = attrKeyOptions.filter((item) =>
    isChartSummaryKey(item.k, fieldRoles),
  );
  const selectedEvent = isSurr
    ? (surrSel ?? (isMarkFocus ? undefined : surrAnchor) ?? undefined)
    : detailOpen
      ? (events[selectedIndex] ?? pinnedEvent ?? undefined)
      : undefined;
  const activeSaved = saved.find((item) => item.id === savedId);
  const boardOn = Boolean(activeSaved?.board);
  const boardUnbound = Boolean(
    activeSaved?.board && isBoardUnbound(activeSaved.board, bind),
  );
  const railSurface = cutRailSurface({
    hasCut: Boolean(cut),
    detailOpen,
    hasSelected: Boolean(events[selectedIndex] ?? pinnedEvent),
    inspectOpen: Boolean(activeInspect),
    isSurr,
    boardOn,
  });
  const cutCrumb = cut
    ? {
        kind: cut.mark.kind,
        label: cutCrumbLabel(
          cut.result,
          formatChangeMarkLabel(cut.mark),
        ),
        title: "Back to the cut, exactly as left — nothing recomputes",
        onBack: () => {
          setDetailOpen(false);
          setPinnedEvent(null);
        },
      }
    : undefined;
  const traceSpans =
    traceView && traceLoad.value === traceView.value
      ? (traceLoad.result?.spans ?? [])
      : [];
  const selectedSpanId =
    traceView && spanSel?.trace === traceView.value ? spanSel.spanId : null;
  const pickedSpan = selectedSpanId
    ? (traceSpans.find((span) => span.span_id === selectedSpanId) ?? null)
    : null;
  const pickedSpanStartMs = pickedSpan
    ? (flattenTrace(traceSpans).rows.find(
        (row) => row.span.span_id === pickedSpan.span_id,
      )?.startMs ?? 0)
    : 0;
  /** The span holds the rail until the operator steps back to the event it was opened from. */
  const spanOnRail = Boolean(pickedSpan && (spanRail === "span" || !selectedEvent));
  const spanBackCrumb = selectedEvent
    ? {
        label: `Event · ${selectedEvent.message} · ${selectedEvent.ts.slice(11, 23)}`,
        title: "Back to the event — the span stays selected",
        onBack: () => setSpanRail("event"),
      }
    : null;
  const spanForwardCrumb = pickedSpan
    ? {
        label: `Span · ${pickedSpan.service} · ${pickedSpan.name} · still selected`,
        title: "Back to the selected span",
        forward: true,
        onBack: () => setSpanRail("span"),
      }
    : undefined;
  const savedLayout =
    activeSaved?.widgets ??
    defaultLayout({ agg: activeSaved?.agg ?? null });
  const dirty = Boolean(
    activeSaved &&
      !boardOn &&
      (activeSaved.query !== q ||
        (activeSaved.range ? activeSaved.range !== range : range !== "custom") ||
        (activeSaved.agg ?? null) !== agg ||
        savedLayout.logs !== logsOn ||
        JSON.stringify(savedLayout.widgets) !== JSON.stringify(widgets)),
  );
  const stripLabels = ordinalLabels(
    wsList.map((tab) =>
      tab.id === wsId ? liveLabelNow() : labelForSnap(tab.snap).label,
    ),
  );
  const stripTabs = wsList.map((tab, i) => ({
    ...tab,
    kind: tab.id === wsId ? wsKind : tab.kind,
    label: stripLabels[i] ?? tab.label,
    board: tab.id === wsId ? boardOn : labelForSnap(tab.snap).board,
    home: homeId !== null && (tab.id === wsId ? savedId : tab.snap.savedId) === homeId,
  }));
  const elsewhere: Record<string, number> = {};
  for (const tab of wsList) {
    const id = tab.id === wsId ? savedId : tab.snap.savedId;
    if (!id || tab.id === wsId) {
      continue;
    }
    elsewhere[id] = (elsewhere[id] ?? 0) + 1;
  }
  const watching = watchCounts(alerts);

  const cutWindows =
    cut && Number.isFinite(windowFromMs) && spanMs > 0
      ? fingerprintCutViewWindows({
          mark: cut.mark,
          openedAt: cut.openedAt,
          range, from, to, spanMs,
          fromMs: windowFromMs,
          toMs: windowToMs,
          result: cut.result,
        })
      : null;
  const compareWindows =
    compare && Number.isFinite(windowFromMs) && spanMs > 0
      ? compareFoldWindows({ mark: compare.mark, openedAt: compare.openedAt,
          from, to, live, huntFromMs: windowFromMs, huntToMs: windowToMs })
      : null;
  const washWindows =
    cut && cutWindows && !cutWindows.dead
      ? { markId: cut.mark.id, windows: cutWindows }
      : compare && compareWindows && !compareWindows.dead
        ? { markId: compare.mark.id, windows: compareWindows }
        : null;
  const pinnedSeries = primaryTimeseries(widgets);

  const marksOverlay = boardOn
    ? null
    : {
        marks: windowMarks,
        before: markBefore,
        after: markAfter,
        offKinds: marksOff,
        mutedIds: marksMuted,
        onToggleKind: (kind: ChangeMarkKind) =>
          setMarksOff((prev) =>
            prev.includes(kind)
              ? prev.filter((item) => item !== kind)
              : [...prev, kind],
          ),
        onMute: (id: string) => {
          setMarksMuted((prev) => (prev.includes(id) ? prev : [...prev, id]));
          setFocusMarkId((prev) => (prev === id ? null : prev));
        },
        onUnmute: (id: string) =>
          setMarksMuted((prev) => prev.filter((item) => item !== id)),
        onFocusLogs: focusMarkInLogs,
        onFingerprints: openFingerprints,
        onCompare: isSurr ? undefined : openCompare,
        compareMarkId: compare?.mark.id ?? null,
        monitors: monitorBand,
        onOpenPanel: isSurr
          ? undefined
          : () => {
              setDetailOpen(false);
              setPinnedEvent(null);
              setMarksPanelOpen((open) => !open);
            },
        cut: washWindows
          ? {
              markId: washWindows.markId,
              beforeFrom: washWindows.windows.beforeFrom,
              beforeTo: washWindows.windows.beforeTo,
              afterFrom: washWindows.windows.afterFrom,
              afterTo: washWindows.windows.afterTo,
            }
          : null,
      };


  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        {(() => {
          const home = homeId ? saved.find((item) => item.id === homeId && !item.board) : undefined;
          const mark = (
            <>
              <BrandMark className="size-4 shrink-0 text-plate" />
              <span className="text-[14px] font-semibold tracking-[-0.015em]">toposcope</span>
            </>
          );
          return home ? (
            <button
              type="button"
              title={`Home · ${home.name} · opens a new tab · this one stays as it is`}
              className="flex items-center gap-1.5 rounded-md text-foreground"
              onClick={() => openSavedTab(home)}
            >
              {mark}
            </button>
          ) : (
            <span className="flex items-center gap-1.5">{mark}</span>
          );
        })()}
        {instance ? (
          <InstanceMenu
            info={instance}
            onRename={() => setView("settings")}
            onSignOut={() => void signOut()}
          />
        ) : null}
        <HeaderTabs view={view} watchOpen={watching.open > 0} onView={setView} />
        <div className="ml-auto flex items-center gap-2">
          {view === "search" && !isSurr ? (
            <div className="flex items-center gap-1.5">
              <TimeRangePicker
                  ref={clockRef}
                  range={range}
                  from={from}
                  to={to}
                  live={live}
                  liveWindowMs={liveWindowMs.current}
                  lockAbsolute={boardOn}
                  disabled={boardOn && !activeSaved?.board?.win}
                  onRangeChange={onRangeChange}
                  onCustomRange={onCustomRange}
                />
                <Button
                  type="button"
                  size="sm"
                  variant={live ? "secondary" : "outline"}
                  aria-pressed={live}
                  className={boardOn ? "pointer-events-none opacity-50" : undefined}
                  onClick={() => onLiveChange(!live)}
                >
                  <span
                    className={`size-1.5 rounded-full ${
                      readingPaused ? "bg-amber-400" : live && !searching ? "animate-pulse bg-emerald-400" : live ? "bg-emerald-400" : "bg-muted-foreground"
                    }`}
                  />
                  {readingPaused ? <span className="text-amber-400">Paused while reading</span> : searching ? "Paused" : "Live"}
                </Button>
            </div>
          ) : null}
          {view !== "search" ? (
            <HeaderField
              onHunt={(q) => {
                if (q !== null) {
                  addWorkspace({ ...blankSearchSnap(), q }, true);
                }
                setView("search");
              }}
            />
          ) : null}
          {watching.open > 0 || watching.late > 0 || watching.warn > 0 ? (
            // 18c: what is open, in the header on every view.
            <button
              type="button"
              className={cn(
                // The Watch tab's dot says it at any width (26a); the counts in words need the room.
                "hidden h-[26px] items-center gap-1.5 whitespace-nowrap rounded-md border px-3 text-[12px] xl:inline-flex",
                watching.open > 0 ? "border-red-500/50" : "border-white/15",
              )}
              title="Open Watch"
              onClick={() => setView("watch")}
            >
              {watching.open > 0 ? (
                <>
                  <span className="size-[7px] rounded-full bg-red-500" />
                  {watching.open} open
                </>
              ) : null}
              {watching.late > 0 ? (
                <span className="text-muted-foreground">
                  {watching.open > 0 ? "· " : ""}
                  {watching.late} late
                </span>
              ) : null}
              {watching.warn > 0 ? (
                <span className="text-muted-foreground">
                  {watching.open > 0 || watching.late > 0 ? "· " : ""}
                  {watching.warn} warn
                </span>
              ) : null}
            </button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant={accessLit(view) ? "secondary" : "ghost"}
            aria-current={accessLit(view) ? "page" : undefined}
            onClick={() => setView("access")}
          >
            Access
          </Button>
          <Button
            type="button"
            size="sm"
            variant={settingsLit(view) ? "secondary" : "ghost"}
            aria-current={settingsLit(view) ? "page" : undefined}
            onClick={() => setView("settings")}
          >
            Settings
          </Button>
          {me ? <MeMenu me={me} onSignOut={() => void signOut()} /> : null}
        </div>
      </header>
      {view === "settings" ? (
        <SettingsPage
          instance={instance}
          onInstanceName={() => void loadInstance().catch(() => undefined)}
          onRetentionDays={setRetentionDays}
          onSignOut={() => void signOut()}
          onOpenFields={() => setView("fields")}
        />
      ) : view === "home" ? (
        <HomeView
          meId={me?.id ?? null}
          saved={saved}
          monitors={alerts}
          instanceName={instance?.name ?? null}
          onOpenSaved={(item, win) => {
            setView("search");
            addWorkspace(
              { ...snapFromSaved(item, {}), range: "custom", from: toLocalInput(new Date(win.from)), to: toLocalInput(new Date(win.to)), live: false },
              true,
            );
          }}
          onOpenHunt={(q, win) => {
            setView("search");
            addWorkspace({ ...blankSearchSnap(), q, range: "custom", from: toLocalInput(new Date(win.from)), to: toLocalInput(new Date(win.to)), live: false }, true);
          }}
          onOpenWatch={() => setView("watch")}
          onOpenAccess={() => setView("access")}
          onOpenBoard={(item) => openSavedTab(item)}
        />
      ) : view === "access" && sharePage ? (
        <SharePage
          name={sharePage}
          onBack={() => setSharePage(null)}
          onOpenHunt={(hq) => {
            setView("search");
            addWorkspace({ ...blankSearchSnap(), kind: "search", q: hq, range: "24h", live: false }, true);
          }}
        />
      ) : (view === "access" || view === "links") && linkPageId ? (
        <LinkPage
          id={linkPageId}
          onBack={() => {
            setLinkPageId(null);
            setView("access");
          }}
          onOpenHunt={(hq) => {
            setView("search");
            addWorkspace({ ...blankSearchSnap(), kind: "search", q: hq, range: "24h", live: false }, true);
          }}
        />
      ) : view === "access" || view === "links" ? (
        <AccessView
          filter={view === "links" ? "links" : accessFilter === "links" ? "all" : accessFilter}
          onFilter={(f) => {
            setLinkPageId(null);
            if (f === "links") {
              setView("links");
            } else {
              setAccessFilter(f);
              setView("access");
            }
          }}
          here={instance?.name ?? null}
          retentionDays={retentionDays}
          onOpenHunt={(hq) => {
            setView("search");
            addWorkspace({ ...blankSearchSnap(), kind: "search", q: hq, range: "24h", live: false }, true);
          }}
          onOpenLink={(id) => setLinkPageId(id)}
          onOpenShare={(shareName) => {
            setView("access");
            setSharePage(shareName);
          }}
          onNewShare={() => setSharesOpen(true)}
        />
      ) : view === "watch" ? (
        <WatchView
          data={monitors}
          canCreate
          range={watchRange}
          onRange={(next) => {
            watchRangeRef.current = next;
            setWatchRange(next);
          }}
          filter={watchFilter}
          onFilter={setWatchFilter}
          marks={watchMarkList}
          onNew={openNewAlert}
          onOpen={openMonitor}
          onOpenMarks={openMarksStretch}
        />

      ) : view === "fields" ? (
        <FieldsView
          catalog={fields}
          wave={fieldsWave}
          warm={fieldsWarm}
          elapsedMs={fieldsElapsedMs}
          failed={fieldsFailed}
          onSettings={() => setView("settings")}
          onStop={cancelFields}
          onSave={saveFields}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <WorkspaceStrip
            tabs={stripTabs}
            activeId={wsId}
            onSelect={goWs}
            onClose={onCloseWorkspace}
            onNew={onNewWorkspace}
            onDuplicate={onDuplicateWorkspace}
          />
          <div className="flex min-h-0 min-w-0 flex-1">
          <div ref={plotRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            {watchThisOpen && !isSurr && !boardOn ? (
              <WatchThisSheet
                q={q}
                agg={pinnedSeries?.metric ? null : (pinnedSeries?.agg ?? agg ?? null)}
                savedName={activeSaved && !activeSaved.board ? activeSaved.name : null}
                savedId={activeSaved && !activeSaved.board ? activeSaved.id : null}
                savedRange={activeSaved && !activeSaved.board ? activeSaved.range : null}
                onSave={saveWatchThis}
                onCancel={() => setWatchThisOpen(false)}
              />
            ) : null}
            {isSurr ? (
              activeInspect ? (
                <>
                  <ContextTabs
                    tabs={inspectTabs}
                    active={activeInspect}
                    resultsLabel="Surroundings"
                    alwaysShow
                    onResults={() => setActiveInspect(null)}
                    onSelect={setActiveInspect}
                    onClose={closeInspect}
                  />
                  {profileView ? (
                    <SpanFlamegraph
                      service={profileView.service}
                      name={profileView.name}
                      spanId={profileView.span_id}
                      ts={profileView.ts}
                      result={
                        profileLoad.key ===
                        `${profileView.trace_id}:${profileView.span_id}`
                          ? profileLoad.result
                          : null
                      }
                      loading={
                        profileLoad.key ===
                        `${profileView.trace_id}:${profileView.span_id}`
                          ? profileLoad.loading
                          : true
                      }
                      failed={
                        profileLoad.key ===
                        `${profileView.trace_id}:${profileView.span_id}`
                          ? profileLoad.failed
                          : false
                      }
                      canBackToTrace={inspectTabs.some(
                        (tab) =>
                          tab.kind === "trace" &&
                          tab.value === profileView.trace_id,
                      )}
                      onBack={backFromProfile}
                    />
                  ) : traceView ? (
                    <div className="flex min-h-0 min-w-0 flex-1">
                    <TraceWaterfall
                      joinKey={traceView.key}
                      joinValue={traceView.value}
                      ts={traceView.ts}
                      result={
                        traceLoad.value === traceView.value
                          ? traceLoad.result
                          : null
                      }
                      loading={
                        traceLoad.value === traceView.value
                          ? traceLoad.loading
                          : true
                      }
                      failed={
                        traceLoad.value === traceView.value
                          ? traceLoad.failed
                          : false
                      }
                      onFollow={(key, value, ts) => {
                        setActiveInspect(null);
                        onFollowField(key, value, ts);
                      }}
                      selected={selectedSpanId}
                      onSelect={onSelectSpan}
                    />
                    {pickedSpan ? (
                      <SpanDetail
                        key={pickedSpan.span_id}
                        span={pickedSpan}
                        startMs={pickedSpanStartMs}
                        onClose={() => setSpanSel(null)}
                        onViewProfiles={openProfile}
                      />
                    ) : null}
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="flex min-h-0 flex-1">
                  <ContextView
                    event={isMarkFocus ? null : surrAnchor}
                    mark={isMarkFocus ? focusMark : null}
                    fromIso={isMarkFocus ? isoFromLocal(from) : undefined}
                    toIso={isMarkFocus ? isoFromLocal(to) : undefined}
                    selected={surrSel}
                    q={q}
                    mode={aroundMode}
                    n={aroundN}
                    fromMs={windowFromMs}
                    spanMs={spanMs}
                    onMode={setAroundMode}
                    onMore={() =>
                      setAroundN((n) =>
                        Math.min(surroundingMaxN, n + surroundingStepN),
                      )
                    }
                    onSelect={setSurrSel}
                    strip={
                      <ContextTabs
                        tabs={inspectTabs}
                        active={activeInspect}
                        resultsLabel="Surroundings"
                        alwaysShow
                        onResults={() => setActiveInspect(null)}
                        onSelect={setActiveInspect}
                        onClose={closeInspect}
                      />
                    }
                  />
                  {selectedEvent ? (
                    <EventDetail
                      event={selectedEvent}
                      onClose={() => setSurrSel(null)}
                      hideClose
                      fromMs={windowFromMs}
                      spanMs={spanMs}
                      onFilter={onFilterField}
                      filterDisabled
                      filterTitle="Frozen query — open a Search tab to add a filter"
                      onAround={openSurroundings}
                      aroundDisabled={
                        Boolean(
                          surrAnchor &&
                            eventKey(selectedEvent) === eventKey(surrAnchor),
                        )
                      }
                      aroundTitle={
                        surrAnchor &&
                        eventKey(selectedEvent) === eventKey(surrAnchor)
                          ? "This tab is already centred on this event"
                          : undefined
                      }
                      onTrace={openTrace}
                      links={fieldLinks}
                      roles={fieldRoles}
                      onFollow={onFollowField}
                    />
                  ) : null}
                </div>
              )
            ) : (
            <>
            <HuntCrumb
              name={activeSaved?.name ?? null}
              board={boardOn}
              dirty={dirty}
              pinned={Boolean(activeSaved?.pinned)}
              mark={compare?.mark ?? null}
              saveDisabled={qErrOn}
              onHome={() => setView("home")}
              onCloseMark={() => setCompare(null)}
              onSave={onSaveClick}
              onSaveAs={() => {
                setSaveUpdate(false);
                setSaveAsOpen(true);
              }}
              onPin={activeSaved ? () => void togglePinned(activeSaved) : null}
              onDelete={activeSaved ? () => void onDelete(activeSaved.id) : null}
              onWatch={() => setWatchThisOpen(true)}
              onShare={() => void copyLink()}
            />
            <form
              className="relative flex shrink-0 flex-wrap items-center gap-1.5 px-3 py-2"
              onSubmit={onSubmit}
            >
              {searching ? (
                <div className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 overflow-hidden bg-white/[0.06]">
                  <div className="h-full w-1/3 animate-toposcope-indeterminate rounded-full bg-gradient-to-r from-transparent via-primary to-transparent" />
                </div>
              ) : null}
              <SearchQueryField
                value={q}
                onChange={setQ}
                onCommit={() => {
                  if (searching || boardOn) {
                    return;
                  }
                  void runSearch("replace");
                }}
                onClear={() => applyQuery("")}
                showFaults={showFaults}
                onShowFaults={setShowFaults}
                chipInField={chipInField}
                onChipInField={setChipInField}
                fields={menuFields}
                loadValues={loadMenuValues}
                history={queryHistory}
                onNeedKeys={() => void onOpenAddFacet()}
                inputRef={searchRef}
                locked={boardOn}
              />
              {searching ? (
                <div
                  className={cn(
                    "flex h-8 min-w-0 items-center gap-2 py-0 pr-1 pl-2.5",
                    "rounded-md border",
                    searchSlow
                      ? "border-amber-400/45 bg-amber-400/10"
                      : "border-input",
                  )}
                >
                  <span className="size-[11px] shrink-0 animate-spin rounded-full border-[1.5px] border-white/25 border-t-foreground" />
                  <span className="shrink-0 text-xs whitespace-nowrap">
                    Searching…
                    {searchElapsedMs >= 100
                      ? ` ${formatSearchElapsed(searchElapsedMs)}`
                      : ""}
                  </span>
                  {searchSlow ? (
                    <span className="min-w-0 truncate border-l border-white/12 pl-2 text-[11.5px] text-amber-400">
                      narrow the window or add a service: filter
                    </span>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 shrink-0 rounded-sm px-2.5 text-[11.5px]"
                    onClick={cancelSearch}
                  >
                    Stop
                  </Button>
                </div>
              ) : null}
              {!searching && lastMs !== null && !qErrOn ? (
                <span className="flex h-8 shrink-0 items-center font-mono text-xs whitespace-nowrap text-muted-foreground">
                  {lastMs} ms
                </span>
              ) : null}
            </form>
            <div className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-[7px] border-b px-3 py-[9px]">
              {unauthorized ? (
                <span className="text-xs text-destructive">
                  Unauthorized. Sign in again.
                </span>
              ) : error ? (
                <span className="text-xs text-destructive">{error}</span>
              ) : null}
              {boardUnbound ? (
                <span className="font-mono text-base font-medium tracking-[-0.01em] whitespace-nowrap text-muted-foreground tabular-nums">
                  — matching
                </span>
              ) : Number.isFinite(windowFromMs) && Number.isFinite(windowToMs) ? (
                <div className="flex items-baseline gap-2.5">
                  <span className="font-mono text-base font-medium tracking-[-0.01em] whitespace-nowrap text-foreground tabular-nums">
                    <CountText n={total} floor={heldV?.floor ?? false} /> matching
                  </span>
                  <span className="font-mono text-base font-medium tracking-[-0.01em] whitespace-nowrap tabular-nums text-muted-foreground">
                    {windowHead(windowFromMs, windowToMs, spanMs)}
                  </span>
                  <span className="font-mono text-[11px] whitespace-nowrap text-muted-foreground/80">
                    {windowMeta(spanMs, barInterval)}
                  </span>
                </div>
              ) : null}
              {!boardUnbound && heldV?.pill ? <HeldPill text={heldV.pill} /> : null}
              {!boardUnbound && heldV?.chip ? <ScopeChipView chip={heldV.chip} /> : null}
              {qErrOn && !chipInField ? <QueryErrorChip faults={qFaults} /> : null}
              {wsKind === "follow" && follow?.opened ? (
                <FollowOpenedChip
                  opened={follow.opened}
                  moved={
                    !followOnOpened(follow.opened, {
                      range,
                      from,
                      to,
                      live,
                      explored: explore !== null,
                    })
                  }
                  onReset={onResetFollow}
                />
              ) : explore ? (
                <>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-white/16 bg-white/5 px-2.5 py-0.5 text-xs text-foreground">
                    <span
                      className="size-1.5 rounded-full"
                      style={{ background: live ? "#0ea5e9" : "#fbbf24" }}
                    />
                    {live ? "Custom window" : "Custom window · paused"}
                  </span>
                  <button
                    type="button"
                    className="inline-flex h-6 items-center gap-1.5 rounded-md border border-white/16 px-2 text-[12px] text-foreground hover:border-ring hover:bg-accent"
                    onClick={onResetExplore}
                  >
                    <Undo2 className="size-3" />
                    Reset to {histogramExploreResetLabel(explore.range)}
                  </button>
                </>
              ) : null}
            </div>
            {boardUnbound && activeSaved?.board ? (
              <BoardEmpty
                keys={activeSaved.board.keys}
                template={activeSaved.query}
                groups={activeSaved.board.keys.map((key) => ({
                  key,
                  value: bind[key] ?? null,
                  values: boardBindValues[key] ?? [],
                }))}
                onPick={onPickBind}
              />
            ) : (
            <>
            <div
              className={cn(
                "px-3 pt-2 pb-2.5 transition-opacity",
                // A Results tab, an open event or the marks panel shrinks the clock (26e, 26f): the rows and the panel need the room.
                activeInspect || (logsOn && (detailOpen || marksPanelOpen))
                  ? "max-h-[32%] min-h-0 overflow-auto"
                  : logsOn
                    ? "max-h-[55%] min-h-0 overflow-auto"
                    : "min-h-0 flex-1 overflow-auto",
                inFlightDim ? "pointer-events-none opacity-50" : "",
              )}
            >
              <SeriesCatalogContext.Provider value={seriesCatalog}>
                <HeldContext.Provider value={heldV}>
                <WidgetCanvas
                  query={q}
                  widgets={widgets}
                  logs={logsOn}
                  onLogs={(on) => {
                    if (on === logsOn) {
                      return;
                    }
                    setLogsOn(on);
                    if (!on) {
                      setDetailOpen(false);
                      setPinnedEvent(null);
                      setActiveInspect(null);
                      setInspectTabs([]);
                    }
                    void runSearch("replace", { logs: on });
                  }}
                  onWidgets={(next) => {
                    const prevQueries = widgetSeriesQueries(widgets);
                    const nextQueries = widgetSeriesQueries(next);
                    const prevPrimary = primaryTimeseries(widgets);
                    const nextPrimary = primaryTimeseries(next);
                    const prevHbar = widgetHbarFetch(widgets);
                    const nextHbar = widgetHbarFetch(next);
                    setWidgets(next);
                    if (nextPrimary) {
                      setSplit(nextPrimary.split);
                      setChart(nextPrimary.chart);
                      setLogScale(nextPrimary.logScale);
                      setAgg(nextPrimary.agg);
                      setReplaceY(nextPrimary.replaceY);
                    }
                    const queriesChanged =
                      JSON.stringify(prevQueries) !== JSON.stringify(nextQueries);
                    const stepWouldChange = histogramChartNeedsRefetch(
                      spanMs,
                      step,
                      prevPrimary?.chart ?? "stacked",
                      nextPrimary?.chart ?? "stacked",
                    );
                    if (queriesChanged || stepWouldChange) {
                      void runSearch("replace", {
                        split: nextPrimary?.split,
                        chart: nextPrimary?.chart,
                        agg: nextPrimary?.agg ?? null,
                        metric: nextPrimary?.metric ?? null,
                        metricLabels: nextPrimary?.metricLabels ?? {},
                        widgets: next,
                      });
                    } else if (
                      hbarFetchNeedsNetwork(prevHbar, nextHbar) ||
                      nextHbar.none !== prevHbar.none
                    ) {
                      void refreshHbarSeries(next);
                    }
                  }}
                  series={seriesByKey}
                  loading={searching}
                  live={live}
                  numericKeys={numericKeys}
                  metricNames={metricNames}
                  attrKeys={chartAttrKeyOptions.map((item) => item.k)}
                  skipAttrKeys={skipFacetKeys}
                  spanMs={spanMs}
                  interval={step}
                  onInterval={(next) => {
                    setStep(next);
                    void runSearch("replace", { step: next });
                  }}
                  onWindow={onHistogramWindow}
                  onCommand={onHbarCommand}
                  locked={boardOn}
                  retentionMs={retentionRangeMs(retentionDays)}
                  scanReason={
                    scanRefuse?.histogram ? scanRefuse.reason : null
                  }
                  marks={marksOverlay}
                  focusMarkId={focusMarkId}
                  onFocusMark={setFocusMarkId}
                  compareFold={
                    compare && !isSurr && !boardOn
                      ? {
                          mark: compare.mark,
                          openedAt: compare.openedAt,
                          q,
                          agg: pinnedSeries?.metric
                            ? null
                            : (pinnedSeries?.agg ?? agg),
                          metric: pinnedSeries?.metric ?? null,
                          ml: formatMetricLabels(pinnedSeries?.metricLabels ?? {}),
                          live,
                          from,
                          to,
                          spanMs,
                          huntFromMs: windowFromMs,
                          huntToMs: windowToMs,
                          onClose: () => setCompare(null),
                        }
                      : null
                  }
                  anchorTs={
                    activeInspect?.kind === "trace" ||
                    activeInspect?.kind === "profile"
                      ? activeInspect.ts
                      : null
                  }
                />
                </HeldContext.Provider>
              </SeriesCatalogContext.Provider>
            </div>
            {activeSaved?.board ? (
              <div className="px-3 pt-2">
                <BoardInputs
                  capLabel={`${boardSlotCount(activeSaved.board)} of 4`}
                  fields={activeSaved.board.keys.map((key) => ({ key, value: bind[key] ?? null, values: boardBindValues[key] ?? [] }))}
                  windowLabel={activeSaved.board.win ? rangeTriggerLabel(range, from, to) : null}
                  onPick={onPickBind}
                  onWindow={() => clockRef.current?.click()}
                />
              </div>
            ) : null}
            <FacetChips
              facets={facets}
              activeFacets={activeFacets}
              loading={facetsLoading || attrFacetsLoading}
              attrPins={attrFacets}
              attrFacetValues={displayAttrFacets}
              attrKeys={chartAttrKeyOptions}
              attrKeysLoading={attrKeysLoading}
              onToggle={onToggleFacet}
              onAddAttrFacet={onAddAttrFacet}
              onRemoveAttrFacet={onRemoveAttrFacet}
              onOpenAddFacet={() => void onOpenAddFacet()}
              floorFor={heldV?.facetFloor}
              locked={boardOn}
            />
            {logsOn ? (
              <>
            <ContextTabs
              tabs={inspectTabs}
              active={activeInspect}
              onResults={() => setActiveInspect(null)}
              onSelect={setActiveInspect}
              onClose={closeInspect}
            />
            <div className="flex min-h-0 flex-1">
              {profileView ? (
                <SpanFlamegraph
                  service={profileView.service}
                  name={profileView.name}
                  spanId={profileView.span_id}
                  ts={profileView.ts}
                  result={
                    profileLoad.key === `${profileView.trace_id}:${profileView.span_id}`
                      ? profileLoad.result
                      : null
                  }
                  loading={
                    profileLoad.key === `${profileView.trace_id}:${profileView.span_id}`
                      ? profileLoad.loading
                      : true
                  }
                  failed={
                    profileLoad.key === `${profileView.trace_id}:${profileView.span_id}`
                      ? profileLoad.failed
                      : false
                  }
                  canBackToTrace={inspectTabs.some(
                    (tab) =>
                      tab.kind === "trace" && tab.value === profileView.trace_id,
                  )}
                  onBack={backFromProfile}
                />
              ) : traceView ? (
                <TraceWaterfall
                  joinKey={traceView.key}
                  joinValue={traceView.value}
                  ts={traceView.ts}
                  result={
                    traceLoad.value === traceView.value ? traceLoad.result : null
                  }
                  loading={
                    traceLoad.value === traceView.value
                      ? traceLoad.loading
                      : true
                  }
                  failed={
                    traceLoad.value === traceView.value ? traceLoad.failed : false
                  }
                  onFollow={(key, value, ts) => {
                    setActiveInspect(null);
                    onFollowField(key, value, ts);
                  }}
                  selected={selectedSpanId}
                  onSelect={onSelectSpan}
                />
              ) : (
                <div
                  className={`flex min-h-0 min-w-0 flex-1 flex-col px-3 pb-2.5 transition-opacity ${
                    inFlightDim ? "pointer-events-none opacity-50" : ""
                  }`}
                >
                  {!searching && !error && events.length === 0 ? (
                    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2.5 rounded-lg border bg-card px-6 py-14 text-center">
                      <p className="text-sm font-medium">
                        {scanRefuse?.events
                          ? scanRefuse.reason
                          : emptyIngest
                            ? "No events ingested yet."
                            : "No events in this range."}
                      </p>
                      <p className="max-w-[360px] text-[13px] leading-relaxed text-muted-foreground">
                        {scanRefuse?.events
                          ? "Narrow the range or simplify q."
                          : emptyIngest
                            ? "POST to /api/ingest, /v1/logs, or syslog UDP 5514."
                            : "Widen the range or clear filters."}
                      </p>
                      {!emptyIngest && q.trim() !== "" ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="mt-0.5"
                          onClick={() => applyQuery("")}
                        >
                          Clear query
                        </Button>
                      ) : null}
                    </div>
                  ) : (
                    <EventTable
                      events={events}
                      selectedIndex={selectedIndex}
                      loading={searching}
                      total={total}
                      q={q}
                      range={range}
                      fromMs={windowFromMs}
                      spanMs={spanMs}
                      showLoadMore={Boolean(nextCursor)}
                      cols={cols}
                      onColsChange={(next) => setCols(parsePromotedCols(next))}
                      onSelect={(i) => {
                        setPinnedEvent(null);
                        setSelectedIndex(i);
                        if (cut) {
                          setDetailOpen(true);
                        setMarksPanelOpen(false);
                          setMarksPanelOpen(false);
                        } else {
                          setDetailOpen(
                            i !== selectedIndex ? true : !detailOpen,
                          );
                        }
                      }}
                      onMove={(i) => {
                        setPinnedEvent(null);
                        setSelectedIndex(i);
                      }}
                      onOpenDetail={() => {
                        setPinnedEvent(null);
                        setDetailOpen(true);
                        setMarksPanelOpen(false);
                      }}
                      onCloseDetail={() => {
                        setDetailOpen(false);
                        setPinnedEvent(null);
                      }}
                      onLoadMore={() => void runSearch("append")}
                      held={heldV?.rows}
                      opened={(monitorBand?.items ?? []).map(({ stretch, monitor }) => ({
                        at: stretch.opened_at,
                        key: `monitor:${stretch.id}`,
                        name: monitor.name,
                        detail: stretch.open_message,
                      }))}
                      floor={heldV?.floor ?? false}
                      marks={marksOverlay}
                      live={live}
                      focusMarkId={focusMarkId}
                      onFocusMark={setFocusMarkId}
                      onLoadToward={(ts) => {
                        loadTowardTsRef.current = Date.parse(ts);
                        void runSearch("append");
                      }}
                    />
                  )}
                </div>
              )}
              {cut && !isSurr && !boardOn ? (
                <div className="relative flex h-full w-[398px] max-w-[36%] min-h-0 shrink-0 flex-col">
                  <div
                    className="flex min-h-0 min-w-0 flex-1 flex-col"
                    inert={railSurface === "detail" || spanOnRail}
                    aria-hidden={railSurface === "detail" || spanOnRail}
                  >
                    <FingerprintCutPanel
                      mark={cut.mark}
                      openedAt={cut.openedAt}
                      q={q}
                      range={range}
                      from={from}
                      to={to}
                      live={live}
                      spanMs={spanMs}
                      fromMs={windowFromMs}
                      toMs={windowToMs}
                      result={cut.result}
                      onResult={onCutResult}
                      onClose={() => setCut(null)}
                      onFilter={(hex) =>
                        applyQuery(toggleFingerprintCutFilter(q, hex, cut.result?.key))
                      }
                    />
                  </div>
                  {spanOnRail && pickedSpan ? (
                    <div className="absolute inset-0 z-10">
                      <SpanDetail
                        key={pickedSpan.span_id}
                        span={pickedSpan}
                        startMs={pickedSpanStartMs}
                        className="h-full w-full max-w-none"
                        crumb={
                          railSurface === "detail" ? spanBackCrumb : cutCrumb
                        }
                        onClose={() => setSpanSel(null)}
                        onViewProfiles={openProfile}
                      />
                    </div>
                  ) : railSurface === "detail" && selectedEvent ? (
                    <div className="absolute inset-0 z-10">
                      <EventDetail
                        event={selectedEvent}
                        className="h-full w-full max-w-none"
                        crumb={pickedSpan ? spanForwardCrumb : cutCrumb}
                        closeTitle="Close this line — back to the cut"
                        onClose={() => {
                          setDetailOpen(false);
                          setPinnedEvent(null);
                        }}
                        fromMs={windowFromMs}
                        spanMs={spanMs}
                        onFilter={onFilterField}
                        onAround={openSurroundings}
                        onTrace={openTrace}
                        links={fieldLinks}
                        roles={fieldRoles}
                        metricNames={metricNames}
                        onGraph={onGraphField}
                        onFollow={onFollowField}
                      />
                    </div>
                  ) : null}
                </div>
              ) : spanOnRail && pickedSpan ? (
                <SpanDetail
                  key={pickedSpan.span_id}
                  span={pickedSpan}
                  startMs={pickedSpanStartMs}
                  crumb={spanBackCrumb}
                  onClose={() => setSpanSel(null)}
                  onViewProfiles={openProfile}
                />
              ) : marksPanelOpen && !isSurr ? (
                <MarksPanel
                  fromMs={windowFromMs}
                  toMs={windowToMs}
                  selectedId={compare?.mark.id ?? null}
                  offKinds={marksOff}
                  onToggleKind={(kind) =>
                    setMarksOff((prev) => (prev.includes(kind) ? prev.filter((item) => item !== kind) : [...prev, kind]))
                  }
                  onSelect={() => undefined}
                  onCompare={(mark) => openCompare(mark)}
                  onFingerprints={(mark) => openFingerprints(mark)}
                  onFocusLogs={(mark) => focusMarkInLogs(mark)}
                  onHide={(mark) => setMarksMuted((prev) => (prev.includes(mark.id) ? prev : [...prev, mark.id]))}
                  onClose={() => setMarksPanelOpen(false)}
                  onWritten={() => void runSearch("replace")}
                />
              ) : selectedEvent ? (
                <EventDetail
                  event={selectedEvent}
                  crumb={spanForwardCrumb}
                  onClose={() => {
                    setDetailOpen(false);
                    setPinnedEvent(null);
                  }}
                  fromMs={windowFromMs}
                  spanMs={spanMs}
                  onFilter={onFilterField}
                  onAround={openSurroundings}
                  onTrace={openTrace}
                  links={fieldLinks}
                  roles={fieldRoles}
                  metricNames={metricNames}
                  onGraph={onGraphField}
                  onFollow={onFollowField}
                  marks={windowMarks}
                  onFingerprints={openFingerprints}
                />
              ) : null}
            </div>
              </>
            ) : null}
            </>
            )}
            </>
            )}
          </div>
          {railMonitor && !isSurr ? (
            <MonitorRail
              monitor={railMonitor}
              nowMs={Date.now()}
              onClose={() =>
                setMonitorRail((prev) => {
                  const next = { ...prev };
                  delete next[wsId];
                  return next;
                })
              }
              onEdit={() =>
                sourceOf(railMonitor) === "push"
                  ? setPushDraft({ mode: "edit", rule: railMonitor })
                  : sourceOf(railMonitor) === "http"
                    ? setHttpDraft({ mode: "edit", monitor: railMonitor })
                    : sourceOf(railMonitor) === "tcp" || sourceOf(railMonitor) === "cert"
                      ? setNetDraft({ mode: "edit", monitor: railMonitor })
                      : setAlertDraft({ mode: "edit", rule: railMonitor })
              }
              onPause={(paused) => void updateAlert(railMonitor.id, { enabled: !paused })}
              onSilence={(forId) => void silenceAlert(railMonitor, forId)}
            />
          ) : null}
          </div>
        </div>
      )}
      <StatusFooter>
        <ThroughputMeter
          onOpenHour={() => {
            setView("search");
            ensureSearchWorkspace();
            setQ("");
            setSavedId(null);
            setBind({});
            setRange("1h");
            setLive(true);
            setExplore(null);
            liveWindowMs.current = 60 * 60 * 1000;
            void runSearch("replace", { q: "", range: "1h", live: true });
          }}
        />
        <span className="h-3.5 w-px shrink-0 bg-border" aria-hidden />
        <SystemMeters />
        <VersionFooter />
      </StatusFooter>
      <SharesDialog
        open={sharesOpen}
        onOpenChange={setSharesOpen}
        onOpenUse={(useQ) => {
          // A share's use rows, refusals first to read, in a Search tab of their own.
          setSharesOpen(false);
          setView("search");
          addWorkspace({ ...blankSearchSnap(), kind: "search", q: useQ, range: "24h", live: false }, true);
        }}
      />
      <SaveSearchDialog
        open={saveAsOpen}
        onOpenChange={setSaveAsOpen}
        mode={saveUpdate ? "update" : "create"}
        defaultName={activeSaved?.name ?? ""}
        query={q}
        rangeLabel={rangeTriggerLabel(range, from, to)}
        rangeIsCustom={range === "custom"}
        slotKeys={[
          ...new Set([
            ...queryFieldKeys(q),
            ...(activeSaved?.board?.keys ?? []),
          ]),
        ]}
        defaultBoard={saveUpdate ? (activeSaved?.board ?? null) : null}
        onSave={(name, board) =>
          saveUpdate ? updateActiveSaved(name, board) : createSaved(name, board)
        }
        onSaveAs={saveUpdate ? createSaved : undefined}
      />
      <NewMonitorDialog
        open={newMonitor !== null}
        onOpenChange={(open) => {
          if (!open) {
            setNewMonitor(null);
          }
        }}
        example={(() => {
          const item = saved.find((row) => row.id === newMonitor?.savedSearchId);
          return item ? { name: item.name, query: item.query, range: item.range } : null;
        })()}
        canSearch={saved.some((item) => !item.board)}
        onPick={(source) => {
          if (!newMonitor) {
            return;
          }
          if (source === "push") {
            setPushDraft({ mode: "create" });
            setNewMonitor(null);
            return;
          }
          if (source === "http") {
            setHttpDraft({ mode: "create" });
            setNewMonitor(null);
            return;
          }
          if (source === "tcp" || source === "cert") {
            setNetDraft({ mode: "create" });
            setNewMonitor(null);
            return;
          }
          if (!newMonitor.savedSearchId) {
            toast.error("Save a search first");
            return;
          }
          setAlertDraft({ mode: "create", ...newMonitor, savedSearchId: newMonitor.savedSearchId, source });
          setNewMonitor(null);
        }}
      />
      <PushMonitorDialog
        open={pushDraft !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPushDraft(null);
          }
        }}
        draft={pushDraft}
        onCreate={createPush}
        onUpdate={updatePush}
        onDelete={deleteAlert}
      />
      <HttpMonitorDialog
        open={httpDraft !== null}
        onOpenChange={(open) => {
          if (!open) {
            setHttpDraft(null);
          }
        }}
        draft={httpDraft}
        onBack={() => {
          setHttpDraft(null);
          openNewAlert();
        }}
        onCreate={createAlert}
        onUpdate={updateAlert}
        onDelete={deleteAlert}
        canLink={alertsCanLink}
      />
      <NetMonitorDialog
        open={netDraft !== null}
        onOpenChange={(open) => {
          if (!open) {
            setNetDraft(null);
          }
        }}
        draft={netDraft}
        onBack={() => {
          setNetDraft(null);
          openNewAlert();
        }}
        onCreate={createAlert}
        onUpdate={updateAlert}
        onDelete={deleteAlert}
        canLink={alertsCanLink}
      />
      <AlertRuleDialog
        open={alertDraft !== null}
        onOpenChange={(open) => {
          if (!open) {
            setAlertDraft(null);
          }
        }}
        draft={alertDraft}
        saved={saved}
        onCreate={createAlert}
        onUpdate={updateAlert}
        onDelete={deleteAlert}
        canLink={alertsCanLink}
      />
    </div>
  );
}
