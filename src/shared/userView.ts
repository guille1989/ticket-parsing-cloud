import type { TenantRecord, UserView, WidgetRecord } from "./types.js";

/** Vista propia de esta persona dentro del negocio, o undefined si ve lo compartido. */
export function userViewFor(tenant: TenantRecord, userId: string | undefined): UserView | undefined {
  if (!userId) return undefined;
  const views = tenant.userViews;
  return views && Object.prototype.hasOwnProperty.call(views, userId) ? views[userId] : undefined;
}

/**
 * Con vista propia, solo se ven los widgets propios; sin ella, solo los compartidos
 * (los de una vista propia no se filtran al resto del negocio).
 */
export function widgetVisibleTo(widget: Pick<WidgetRecord, "userId">, userId: string | undefined, hasOwnView: boolean): boolean {
  return hasOwnView ? widget.userId !== undefined && widget.userId === userId : widget.userId === undefined;
}
