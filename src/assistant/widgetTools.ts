import { widgetVisibleTo } from "../shared/userView.js";
import { WIDGETS_TABLE } from "../shared/dynamo.js";
import { queryAllPages } from "../shared/pagination.js";
import type { WidgetRecord } from "../shared/types.js";

const LIST_WIDGETS_DEFAULT_LIMIT = 30;
const LIST_WIDGETS_MAX_LIMIT = 50;

function parseLimit(raw: unknown): number {
  if (raw === undefined) return LIST_WIDGETS_DEFAULT_LIMIT;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new Error(`limit inválido: entero 1–${LIST_WIDGETS_MAX_LIMIT}`);
  }
  return Math.min(raw, LIST_WIDGETS_MAX_LIMIT);
}

/** Resumen de filtros para el modelo (sin agentId crudo si no aporta). */
function summarizeFilters(filters: WidgetRecord["filters"]): Record<string, string> | undefined {
  if (!filters) return undefined;
  const out: Record<string, string> = {};
  if (filters.descriptionContains) out.descriptionContains = filters.descriptionContains;
  if (filters.paymentMethod) out.paymentMethod = filters.paymentMethod;
  if (filters.agentId) out.branch = "(filtrado por sucursal)";
  if (filters.status) out.status = filters.status;
  return Object.keys(out).length ? out : undefined;
}

function toListItem(widget: WidgetRecord) {
  return {
    widgetId: widget.widgetId,
    title: widget.name,
    chartType: widget.visualization,
    field: widget.metric.field,
    aggregation: widget.metric.aggregation,
    ...(widget.secondaryMetric
      ? { secondaryField: widget.secondaryMetric.field, secondaryAggregation: widget.secondaryMetric.aggregation }
      : {}),
    ...(widget.groupBy ? { groupBy: widget.groupBy } : {}),
    ...(summarizeFilters(widget.filters) ? { filters: summarizeFilters(widget.filters) } : {}),
  };
}

/**
 * Lista los widgets del dashboard del tenant para que Ask evite duplicar KPIs
 * antes de create_widget (F3 / P1).
 */
export async function listWidgetsTool(input: unknown, tenantId: string, scope?: { userId?: string; ownView: boolean }): Promise<unknown> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const limit = parseLimit(raw.limit);

  const items = await queryAllPages<WidgetRecord>({
    TableName: WIDGETS_TABLE,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":prefix": "WIDGET#" },
  });

  const visible = scope ? items.filter((w) => widgetVisibleTo(w, scope.userId, scope.ownView)) : items;
  const widgets = visible.slice(0, limit).map(toListItem);
  return { widgets, count: widgets.length, total: visible.length };
}
