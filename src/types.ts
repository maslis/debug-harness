import { z } from "zod";

export const ViewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type Viewport = z.infer<typeof ViewportSchema>;

export const ActionSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("waitFor"),
    selector: z.string().min(1),
    state: z.enum(["attached", "visible", "hidden"]).optional(),
    timeout: z.number().int().positive().optional(),
  }),
  z.object({ op: z.literal("sleep"), ms: z.number().int().nonnegative() }),
  z.object({
    op: z.literal("click"),
    selector: z.string().min(1),
    button: z.enum(["left", "right", "middle"]).optional(),
    clickCount: z.number().int().positive().optional(),
    timeout: z.number().int().positive().optional(),
  }),
  z.object({
    op: z.literal("type"),
    selector: z.string().min(1),
    text: z.string(),
    delay: z.number().int().nonnegative().optional(),
    clear: z.boolean().optional(),
  }),
  z.object({ op: z.literal("press"), key: z.string().min(1) }),
  z.object({
    op: z.literal("scroll"),
    selector: z.string().optional(),
    y: z.number().optional(),
  }),
  z.object({ op: z.literal("hover"), selector: z.string().min(1) }),
  z.object({
    op: z.literal("select"),
    selector: z.string().min(1),
    value: z.union([z.string(), z.array(z.string())]),
  }),
  z.object({
    op: z.literal("evaluate"),
    script: z.string().min(1),
    returnAs: z.string().optional(),
  }),
  z.object({
    op: z.literal("goto"),
    url: z.string().url(),
    waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
  }),
  z.object({
    op: z.literal("setViewport"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  z.object({ op: z.literal("emulate"), device: z.string().min(1) }),
]);
export type Action = z.infer<typeof ActionSchema>;

// Extra HTTP headers attached to every request the browser makes during
// a run. Use cases: bypass headers for upstream WAF/bot-fight rules,
// auth tokens for staging, A/B test cohort overrides. Each consumer
// picks their own header name; nothing here is project-specific.
export const HeadersSchema = z.record(z.string().min(1), z.string()).optional();

export const CaptureRequestSchema = z.object({
  url: z.string().url(),
  viewport: ViewportSchema.optional(),
  device: z.string().nullable().optional(),
  actions: z.array(ActionSchema).default([]),
  inspect: z.array(z.string().min(1)).default([]),
  allowAds: z.boolean().default(false),
  blockHosts: z.array(z.string().min(1)).default([]),
  settleMs: z.number().int().nonnegative().default(500),
  runId: z.string().min(1).optional(),
  headers: HeadersSchema,
});
export type CaptureRequest = z.infer<typeof CaptureRequestSchema>;

export const CompareRequestSchema = z.object({
  local: CaptureRequestSchema,
  prod: CaptureRequestSchema.partial().required({ url: true }),
  viewport: ViewportSchema.optional(),
  device: z.string().nullable().optional(),
  // Top-level headers apply to BOTH local and prod sub-requests. Per-capture
  // headers (req.local.headers / req.prod.headers) override on key overlap.
  headers: HeadersSchema,
  diff: z
    .object({
      threshold: z.number().min(0).max(1).default(0.1),
      alpha: z.number().min(0).max(1).default(0.3),
    })
    .default({ threshold: 0.1, alpha: 0.3 }),
});
export type CompareRequest = z.infer<typeof CompareRequestSchema>;

export const LighthouseCategorySchema = z.enum([
  "performance",
  "accessibility",
  "best-practices",
  "seo",
]);
export type LighthouseCategory = z.infer<typeof LighthouseCategorySchema>;

export const AuditRequestSchema = z.object({
  url: z.string().url(),
  viewport: ViewportSchema.optional(),
  device: z.string().nullable().optional(),
  actions: z.array(ActionSchema).default([]),
  allowAds: z.boolean().default(false),
  blockHosts: z.array(z.string().min(1)).default([]),
  settleMs: z.number().int().nonnegative().default(500),
  runId: z.string().min(1).optional(),
  categories: z.array(LighthouseCategorySchema).default([
    "performance",
    "accessibility",
    "best-practices",
    "seo",
  ]),
  thresholds: z.record(LighthouseCategorySchema, z.number().min(0).max(100)).default({}),
  preset: z.enum(["mobile", "desktop"]).default("desktop"),
  headers: HeadersSchema,
});
export type AuditRequest = z.infer<typeof AuditRequestSchema>;

export interface AuditOpportunity {
  id: string;
  title: string;
  description: string;
  score: number | null;
  wastedMs: number | null;
  wastedBytes: number | null;
  displayValue: string | null;
}

export interface AuditFailedCheck {
  id: string;
  title: string;
  score: number | null;
  displayValue: string | null;
  category: LighthouseCategory;
}

export interface AuditSummary {
  finalUrl: string;
  fetchTime: string;
  scores: Record<LighthouseCategory, number | null>;
  opportunities: AuditOpportunity[];
  failedAudits: AuditFailedCheck[];
  thresholdFailures: Array<{ category: LighthouseCategory; score: number; min: number }>;
  cwv: {
    lcpMs: number | null;
    cls: number | null;
    fcpMs: number | null;
    ttfbMs: number | null;
    tbtMs: number | null;
    speedIndex: number | null;
  };
  error?: { kind: ErrorKind; reason: string; detail?: unknown };
}

export interface AuditResult {
  runId: string;
  artifactDir: string;
  files: Record<string, string>;
  summary: AuditSummary;
}

export type ErrorKind =
  | "navigation_failed"
  | "action_failed"
  | "click_guard_blocked"
  | "browser_crashed"
  | "lighthouse_failed"
  | "internal";

export interface CaptureSummary {
  finalUrl: string;
  title: string;
  statusCode: number | null;
  pageErrors: number;
  consoleErrors: number;
  requests: number;
  failedRequests: number;
  blockedAdRequests: number;
  clickGuardBlocks: number;
  actionsRun: number;
  actionsFailed: number;
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
  error?: { kind: ErrorKind; actionIndex?: number; op?: string; reason: string; detail?: unknown };
}

export interface CaptureResult {
  runId: string;
  artifactDir: string;
  files: Record<string, string>;
  summary: CaptureSummary;
}
