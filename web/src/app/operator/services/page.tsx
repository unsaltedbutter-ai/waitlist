"use client";

import { useState, useEffect, useCallback } from "react";
import { authFetch } from "@/lib/hooks/use-auth";
import { SectionHeader, thClass, tdClass, tdMuted } from "../_components";

interface Service {
  id: string;
  display_name: string;
  signup_url: string;
  cancel_url: string | null;
  logo_url: string | null;
  notes: string | null;
  supported: boolean;
}

interface Plan {
  id: string;
  service_id: string;
  display_name: string;
  monthly_price_cents: number;
  has_ads: boolean;
  is_bundle: boolean;
  bundle_services: string[] | null;
  display_order: number;
  active: boolean;
  service_display_name: string;
}

type ServiceFormData = {
  display_name: string;
  signup_url: string;
  cancel_url: string;
  logo_url: string;
  notes: string;
};

type PlanFormData = {
  service_id: string;
  display_name: string;
  monthly_price_cents: string;
  has_ads: boolean;
  is_bundle: boolean;
  bundle_services: string;
  display_order: string;
};

const emptyServiceForm: ServiceFormData = {
  display_name: "",
  signup_url: "",
  cancel_url: "",
  logo_url: "",
  notes: "",
};

const emptyPlanForm: PlanFormData = {
  service_id: "",
  display_name: "",
  monthly_price_cents: "",
  has_ads: false,
  is_bundle: false,
  bundle_services: "",
  display_order: "0",
};

const inputClass =
  "w-full bg-background border border-border rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:border-accent";
const btnAccent =
  "text-xs px-2 py-1 rounded border border-accent text-accent hover:bg-accent hover:text-background transition-colors disabled:opacity-30";
const btnMuted =
  "text-xs px-3 py-1.5 rounded border border-border text-muted hover:text-foreground transition-colors disabled:opacity-30";

