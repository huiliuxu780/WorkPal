import { i18n } from "@lingui/core";

export type EffectView = { label: string; note: string | null; tone: "neutral" | "warning" | "danger" };

/** Ledger status describes a local claim/record; it is not a delivery receipt. */
export function effectView(status: string): EffectView {
  switch (status) {
    case "intended":
      return { label: i18n._("Awaiting execution"), note: null, tone: "neutral" };
    case "approved":
      return { label: i18n._("Approved; awaiting execution"), note: null, tone: "neutral" };
    case "denied":
      return { label: i18n._("Request denied"), note: null, tone: "danger" };
    case "executing":
      return { label: i18n._("Execution claimed; outcome unconfirmed"), note: null, tone: "warning" };
    case "completed":
      return { label: i18n._("Call recorded as completed"), note: null, tone: "neutral" };
    case "uncertain":
    case "ambiguous":
      return {
        label: i18n._("Result unconfirmed"),
        note: i18n._("Cannot confirm whether the external system accepted or performed this action. Check it before trying again."),
        tone: "warning",
      };
    case "failed":
      return { label: i18n._("Call failed"), note: null, tone: "danger" };
    case "reconciled":
      return { label: i18n._("Reconciled"), note: null, tone: "neutral" };
    default:
      return { label: i18n._("Status unconfirmed"), note: null, tone: "warning" };
  }
}
