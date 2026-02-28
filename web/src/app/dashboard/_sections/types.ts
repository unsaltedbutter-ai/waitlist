import type { EnrichedQueueItem } from "@/lib/types";

export interface JobRecord {
  id: string;
  service_name: string;
  flow_type: string;
  status: string;
  completed_at: string | null;
  created_at: string;
}

export interface ServicePlan {
  id: string;
  service_id: string;
  display_name: string;
  monthly_price_cents: number;
  has_ads: boolean;
  is_bundle: boolean;
}

export interface ServiceOption {
  serviceId: string;
  label: string;
  plans: ServicePlan[];
}

export interface CachedCredential {
  serviceId: string;
  serviceName: string;
}

export function flowTypeLabel(flowType: string): string {
  switch (flowType) {
    case "cancel":
      return "Cancel";
    case "resume":
      return "Resume";
    default:
      return flowType;
  }
}

export function isItemPinned(item: EnrichedQueueItem): boolean {
  return item.active_job_id !== null;
}
