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
});
export type CaptureRequest = z.infer<typeof CaptureRequestSchema>;

export const CompareRequestSchema = z.object({
  local: CaptureRequestSchema,
  prod: CaptureRequestSchema.partial().required({ url: true }),
  viewport: ViewportSchema.optional(),
  device: z.string().nullable().optional(),
  diff: z
    .object({
      threshold: z.number().min(0).max(1).default(0.1),
      alpha: z.number().min(0).max(1).default(0.3),
    })
    .default({ threshold: 0.1, alpha: 0.3 }),
});
export type CompareRequest = z.infer<typeof CompareRequestSchema>;

export type ErrorKind =
  | "navigation_failed"
  | "action_failed"
  | "click_guard_blocked"
  | "browser_crashed"
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
