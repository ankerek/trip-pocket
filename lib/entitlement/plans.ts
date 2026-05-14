export type PlanId = 'weekly' | 'monthly' | 'yearly';

export interface PlanConfig {
  id: PlanId;
  productId: string;
  label: string;
  badge?: string;
}

// Edit this array (and only this array) when launch plans are finalized.
// The first entry is the default-selected tile.
export const PLANS: PlanConfig[] = [
  { id: 'yearly', productId: 'trip_pocket_pro_yearly', label: 'Yearly', badge: 'BEST VALUE' },
  { id: 'monthly', productId: 'trip_pocket_pro_monthly', label: 'Monthly' },
  { id: 'weekly', productId: 'trip_pocket_pro_weekly', label: 'Weekly' },
];

// `PLANS` is a non-empty literal, so the index is safe — assert away the
// `noUncheckedIndexedAccess` undefined.
export const DEFAULT_SELECTED_PLAN: PlanId = PLANS[0]!.id;
