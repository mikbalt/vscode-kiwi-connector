// Shapes returned by the Kiwi TCMS JSON-RPC API (only the fields this extension uses).

export interface TestPlan {
  id: number;
  name: string;
  text?: string;
  is_active: boolean;
  product: number;
  product__name?: string;
  product_version: number;
  product_version__value?: string;
  type__name?: string;
  parent?: number | null;
}

export interface TestCase {
  id: number;
  summary: string;
  text?: string;
  notes?: string;
  is_automated: boolean;
  script?: string | null;
  arguments?: string | null;
  requirement?: string | null;
  extra_link?: string | null;
  case_status: number;
  case_status__name?: string;
  category: number;
  category__name?: string;
  priority: number;
  priority__value?: string;
  author__username?: string;
  default_tester__username?: string | null;
  create_date?: string;
}

export interface TestRun {
  id: number;
  summary: string;
  notes?: string;
  plan: number;
  plan__name?: string;
  build: number;
  build__name?: string;
  product_version__value?: string;
  manager__username?: string;
  default_tester__username?: string | null;
  start_date?: string | null;
  stop_date?: string | null;
}

export interface TestExecution {
  id: number;
  run: number;
  case: number;
  case__summary?: string;
  status: number;
  status__name?: string;
  assignee__username?: string | null;
  tested_by__username?: string | null;
  build__name?: string;
  start_date?: string | null;
  stop_date?: string | null;
  sortkey?: number | null;
}

export interface ExecutionStatus {
  id: number;
  name: string;
  /** > 0 positive (PASSED, WAIVED), < 0 negative (FAILED, ERROR, BLOCKED), 0 neutral (IDLE, RUNNING, PAUSED). */
  weight: number;
  icon?: string;
  color?: string;
}

export interface Build {
  id: number;
  name: string;
  version: number;
  is_active: boolean;
}

export interface Category {
  id: number;
  name: string;
  product: number;
}

export interface Priority {
  id: number;
  value: string;
  is_active: boolean;
}

export interface CaseStatus {
  id: number;
  name: string;
  is_confirmed?: boolean;
}

export interface User {
  id: number;
  username: string;
}

export type Query = Record<string, unknown>;
