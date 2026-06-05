import { SetMetadata } from "@nestjs/common";

export const ADMIN_PERMISSION_KEY = "admin_permission";

export const AdminPermission = {
  UsersRead: "users.read",
  UsersWrite: "users.write",
  ClientsRead: "clients.read",
  ClientsWrite: "clients.write",
  CleaningPlansRead: "cleaning_plans.read",
  CleaningPlansWrite: "cleaning_plans.write",
  SubscriptionsRead: "subscriptions.read",
  SubscriptionsWrite: "subscriptions.write",
  PaymentsRead: "payments.read",
  PaymentsWrite: "payments.write",
  BookingsRead: "bookings.read",
  BookingsWrite: "bookings.write",
  AdminSettingsRead: "admin_settings.read",
  AdminSettingsWrite: "admin_settings.write",
  RoleManagementRead: "role_management.read",
  RoleManagementWrite: "role_management.write",
} as const;

export type AdminPermissionKey = (typeof AdminPermission)[keyof typeof AdminPermission];

export const RequireAdminPermission = (permission: AdminPermissionKey) =>
  SetMetadata(ADMIN_PERMISSION_KEY, permission);