export default function ServicesPage() {
  const [priceSats, setPriceSats] = useState(3000);
  const [editingPrice, setEditingPrice] = useState(false);
  const [priceInput, setPriceInput] = useState("");
  const [services, setServices] = useState<Service[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Service modal
  const [serviceModal, setServiceModal] = useState<
    { mode: "add" } | { mode: "edit"; service: Service } | null
  >(null);
  const [serviceForm, setServiceForm] = useState<ServiceFormData>(emptyServiceForm);
  const [serviceError, setServiceError] = useState("");
  const [serviceSubmitting, setServiceSubmitting] = useState(false);

  // Plan modal
  const [planModal, setPlanModal] = useState<
    { mode: "add" } | { mode: "edit"; plan: Plan } | null
  >(null);
  const [planForm, setPlanForm] = useState<PlanFormData>(emptyPlanForm);
  const [planError, setPlanError] = useState("");
  const [planSubmitting, setPlanSubmitting] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [settingsRes, servicesRes, plansRes] = await Promise.all([
        authFetch("/api/operator/settings"),
        authFetch("/api/operator/services"),
        authFetch("/api/operator/plans"),
      ]);

      if (settingsRes.status === 403 || servicesRes.status === 403 || plansRes.status === 403) {
        setError("Access denied.");
        return;
      }
      if (!settingsRes.ok || !servicesRes.ok || !plansRes.ok) {
        setError("Failed to load data.");
        return;
      }

      const [settingsData, servicesData, plansData] = await Promise.all([
        settingsRes.json(),
        servicesRes.json(),
        plansRes.json(),
      ]);

      setPriceSats(settingsData.action_price_sats);
      setServices(servicesData.services);
      setPlans(plansData.plans);
    } catch {
      setError("Failed to load data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Pricing
  const savePrice = async () => {
    const val = parseInt(priceInput, 10);
    if (!Number.isInteger(val) || val <= 0 || val > 1_000_000) return;

    const prev = priceSats;
    setPriceSats(val);
    setEditingPrice(false);

    const res = await authFetch("/api/operator/settings", {
      method: "PATCH",
      body: JSON.stringify({ action_price_sats: val }),
    });
    if (!res.ok) setPriceSats(prev);
  };

  // Service toggle
  const toggleService = async (svc: Service) => {
    const newVal = !svc.supported;
    setServices((prev) =>
      prev.map((s) => (s.id === svc.id ? { ...s, supported: newVal } : s))
    );

    const res = await authFetch(`/api/operator/services/${svc.id}`, {
      method: "PATCH",
      body: JSON.stringify({ supported: newVal }),
    });
    if (!res.ok) {
      setServices((prev) =>
        prev.map((s) => (s.id === svc.id ? { ...s, supported: svc.supported } : s))
      );
    }
  };

  // Service modal
  const openAddService = () => {
    setServiceForm(emptyServiceForm);
    setServiceError("");
    setServiceModal({ mode: "add" });
  };

  const openEditService = (svc: Service) => {
    setServiceForm({
      display_name: svc.display_name,
      signup_url: svc.signup_url,
      cancel_url: svc.cancel_url ?? "",
      logo_url: svc.logo_url ?? "",
      notes: svc.notes ?? "",
    });
    setServiceError("");
    setServiceModal({ mode: "edit", service: svc });
  };

  const submitService = async () => {
    setServiceSubmitting(true);
    setServiceError("");
    try {
      if (serviceModal?.mode === "add") {
        const res = await authFetch("/api/operator/services", {
          method: "POST",
          body: JSON.stringify(serviceForm),
        });
        if (!res.ok) {
          const data = await res.json();
          setServiceError(data.error || "Failed to create service.");
          return;
        }
      } else if (serviceModal?.mode === "edit") {
        const res = await authFetch(
          `/api/operator/services/${serviceModal.service.id}`,
          {
            method: "PATCH",
            body: JSON.stringify(serviceForm),
          }
        );
        if (!res.ok) {
          const data = await res.json();
          setServiceError(data.error || "Failed to update service.");
          return;
        }
      }
      setServiceModal(null);
      fetchData();
    } catch {
      setServiceError("Request failed.");
    } finally {
      setServiceSubmitting(false);
    }
  };

  // Plan toggle
  const togglePlan = async (plan: Plan) => {
    const newVal = !plan.active;
    setPlans((prev) =>
      prev.map((p) => (p.id === plan.id ? { ...p, active: newVal } : p))
    );

    const res = await authFetch(`/api/operator/plans/${plan.id}`, {
      method: "PATCH",
      body: JSON.stringify({ active: newVal }),
    });
    if (!res.ok) {
      setPlans((prev) =>
        prev.map((p) => (p.id === plan.id ? { ...p, active: plan.active } : p))
      );
    }
  };

  // Plan modal
  const openAddPlan = () => {
    setPlanForm({ ...emptyPlanForm, service_id: services[0]?.id ?? "" });
    setPlanError("");
    setPlanModal({ mode: "add" });
  };

  const openEditPlan = (plan: Plan) => {
    setPlanForm({
      service_id: plan.service_id,
      display_name: plan.display_name,
      monthly_price_cents: String(plan.monthly_price_cents),
      has_ads: plan.has_ads,
      is_bundle: plan.is_bundle,
      bundle_services: plan.bundle_services?.join(", ") ?? "",
      display_order: String(plan.display_order),
    });
    setPlanError("");
    setPlanModal({ mode: "edit", plan });
  };

  const submitPlan = async () => {
    setPlanSubmitting(true);
    setPlanError("");
    try {
      const payload = {
        ...planForm,
        monthly_price_cents: parseInt(planForm.monthly_price_cents, 10),
        display_order: parseInt(planForm.display_order, 10) || 0,
        bundle_services: planForm.bundle_services.trim()
          ? planForm.bundle_services.split(",").map((s) => s.trim())
          : null,
      };

      if (planModal?.mode === "add") {
        const res = await authFetch("/api/operator/plans", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const data = await res.json();
          setPlanError(data.error || "Failed to create plan.");
          return;
        }
      } else if (planModal?.mode === "edit") {
        const { service_id: _sid, ...patchPayload } = payload;
        const res = await authFetch(
          `/api/operator/plans/${planModal.plan.id}`,
          {
            method: "PATCH",
            body: JSON.stringify(patchPayload),
          }
        );
        if (!res.ok) {
          const data = await res.json();
          setPlanError(data.error || "Failed to update plan.");
          return;
        }
      }
      setPlanModal(null);
      fetchData();
    } catch {
      setPlanError("Request failed.");
    } finally {
      setPlanSubmitting(false);
    }
  };

  if (error === "Access denied.") {
    return <p className="text-red-400 text-sm">403 -- Not authorized.</p>;
  }

  if (loading) return <p className="text-muted">Loading services...</p>;
  if (error) return <p className="text-red-400 text-sm">{error}</p>;

  // Group plans by service for visual grouping
  const plansByService: Record<string, Plan[]> = {};
  for (const p of plans) {
    if (!plansByService[p.service_id]) plansByService[p.service_id] = [];
    plansByService[p.service_id].push(p);
  }

  return (
    <div className="space-y-8">
      {/* Section 1: Pricing */}
      <section>
        <SectionHeader>Pricing</SectionHeader>
        <div className="bg-surface border border-border rounded p-4 flex items-center justify-between">
          {editingPrice ? (
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={priceInput}
                onChange={(e) => setPriceInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") savePrice();
                  if (e.key === "Escape") setEditingPrice(false);
                }}
                className="bg-background border border-border rounded px-3 py-1.5 text-sm text-foreground w-32 focus:outline-none focus:border-accent"
                min={1}
                max={1000000}
                autoFocus
              />
              <span className="text-xs text-muted">sats per action</span>
              <button type="button" onClick={savePrice} className={btnAccent}>
                Save
              </button>
              <button
                type="button"
                onClick={() => setEditingPrice(false)}
                className={btnMuted}
              >
                Cancel
              </button>
            </div>
          ) : (
            <>
              <div>
                <p className="text-xs text-muted mb-1">Action Price</p>
                <p className="text-xl font-bold text-foreground">
                  {priceSats.toLocaleString()} sats
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setPriceInput(String(priceSats));
                  setEditingPrice(true);
                }}
                className={btnAccent}
              >
                Edit
              </button>
            </>
          )}
        </div>
      </section>

      {/* Section 2: Services */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <SectionHeader>Services</SectionHeader>
          <button type="button" onClick={openAddService} className={btnAccent}>
            Add Service
          </button>
        </div>
        {services.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className={thClass}>Display Name</th>
                  <th className={thClass}>Slug</th>
                  <th className={thClass}>Status</th>
                  <th className={thClass}>Cancel URL</th>
                  <th className={thClass}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {services.map((svc) => (
                  <tr key={svc.id} className="border-b border-border/50">
                    <td className={tdClass}>{svc.display_name}</td>
                    <td className={tdMuted}>
                      <span className="font-mono text-xs">{svc.id}</span>
                    </td>
                    <td className={tdClass}>
                      {svc.supported ? (
                        <span className="text-xs px-2 py-0.5 bg-green-900/40 text-green-400 rounded">
                          Supported
                        </span>
                      ) : (
                        <span className="text-xs px-2 py-0.5 bg-neutral-800 text-muted rounded">
                          Unsupported
                        </span>
                      )}
                    </td>
                    <td className={tdMuted}>
                      <span className="text-xs truncate max-w-[200px] inline-block">
                        {svc.cancel_url || "--"}
                      </span>
                    </td>
                    <td className="px-3 py-2 space-x-2">
                      <button
                        type="button"
                        onClick={() => openEditService(svc)}
                        className={btnAccent}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleService(svc)}
                        className={btnAccent}
                      >
                        {svc.supported ? "Disable" : "Enable"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted text-sm">No services configured.</p>
        )}
      </section>

      {/* Section 3: Plans */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <SectionHeader>Plans</SectionHeader>
          <button type="button" onClick={openAddPlan} className={btnAccent}>
            Add Plan
          </button>
        </div>
        {plans.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className={thClass}>Service</th>
                  <th className={thClass}>Plan Name</th>
                  <th className={thClass}>Price ($/mo)</th>
                  <th className={thClass}>Ads</th>
                  <th className={thClass}>Status</th>
                  <th className={thClass}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(plansByService).map(
                  ([serviceId, servicePlans], groupIdx) => (
                    servicePlans.map((plan, idx) => (
                      <tr
                        key={plan.id}
                        className={`border-b ${
                          idx === servicePlans.length - 1 && groupIdx < Object.keys(plansByService).length - 1
                            ? "border-border"
                            : "border-border/50"
                        }`}
                      >
                        <td className={tdMuted}>
                          {idx === 0 ? plan.service_display_name : ""}
                        </td>
                        <td className={tdClass}>{plan.display_name}</td>
                        <td className={tdMuted}>
                          ${(plan.monthly_price_cents / 100).toFixed(2)}
                        </td>
                        <td className={tdMuted}>
                          {plan.has_ads ? (
                            <span className="text-xs text-amber-400">Yes</span>
                          ) : (
                            <span className="text-xs text-muted">No</span>
                          )}
                        </td>
                        <td className={tdClass}>
                          {plan.active ? (
                            <span className="text-xs px-2 py-0.5 bg-green-900/40 text-green-400 rounded">
                              Active
                            </span>
                          ) : (
                            <span className="text-xs px-2 py-0.5 bg-neutral-800 text-muted rounded">
                              Inactive
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 space-x-2">
                          <button
                            type="button"
                            onClick={() => openEditPlan(plan)}
                            className={btnAccent}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => togglePlan(plan)}
                            className={btnAccent}
                          >
                            {plan.active ? "Deactivate" : "Activate"}
                          </button>
                        </td>
                      </tr>
                    ))
                  )
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted text-sm">No plans configured.</p>
        )}
      </section>

      {/* Service Modal */}
      {serviceModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-surface border border-border rounded p-6 w-full max-w-md space-y-4">
            <h3 className="text-sm font-semibold text-foreground">
              {serviceModal.mode === "add" ? "Add Service" : "Edit Service"}
            </h3>

            <div>
              <label className="block text-xs text-muted mb-1">
                Display Name
              </label>
              <input
                type="text"
                value={serviceForm.display_name}
                onChange={(e) =>
                  setServiceForm({ ...serviceForm, display_name: e.target.value })
                }
                className={inputClass}
                disabled={serviceModal.mode === "edit"}
              />
            </div>

            <div>
              <label className="block text-xs text-muted mb-1">
                Signup URL
              </label>
              <input
                type="text"
                value={serviceForm.signup_url}
                onChange={(e) =>
                  setServiceForm({ ...serviceForm, signup_url: e.target.value })
                }
                className={inputClass}
              />
            </div>

            <div>
              <label className="block text-xs text-muted mb-1">
                Cancel URL (optional)
              </label>
              <input
                type="text"
                value={serviceForm.cancel_url}
                onChange={(e) =>
                  setServiceForm({ ...serviceForm, cancel_url: e.target.value })
                }
                className={inputClass}
              />
            </div>

            <div>
              <label className="block text-xs text-muted mb-1">
                Logo URL (optional)
              </label>
              <input
                type="text"
                value={serviceForm.logo_url}
                onChange={(e) =>
                  setServiceForm({ ...serviceForm, logo_url: e.target.value })
                }
                className={inputClass}
              />
            </div>

            <div>
              <label className="block text-xs text-muted mb-1">
                Notes (optional)
              </label>
              <textarea
                value={serviceForm.notes}
                onChange={(e) =>
                  setServiceForm({ ...serviceForm, notes: e.target.value })
                }
                rows={2}
                className={inputClass}
              />
            </div>

            {serviceError && (
              <p className="text-red-400 text-xs">{serviceError}</p>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setServiceModal(null)}
                disabled={serviceSubmitting}
                className={btnMuted}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitService}
                disabled={serviceSubmitting}
                className={btnAccent}
              >
                {serviceSubmitting
                  ? "Saving..."
                  : serviceModal.mode === "add"
                    ? "Create"
                    : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Plan Modal */}
      {planModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-surface border border-border rounded p-6 w-full max-w-md space-y-4">
            <h3 className="text-sm font-semibold text-foreground">
              {planModal.mode === "add" ? "Add Plan" : "Edit Plan"}
            </h3>

            {planModal.mode === "add" && (
              <div>
                <label className="block text-xs text-muted mb-1">
                  Service
                </label>
                <select
                  value={planForm.service_id}
                  onChange={(e) =>
                    setPlanForm({ ...planForm, service_id: e.target.value })
                  }
                  className={inputClass}
                >
                  {services.map((svc) => (
                    <option key={svc.id} value={svc.id}>
                      {svc.display_name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className="block text-xs text-muted mb-1">
                Display Name
              </label>
              <input
                type="text"
                value={planForm.display_name}
                onChange={(e) =>
                  setPlanForm({ ...planForm, display_name: e.target.value })
                }
                className={inputClass}
              />
            </div>

            <div>
              <label className="block text-xs text-muted mb-1">
                Monthly Price (cents)
              </label>
              <input
                type="number"
                value={planForm.monthly_price_cents}
                onChange={(e) =>
                  setPlanForm({
                    ...planForm,
                    monthly_price_cents: e.target.value,
                  })
                }
                className={inputClass}
                min={0}
              />
            </div>

            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={planForm.has_ads}
                  onChange={(e) =>
                    setPlanForm({ ...planForm, has_ads: e.target.checked })
                  }
                  className="accent-accent"
                />
                Has Ads
              </label>
              <label className="flex items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={planForm.is_bundle}
                  onChange={(e) =>
                    setPlanForm({ ...planForm, is_bundle: e.target.checked })
                  }
                  className="accent-accent"
                />
                Is Bundle
              </label>
            </div>

            <div>
              <label className="block text-xs text-muted mb-1">
                Bundle Services (comma-separated, optional)
              </label>
              <input
                type="text"
                value={planForm.bundle_services}
                onChange={(e) =>
                  setPlanForm({ ...planForm, bundle_services: e.target.value })
                }
                className={inputClass}
                placeholder="disney_plus, hulu, max"
              />
            </div>

            <div>
              <label className="block text-xs text-muted mb-1">
                Display Order
              </label>
              <input
                type="number"
                value={planForm.display_order}
                onChange={(e) =>
                  setPlanForm({ ...planForm, display_order: e.target.value })
                }
                className={inputClass}
              />
            </div>

            {planError && (
              <p className="text-red-400 text-xs">{planError}</p>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPlanModal(null)}
                disabled={planSubmitting}
                className={btnMuted}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitPlan}
                disabled={planSubmitting}
                className={btnAccent}
              >
                {planSubmitting
                  ? "Saving..."
                  : planModal.mode === "add"
                    ? "Create"
                    : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
